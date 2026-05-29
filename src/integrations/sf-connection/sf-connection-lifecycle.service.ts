/**
 * SfConnectionLifecycleService — Phase 2C PR-C2.1.
 *
 * Single writer of sf_connections + linked CrmWebhookSubscription rows.
 * Three public entry points:
 *
 *   applyConnectionConnected
 *     Initial provisioning. Called from:
 *       (a) OAuth callback after exchange success
 *       (b) inbound connection.connected webhook (catch-up / re-delivery)
 *
 *     Canonical SF S4 flow inversion: the webhook signing secret is
 *     **LB-generated** and passed in via `webhookSecretPlaintext`.
 *     SF only echoes `secret_set: true` in the provisioning payload —
 *     never echoes the secret itself. The caller (OAuth service for
 *     fresh handshakes; webhook service for SF re-deliveries) is
 *     responsible for sourcing the secret. The webhook re-delivery
 *     path therefore CANNOT change the stored secret — it preserves
 *     whatever is currently stored on the inbound subscription.
 *
 *   applyCredentialRotated
 *     Demotes the current token to previousOrchestrationToken (5-min
 *     SF-guaranteed grace), stores the new token, sets status='rotating'.
 *
 *   applyConnectionRevoked
 *     Terminal state. sf_authority → 'revoked'; lb_user/lb_admin →
 *     'disconnected'. Wipes tokens. Deactivates subscription. Audit
 *     preserved.
 *
 * Idempotency model:
 *   - applyConnectionConnected: re-delivery with identical sfTenantId +
 *     credential.issued_at is a noop.
 *   - applyCredentialRotated: stale issued_at → noop.
 *   - applyConnectionRevoked: re-revoke is safe.
 *
 * Safety:
 *   - Plaintext token + plaintext webhook secret NEVER logged. Log lines
 *     reference token_prefix + token_len + webhook_secret_len only.
 *   - All multi-row changes wrapped in $transaction.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import type {
  SfConnectionRevokedPayload,
  SfCredentialRotatedPayload,
  SfProvisioningPayload,
} from './sf-connection.contracts';

const DEFAULT_GRACE_SECONDS = 5 * 60;

export interface ApplyConnectionConnectedInput {
  userId: string;
  /** The pending row id (OAuth path) or a fresh uuid (sf_push first-time path). */
  connectionId: string;
  /** Canonical SF payload (nested envelope). */
  provisioning: SfProvisioningPayload;
  /**
   * LB-generated webhook signing secret (base64 32 bytes). Required on
   * the oauth_exchange path because SF never echoes it. Optional on
   * sf_push re-deliveries — if omitted, the lifecycle service preserves
   * the secret already stored on the linked CrmWebhookSubscription.
   */
  webhookSecretPlaintext?: string | null;
  /** LB-generated webhook URL (required on oauth_exchange path). */
  webhookUrl?: string | null;
  /** LB-generated subscription correlation id (echoed by SF). */
  webhookSubscriptionId?: string | null;
  /** LB-generated state ref (echoed by SF). */
  webhookStateRef?: string | null;
  source: 'oauth_exchange' | 'sf_push';
}

export interface ApplyCredentialRotatedInput {
  userId: string;
  payload: SfCredentialRotatedPayload;
  eventId?: string | null;
}

/**
 * R1 — input for the notification-shape rotation path. SF sends this
 * when they've rotated the credential on their side but are NOT
 * re-delivering the plaintext token over the webhook channel (correct
 * security posture: secrets only flow via OAuth exchange). LB records
 * what SF said happened + the grace window; an out-of-band refresh
 * mechanism (re-handshake) materializes the new token before the grace
 * elapses.
 */
export interface ApplyCredentialRotationNotificationInput {
  userId: string;
  /** SF's new cred_id (their internal credential id) — required. */
  newCredId: string | number;
  /** SF's new kid — optional (rotation may keep the same signing key). */
  newKid?: string | null;
  /** Token prefix from SF for log/UI correlation — optional. */
  newTokenPrefix?: string | null;
  /** New token expiry (SF-declared) — optional, informational. */
  newExpiresAt?: string | null;
  /** SF-declared grace window end (when the old token stops working). Required. */
  previousGraceExpiresAt: string;
  /** SF's prior cred_id for forensic correlation — optional. */
  previousCredId?: string | number | null;
  /** Why SF rotated — optional, audit only. */
  reason?: string | null;
  eventId?: string | null;
}

