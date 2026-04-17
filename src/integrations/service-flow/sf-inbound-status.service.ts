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
}

const SIGNATURE_SKEW_SECONDS = 300;

@Injectable()
export class SfInboundStatusService {
  private readonly logger = new Logger(SfInboundStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => FollowUpEngineService))
    private readonly followUpEngine: FollowUpEngineService,
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
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'missing headers' };
    }

    // Timestamp drift check
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) {
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'invalid timestamp' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > SIGNATURE_SKEW_SECONDS) {
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'timestamp drift' };
    }

    const subscription = await this.prisma.crmWebhookSubscription.findUnique({
      where: { id: subId },
    });
    if (!subscription || !subscription.isActive || subscription.direction !== 'inbound') {
      return { httpStatus: 404, result: 'noop', eventId: 'n/a', error: 'subscription not found' };
    }

    const expected = this.sign(ts, rawBody, subscription.secret);
    // Normalize the caller's signature: accept both `sha256=<hex>` and raw hex.
    const receivedHex = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (!this.timingSafeEqual(expected, receivedHex)) {
      // Log but don't expose details in response
      this.logger.warn(`[SfInbound] Signature mismatch for subscription ${subId}`);
      await this.recordEvent({
        eventId: 'unauth_' + crypto.randomUUID(),
        eventType: 'unknown',
        occurredAt: new Date(),
        status: 'unauthorized',
        result: 'signature_mismatch',
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
      return { httpStatus: 400, result: 'noop', eventId: 'n/a', error: 'invalid json' };
    }

    const missing = this.validatePayload(payload);
    if (missing) {
      return { httpStatus: 400, result: 'noop', eventId: payload?.event_id || 'n/a', error: `missing ${missing}` };
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
      return { httpStatus: 200, result: 'deferred', eventId: payload.event_id, leadId: null };
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
      return { httpStatus: 200, result: 'stale', eventId: payload.event_id, leadId: lead.id };
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
        payloadJson: payload,
      });
      return {
        httpStatus: 422,
        result: 'unmapped_status',
        eventId: payload.event_id,
        leadId: lead.id,
        error: `unknown SF status: ${payload.status.new}`,
      };
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
      return { httpStatus: 200, result: 'noop', eventId: payload.event_id, leadId: lead.id };
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
      return { httpStatus: 200, result: 'dry_run', eventId: payload.event_id, leadId: lead.id };
    }

    // ------------------------ Transactional write ------------------------
    const oldStatus = lead.status;

    const updateResult = await this.prisma.lead.updateMany({
      where: {
        id: lead.id,
        // Guard against out-of-order writes: only apply if newer than
        // the last write OR if last write was also SF.
        OR: [
          { statusUpdatedAt: null },
          { statusUpdatedAt: { lt: occurredAt } },
          { statusSource: 'service_flow' },
        ],
      },
      data: {
        status: canonical,
        sfJobId: lead.sfJobId || payload.sf_job_id,
        sfJobMappedAt: lead.sfJobMappedAt || new Date(),
        statusSource: 'service_flow',
        statusUpdatedAt: occurredAt,
        sfLastEventAt: occurredAt,
      },
    });

    if (updateResult.count === 0) {
      // Another writer beat us with a newer timestamp
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        leadId: lead.id,
        userId: subscription.userId,
        sfSubscriptionId: subscription.id,
        status: 'stale',
        result: 'lost_race_to_newer_write',
        payloadJson: payload,
      });
      return { httpStatus: 200, result: 'stale', eventId: payload.event_id, leadId: lead.id };
    }

    // Audit log
    await this.prisma.leadStatusAuditLog.create({
      data: {
        leadId: lead.id,
        oldStatus,
        newStatus: canonical,
        source: 'service_flow',
        sourceEventId: payload.event_id,
        actorType: payload.actor?.type,
        actorId: payload.actor?.id,
        actorName: payload.actor?.display_name,
        occurredAt,
      },
    });

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
      `[SfInbound] Applied ${oldStatus} → ${canonical} for lead ${lead.id} (sfJob=${payload.sf_job_id})`,
    );

    return { httpStatus: 200, result: 'applied', eventId: payload.event_id, leadId: lead.id };
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
          payloadJson: args.payloadJson ?? {},
          userId: args.userId ?? null,
          leadId: args.leadId ?? null,
          sfJobId: args.sfJobId ?? null,
          sfSubscriptionId: args.sfSubscriptionId ?? null,
        },
      });
    } catch (err: any) {
      this.logger.warn(`[SfInbound] Failed to persist event ${args.eventId}: ${err.message}`);
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
