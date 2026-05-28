/**
 * SfConnectionWebhookService — Phase 2C PR-C2.
 *
 * Inbound endpoint for the three connection-lifecycle events SF pushes
 * to LB: connection.connected, credential.rotated, connection.revoked.
 *
 * Contract (must match the SF side):
 *   POST /v1/integrations/sf/connection-webhook
 *   Headers:
 *     X-SF-Event-Id        — dedup key; LB rejects re-deliveries
 *     X-SF-Signature       — sha256 HMAC of `${timestamp}.${rawBody}`
 *                            using the LB-stored webhook signing
 *                            secret (received at exchange time;
 *                            decrypted just-in-time, never logged)
 *     X-SF-Timestamp       — unix seconds, ±300s skew window
 *     X-SF-Subscription-Id — matches CrmWebhookSubscription.metadata
 *                            .sf_subscription_id
 *     X-SF-Signature-Kid   — (optional) signing key id; if present and
 *                            sf_connections.signatureKeyId is set, the
 *                            two must match
 *
 * Body envelope (validated):
 *   {
 *     event_id, event_type, occurred_at, sf_tenant_id,
 *     payload: { ...event-specific... }
 *   }
 *
 * Idempotency:
 *   - X-SF-Event-Id is stored in SfInboundEvent (eventId unique).
 *   - Re-delivery returns 409 with the prior result, without re-applying.
 *   - When header and body event_id disagree, we treat the HEADER as
 *     authoritative (matches SF's docs); body mismatch is logged but
 *     does not fail the request.
 *
 * Tenant identity:
 *   - Look up CrmWebhookSubscription by X-SF-Subscription-Id (resolves
 *     to subscription.userId)
 *   - Look up SfConnection by that userId (must exist)
 *   - Cross-check the body's sf_tenant_id matches SfConnection.sfTenantId;
 *     mismatch → 403 (cross-tenant signal)
 *   - HMAC verification uses the LB-stored signing secret for that
 *     subscription; an attacker who got hold of one tenant's secret
 *     cannot spoof another tenant's events because the
 *     X-SF-Subscription-Id binds them.
 *
 * No plaintext token logging — even in error paths.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import {
  SF_CONNECTION_EVENT_TYPES,
  type ConnectionWebhookOutcome,
  type SfConnectionConnectedPayload,
  type SfConnectionEventType,
  type SfConnectionRevokedPayload,
  type SfConnectionWebhookEnvelope,
  type SfCredentialRotatedPayload,
} from './sf-connection.contracts';

const SIGNATURE_SKEW_SECONDS = 300;

@Injectable()
export class SfConnectionWebhookService {
  private readonly logger = new Logger(SfConnectionWebhookService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lifecycle: SfConnectionLifecycleService,
  ) {}

  /**
   * Master entry — never throws. Returns a typed outcome the controller
   * passes back as the HTTP response.
   */
  async ingest(
    rawBody: string,
    headers: {
      signature?: string | string[];
      timestamp?: string | string[];
      subscriptionId?: string | string[];
      eventId?: string | string[];
      signatureKid?: string | string[];
    },
  ): Promise<ConnectionWebhookOutcome> {
    const sigKidHeader = this.pickHeader(headers.signatureKid);
    const subId = this.pickHeader(headers.subscriptionId);
    const sig = this.pickHeader(headers.signature);
    const ts = this.pickHeader(headers.timestamp);
    const eventIdHeader = this.pickHeader(headers.eventId);

    // ── 1. Headers must all be present ───────────────────────────
    if (!subId || !sig || !ts || !eventIdHeader) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=null result=unauthorized error=missing_headers` +
          ` sub_present=${!!subId} sig_present=${!!sig} ts_present=${!!ts} eventid_present=${!!eventIdHeader}`,
      );
      return { httpStatus: 401, result: 'unauthorized', eventId: 'n/a', error: 'missing headers' };
    }

    // ── 2. Timestamp skew (±300s) ────────────────────────────────
    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) {
      return { httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader, error: 'invalid timestamp' };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    const drift = nowSec - tsNum;
    if (Math.abs(drift) > SIGNATURE_SKEW_SECONDS) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=replay_rejected error=timestamp_drift drift=${drift}`,
      );
      return {
        httpStatus: 401,
        result: 'replay_rejected',
        eventId: eventIdHeader,
        error: 'timestamp drift',
      };
    }

    // ── 3. Subscription lookup ───────────────────────────────────
    const subscription = await this.prisma.crmWebhookSubscription.findUnique({
      where: { id: subId },
    });
    if (!subscription || !subscription.isActive || subscription.direction !== 'inbound') {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=noop error=subscription_not_found sub_id=${subId}`,
      );
      return { httpStatus: 404, result: 'noop', eventId: eventIdHeader, error: 'subscription not found' };
    }

    // ── 4. HMAC verification ─────────────────────────────────────
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      this.logger.error(`[SfConnectionWebhook] event_id=${eventIdHeader} result=exception error=encryption_key_unset`);
      return { httpStatus: 500, result: 'exception', eventId: eventIdHeader, error: 'config error' };
    }
    let secret: string;
    try {
      secret = EncryptionUtil.decrypt(subscription.secret, encryptionKey);
    } catch (e: any) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=exception error=secret_decrypt_failed err=${this.safe(e?.message)}`,
      );
      return { httpStatus: 500, result: 'exception', eventId: eventIdHeader, error: 'secret decrypt' };
    }
    const expected = this.sign(ts, rawBody, secret);
    const received = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (!this.timingSafeHexEqual(expected, received)) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=unauthorized error=signature_mismatch sub_id=${subId}`,
      );
      return { httpStatus: 401, result: 'unauthorized', eventId: eventIdHeader, error: 'signature mismatch' };
    }

    // ── 5. Parse + validate body ─────────────────────────────────
    let envelope: SfConnectionWebhookEnvelope<unknown>;
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
      !(SF_CONNECTION_EVENT_TYPES as readonly string[]).includes(envelope.event_type)
    ) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} result=validation_failed error=unknown_event_type type=${this.safe(envelope.event_type)}`,
      );
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'unknown event_type' };
    }
    if (typeof envelope.sf_tenant_id !== 'string' || !envelope.sf_tenant_id) {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'missing sf_tenant_id' };
    }
    if (typeof envelope.occurred_at !== 'string' || isNaN(new Date(envelope.occurred_at).getTime())) {
      return { httpStatus: 400, result: 'validation_failed', eventId: eventIdHeader, error: 'invalid occurred_at' };
    }

    // Header-vs-body event_id mismatch is logged but doesn't fail —
    // header is authoritative for dedup.
    if (envelope.event_id !== eventIdHeader) {
      this.logger.warn(
        `[SfConnectionWebhook] event_id=${eventIdHeader} body_event_id=${this.safe(envelope.event_id)} result=note warn=body_id_mismatch`,
      );
    }
    const eventId = eventIdHeader;

    // ── 6. Signature key id cross-check ──────────────────────────
    // If we already have an SfConnection for this subscription's user
    // AND the connection records a signatureKeyId AND the header brings
    // one, they must match. Mismatch → cross-tenant or key-rotation
    // race; reject.
    const conn = await this.prisma.sfConnection.findUnique({
      where: { userId: subscription.userId },
    });
    if (conn && conn.signatureKeyId && sigKidHeader && conn.signatureKeyId !== sigKidHeader) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventId} result=unauthorized error=signature_kid_mismatch` +
          ` stored=${conn.signatureKeyId} received=${sigKidHeader}`,
      );
      return { httpStatus: 401, result: 'unauthorized', eventId, error: 'signature kid mismatch' };
    }

    // ── 7. Cross-tenant safety: body's sf_tenant_id must match the
    //       connection's recorded sf_tenant_id (when we have one)
    // For connection.connected on a first-time provisioning, conn may
    // be missing or have sf_tenant_id='pending'. Allow those cases.
    if (
      conn &&
      conn.sfTenantId !== 'pending' &&
      conn.sfTenantId !== envelope.sf_tenant_id
    ) {
      this.logger.error(
        `[SfConnectionWebhook] event_id=${eventId} result=unauthorized error=tenant_mismatch` +
          ` stored=${conn.sfTenantId} body=${envelope.sf_tenant_id}`,
      );
      return { httpStatus: 403, result: 'unauthorized', eventId, error: 'tenant mismatch' };
    }

    // ── 8. Idempotency check ─────────────────────────────────────
    const existing = await this.prisma.sfInboundEvent.findUnique({ where: { eventId } });
    if (existing) {
      return {
        httpStatus: 409,
        result: 'duplicate',
        eventId,
        sfTenantId: envelope.sf_tenant_id,
      };
    }

    // ── 9. Dispatch to lifecycle handler ─────────────────────────
    const userId = subscription.userId;
    const occurredAt = new Date(envelope.occurred_at);
    let resultTag = 'applied';
    let errorMsg: string | null = null;
    try {
      switch (envelope.event_type as SfConnectionEventType) {
        case 'connection.connected': {
          const payload = envelope.payload as SfConnectionConnectedPayload;
          if (!payload?.provisioning || typeof payload.provisioning !== 'object') {
            throw new Error('missing provisioning payload');
          }
          await this.lifecycle.applyConnectionConnected({
            userId,
            connectionId: conn?.id ?? crypto.randomUUID(),
            provisioning: payload.provisioning,
            source: 'sf_push',
          });
          break;
        }
        case 'credential.rotated': {
          const payload = envelope.payload as SfCredentialRotatedPayload;
          if (typeof payload?.new_orchestration_token !== 'string') {
            throw new Error('missing new_orchestration_token');
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
          const payload = (envelope.payload as SfConnectionRevokedPayload) ?? {};
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

    // ── 10. Record audit row (always — both success + failure) ───
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
        `[SfConnectionWebhook] event_id=${eventId} user_id=${userId} sf_tenant_id=${envelope.sf_tenant_id}` +
          ` event_type=${envelope.event_type} result=exception error=${errorMsg}`,
      );
      return { httpStatus: 500, result: 'exception', eventId, sfTenantId: envelope.sf_tenant_id, error: errorMsg };
    }

    this.logger.log(
      `[SfConnectionWebhook] event_id=${eventId} user_id=${userId} sf_tenant_id=${envelope.sf_tenant_id}` +
        ` event_type=${envelope.event_type} result=${resultTag}`,
    );

    return {
      httpStatus: 200,
      result: 'accepted',
      eventId,
      sfTenantId: envelope.sf_tenant_id,
    };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Strip secrets from the payload before persisting to the audit row.
   * orchestration_token / webhook_signing_secret / new_orchestration_token
   * are sensitive — replace with metadata (length + kid only) so the
   * audit row is queryable without ever surfacing the bearer text.
   */
  private scrubPayloadForAudit(envelope: SfConnectionWebhookEnvelope<unknown>): any {
    try {
      const clone: any = JSON.parse(JSON.stringify(envelope));
      const scrub = (obj: any, k: string) => {
        if (obj && typeof obj[k] === 'string') {
          obj[`${k}_len`] = obj[k].length;
          delete obj[k];
        }
      };
      const p = clone.payload ?? {};
      if (p.provisioning) {
        scrub(p.provisioning, 'orchestration_token');
        scrub(p.provisioning, 'webhook_signing_secret');
      }
      scrub(p, 'new_orchestration_token');
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
