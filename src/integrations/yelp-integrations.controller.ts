/**
 * Yelp Integrations Controller
 *
 * Backend endpoints for the LeadBridge Sync - Yelp Chrome extension.
 * Receives scraped lead IDs from biz.yelp.com inbox, fetches lead details
 * from Yelp API, and creates leads in the database.
 */

import { Controller, Post, Get, Body, Query, UseGuards, Logger, Inject, Optional, forwardRef } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { ConfigService } from '@nestjs/config';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';
import { LeadStatusService, WriteStatusResult } from '../leads/lead-status.service';
import { mapYelpToLbStatus } from './yelp-status-map';

@Controller('v1/integrations/yelp')
@UseGuards(JwtAuthGuard)
export class YelpIntegrationsController {
  private readonly logger = new Logger(YelpIntegrationsController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformService: PlatformService,
    private readonly platformFactory: PlatformFactory,
    private readonly configService: ConfigService,
    private readonly leadStatusService: LeadStatusService,
    @Optional()
    @Inject(forwardRef(() => FollowUpEngineService))
    private readonly followUpEngine: FollowUpEngineService | null,
  ) {}

  /**
   * POST /v1/integrations/yelp/leads/collect
   * Receive scraped lead IDs from the Chrome extension.
   * For each new lead ID, fetch details from Yelp API and create in DB.
   */
  @Post('leads/collect')
  async collectLeads(
    @CurrentUser() user: any,
    @Body() body: {
      savedAccountId: string;
      businessId: string;
      leadIds: string[];
      leadNames?: Record<string, string>;
      leadDates?: Record<string, string>;
      leadCategories?: Record<string, string>;
      leadLocations?: Record<string, string>;
      leadStatuses?: Record<string, string>;
      source?: string;
    },
  ) {
    const { savedAccountId, businessId, leadIds, leadNames, leadDates, leadCategories, leadLocations, leadStatuses } = body;
    this.logger.log(`[Yelp Import] Received ${leadIds.length} lead IDs for business ${businessId}`);

    // Get credentials for this account
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id, platform: 'yelp' },
    });
    if (!account?.credentialsJson) {
      return { ok: false, error: 'Yelp account not found or not connected' };
    }

    const encryptionKey = this.configService.get<string>('encryption.key') || '';
    const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, encryptionKey);
    const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;

    let imported = 0;
    let skipped = 0;
    let failed = 0;
    // Structured skip reasons returned alongside the aggregate `skipped` count
    // so the operator UI can surface what actually happened (which leads
    // belong to a different connected Yelp account, which were rejected by
    // Yelp's API for scope reasons). Mirror of the `skipped` payload added
    // in the Thumbtack reimport flow.
    const skippedOtherAccount: Array<{ id: string; businessId: string | null; businessName: string | null }> = [];
    const skippedWrongScope: Array<{ id: string; message: string }> = [];

    const currentBusinessId = businessId || account.businessId || null;

    for (const leadId of leadIds) {
      // Check if already exists
      const existing = await this.prisma.lead.findUnique({
        where: { platform_externalRequestId: { platform: 'yelp', externalRequestId: leadId } },
      });
      if (existing) {
        // The (platform, externalRequestId) pair is globally unique, so an
        // existing row could belong to a different tenant if two LeadBridge
        // users connected the same Yelp business. Refuse to mutate another
        // tenant's lead — silently skip (don't leak existence by erroring).
        if (existing.userId !== user.id) {
          this.logger.warn(`[Yelp Import] Skipping lead ${leadId}: existing row owned by another user`);
          skipped++;
          continue;
        }

        // Cross-account guard within the same user. Operator picked
        // savedAccount X but this lead's existing row lives under businessId
        // Y. Updating it under X's import context would silently re-attribute
        // the lead — and downstream filters / analytics would assume the
        // wrong account. Skip and surface the owning account so the operator
        // knows where to look.
        if (
          existing.businessId &&
          currentBusinessId &&
          existing.businessId !== currentBusinessId
        ) {
          const ownerAccount = await this.prisma.savedAccount.findFirst({
            where: { userId: user.id, platform: 'yelp', businessId: existing.businessId },
            select: { businessName: true },
          });
          this.logger.log(
            `[Yelp Import] other_account_skip leadId=${leadId} ` +
              `existingBusinessId=${existing.businessId} ` +
              `currentBusinessId=${currentBusinessId} ` +
              `accountId=${savedAccountId} ` +
              `owner=${ownerAccount?.businessName ?? 'unknown'}`,
          );
          skippedOtherAccount.push({
            id: leadId,
            businessId: existing.businessId,
            businessName: ownerAccount?.businessName ?? null,
          });
          skipped++;
          continue;
        }
        // Check if anything changed
        const newName = leadNames?.[leadId];
        const newCategory = leadCategories?.[leadId];
        const newStatusRaw = leadStatuses?.[leadId];
        // Translate Yelp's vocabulary into LB canonical pipeline values. Raw
        // Yelp text is preserved on Lead.platformStatus regardless. Unknown
        // values return null and skip the Lead.status write.
        const newStatus = mapYelpToLbStatus(newStatusRaw);
        const newLocation = leadLocations?.[leadId];

        const nameChanged = newName && existing.customerName !== newName && (existing.customerName === 'Unknown' || newName !== 'Unknown');
        const statusChanged = newStatus !== null && existing.status !== newStatus;
        const platformStatusChanged = newStatusRaw && existing.platformStatus !== newStatusRaw;
        const categoryChanged = newCategory && existing.category !== newCategory && !existing.category;
        const locationChanged = newLocation && !existing.city;

        if (nameChanged || statusChanged || categoryChanged || locationChanged || platformStatusChanged) {
          // Non-status updates go in a direct write.
          const nonStatusUpdates: any = {};
          if (nameChanged) nonStatusUpdates.customerName = newName;
          if (categoryChanged) nonStatusUpdates.category = newCategory;
          if (locationChanged) {
            nonStatusUpdates.city = newLocation.split(',')[0]?.trim();
            nonStatusUpdates.state = newLocation.split(',')[1]?.trim()?.split(' ')[0];
            nonStatusUpdates.postcode = newLocation.match(/\d{5}/)?.[0];
          }
          if (Object.keys(nonStatusUpdates).length > 0) {
            await this.prisma.lead.update({ where: { id: existing.id }, data: nonStatusUpdates });
          }

          // Single writeStatus call carries both the raw platformStatus and
          // the mapped canonical newStatus. LeadStatusService.applyPlatformSync
          // is the authoritative gate: it enforces SF_STATUS_WINS, the
          // pipeline-downgrade guard, the completed-lock, and dedup. The
          // returned skipReason tells us which (if any) guard fired so we can
          // log it greppably.
          let writeResult: WriteStatusResult | null = null;
          if (platformStatusChanged || statusChanged) {
            writeResult = await this.leadStatusService.writeStatus({
              leadId: existing.id,
              source: 'platform_sync',
              platformStatus: platformStatusChanged ? newStatusRaw : undefined,
              newStatus: statusChanged ? newStatus : undefined,
              actorType: 'extension',
              sourceEventId: `yelp_scrape_${Date.now()}`,
            });
          }

          // Also update conversation name if changed
          if (nameChanged && existing.threadId) {
            await this.prisma.conversation.update({
              where: { id: existing.threadId },
              data: { customerName: newName },
            }).catch(() => {});
          }

          // Trigger engagement-aware re-evaluation when the platform signal
          // is one we care about (Not hired / Archived / Hired / Active).
          // Only fire on transitions — skip no-op.
          if (platformStatusChanged && existing.threadId && this.followUpEngine) {
            const signal = newStatusRaw || '';
            const relevant = /^(not hired|archived|hired|active)$/i.test(signal);
            if (relevant) {
              this.followUpEngine.handlePlatformSignal(existing.threadId, signal)
                .then(action => {
                  if (action !== 'no_change' && action !== 'no_enrollment') {
                    this.logger.log(`[Yelp Import] Platform signal "${signal}" on lead ${leadId} → ${action}`);
                  }
                })
                .catch(err => this.logger.warn(`[Yelp Import] handlePlatformSignal failed: ${err.message}`));
            }
          }

          imported++;
          const touched: string[] = [];
          if (Object.keys(nonStatusUpdates).length > 0) touched.push(...Object.keys(nonStatusUpdates));
          if (writeResult?.platformStatus === newStatusRaw && platformStatusChanged) touched.push('platformStatus');
          if (writeResult?.status === newStatus && statusChanged) touched.push('status');
          const reason = writeResult?.skipReason;
          this.logger.log(
            `[Yelp Import] Updated lead ${leadId}: ${touched.join(', ') || '(no fields written)'}${reason ? ` skipReason=${reason}` : ''}`,
          );
        } else {
          skipped++;
        }
        continue;
      }

      // Fetch lead details from Yelp API
      try {
        const leadData = await yelpAdapter.getLead({ accessToken: creds.accessToken }, leadId);

        // Create conversation
        const conversation = await this.prisma.conversation.upsert({
          where: { platform_externalThreadId: { platform: 'yelp', externalThreadId: leadId } },
          create: {
            userId: user.id,
            platform: 'yelp',
            externalThreadId: leadId,
            customerName: leadData.customerName || leadNames?.[leadId] || 'Unknown',
            lastMessageAt: leadData.createdAt || new Date(),
            status: 'active',
          },
          update: { lastMessageAt: new Date() },
        });

        // Create lead with the canonical default 'new'. The scraped raw status
        // (if any) flows through LeadStatusService.writeStatus below — that's
        // the single write path that produces an audit row, applies the
        // SF_STATUS_WINS guard, and canonicalizes via mapYelpToLbStatus.
        // leadData.status from the adapter is intentionally ignored here: it
        // can be a raw Yelp value ('Active', 'Hired', etc.) and writing it
        // directly would bypass the canonical pipeline.
        const created = await this.prisma.lead.create({
          data: {
            userId: user.id,
            platform: 'yelp',
            businessId: businessId || account.businessId,
            externalRequestId: leadId,
            threadId: conversation.id,
            customerName: leadData.customerName || leadNames?.[leadId] || 'Unknown',
            customerPhone: leadData.customerPhone,
            customerEmail: leadData.customerEmail,
            message: leadData.message,
            city: leadData.city,
            state: leadData.state,
            postcode: leadData.postcode,
            category: leadData.category || leadCategories?.[leadId],
            status: 'new',
            rawJson: JSON.stringify(leadData.raw || {}),
          },
        });

        // Persist the scraped status (preferred) or the adapter status through
        // the canonical write path. Unknown raw values resolve to undefined
        // canonical, so applyPlatformSync writes only platformStatus —
        // Lead.status stays on schema default 'new'.
        const rawForCreate = leadStatuses?.[leadId] ?? leadData.status;
        if (rawForCreate) {
          await this.applyScrapedStatusToCreatedLead(created.id, leadId, rawForCreate);
        }

        imported++;
        this.logger.log(`[Yelp Import] Imported lead ${leadId}: ${leadData.customerName}`);
      } catch (err: any) {
        const status = err.response?.status ?? (err.message?.match(/\b(\d{3})\b/)?.[1]
          ? Number(err.message.match(/\b(\d{3})\b/)[1])
          : undefined);

        // 403 means the Yelp token is valid but doesn't have access to this
        // specific lead — typically because the lead belongs to a Yelp
        // business connected under a different SavedAccount. Don't fall
        // through to the fallback-create path: we don't own this lead and
        // creating a row from the scraped metadata would re-attribute it
        // to the wrong account. Skip and surface as wrongScope, no retry.
        if (status === 403) {
          this.logger.warn(
            `[Yelp Import] wrong_scope leadId=${leadId} accountId=${savedAccountId} ` +
              `businessId=${currentBusinessId} status=403 message=${err.message ?? 'none'}`,
          );
          skippedWrongScope.push({
            id: leadId,
            message: 'This lead belongs to a different connected Yelp account.',
          });
          skipped++;
          continue;
        }

        // If API fails, create minimal lead from scraped metadata
        const is401 = status === 401 || err.message?.includes('401');
        if (is401) {
          this.logger.warn(`[Yelp Import] 401 for lead ${leadId} — creating from scraped data`);
        } else {
          this.logger.warn(`[Yelp Import] Failed to fetch lead ${leadId}: ${err.message} — creating from scraped data`);
        }

        try {
          const scrapedName = leadNames?.[leadId] || 'Unknown';
          const conversation = await this.prisma.conversation.upsert({
            where: { platform_externalThreadId: { platform: 'yelp', externalThreadId: leadId } },
            create: {
              userId: user.id,
              platform: 'yelp',
              externalThreadId: leadId,
              customerName: scrapedName,
              lastMessageAt: new Date(),
              status: 'active',
            },
            update: { customerName: scrapedName !== 'Unknown' ? scrapedName : undefined },
          });

          // Same canonical-default + writeStatus pattern as the API-success
          // path. Previous code wrote leadStatuses[leadId].toLowerCase()
          // directly into Lead.status which produced non-canonical raw values
          // ('active' / 'done' / etc.) bypassing audit + SF guard.
          const created = await this.prisma.lead.create({
            data: {
              userId: user.id,
              platform: 'yelp',
              businessId: businessId || account.businessId,
              externalRequestId: leadId,
              threadId: conversation.id,
              customerName: leadNames?.[leadId] || 'Unknown',
              message: '',
              category: leadCategories?.[leadId],
              city: leadLocations?.[leadId]?.split(',')[0]?.trim(),
              state: leadLocations?.[leadId]?.split(',')[1]?.trim()?.split(' ')[0],
              postcode: leadLocations?.[leadId]?.match(/\d{5}/)?.[0],
              status: 'new',
              rawJson: JSON.stringify({ scraped: true, source: 'extension', location: leadLocations?.[leadId], date: leadDates?.[leadId] }),
            },
          });

          const rawForFallback = leadStatuses?.[leadId];
          if (rawForFallback) {
            await this.applyScrapedStatusToCreatedLead(created.id, leadId, rawForFallback);
          }
          imported++;
        } catch (createErr: any) {
          failed++;
          this.logger.error(`[Yelp Import] Failed to create lead ${leadId}: ${createErr.message}`);
        }
      }
    }

    this.logger.log(
      `[Yelp Import] Done: ${imported} imported, ${skipped} skipped ` +
        `(otherAccount=${skippedOtherAccount.length} wrongScope=${skippedWrongScope.length}), ${failed} failed`,
    );
    // Top-level `skipped` stays a number for backwards compatibility with
    // existing extension consumers; `skippedDetails` carries the structured
    // breakdown so the operator UI can render "X already in <other account>"
    // / "Y belong to a different connected Yelp account" partial-success
    // messages instead of an opaque skipped count.
    return {
      ok: true,
      imported,
      skipped,
      skippedDetails: {
        otherAccount: skippedOtherAccount,
        wrongScope: skippedWrongScope,
      },
      failed,
      total: leadIds.length,
    };
  }

  /**
   * Persist a scraped Yelp status onto a freshly-created lead through the
   * canonical write path. Always writes platformStatus; only writes
   * Lead.status when mapYelpToLbStatus returns a known canonical value.
   * applyPlatformSync owns the SF_STATUS_WINS / completed-lock / pipeline-
   * downgrade guards and produces a LeadStatusAuditLog row. Failures here
   * never bubble up — the lead row was already created, so we degrade
   * gracefully rather than fail the whole import.
   */
  private async applyScrapedStatusToCreatedLead(
    leadPk: string,
    yelpLeadId: string,
    rawStatus: string,
  ): Promise<void> {
    const trimmed = rawStatus.trim();
    if (!trimmed) return;
    const canonical = mapYelpToLbStatus(trimmed);
    const sourceEventId = `yelp_scrape_create_${yelpLeadId}_${trimmed.toLowerCase().replace(/\s+/g, '_')}`;
    try {
      await this.leadStatusService.writeStatus({
        leadId: leadPk,
        source: 'platform_sync',
        newStatus: canonical ?? undefined,
        platformStatus: trimmed,
        actorType: 'extension',
        sourceEventId,
      });
    } catch (err: any) {
      this.logger.warn(
        `[Yelp Import] applyScrapedStatusToCreatedLead failed lead=${leadPk} yelpId=${yelpLeadId} raw="${trimmed}": ${err?.message ?? err}`,
      );
    }
  }

  /**
   * GET /v1/integrations/yelp/leads
   * Get existing Yelp leads for comparison (used by extension to detect new vs existing).
   */
  @Get('leads')
  async getLeads(
    @CurrentUser() user: any,
    @Query('accountId') accountId?: string,
  ) {
    const where: any = { userId: user.id, platform: 'yelp' };
    if (accountId) {
      const account = await this.prisma.savedAccount.findFirst({
        where: { id: accountId, userId: user.id },
        select: { businessId: true },
      });
      if (account) where.businessId = account.businessId;
    }

    const leads = await this.prisma.lead.findMany({
      where,
      select: { id: true, externalRequestId: true, customerName: true, status: true },
      orderBy: { createdAt: 'desc' },
    });

    return {
      ok: true,
      leads: leads.map(l => ({
        yelpLeadId: l.externalRequestId,
        name: l.customerName,
        status: l.status,
      })),
    };
  }
}
