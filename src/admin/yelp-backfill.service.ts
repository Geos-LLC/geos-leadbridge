/**
 * Admin Yelp backfill — dry-run only.
 *
 * Inspect what the FEATURE_YELP_WEBHOOK_PERSIST_FULL_THREAD code path would
 * persist for a given set of Yelp leads, WITHOUT writing anything. Read-only.
 *
 * Use case: smoke-test the persistence math against real staging data BEFORE
 * flipping the webhook flag. Reuses the same projection helpers as the live
 * write path so the dry-run report matches what the writer would do.
 *
 * Out of scope (deliberately deferred):
 *  - The actual write path (separate PR, different gating flag).
 *  - Schema bookkeeping writes (Conversation.backfillStatus / lastBackfilledAt).
 *  - Recurring sync.
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import {
  isDisplayableYelpEvent,
  extractYelpEventContent,
  yelpEventSender,
} from '../platforms/yelp/yelp-event-content.util';

const SAMPLE_TRUNCATE_CHARS = 200;
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 50;

export interface BackfillDryRunInput {
  leadIds?: string[];
  userId?: string;
  businessId?: string;
  limit?: number;
  /** Must be true (or omitted) in this PR — the write path lands in a follow-up PR. */
  dryRun?: boolean;
}

export interface BackfillSampleEvent {
  externalMessageId: string;
  sender: 'customer' | 'pro';
  content: string;
  sentAt: string | null;
  newOrExisting: 'new' | 'existing';
}

export interface BackfillLeadResult {
  leadId: string;
  externalRequestId: string;
  businessId: string | null;
  eventsFromYelp: number;
  displayableEvents: number;
  wouldPersist: number;
  alreadyInDb: number;
  sample: BackfillSampleEvent[];
  error?: string;
}

export interface BackfillDryRunResult {
  totalLeadsScanned: number;
  totalEventsWouldPersist: number;
  totalEventsAlreadyInDb: number;
  results: BackfillLeadResult[];
}

@Injectable()
export class YelpBackfillService {
  private readonly logger = new Logger(YelpBackfillService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformFactory: PlatformFactory,
    private readonly configService: ConfigService,
  ) {}

