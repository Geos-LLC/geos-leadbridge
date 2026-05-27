/**
 * Service Flow → LeadBridge inbound status sync.
 *
 * Handles the SF → LB webhook that delivers job.status_changed events.
 * Pipeline: verify HMAC → validate → idempotency → lookup → loop guard →
 * map → compute decision → transactional write → follow-up reaction.
 *
 * See plans/2026-04-17-job-sync-sf-lb.md §5.
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { FollowUpEngineService } from '../../follow-up-engine/follow-up-engine.service';
import { LeadStatusService } from '../../leads/lead-status.service';
import {
  LbPipelineStatus,
  mapSfStatus,
  isSfTerminal,
} from './sf-status-map';

/** Shape of the payload SF POSTs to LB. See §4.2 of the plan. */
export interface SfJobStatusPayload {
  event_id: string;
  event_type: string;
  occurred_at: string;
  source: string;
  source_instance?: string;
  sf_job_id: string;
  sf_user_id?: string;
  external_request_id?: string;
  channel?: string;
  sf_lead_id?: string;
  status: {
    new: string;
    previous?: string;
    canonical?: string;
  };
  actor?: {
    type?: string;
    id?: string;
    display_name?: string;
  };
  job?: Record<string, any>;
  raw?: any;
}

export type ProcessResult =
  | 'applied'
  | 'noop'
  | 'deferred'
  | 'stale'
  | 'unmapped_status'
  | 'unauthorized'
  | 'dry_run';

export interface ProcessOutcome {
  httpStatus: 200 | 400 | 401 | 404 | 409 | 422;
  result: ProcessResult;
  eventId: string;
  leadId?: string | null;
  error?: string;
  /**
   * Enrichment fields for SF's lifecycle_drift classifier. Populated whenever
   * the lead is known (i.e. lookup hit, not deferred). Optional everywhere so
   * old callers + auth-failure paths stay untouched.
   *
   *  - skipReason:           guard name when the write was rejected
   *                          ('hard_terminal' | 'stale_event' | 'duplicate' |
   *                           'pipeline_downgrade' | 'status_unchanged' |
   *                           'older_than_last_sf_event' | 'unmapped_status' | ...)
   *  - currentStatus:        Lead.status as LB sees it right now
   *  - currentPlatformStatus: Lead.platformStatus (or thumbtackStatus fallback)
   *  - sfJobId:              from the lead row when linked, else echo payload
   *  - externalRequestId:    canonical marketplace lead id
   *  - platform:             marketplace channel (thumbtack/yelp/...)
   */
  skipReason?: string | null;
  currentStatus?: string | null;
  currentPlatformStatus?: string | null;
  sfJobId?: string | null;
  externalRequestId?: string | null;
  platform?: string | null;
}

const SIGNATURE_SKEW_SECONDS = 300;

/**
 * Build the lead-context enrichment object for a ProcessOutcome. Pulled out so
 * every return statement that has a lead row produces the same shape — SF's
 * lifecycle_drift classifier reads `skipReason` + `currentStatus` directly
 * from these fields.
 *
 * `currentPlatformStatus` falls back to the legacy `thumbtackStatus` column for
 * TT leads whose platformStatus hasn't been backfilled yet, matching the
 * canonical resolution `LeadStatusService.applyPlatformSync` uses.
 */
interface LeadEnrichmentSource {
  status: string;
  platformStatus: string | null;
  thumbtackStatus: string | null;
  sfJobId: string | null;
  externalRequestId: string;
  platform: string;
}

export interface LeadEnrichment {
  skipReason: string | null;
  currentStatus: string;
  currentPlatformStatus: string | null;
  sfJobId: string | null;
  externalRequestId: string;
  platform: string;
}

function leadEnrichment(
  lead: LeadEnrichmentSource,
  payload: { sf_job_id?: string | null },
  skipReason: string | null,
): LeadEnrichment {
  return {
    skipReason,
    currentStatus: lead.status,
    currentPlatformStatus: lead.platformStatus ?? lead.thumbtackStatus ?? null,
    sfJobId: lead.sfJobId ?? payload.sf_job_id ?? null,
    externalRequestId: lead.externalRequestId,
    platform: lead.platform,
  };
}