export interface ApplyConnectionRevokedInput {
  userId: string;
  payload: SfConnectionRevokedPayload;
  initiator: 'sf_authority' | 'lb_user' | 'lb_admin';
  eventId?: string | null;
}

export interface ApplyResult {
  ok: boolean;
  connectionId?: string;
  noop?: boolean;
  reason?: string;
}

@Injectable()
export class SfConnectionLifecycleService {
  private readonly logger = new Logger(SfConnectionLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // applyConnectionConnected
  // ═══════════════════════════════════════════════════════════════════════

  async applyConnectionConnected(input: ApplyConnectionConnectedInput): Promise<ApplyResult> {
    const { userId, connectionId, provisioning, source } = input;
    const encryptionKey = this.getEncryptionKey();
    const tokenIssuedAt = new Date(provisioning.credential.issued_at);
    // sf_tenant_id arrives as integer on the wire; store as string for
    // backward compat with the existing column type + cross-platform
    // ergonomics (everything else in LB treats tenant ids as strings).
    const sfTenantIdStr = String(provisioning.tenant.sf_tenant_id);
    const sfWorkspaceIdStr = String(provisioning.tenant.sf_workspace_id);

    const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });

    // Idempotent re-delivery — same SF tenant + same issued_at = noop.
    if (
      existing &&
      existing.status === 'active' &&
      existing.sfTenantId === sfTenantIdStr &&
      existing.tokenIssuedAt.getTime() === tokenIssuedAt.getTime()
    ) {
      this.logger.log(
        `[SfConnectionLifecycle] event=connected_noop user_id=${userId} sf_tenant_id=${sfTenantIdStr}` +
          ` source=${source} reason=identical_issued_at`,
      );
      return { ok: true, noop: true, connectionId: existing.id };
    }

    // Webhook secret resolution:
    //   - oauth_exchange path: caller MUST pass it (LB generated it for this handshake)
    //   - sf_push re-delivery: caller MAY pass it; otherwise preserve existing
    let encryptedWebhookSecret: string;
    if (input.webhookSecretPlaintext) {
      encryptedWebhookSecret = EncryptionUtil.encrypt(input.webhookSecretPlaintext, encryptionKey);
    } else if (existing?.inboundSubscriptionId) {
      const sub = await this.prisma.crmWebhookSubscription.findUnique({
        where: { id: existing.inboundSubscriptionId },
      });
      if (!sub?.secret) {
        // First-time sf_push without LB context to provide the secret —
        // this can't happen on the canonical flow; reject loudly.
        this.logger.error(
          `[SfConnectionLifecycle] event=connected_rejected user_id=${userId} ` +
            `reason=no_webhook_secret_available source=${source}`,
        );
        return { ok: false, reason: 'no_webhook_secret_available' };
      }
      encryptedWebhookSecret = sub.secret;
    } else {
      // No existing subscription + no secret in input — first-ever sf_push
      // before any OAuth, which is not how SF S4 operates. Reject.
      this.logger.error(
        `[SfConnectionLifecycle] event=connected_rejected user_id=${userId} ` +
          `reason=cold_sf_push_without_secret source=${source}`,
      );
      return { ok: false, reason: 'cold_sf_push_without_secret' };
    }

    const encryptedToken = EncryptionUtil.encrypt(provisioning.credential.token, encryptionKey);
    const tokenExpiresAt = provisioning.credential.expires_at
      ? new Date(provisioning.credential.expires_at)
      : null;
    const now = new Date();
    const events = Array.isArray(provisioning.event_types) ? provisioning.event_types : [];

    // Webhook url resolution (mirror the secret logic):
    //   - oauth_exchange path: required from input
    //   - sf_push: prefer the URL SF echoed in the payload
    const webhookUrl =
      input.webhookUrl ??
      provisioning.webhook.url ??
      `sf://${provisioning.tenant.source_instance}/${userId}`;

