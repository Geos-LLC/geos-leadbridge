/**
 * SfConnectionWebhookService — Phase 2C PR-C2.1.
 *
 * Single LB inbound endpoint for ALL SF-pushed orchestration events:
 *   - service_scheduled / service_rescheduled / service_cancelled / service_completed
 *   - connection.connected
 *   - credential.rotated
 *   - connection.revoked
 *
 * Canonical SF S4 header set (locked):
 *   X-SF-Signature   — sha256 HMAC hex over `${X-SF-Timestamp}.${rawBody}`
 *                       using the LB-generated webhook signing secret
 *                       (decrypted just-in-time from the subscription row)
 *   X-SF-Timestamp   — unix seconds, ±300s skew window
 *   X-SF-Event-Id    — dedup key (authoritative — header wins over body)
 *   X-SF-Event-Type  — convenience copy of body event_type
 *   X-SF-Tenant-Id   — sf_tenant_id (integer) — drives tenant resolution
 *   X-SF-Kid         — SF signing key id — cross-checked vs stored
 *
 * Note: SF does NOT send X-SF-Subscription-Id in the canonical contract.
 * Tenant resolution flows from X-SF-Tenant-Id → SfConnection (by
 * sfTenantId) → linked CrmWebhookSubscription → decrypted secret.
 *
 * Idempotency: X-SF-Event-Id stored in SfInboundEvent (unique). Re-delivery
 * of an already-applied event returns 200 OK with result='idempotent_replay'
 * — same shape as the original 'accepted' response so SF treats it as a
 * successful ack and breaks the retry loop. Side effects are NOT re-applied.
 * 200 (not 409) because 4xx classifies as failure for SF's retry policy and
 * causes infinite retry escalation / DLQ growth on a legitimate duplicate.
 *
 * Cross-tenant safety:
 *   - SfConnection lookup is keyed on the wire's X-SF-Tenant-Id; an
 *     attacker who got hold of one tenant's secret can't sign events
 *     for a different tenant (the HMAC check uses THAT tenant's secret,
 *     so signature would fail).
 *   - X-SF-Kid is cross-checked against stored signatureKeyId when set.
 *
 * Event dispatch:
 *   - service_* events  → BookingOrchestratorService.handleServiceOutcomeEvent
 *   - connection.connected  → SfConnectionLifecycleService.applyConnectionConnected
 *   - credential.rotated    → SfConnectionLifecycleService.applyCredentialRotated
 *   - connection.revoked    → SfConnectionLifecycleService.applyConnectionRevoked
 *
 * No plaintext secret in logs anywhere — token_kid + token_prefix + length only.
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { BookingOrchestratorService } from '../../booking-orchestrator/booking-orchestrator.service';
import {
  SF_WEBHOOK_EVENT_TYPES,
  type OrchestrationWebhookOutcome,
  type SfConnectionConnectedPayload,
  type SfConnectionRevokedPayload,
  type SfCredentialRotatedPayload,
  type SfServiceEventPayload,
  type SfWebhookEnvelope,
  type SfWebhookEventType,
} from './sf-connection.contracts';

const SIGNATURE_SKEW_SECONDS = 300;

@Injectable()
export class SfConnectionWebhookService {
  private readonly logger = new Logger(SfConnectionWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lifecycle: SfConnectionLifecycleService,
    @Inject(forwardRef(() => BookingOrchestratorService))
    private readonly bookingOrchestrator: BookingOrchestratorService,
  ) {}

  /**
   * Master entry — never throws. Returns a typed outcome the controller
   * forwards as the HTTP response.
   */
  async ingest(
    rawBody: string,
    headers: {
      signature?: string | string[];
      timestamp?: string | string[];
      eventId?: string | string[];
      eventType?: string | string[];
      tenantId?: string | string[];
      kid?: string | string[];
    },
  ): Promise<OrchestrationWebhookOutcome> {
    const sig = this.pickHeader(headers.signature);
    const ts = this.pickHeader(headers.timestamp);
    const eventIdHeader = this.pickHeader(headers.eventId);
    const eventTypeHeader = this.pickHeader(headers.eventType);
    const tenantIdHeader = this.pickHeader(headers.tenantId);
    const kidHeader = this.pickHeader(headers.kid);

    // Pre-parse the tenant header as integer for response surfacing. Best-effort
    // — used only in rejection diagnostics; tenant resolution still uses the
    // string form below.
    const tenantIdHeaderNum = tenantIdHeader != null ? parseInt(tenantIdHeader, 10) : NaN;
    const headerSfTenantId = Number.isFinite(tenantIdHeaderNum) ? tenantIdHeaderNum : null;

    // ── 1. Required headers ─────────────────────────────────────────
    if (!sig || !ts || !eventIdHeader || !tenantIdHeader) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader ?? 'null'} result=unauthorized error=missing_headers ` +
          `sig=${!!sig} ts=${!!ts} eventid=${!!eventIdHeader} tenantid=${!!tenantIdHeader} ` +
          `event_type=${eventTypeHeader ?? 'null'} sf_tenant_id=${tenantIdHeader ?? 'null'}`,
      );
      return {
        httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader ?? 'n/a',
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: headerSfTenantId ?? undefined,
        error: 'missing headers',
      };
    }

    // ── 2. Timestamp skew (±300s) ────────────────────────────────────
    // Source: X-SF-Timestamp header ONLY. Body `occurred_at` is informational
    // (audit / lead correlation) and is never used for freshness validation.
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) {
      return {
        httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader,
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: headerSfTenantId ?? undefined,
        error: 'invalid timestamp',
      };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const drift = nowSec - tsNum;
    if (Math.abs(drift) > SIGNATURE_SKEW_SECONDS) {
      // Diagnostic: include raw header value + raw body sha + secret-id
      // fingerprint so SF can directly correlate what they sent vs what
      // LB received without us logging anything sensitive.
      const bodySha = crypto.createHash('sha256').update(rawBody).digest('hex').slice(0, 16);
      const bodyLen = Buffer.byteLength(rawBody, 'utf8');
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=replay_rejected error=timestamp_drift ` +
          `drift=${drift} drift_source=x-sf-timestamp ts_raw="${ts}" ts_parsed=${tsNum} now_sec=${nowSec} ` +
          `body_sha256_12=${bodySha} body_bytes=${bodyLen} ` +
          `event_type=${eventTypeHeader ?? 'null'} sf_tenant_id=${tenantIdHeader ?? 'null'}`,
      );
      return {
        httpStatus: 401, result: 'replay_rejected', eventId: eventIdHeader,
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: headerSfTenantId ?? undefined,
        error: 'timestamp drift',
      };
    }

    // ── 3. Tenant resolution via X-SF-Tenant-Id ─────────────────────
    // SF sends the integer tenant id; we store as string. Look up
    // SfConnection by sfTenantId — that's the authoritative bridge.
    const sfTenantIdStr = tenantIdHeader.trim();
    const sfTenantIdNum = parseInt(sfTenantIdStr, 10);
    const conn = await this.prisma.sfConnection.findFirst({
      where: { sfTenantId: sfTenantIdStr },
    });
    if (!conn) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=tenant_not_found ` +
          `sf_tenant_id=${sfTenantIdStr} event_type=${eventTypeHeader ?? 'null'}`,
      );
      return {
        httpStatus: 404,
        result: 'tenant_not_found',
        eventId: eventIdHeader,
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: Number.isFinite(sfTenantIdNum) ? sfTenantIdNum : null,
        error: 'tenant not found',
      };
    }
    if (!conn.inboundSubscriptionId) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=noop ` +
          `error=connection_missing_subscription user_id=${conn.userId}`,
      );
      return { httpStatus: 500, result: 'noop', eventId: eventIdHeader, error: 'subscription unlinked' };
    }
    const subscription = await this.prisma.crmWebhookSubscription.findUnique({
      where: { id: conn.inboundSubscriptionId },
    });
    if (!subscription || !subscription.isActive) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=noop ` +
          `error=subscription_inactive user_id=${conn.userId}`,
      );
      return { httpStatus: 404, result: 'noop', eventId: eventIdHeader, error: 'subscription inactive' };
    }

    // ── 4. HMAC verification ────────────────────────────────────────
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=exception error=encryption_key_unset`,
      );
      return { httpStatus: 500, result: 'exception', eventId: eventIdHeader, error: 'config error' };
    }
    let secret: string;
    try {
      secret = EncryptionUtil.decrypt(subscription.secret, encryptionKey);
    } catch (e: any) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=exception error=secret_decrypt_failed`,
      );
      return { httpStatus: 500, result: 'exception', eventId: eventIdHeader, error: 'secret decrypt' };
    }
    const expected = this.sign(ts, rawBody, secret);
    const received = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (!this.timingSafeHexEqual(expected, received)) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=unauthorized error=signature_mismatch ` +
          `user_id=${conn.userId} sf_tenant_id=${sfTenantIdStr} event_type=${eventTypeHeader ?? 'null'}`,
      );
      return {
        httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader,
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: headerSfTenantId ?? undefined,
        error: 'signature mismatch',
      };
    }

    // ── 5. X-SF-Kid cross-check ─────────────────────────────────────
    if (conn.signatureKeyId && kidHeader && conn.signatureKeyId !== kidHeader) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=unauthorized error=kid_mismatch ` +
          `stored=${conn.signatureKeyId} received=${kidHeader} event_type=${eventTypeHeader ?? 'null'} sf_tenant_id=${sfTenantIdStr}`,
      );
      return {
        httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader,
        eventType: eventTypeHeader ?? undefined,
        sfTenantId: headerSfTenantId ?? undefined,
        error: 'kid mismatch',
      };
    }

    // ── 6. Parse + validate envelope ────────────────────────────────
    let envelope: SfWebhookEnvelope<unknown>;
    try {
      envelope = JSON.parse(rawBody);
    } catch {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'invalid json' };
    }
    if (typeof envelope?.event_id !== 'string' || !envelope.event_id) {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'missing body event_id' };
    }
    if (
      typeof envelope.event_type !== 'string' ||
      !(SF_WEBHOOK_EVENT_TYPES as readonly string[]).includes(envelope.event_type)
    ) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=validation_failed error=unknown_event_type ` +
          `type=${this.safe(envelope.event_type)}`,
      );
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'unknown event_type' };
    }
    if (typeof envelope.sf_tenant_id !== 'number') {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'missing/invalid sf_tenant_id' };
    }
    if (typeof envelope.occurred_at !== 'string' || isNaN(new Date(envelope.occurred_at).getTime())) {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'invalid occurred_at' };
    }

    // Header-vs-body event_id mismatch: log but don't fail (header wins for dedup).
    if (envelope.event_id !== eventIdHeader) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} body_event_id=${this.safe(envelope.event_id)} ` +
          `warn=body_id_mismatch result=note`,
      );
    }
    // Header-vs-body event_type mismatch: same — log + use header for dispatch.
    if (eventTypeHeader && envelope.event_type !== eventTypeHeader) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} body_event_type=${envelope.event_type} ` +
          `header_event_type=${eventTypeHeader} warn=event_type_mismatch result=note`,
      );
    }
    // Header-vs-body tenant_id mismatch: SECURITY-relevant. Reject.
    if (String(envelope.sf_tenant_id) !== sfTenantIdStr) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=unauthorized error=body_tenant_mismatch ` +
          `header=${sfTenantIdStr} body=${envelope.sf_tenant_id}`,
      );
      return { httpStatus: 403, result: 'unauthorized', eventId: eventIdHeader, error: 'tenant mismatch' };
    }

    const eventId = eventIdHeader;

    // ── 7. Idempotency ───────────────────────────────────────────────
    // Already-applied event: return 200 OK with result='idempotent_replay'.
    // - 200 (not 4xx) so SF treats it as a successful ack and stops retrying.
    // - Side effects NOT re-applied; we just acknowledge the original work.
    // - No new audit row written (eventId is unique on SfInboundEvent; the
    //   original row already captures the apply). Observability comes from
    //   the log line below + the existing row's status/result.
    const existing = await this.prisma.sfInboundEvent.findUnique({
      where: { eventId },
      select: { eventType: true, result: true, status: true, receivedAt: true },
    });
    if (existing) {
      this.logger.log(
        `[SfConnectionWebhook] event_id=${eventId} result=idempotent_replay ` +
          `user_id=${conn.userId} sf_tenant_id=${sfTenantIdStr} event_type=${existing.eventType} ` +
          `original_result=${existing.result ?? 'null'} original_status=${existing.status} ` +
          `original_received_at=${existing.receivedAt.toISOString()}`,
      );
      return {
        httpStatus: 200,
        result: 'idempotent_replay',
        eventId,
        eventType: existing.eventType,
        sfTenantId: envelope.sf_tenant_id,
      };
    }

    // ── 8. Dispatch by event_type ───────────────────────────────────
    const userId = subscription.userId;
    const occurredAt = new Date(envelope.occurred_at);
    let resultTag = 'applied';
    let errorMsg: string | null = null;

    // Envelope payload aliasing. SF S4 wire format uses `data` for the
    // event body; the original LB contract draft used `payload`. We accept
    // either, with `data` winning on the rare case both are present.
    // The OAuth exchange remains the authoritative provisioning channel —
    // webhooks are operational events / confirmations only.
    const envBody = this.envelopePayload(envelope);

    try {
      switch (envelope.event_type as SfWebhookEventType) {
        // ─── service lifecycle events (PR-B2 territory; routed here) ─
        case 'service_scheduled':
        case 'service_rescheduled':
        case 'service_cancelled':
        case 'service_completed': {
          const payload = envBody as SfServiceEventPayload;
          if (typeof payload.sf_job_id !== 'string') {
            throw new Error('missing sf_job_id');
          }
          // Resolve lead from sf_job_id (PR-B2 pattern)
          let lead = await this.prisma.lead.findFirst({
            where: { sfJobId: payload.sf_job_id, userId },
            select: { id: true, threadId: true, userId: true },
          });
          if (!lead && payload.external_request_id && payload.channel) {
            lead = await this.prisma.lead.findFirst({
              where: {
                userId,
                platform: payload.channel,
                externalRequestId: payload.external_request_id,
              },
              select: { id: true, threadId: true, userId: true },
            });
          }
          if (!lead) {
            // Deferred — no lead but record the event. Don't fail the request.
            this.logger.warn(
              `[SfConnectionWebhook] event_id=${eventId} event_type=${envelope.event_type} ` +
                `result=deferred error=lead_not_found sf_job_id=${payload.sf_job_id} user_id=${userId}`,
            );
            resultTag = 'deferred_lead_not_found';
            break;
          }
          await this.bookingOrchestrator.handleServiceOutcomeEvent({
            eventId,
            eventType: envelope.event_type as
              | 'service_scheduled' | 'service_rescheduled' | 'service_cancelled' | 'service_completed',
            sfJobId: payload.sf_job_id,
            userId,
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
          break;
        }

        // ─── connection lifecycle ────────────────────────────────────
        case 'connection.connected': {
          const payload = envBody as SfConnectionConnectedPayload & {
            credential?: { kid?: string; cred_id?: number | string; token_prefix?: string; expires_at?: string };
            connected_at?: string;
            webhook_set_at?: string;
          };

          if (payload?.provisioning) {
            // Re-establishment path — full provisioning was re-delivered
            // (rare: SF restoring a lost connection from scratch).
            await this.lifecycle.applyConnectionConnected({
              userId,
              connectionId: conn.id,
              provisioning: payload.provisioning,
              webhookSecretPlaintext: null,
              source: 'sf_push',
            });
            break;
          }

          // Confirmation path — OAuth exchange already delivered provisioning
          // authoritatively. This webhook is SF acknowledging the handshake
          // completed on their side. No reprovisioning, no token rewrite,
          // no secret change. Just record the heartbeat with a kid sanity
          // check (the X-SF-Kid header check upstream already enforced this).
          if (!conn.isActive || conn.status !== 'active') {
            // No prior active connection AND no provisioning in payload:
            // cold sf_push with confirmation shape. Not a supported flow —
            // SF must do a real handshake first.
            throw new Error('confirmation without active connection or provisioning');
          }
          const confirmedKid = payload?.credential?.kid;
          if (confirmedKid && conn.signatureKeyId && confirmedKid !== conn.signatureKeyId) {
            // Already caught by header kid check; redundant safety net for
            // body-vs-header divergence. Doesn't mutate state on its own —
            // surface as exception so SF sees the mismatch.
            throw new Error(`body_kid_mismatch stored=${conn.signatureKeyId} body=${confirmedKid}`);
          }
          this.logger.log(
            `[SfConnectionWebhook] event_id=${eventId} event_type=connection.connected ` +
              `result=applied_confirmation user_id=${userId} sf_tenant_id=${sfTenantIdStr} ` +
              `confirmed_kid=${confirmedKid ?? 'null'} cred_id=${payload?.credential?.cred_id ?? 'null'} ` +
              `sf_connected_at=${payload?.connected_at ?? 'null'} ` +
              `sf_webhook_set_at=${payload?.webhook_set_at ?? 'null'}`,
          );
          resultTag = 'applied_confirmation';
          break;
        }
        case 'credential.rotated': {
          const payload = envBody as SfCredentialRotatedPayload;
          if (!payload?.new_credential || typeof payload.new_credential.token !== 'string') {
            throw new Error('missing new_credential.token');
          }
          const r = await this.lifecycle.applyCredentialRotated({
            userId,
            payload,
            eventId,
          });
          if (r.noop) resultTag = 'applied_noop';
          break;
        }
        case 'connection.revoked': {
          const payload = (envBody as SfConnectionRevokedPayload) ?? {};
          await this.lifecycle.applyConnectionRevoked({
            userId,
            payload,
            initiator: 'sf_authority',
            eventId,
          });
          break;
        }
      }
    } catch (e: any) {
      errorMsg = this.safe(e?.message);
      resultTag = 'exception';
    }

    // ── 9. Audit row (always — success + failure) ───────────────────
    await this.recordEvent({
      eventId,
      eventType: envelope.event_type,
      occurredAt,
      sfSubscriptionId: subscription.id,
      userId,
      status: resultTag === 'exception' ? 'noop' : 'applied',
      result: resultTag,
      processingError: errorMsg,
      payloadJson: this.scrubPayloadForAudit(envelope),
    }).catch((e) => {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventId} result=record_failed err=${this.safe(e?.message)}`,
      );
    });

    if (errorMsg) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventId} user_id=${userId} sf_tenant_id=${sfTenantIdStr} ` +
          `event_type=${envelope.event_type} result=exception error=${errorMsg}`,
      );
      return {
        httpStatus: 500, result: 'exception', eventId, eventType: envelope.event_type,
        sfTenantId: envelope.sf_tenant_id, error: errorMsg,
      };
    }

    this.logger.log(
      `[SfConnectionWebhook] event_id=${eventId} user_id=${userId} sf_tenant_id=${sfTenantIdStr} ` +
        `event_type=${envelope.event_type} result=${resultTag}`,
    );

    return {
      httpStatus: 200, result: 'accepted', eventId, eventType: envelope.event_type,
      sfTenantId: envelope.sf_tenant_id,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Extract the event body from the canonical envelope. SF S4 wire format
   * uses `data`; the LB-original contract draft used `payload`. We accept
   * either, with `data` winning when both are present. Always returns a
   * non-null object so callers can dereference safely.
   */
  private envelopePayload(envelope: any): Record<string, any> {
    if (envelope && typeof envelope === 'object') {
      if (envelope.data && typeof envelope.data === 'object') return envelope.data;
      if (envelope.payload && typeof envelope.payload === 'object') return envelope.payload;
    }
    return {};
  }

  /**
   * Strip secrets from the payload before persisting to the audit row.
   * orchestration_token / webhook_signing_secret / new_credential.token
   * are sensitive — replace with *_len + *_prefix only. Walks both
   * `data` (SF wire) and `payload` (LB-original) branches.
   */
  private scrubPayloadForAudit(envelope: SfWebhookEnvelope<unknown>): any {
    try {
      const clone: any = JSON.parse(JSON.stringify(envelope));
      const scrub = (obj: any, k: string) => {
        if (obj && typeof obj[k] === 'string') {
          obj[`${k}_len`] = obj[k].length;
          delete obj[k];
        }
      };
      for (const branch of [clone.data, clone.payload]) {
        const p = branch ?? {};
        if (p.provisioning?.credential) scrub(p.provisioning.credential, 'token');
        if (p.new_credential) scrub(p.new_credential, 'token');
        if (p.credential) scrub(p.credential, 'token'); // confirmation-shape safety
      }
      return clone;
    } catch {
      return { event_type: envelope.event_type, event_id: envelope.event_id, scrub_failed: true };
    }
  }

  private async recordEvent(args: {
    eventId: string;
    eventType: string;
    occurredAt: Date;
    sfSubscriptionId?: string | null;
    userId?: string;
    leadId?: string;
    status: 'applied' | 'noop' | 'deferred' | 'unauthorized';
    result: string;
    processingError?: string | null;
    payloadJson: unknown;
  }): Promise<void> {
    await this.prisma.sfInboundEvent.create({
      data: {
        eventId: args.eventId,
        eventType: args.eventType,
        occurredAt: args.occurredAt,
        sfSubscriptionId: args.sfSubscriptionId ?? null,
        userId: args.userId,
        leadId: args.leadId,
        status: args.status,
        result: args.result,
        processingError: args.processingError ?? null,
        payloadJson: args.payloadJson as any,
      },
    });
  }

  private pickHeader(v: string | string[] | undefined): string | null {
    if (!v) return null;
    if (Array.isArray(v)) return v[0] ?? null;
    return v;
  }

  private sign(timestamp: string, body: string, secret: string): string {
    return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  }

  private timingSafeHexEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    try {
      return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
    } catch {
      return false;
    }
  }

  private safe(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