@Injectable()
export class SfInboundStatusService {
  private readonly logger = new Logger(SfInboundStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => FollowUpEngineService))
    private readonly followUpEngine: FollowUpEngineService,
    @Inject(forwardRef(() => LeadStatusService))
    private readonly leadStatus: LeadStatusService,
  ) {}

  /**
   * Master entry point: validates headers/signature, routes through the full
   * pipeline, and returns the HTTP status the controller should send.
   */
  async ingest(
    rawBody: string,
    headers: {
      signature?: string | string[];
      timestamp?: string | string[];
      subscriptionId?: string | string[];
    },
  ): Promise<ProcessOutcome> {
    const enabled = this.config.get<string>('SF_INBOUND_WEBHOOK_ENABLED', 'false') === 'true';
    if (!enabled) {
      return { httpStatus: 400, result: 'noop', eventId: 'n/a', error: 'SF inbound disabled' };
    }

    // ------------------------ HMAC verification ------------------------
    const subId = this.pickHeader(headers.subscriptionId);
    const sig = this.pickHeader(headers.signature);
    const ts = this.pickHeader(headers.timestamp);

    if (!subId || !sig || !ts) {
      this.logger.warn(`[SfInbound] event_id=null lead_id=null result=unauthorized error=missing_headers`);
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'missing headers' };
    }

    // Timestamp drift check
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) {
      this.logger.warn(`[SfInbound] event_id=null lead_id=null result=unauthorized error=invalid_timestamp`);
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'invalid timestamp' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > SIGNATURE_SKEW_SECONDS) {
      this.logger.warn(`[SfInbound] event_id=null lead_id=null result=unauthorized error=timestamp_drift`);
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'timestamp drift' };
    }

    const subscription = await this.prisma.crmWebhookSubscription.findUnique({
      where: { id: subId },
    });
    if (!subscription || !subscription.isActive || subscription.direction !== 'inbound') {
      this.logger.warn(`[SfInbound] event_id=null lead_id=null result=noop error=subscription_not_found sub_id=${subId}`);
      return { httpStatus: 404, result: 'noop', eventId: 'n/a', error: 'subscription not found' };
    }

    const expected = this.sign(ts, rawBody, subscription.secret);
    // Normalize the caller's signature: accept both `sha256=<hex>` and raw hex.
    const receivedHex = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (!this.timingSafeEqual(expected, receivedHex)) {
      const unauthEventId = 'unauth_' + crypto.randomUUID();
      this.logger.warn(`[SfInbound] event_id=${unauthEventId} lead_id=null result=unauthorized error=signature_mismatch sub_id=${subId}`);
      await this.recordEvent({
        eventId: unauthEventId,
        eventType: 'unknown',
        occurredAt: new Date(),
        status: 'unauthorized',
        result: 'signature_mismatch',
        processingError: 'signature_mismatch',
        payloadJson: { rawBodyLength: rawBody.length, subscriptionId: subId },
        userId: subscription.userId,
      });
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a' };
    }

    // ------------------------ Payload parse + validate ------------------------
    let payload: SfJobStatusPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      this.logger.warn(`[SfInbound] event_id=null lead_id=null result=noop error=invalid_json sub_id=${subId}`);
      return { httpStatus: 400, result: 'noop', eventId: 'n/a', error: 'invalid json' };
    }

    const missing = this.validatePayload(payload);
    if (missing) {
      const eventId = payload?.event_id || 'n/a';
      this.logger.warn(`[SfInbound] event_id=${eventId} lead_id=null result=noop error=missing_${missing}`);
      // Persist a row so the failure is queryable, not just log-only.
      if (payload?.event_id) {
        await this.recordEvent({
          eventId: payload.event_id,
          eventType: payload.event_type || 'unknown',
          occurredAt: payload.occurred_at ? new Date(payload.occurred_at) : new Date(),
          sfJobId: payload.sf_job_id,
          sfSubscriptionId: subscription.id,
          userId: subscription.userId,
          status: 'noop',
          result: `validation_failed:${missing}`,
          processingError: `missing_${missing}`,
          payloadJson: payload,
        });
      }
      return { httpStatus: 400, result: 'noop', eventId, error: `missing ${missing}` };
    }

    // ------------------------ Idempotency ------------------------
    const existing = await this.prisma.sfInboundEvent.findUnique({
      where: { eventId: payload.event_id },
    });
    if (existing) {
      return {
        httpStatus: 409,
        result: existing.status as ProcessResult,
        eventId: payload.event_id,
        leadId: existing.leadId,
      };
    }

    // Update subscription lastEventAt (best effort)
    this.prisma.crmWebhookSubscription
      .update({ where: { id: subId }, data: { lastEventAt: new Date() } })
      .catch(() => {});

    return this.process(payload, subscription);
  }

  /**
   * Core pipeline once the payload is validated + authenticated.
   * Exposed so tests can exercise it without crafting an HMAC signature.
   */
  async process(payload: SfJobStatusPayload, subscription: { id: string; userId: string }): Promise<ProcessOutcome> {
    const occurredAt = new Date(payload.occurred_at);
    const dryRun = this.config.get<string>('SF_INBOUND_WEBHOOK_DRY_RUN', 'true') === 'true';

    // ------------------------ Lookup lead ------------------------
    let lead = await this.prisma.lead.findFirst({
      where: { sfJobId: payload.sf_job_id, userId: subscription.userId },
    });

    if (!lead && payload.external_request_id && payload.channel) {
      lead = await this.prisma.lead.findFirst({
        where: {
          userId: subscription.userId,
          platform: payload.channel,
          externalRequestId: payload.external_request_id,
        },
      });
    }

    if (!lead) {
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        sfSubscriptionId: subscription.id,
        userId: subscription.userId,
        status: 'deferred',
        result: 'lead_not_found',
        payloadJson: payload,
      });
      this.logger.log(`[SfInbound] event_id=${payload.event_id} lead_id=null result=deferred error=lead_not_found sf_job_id=${payload.sf_job_id}`);
      // No lead → can't surface currentStatus/currentPlatformStatus, but we can
      // echo the payload-side identifiers so SF doesn't have to re-derive them.
      return {
        httpStatus: 200,
        result: 'deferred',
        eventId: payload.event_id,
        leadId: null,
        skipReason: 'lead_not_found',
        sfJobId: payload.sf_job_id ?? null,
        externalRequestId: payload.external_request_id ?? null,
        platform: payload.channel ?? null,
      };
    }

    // ------------------------ Loop guard ------------------------
    // If this lead's last write was already from SF and this event is
    // older than what we've already recorded, skip.
    if (
      lead.statusSource === 'service_flow' &&
      lead.sfLastEventAt &&
      occurredAt <= lead.sfLastEventAt
    ) {
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: 'stale',
        result: 'older_than_last_sf_event',
        payloadJson: payload,
      });
      this.logger.log(`[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=stale error=older_than_last_sf_event`);
      return {
        httpStatus: 200,
        result: 'stale',
        eventId: payload.event_id,
        leadId: lead.id,
        ...leadEnrichment(lead, payload, 'older_than_last_sf_event'),
      };
    }

    // ------------------------ Map status ------------------------
    const canonical = mapSfStatus(payload.status.canonical || payload.status.new);
    if (!canonical) {
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: 'unmapped_status',
        result: `unknown_sf_status:${payload.status.new}`,
        processingError: `unmapped_status:${payload.status.new}`,
        payloadJson: payload,
      });
      this.logger.warn(`[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=unmapped_status error=unknown_sf_status:${payload.status.new}`);
      return {
        httpStatus: 422,
        result: 'unmapped_status',
        eventId: payload.event_id,
        leadId: lead.id,
        error: `unknown SF status: ${payload.status.new}`,
        ...leadEnrichment(lead, payload, 'unmapped_status'),
      };
    }

    // ─── Phase 1: SF operational lifecycle mirror ──────────────────────
    // Always tracks SF's most recent view, independent of whether the LB
    // canonical status write succeeds (carve-out, dedup, downgrade guards
    // may all block that). Stale-protected by occurredAt comparison so an
    // out-of-order replay won't overwrite a newer value.
    //
    // This is intentionally a SEPARATE write from the canonical Lead.status
    // path. SF owns operational lifecycle; LB's acquisition pipeline is a
    // distinct domain. Phase 5 will stop writing Lead.status from this path
    // entirely; sfJobOutcome is the migration target.
    try {
      const sfWriteResult = await this.prisma.lead.updateMany({
        where: {
          id: lead.id,
          OR: [
            { sfJobOutcomeAt: null },
            { sfJobOutcomeAt: { lt: occurredAt } },
          ],
        },
        data: { sfJobOutcome: canonical, sfJobOutcomeAt: occurredAt },
      });
      if (sfWriteResult.count > 0) {
        this.logger.log(
          `[ConversationRuntime] event=sf_job_outcome_write lead_id=${lead.id} new_outcome=${canonical} sf_job_id=${payload.sf_job_id} source_event_id=${payload.event_id} user_id=${subscription.userId}`,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `[SfInbound] sfJobOutcome write failed lead_id=${lead.id} err=${e?.message ?? e}`,
      );
    }

    // ------------------------ No-op detection ------------------------
    if (canonical === lead.status && lead.sfJobId === payload.sf_job_id) {
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: 'noop',
        result: 'status_unchanged',
        payloadJson: payload,
      });
      this.logger.log(`[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=noop error=null`);
      return {
        httpStatus: 200,
        result: 'noop',
        eventId: payload.event_id,
        leadId: lead.id,
        ...leadEnrichment(lead, payload, 'status_unchanged'),
      };
    }

    // ------------------------ Dry-run check ------------------------
    if (dryRun) {
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: 'dry_run',
        result: `would_apply:${canonical}`,
        payloadJson: payload,
      });
      this.logger.log(`[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=dry_run error=null would_apply=${canonical}`);
      return {
        httpStatus: 200,
        result: 'dry_run',
        eventId: payload.event_id,
        leadId: lead.id,
        ...leadEnrichment(lead, payload, null),
      };
    }

    // ------------------------ Transactional write via LeadStatusService ----
    // LeadStatusService.writeStatus is the single write path for Lead.status.
    // It handles canonical validation, terminal/downgrade guards, dedup by
    // (source, sourceEventId), out-of-order rejection (statusUpdatedAt), and
    // emits the audit log row. extraLeadUpdates carries the SF-only columns
    // we still need to set (sfJobId, sfJobMappedAt, sfLastEventAt) inside
    // the same transaction.
    const oldStatus = lead.status;
    const writeResult = await this.leadStatus.writeStatus({
      leadId: lead.id,
      newStatus: canonical,
      source: 'service_flow',
      occurredAt,
      sourceEventId: payload.event_id,
      actorType: payload.actor?.type ?? null,
      actorId: payload.actor?.id ?? null,
      actorName: payload.actor?.display_name ?? null,
      extraLeadUpdates: {
        sfJobId: lead.sfJobId || payload.sf_job_id,
        sfJobMappedAt: lead.sfJobMappedAt || new Date(),
        sfLastEventAt: occurredAt,
      },
    });

    if (!writeResult.applied) {
      // The guard chain rejected the write. Map the skip reason to our
      // outbound contract: stale_event/duplicate → 'stale' (200, idempotent);
      // anything else → 'noop'.
      const skip = writeResult.skipReason;
      const result: ProcessResult =
        skip === 'stale_event' || skip === 'duplicate' ? 'stale' : 'noop';
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: result,
        result: `lead_status_skip:${skip ?? 'unknown'}`,
        payloadJson: payload,
      });
      this.logger.log(`[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=${result} error=lead_status_skip:${skip ?? 'unknown'}`);
      // Use writeResult.{status,platformStatus} for currentStatus/currentPlatformStatus —
      // those are the freshly-read values from inside writeStatus's transaction
      // (writeStatus.skipped() returns the lead snapshot it read). lead.* could
      // be microseconds stale if another tx raced.
      return {
        httpStatus: 200,
        result,
        eventId: payload.event_id,
        leadId: lead.id,
        ...leadEnrichment(
          {
            ...lead,
            status: writeResult.status,
            platformStatus: writeResult.platformStatus,
          },
          payload,
          skip ?? 'unknown',
        ),
      };
    }

    // Inbound event record (applied)
    await this.recordEvent({
      eventId: payload.event_id,
      eventType: payload.event_type,
      occurredAt,
      sfJobId: payload.sf_job_id,
      leadId: lead.id,
      userId: subscription.userId,
      sfSubscriptionId: subscription.id,
      status: 'applied',
      result: `${oldStatus}→${canonical}`,
      payloadJson: payload,
    });

    // ------------------------ Follow-up reaction ------------------------
    if (isSfTerminal(canonical) && lead.threadId) {
      await this.stopEnrollmentsForConversation(lead.threadId, `sf_status_${canonical}`);
    } else if (canonical === 'no_show' && lead.threadId) {
      // no_show → switch to long-term mode rather than stop
      await this.switchActiveEnrollmentToLongTerm(lead.threadId, 'sf_no_show');
    }

    this.logger.log(
      `[SfInbound] event_id=${payload.event_id} lead_id=${lead.id} result=applied error=null status=${canonical} old_status=${oldStatus} sf_job_id=${payload.sf_job_id}`,
    );

    // Use the freshly-written canonical status. writeResult.platformStatus is
    // unchanged for source='service_flow' (applyPlatformSync isn't called).
    return {
      httpStatus: 200,
      result: 'applied',
      eventId: payload.event_id,
      leadId: lead.id,
      ...leadEnrichment(
        {
          ...lead,
          status: writeResult.status,
          platformStatus: writeResult.platformStatus,
          sfJobId: lead.sfJobId ?? payload.sf_job_id,
        },
        payload,
        null,
      ),
    };
  }

  // ──────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────

  private validatePayload(p: any): string | null {
    if (!p || typeof p !== 'object') return 'payload';
    if (!p.event_id) return 'event_id';
    if (!p.event_type) return 'event_type';
    if (!p.occurred_at) return 'occurred_at';
    if (!p.sf_job_id) return 'sf_job_id';
    if (!p.status || !p.status.new) return 'status.new';
    return null;
  }

  private pickHeader(h: string | string[] | undefined): string | undefined {
    if (Array.isArray(h)) return h[0];
    return h;
  }

  private sign(timestamp: string, body: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  private async recordEvent(args: {
    eventId: string;
    eventType: string;
    occurredAt: Date;
    status: ProcessResult | 'unauthorized';
    result?: string | null;
    /** Populated when ingest threw, validation failed, signature mismatched,
     *  or status was unmappable. Surfaces in /v1/integrations/health. */
    processingError?: string | null;
    payloadJson: any;
    userId?: string | null;
    leadId?: string | null;
    sfJobId?: string | null;
    sfSubscriptionId?: string | null;
  }): Promise<void> {
    try {
      await this.prisma.sfInboundEvent.create({
        data: {
          eventId: args.eventId,
          eventType: args.eventType,
          occurredAt: args.occurredAt,
          status: args.status,
          result: args.result ?? null,
          processingError: args.processingError ?? null,
          payloadJson: args.payloadJson ?? {},
          userId: args.userId ?? null,
          leadId: args.leadId ?? null,
          sfJobId: args.sfJobId ?? null,
          sfSubscriptionId: args.sfSubscriptionId ?? null,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `[SfInbound] event_id=${args.eventId} lead_id=${args.leadId ?? 'null'} result=persist_failed error=${(err?.message ?? 'unknown').replace(/\s+/g, ' ').slice(0, 200)}`,
      );
    }
  }

  private async stopEnrollmentsForConversation(conversationId: string, reason: string): Promise<void> {
    const active = await this.prisma.followUpEnrollment.findMany({
      where: { conversationId, status: 'active' },
      select: { id: true },
    });
    for (const e of active) {
      try {
        await this.followUpEngine.stopEnrollment(e.id, reason);
      } catch (err: any) {
        this.logger.warn(`[SfInbound] Failed to stop enrollment ${e.id}: ${err.message}`);
      }
    }
  }

  private async switchActiveEnrollmentToLongTerm(conversationId: string, reason: string): Promise<void> {
    const active = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      select: { id: true },
    });
    if (!active) return;
    try {
      await this.followUpEngine.switchToLongTermMode(active.id, reason);
    } catch (err: any) {
      this.logger.warn(`[SfInbound] Failed to switch ${active.id} to long-term: ${err.message}`);
    }
  }

  /**
   * Engagement check — delegates to engine, exposed for testing.
   */
  async isEngaged(conversationId: string): Promise<boolean> {
    return this.followUpEngine.isEngaged(conversationId);
  }
}