    await this.prisma.$transaction(async (tx) => {
      const subName = `Service Flow (${provisioning.tenant.sf_tenant_name ?? sfTenantIdStr})`;
      const subMetadata = {
        sf_subscription_id: provisioning.webhook.subscription_id ?? input.webhookSubscriptionId ?? null,
        signature_key_id: provisioning.credential.kid,
        signature_algorithm: provisioning.signature_metadata.algorithm,
      };
      const sub = await tx.crmWebhookSubscription.upsert({
        where: {
          userId_direction_webhookUrl: { userId, direction: 'inbound', webhookUrl },
        },
        create: {
          userId,
          name: subName,
          webhookUrl,
          secret: encryptedWebhookSecret,
          events,
          direction: 'inbound',
          isActive: true,
          metadata: subMetadata,
        },
        update: {
          name: subName,
          secret: encryptedWebhookSecret,
          events,
          isActive: true,
          metadata: subMetadata,
        },
      });

      const rotationSource = source === 'oauth_exchange' ? 'handshake' : 'sf_push';

      const sharedFields = {
        sfTenantId: sfTenantIdStr,
        sfTenantName: provisioning.tenant.sf_tenant_name ?? null,
        baseUrl: provisioning.tenant.sf_base_url,
        sourceInstance: provisioning.tenant.source_instance ?? null,
        apiRegion: provisioning.tenant.api_region ?? null,
        sfWorkspaceId: sfWorkspaceIdStr,
        signatureKeyId: provisioning.credential.kid,
        signatureAlgorithm: provisioning.signature_metadata.algorithm,
        maxClockSkewSeconds: provisioning.signature_metadata.max_clock_skew_seconds,
        endpointsJson: JSON.stringify(provisioning.endpoints),
        orchestrationToken: encryptedToken,
        orchestrationTokenKid: provisioning.credential.kid,
        orchestrationTokenScope: provisioning.credential.scope,
        tokenPrefix: provisioning.credential.token_prefix,
        tokenIssuedAt,
        tokenExpiresAt,
        tokenLastReceivedAt: now,
        tokenLastRotationSource: rotationSource,
        previousOrchestrationToken: null,
        previousTokenExpiresAt: null,
        // R1: a successful handshake materializes the new token, so any
        // pending rotation notification we'd been holding is now satisfied.
        rotationPending: false,
        pendingRotationKid: null,
        pendingRotationCredId: null,
        pendingRotationGraceExpiresAt: null,
        pendingRotationObservedAt: null,
        inboundSubscriptionId: sub.id,
        events,
        isActive: true,
        status: 'active' as const,
      };

      if (existing) {
        await tx.sfConnection.update({
          where: { userId },
          data: {
            ...sharedFields,
            disconnectInitiator: null,
            disconnectedAt: null,
            lastErrorAt: null,
            lastErrorMessage: null,
            updatedAt: now,
          },
        });
      } else {
        await tx.sfConnection.create({
          data: {
            id: connectionId,
            userId,
            ...sharedFields,
          },
        });
      }
    });

    this.logger.log(
      `[SfConnectionLifecycle] event=connected user_id=${userId} sf_tenant_id=${sfTenantIdStr}` +
        ` sf_workspace_id=${sfWorkspaceIdStr} source_instance=${provisioning.tenant.source_instance}` +
        ` token_kid=${provisioning.credential.kid} token_prefix=${provisioning.credential.token_prefix}` +
        ` token_len=${provisioning.credential.token.length} events=${events.length} source=${source}` +
        ` webhook_secret_len=${input.webhookSecretPlaintext?.length ?? 'preserved'}`,
    );

