/**
 * SfOrchestrationEventService — Phase 2B PR-B2.
 *
 * Inbound handler for SF orchestration-lifecycle events. Mirrors the
 * HMAC + idempotency contract of SfInboundStatusService but routes to
 * BookingOrchestratorService.handleServiceOutcomeEvent — which writes
 * sfJobOutcome, bookingState, aiStatus, conversationState (and never
 * Lead.status).
 *
 * Endpoint contract:
 *   POST /v1/integrations/service-flow/orchestration-event
 *   Headers:
 *     X-SF-Subscription-Id  (reuses existing CrmWebhookSubscription)
 *     X-SF-Timestamp         (unix seconds, ±300s skew window)
 *     X-SF-Signature         (sha256 HMAC of `${ts}.${rawBody}` — `sha256=` prefix optional)
 *   Body:
 *     {
 *       event_id:           string                      // unique per event
 *       event_type:         "service_scheduled" | "service_rescheduled"
 *                            | "service_cancelled" | "service_completed"
 *       occurred_at:        ISO-8601 string
 *       sf_job_id:          string
 *       channel?:           "thumbtack" | "yelp" | ...   // optional; used for fallback lead lookup
 *       external_request_id?: string                    // optional; used for fallback lead lookup
 *       scheduled_for?:     ISO-8601 string             // present on service_scheduled / service_rescheduled
 *       rescheduled_slot?:  { slotId, start, end, ... } // present on service_rescheduled
 *       reason?:            string                      // present on service_cancelled
 *       raw?:               object                       // pass-through for forensics
 *     }
 *
 * Three orthogonal gates:
 *   1. SF_ORCHESTRATION_INBOUND_ENABLED env (off by default) — operator
 *      kill-switch independent of the per-tenant canary flag.
 *   2. HMAC signature verification + 300s timestamp skew window.
 *   3. BookingOrchestratorService internally checks
 *      BOOKING_ORCHESTRATION_ENABLED_USER_IDS — events for non-canary
 *      tenants are recorded as processed but produce no runtime mutation.
 *
 * Idempotency: SfInboundEvent unique constraint on eventId. Replay of the
 * same event_id returns 409 with the prior status.
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { BookingOrchestratorService } from '../../booking-orchestrator/booking-orchestrator.service';

const SIGNATURE_SKEW_SECONDS = 300;

const ALLOWED_EVENT_TYPES = [
  'service_scheduled',
  'service_rescheduled',
  'service_cancelled',
  'service_completed',
] as const;
type OrchestrationEventType = (typeof ALLOWED_EVENT_TYPES)[number];

export interface OrchestrationEventPayload {
  event_id: string;
  event_type: OrchestrationEventType;
  occurred_at: string;
  sf_job_id: string;
  channel?: string;
  external_request_id?: string;
  scheduled_for?: string;
  rescheduled_slot?: {
    slotId: string;
    slotToken?: string;
    start: string;
    end: string;
    cleanerId?: string;
  };
  reason?: string;
  raw?: unknown;
}

export interface OrchestrationEventOutcome {
  httpStatus: number;
  result:
    | 'accepted'
    | 'noop'
    | 'unauthorized'
    | 'duplicate'
    | 'deferred'
    | 'validation_failed'
    | 'flag_disabled';
  eventId: string;
  leadId?: string | null;
  error?: string;
}

@Injectable()
export class SfOrchestrationEventService {
  private readonly logger = new Logger(SfOrchestrationEventService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => BookingOrchestratorService))
    private readonly orchestrator: BookingOrchestratorService,
  ) {}

  /**
   * Master entry point: validates headers/signature, dedupes, looks up
   * lead, delegates to BookingOrchestratorService.handleServiceOutcomeEvent.
   *
   * Never throws — converts every failure mode to a typed outcome the
   * controller can pass back as the HTTP response.
   */
  async ingest(
    rawBody: string,
    headers: {
      signature?: string | string[];
      timestamp?: string | string[];
      subscriptionId?: string | string[];
    },
  ): Promise<OrchestrationEventOutcome> {
    const enabled = this.config.get<string>('SF_ORCHESTRATION_INBOUND_ENABLED', 'false') === 'true';
    if (!enabled) {
      // Endpoint kill-switch. Return 400 (not 200) so SF retries don't
      // accumulate while disabled.
      return { httpStatus: 400, result: 'noop', eventId: 'n/a', error: 'SF orchestration inbound disabled' };
    }

    // ─── HMAC verification ────────────────────────────────────────────
    const subId = this.pickHeader(headers.subscriptionId);
    const sig = this.pickHeader(headers.signature);
    const ts = this.pickHeader(headers.timestamp);
    if (!subId || !sig || !ts) {
      this.logger.warn('[SfOrchestrationEvent] event_id=null result=unauthorized error=missing_headers');
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'missing headers' };
    }
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) {
      this.logger.warn('[SfOrchestrationEvent] event_id=null result=unauthorized error=invalid_timestamp');
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'invalid timestamp' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - tsNum) > SIGNATURE_SKEW_SECONDS) {
      this.logger.warn(`[SfOrchestrationEvent] event_id=null result=unauthorized error=timestamp_drift skew=${nowSec - tsNum}`);
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'timestamp drift' };
    }

    const subscription = await this.prisma.crmWebhookSubscription.findUnique({ where: { id: subId } });
    if (!subscription || !subscription.isActive || subscription.direction !== 'inbound') {
      this.logger.warn(`[SfOrchestrationEvent] event_id=null result=noop error=subscription_not_found sub_id=${subId}`);
      return { httpStatus: 404, result: 'noop', eventId: 'n/a', error: 'subscription not found' };
    }

    const expected = this.sign(ts, rawBody, subscription.secret);
    const receivedHex = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (!this.timingSafeEqual(expected, receivedHex)) {
      this.logger.warn(`[SfOrchestrationEvent] event_id=null result=unauthorized error=signature_mismatch sub_id=${subId}`);
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'signature_mismatch' };
    }

    // ─── Parse + validate payload ─────────────────────────────────────
    let payload: OrchestrationEventPayload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      return { httpStatus: 400, result: 'validation_failed', eventId: 'n/a', error: 'invalid json' };
    }
    if (!payload?.event_id || typeof payload.event_id !== 'string') {
      return { httpStatus: 400, result: 'validation_failed', eventId: 'n/a', error: 'missing event_id' };
    }
    if (!payload.event_type || !(ALLOWED_EVENT_TYPES as readonly string[]).includes(payload.event_type)) {
      this.logger.warn(`[SfOrchestrationEvent] event_id=${payload.event_id} result=validation_failed error=unknown_event_type type=${payload.event_type}`);
      return { httpStatus: 400, result: 'validation_failed', eventId: payload.event_id, error: 'unknown event_type' };
    }
    if (!payload.sf_job_id || typeof payload.sf_job_id !== 'string') {
      return { httpStatus: 400, result: 'validation_failed', eventId: payload.event_id, error: 'missing sf_job_id' };
    }
    if (!payload.occurred_at || isNaN(new Date(payload.occurred_at).getTime())) {
      return { httpStatus: 400, result: 'validation_failed', eventId: payload.event_id, error: 'missing or invalid occurred_at' };
    }

    // ─── Idempotency (shared SfInboundEvent table) ────────────────────
    const existing = await this.prisma.sfInboundEvent.findUnique({ where: { eventId: payload.event_id } });
    if (existing) {
      return {
        httpStatus: 409,
        result: 'duplicate',
        eventId: payload.event_id,
        leadId: existing.leadId ?? null,
      };
    }

    // ─── Lookup lead ──────────────────────────────────────────────────
    let lead = await this.prisma.lead.findFirst({
      where: { sfJobId: payload.sf_job_id, userId: subscription.userId },
      select: { id: true, threadId: true, userId: true },
    });
    if (!lead && payload.external_request_id && payload.channel) {
      lead = await this.prisma.lead.findFirst({
        where: {
          userId: subscription.userId,
          platform: payload.channel,
          externalRequestId: payload.external_request_id,
        },
        select: { id: true, threadId: true, userId: true },
      });
    }

    const occurredAt = new Date(payload.occurred_at);
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
      this.logger.log(
        `[SfOrchestrationEvent] event_id=${payload.event_id} lead_id=null result=deferred error=lead_not_found sf_job_id=${payload.sf_job_id}`,
      );
      return { httpStatus: 202, result: 'deferred', eventId: payload.event_id, leadId: null, error: 'lead not found' };
    }

    // ─── Delegate to BookingOrchestratorService ───────────────────────
    try {
      await this.orchestrator.handleServiceOutcomeEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        sfJobId: payload.sf_job_id,
        userId: lead.userId,
        leadId: lead.id,
        conversationId: lead.threadId,
        scheduledFor: payload.scheduled_for ?? null,
        rescheduledSlot: payload.rescheduled_slot
          ? {
              slotId: payload.rescheduled_slot.slotId,
              slotToken: payload.rescheduled_slot.slotToken ?? null,
              start: payload.rescheduled_slot.start,
              end: payload.rescheduled_slot.end,
              cleanerId: payload.rescheduled_slot.cleanerId ?? null,
              providerCost: null,
            }
          : null,
        reason: payload.reason ?? null,
      });

      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        sfSubscriptionId: subscription.id,
        userId: subscription.userId,
        leadId: lead.id,
        status: 'applied',
        result: 'applied',
        payloadJson: payload,
      });

      this.logger.log(
        `[SfOrchestrationEvent] event_id=${payload.event_id} lead_id=${lead.id} user_id=${lead.userId} result=applied event_type=${payload.event_type} sf_job_id=${payload.sf_job_id}`,
      );
      return { httpStatus: 200, result: 'accepted', eventId: payload.event_id, leadId: lead.id };
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).slice(0, 300).replace(/\s+/g, ' ');
      this.logger.error(
        `[SfOrchestrationEvent] event_id=${payload.event_id} lead_id=${lead.id} result=exception error=${msg}`,
      );
      await this.recordEvent({
        eventId: payload.event_id,
        eventType: payload.event_type,
        occurredAt,
        sfJobId: payload.sf_job_id,
        sfSubscriptionId: subscription.id,
        userId: subscription.userId,
        leadId: lead.id,
        status: 'noop',
        result: 'exception',
        processingError: msg,
        payloadJson: payload,
      });
      return { httpStatus: 500, result: 'noop', eventId: payload.event_id, leadId: lead.id, error: msg };
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────

  private async recordEvent(args: {
    eventId: string;
    eventType: string;
    occurredAt: Date;
    sfJobId?: string;
    sfSubscriptionId?: string | null;
    userId?: string;
    leadId?: string;
    status: 'applied' | 'noop' | 'deferred' | 'unauthorized';
    result: string;
    processingError?: string;
    payloadJson: unknown;
  }): Promise<void> {
    try {
      await this.prisma.sfInboundEvent.create({
        data: {
          eventId: args.eventId,
          eventType: args.eventType,
          occurredAt: args.occurredAt,
          sfJobId: args.sfJobId,
          sfSubscriptionId: args.sfSubscriptionId ?? null,
          userId: args.userId,
          leadId: args.leadId,
          status: args.status,
          result: args.result,
          processingError: args.processingError,
          payloadJson: args.payloadJson as any,
        },
      });
    } catch (e: any) {
      // Most likely unique constraint on eventId — a partial record
      // already exists. Don't block the response on persistence.
      this.logger.warn(
        `[SfOrchestrationEvent] event_id=${args.eventId} result=record_failed error=${(e?.message ?? '').slice(0, 200)}`,
      );
    }
  }

  private pickHeader(v: string | string[] | undefined): string | null {
    if (!v) return null;
    if (Array.isArray(v)) return v[0] ?? null;
    return v;
  }

  private sign(timestamp: string, body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }

  private timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }
}