  async dryRun(input: BackfillDryRunInput): Promise<BackfillDryRunResult> {
    if (input.dryRun === false) {
      // Hard 400: the write path is not in this PR. Forces callers to omit the
      // field or pass true; eliminates accidental writes during the staging-test phase.
      throw new BadRequestException(
        'dryRun=false is not supported in this PR. The write path will be a separate change with its own gating flag.',
      );
    }

    const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    const leads = await this.prisma.lead.findMany({
      where: {
        platform: 'yelp',
        ...(input.leadIds && input.leadIds.length > 0 ? { id: { in: input.leadIds } } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.businessId ? { businessId: input.businessId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    if (leads.length === 0) {
      this.logger.log('[yelp_backfill_dryrun] scanned=0 (no leads matched filters)');
      return {
        totalLeadsScanned: 0,
        totalEventsWouldPersist: 0,
        totalEventsAlreadyInDb: 0,
        results: [],
      };
    }

    // Single-lead inspection mode (the staging-proof workflow): emit ALL displayable
    // events. Multi-lead mode caps at 10 per lead so the response stays compact.
    const singleLeadMode = (input.leadIds?.length ?? 0) === 1;
    const sampleCap = singleLeadMode ? Number.POSITIVE_INFINITY : 10;

    const results: BackfillLeadResult[] = [];

    for (const lead of leads) {
      try {
        results.push(await this.inspectLead(lead, sampleCap));
      } catch (err: any) {
        const errMessage = (err?.message ?? 'unknown').substring(0, 200);
        this.logger.warn(`[yelp_backfill_dryrun] lead=${lead.id} failed: ${errMessage}`);
        results.push({
          leadId: lead.id,
          externalRequestId: lead.externalRequestId,
          businessId: lead.businessId,
          eventsFromYelp: 0,
          displayableEvents: 0,
          wouldPersist: 0,
          alreadyInDb: 0,
          sample: [],
          error: errMessage,
        });
      }
    }

    const totalEventsWouldPersist = results.reduce((s, r) => s + r.wouldPersist, 0);
    const totalEventsAlreadyInDb = results.reduce((s, r) => s + r.alreadyInDb, 0);

    this.logger.log(
      `[yelp_backfill_dryrun] scanned=${results.length} wouldPersist=${totalEventsWouldPersist} alreadyInDb=${totalEventsAlreadyInDb}`,
    );

    return {
      totalLeadsScanned: results.length,
      totalEventsWouldPersist,
      totalEventsAlreadyInDb,
      results,
    };
  }

  private async inspectLead(lead: any, sampleCap: number): Promise<BackfillLeadResult> {
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: { userId: lead.userId, platform: 'yelp', businessId: lead.businessId },
    });
    if (!savedAccount?.credentialsJson) {
      throw new Error('no saved Yelp account / credentials for this lead');
    }

    const encryptionKey = this.configService.get<string>('encryption.key') || '';
    const creds = EncryptionUtil.decryptObject<any>(savedAccount.credentialsJson, encryptionKey);

    const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;

    // Token-refresh-on-401 mirrors webhooks.service.ts:1671-1684. We hit the
    // same path the live writer would, so dry-run reflects real persistence math.
    let events: any[];
    try {
      events = await yelpAdapter.getLeadEvents({ accessToken: creds.accessToken }, lead.externalRequestId);
    } catch (fetchErr: any) {
      const is401 = fetchErr.message?.includes('401') || fetchErr.response?.status === 401;
      if (!is401 || !creds.refreshToken) throw fetchErr;
      const refreshed = await yelpAdapter.refreshAccessToken(creds.refreshToken);
      const updated = {
        ...creds,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || creds.refreshToken,
        expiresAt: refreshed.expiresAt,
      };
      const enc = EncryptionUtil.encryptObject(updated, encryptionKey);
      await this.prisma.savedAccount.updateMany({
        where: { userId: lead.userId, platform: 'yelp' },
        data: { credentialsJson: enc },
      });
      this.logger.log(`[yelp_backfill_dryrun] refreshed token for user=${lead.userId} business=${lead.businessId}`);
      events = await yelpAdapter.getLeadEvents({ accessToken: refreshed.accessToken }, lead.externalRequestId);
    }

    if (!Array.isArray(events)) events = [];

    const eventsFromYelp = events.length;
    const displayable = events.filter(isDisplayableYelpEvent);
    const displayableEvents = displayable.length;

    // The "would persist" projection mirrors webhooks.service.ts handleYelpNewEventInner
    // exactly: requires id, must pass display filter, must produce non-empty content.
    const projected = displayable
      .filter((e: any) => !!e.id)
      .map((e: any) => ({
        externalMessageId: e.id as string,
        sender: yelpEventSender(e),
        content: extractYelpEventContent(e),
        sentAt: e.time_created ? new Date(e.time_created).toISOString() : null,
      }))
      .filter(p => p.content.length > 0);

    const ids = projected.map(p => p.externalMessageId);
    const existingRows = ids.length
      ? await this.prisma.message.findMany({
          where: { platform: 'yelp', externalMessageId: { in: ids } },
          select: { externalMessageId: true },
        })
      : [];
    const existingIds = new Set(existingRows.map(r => r.externalMessageId));

    let wouldPersist = 0;
    let alreadyInDb = 0;
    const sample: BackfillSampleEvent[] = [];

    for (const p of projected) {
      const exists = existingIds.has(p.externalMessageId);
      if (exists) alreadyInDb++;
      else wouldPersist++;
      if (sample.length < sampleCap) {
        const truncated =
          p.content.length > SAMPLE_TRUNCATE_CHARS
            ? p.content.slice(0, SAMPLE_TRUNCATE_CHARS) + '...'
            : p.content;
        sample.push({
          externalMessageId: p.externalMessageId,
          sender: p.sender,
          content: truncated,
          sentAt: p.sentAt,
          newOrExisting: exists ? 'existing' : 'new',
        });
      }
    }

    return {
      leadId: lead.id,
      externalRequestId: lead.externalRequestId,
      businessId: lead.businessId,
      eventsFromYelp,
      displayableEvents,
      wouldPersist,
      alreadyInDb,
      sample,
    };
  }
}