    return { ok: true, connectionId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // applyCredentialRotated
  // ═══════════════════════════════════════════════════════════════════════

  async applyCredentialRotated(input: ApplyCredentialRotatedInput): Promise<ApplyResult> {
    const { userId, payload, eventId } = input;
    const encryptionKey = this.getEncryptionKey();
    const newIssuedAt = new Date(payload.new_credential.issued_at);
    const conn = await this.prisma.sfConnection.findUnique({ where: { userId } });
    if (!conn) {
      this.logger.warn(
        `[SfConnectionLifecycle] event=rotation_no_row user_id=${userId} event_id=${eventId ?? 'null'}`,
      );
      return { ok: false, reason: 'no_connection' };
    }
    if (!conn.isActive || (conn.status !== 'active' && conn.status !== 'rotating')) {
      this.logger.warn(
        `[SfConnectionLifecycle] event=rotation_inactive_target user_id=${userId} status=${conn.status} event_id=${eventId ?? 'null'}`,
      );
      return { ok: false, reason: `status_${conn.status}` };
    }
    if (conn.tokenIssuedAt.getTime() >= newIssuedAt.getTime()) {
      this.logger.log(
        `[SfConnectionLifecycle] event=rotation_noop user_id=${userId} event_id=${eventId ?? 'null'} reason=stale_or_equal`,
      );
      return { ok: true, noop: true };
    }

    const grace = payload.grace_period_seconds > 0 ? payload.grace_period_seconds : DEFAULT_GRACE_SECONDS;
    const previousExpiresAt = new Date(Date.now() + grace * 1000);
    const newEncrypted = EncryptionUtil.encrypt(payload.new_credential.token, encryptionKey);
    const newExpiresAt = payload.new_credential.expires_at ? new Date(payload.new_credential.expires_at) : null;

    await this.prisma.sfConnection.update({
      where: { userId },
      data: {
        previousOrchestrationToken: conn.orchestrationToken,
        previousTokenExpiresAt: previousExpiresAt,
        orchestrationToken: newEncrypted,
        orchestrationTokenKid: payload.new_credential.kid,
        tokenPrefix: payload.new_credential.token_prefix,
        tokenIssuedAt: newIssuedAt,
        tokenExpiresAt: newExpiresAt,
        tokenLastReceivedAt: new Date(),
        tokenLastRotationSource: 'sf_push',
        signatureKeyId: payload.new_credential.kid,
        status: 'rotating',
        updatedAt: new Date(),
      },
    });

    this.logger.log(
      `[SfConnectionLifecycle] event=rotated user_id=${userId} event_id=${eventId ?? 'null'}` +
        ` new_token_kid=${payload.new_credential.kid} new_token_prefix=${payload.new_credential.token_prefix}` +
        ` new_token_len=${payload.new_credential.token.length} grace_seconds=${grace}`,
    );

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // applyCredentialRotationNotification — R1
  // ═══════════════════════════════════════════════════════════════════════
  //
  // Notification-shape rotation: SF tells LB "I rotated credentials on my
  // side, the old token is valid until <grace>". No plaintext token is
  // delivered over the webhook. LB:
  //   1. Persists rotationPending=true + the metadata SF sent
  //   2. Keeps using the current stored token until it's refreshed
  //      out-of-band (re-handshake or, future, a service-to-service
  //      refresh endpoint once SF exposes one)
  //   3. The resolver surfaces rotation_pending so callers can decide
  //      what to do; it also alerts loudly as grace approaches
  //
  // Idempotent on the same (eventId, newCredId) — re-delivery is a noop.

  async applyCredentialRotationNotification(
    input: ApplyCredentialRotationNotificationInput,
  ): Promise<ApplyResult> {
    const { userId, newCredId, newKid, previousGraceExpiresAt, eventId } = input;
    const conn = await this.prisma.sfConnection.findUnique({ where: { userId } });
    if (!conn) {
      this.logger.warn(
        `[SfConnectionLifecycle] event=rotation_notification_no_row user_id=${userId} event_id=${eventId ?? 'null'}`,
      );
      return { ok: false, reason: 'no_connection' };
    }
    if (!conn.isActive || conn.status !== 'active') {
      this.logger.warn(
        `[SfConnectionLifecycle] event=rotation_notification_inactive_target user_id=${userId} ` +
          `status=${conn.status} event_id=${eventId ?? 'null'}`,
      );
      return { ok: false, reason: `status_${conn.status}` };
    }
    const graceExpiresAt = new Date(previousGraceExpiresAt);
    if (isNaN(graceExpiresAt.getTime())) {
      this.logger.warn(
        `[SfConnectionLifecycle] event=rotation_notification_bad_grace user_id=${userId} ` +
          `previous_grace_expires_at=${this.safe(previousGraceExpiresAt)}`,
      );
      return { ok: false, reason: 'invalid_grace' };
    }

    // Idempotent on same cred_id — re-delivery doesn't shift the grace clock.
    const newCredIdStr = String(newCredId);
    if (
      conn.rotationPending &&
      conn.pendingRotationCredId === newCredIdStr &&
      conn.pendingRotationGraceExpiresAt &&
      conn.pendingRotationGraceExpiresAt.getTime() === graceExpiresAt.getTime()
    ) {
      this.logger.log(
        `[SfConnectionLifecycle] event=rotation_notification_noop user_id=${userId} ` +
          `cred_id=${newCredIdStr} event_id=${eventId ?? 'null'}`,
      );
      return { ok: true, noop: true };
    }

    await this.prisma.sfConnection.update({
      where: { userId },
      data: {
        rotationPending: true,
        pendingRotationKid: newKid ?? null,
        pendingRotationCredId: newCredIdStr,
        pendingRotationGraceExpiresAt: graceExpiresAt,
        pendingRotationObservedAt: new Date(),
        updatedAt: new Date(),
        // status stays 'active' — old token still valid; flag the pending
        // state separately so consumers can see both signals independently.
      },
    });

    const graceMs = graceExpiresAt.getTime() - Date.now();
    this.logger.log(
      `[SfConnectionLifecycle] event=rotation_notification_recorded user_id=${userId} ` +
        `event_id=${eventId ?? 'null'} new_cred_id=${newCredIdStr} new_kid=${newKid ?? 'unchanged'} ` +
        `grace_expires_at=${graceExpiresAt.toISOString()} grace_ms_remaining=${graceMs} ` +
        `prev_cred_id=${input.previousCredId != null ? String(input.previousCredId) : 'null'} ` +
        `reason=${this.safe(input.reason ?? '')}`,
    );

    return { ok: true };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // applyConnectionRevoked
  // ═══════════════════════════════════════════════════════════════════════

  async applyConnectionRevoked(input: ApplyConnectionRevokedInput): Promise<ApplyResult> {
    const { userId, payload, initiator, eventId } = input;
    const conn = await this.prisma.sfConnection.findUnique({ where: { userId } });
    if (!conn) {
      this.logger.warn(
        `[SfConnectionLifecycle] event=revoke_no_row user_id=${userId} event_id=${eventId ?? 'null'}`,
      );
      return { ok: false, reason: 'no_connection' };
    }
    const isAlreadyTerminal = conn.status === 'revoked' || conn.status === 'disconnected';
    const finalStatus = initiator === 'sf_authority' ? 'revoked' : 'disconnected';

    await this.prisma.$transaction(async (tx) => {
      await tx.sfConnection.update({
        where: { userId },
        data: {
          status: finalStatus,
          isActive: false,
          orchestrationToken: '',
          previousOrchestrationToken: null,
          previousTokenExpiresAt: null,
          disconnectInitiator: initiator,
          disconnectedAt: isAlreadyTerminal ? conn.disconnectedAt : new Date(),
          lastErrorAt: payload.reason ? new Date() : conn.lastErrorAt,
          lastErrorMessage: payload.reason
            ? `${initiator}:${this.safe(payload.reason)}${payload.detail ? ':' + this.safe(payload.detail) : ''}`.slice(0, 300)
            : conn.lastErrorMessage,
          updatedAt: new Date(),
        },
      });
      if (conn.inboundSubscriptionId) {
        await tx.crmWebhookSubscription.update({
          where: { id: conn.inboundSubscriptionId },
          data: { isActive: false },
        });
      }
    });

    this.logger.log(
      `[SfConnectionLifecycle] event=revoked user_id=${userId} initiator=${initiator}` +
        ` reason=${this.safe(payload.reason ?? 'none')} event_id=${eventId ?? 'null'}` +
        ` final_status=${finalStatus} was_terminal=${isAlreadyTerminal}`,
    );

    return { ok: true, connectionId: conn.id };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private getEncryptionKey(): string {
    const key = this.config.get<string>('encryption.key');
    if (!key) throw new Error('encryption.key not configured');
    return key;
  }

  private safe(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
