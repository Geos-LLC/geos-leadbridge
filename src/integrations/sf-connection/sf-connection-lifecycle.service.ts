/**
 * SfConnectionLifecycleService — Phase 2C PR-C2.
 *
 * Pure persistence layer for the SF connect lifecycle. Three public
 * entry points:
 *
 *   applyConnectionConnected   — initial provisioning (OAuth exchange OR
 *                                inbound connection.connected event).
 *                                Atomic transaction: encrypt creds +
 *                                upsert SfConnection + create/update
 *                                linked CrmWebhookSubscription.
 *
 *   applyCredentialRotated     — SF pushed a new orchestration token.
 *                                Demotes the current token to
 *                                previousOrchestrationToken (5-min
 *                                grace window), stores the new token,
 *                                sets status='rotating'.
 *
 *   applyConnectionRevoked     — SF authority revoked the connection.
 *                                Sets status='revoked', wipes tokens,
 *                                deactivates webhook subscription.
 *                                Preserves audit trail.
 *
 * Idempotency model:
 *   - applyConnectionConnected is called from two paths:
 *       (a) OAuth callback (status='pending' → 'active')
 *       (b) connection.connected webhook (re-delivery / catch-up)
 *     Both upsert by userId. If status is already 'active' with
 *     matching sfTenantId AND the same token_issued_at, it's a no-op
 *     (idempotent re-delivery). If the token_issued_at advanced, it's
 *     a refresh and we accept the new payload.
 *
 *   - applyCredentialRotated is idempotent on (userId, new token_issued_at):
 *     if our tokenIssuedAt >= new_token_issued_at the call no-ops.
 *
 *   - applyConnectionRevoked is idempotent: re-revoke is safe.
 *
 * Safety:
 *   - Plaintext orchestration_token + webhook_signing_secret are NEVER
 *     logged. Log lines reference token_kid and length only.
 *   - Encryption uses ENCRYPTION_KEY via EncryptionUtil — same as the
 *     existing Yelp/Thumbtack credentials.
 *   - All multi-row changes are wrapped in prisma.$transaction so a
 *     partial failure leaves the system in a consistent state.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import type {
  SfConnectionConnectedPayload,
  SfConnectionRevokedPayload,
  SfCredentialRotatedPayload,
  SfProvisioningPayload,
} from './sf-connection.contracts';

const DEFAULT_GRACE_SECONDS = 5 * 60;

export interface ApplyConnectionConnectedInput {
  userId: string;
  connectionId: string;
  provisioning: SfProvisioningPayload;
  /** Where the call came from — drives the rotation-source tag. */
  source: 'oauth_exchange' | 'sf_push';
}

export interface ApplyCredentialRotatedInput {
  userId: string;
  payload: SfCredentialRotatedPayload;
  /** Optional event id for logging correlation. */
  eventId?: string | null;
}

export interface ApplyConnectionRevokedInput {
  userId: string;
  payload: SfConnectionRevokedPayload;
  initiator: 'sf_authority' | 'lb_user' | 'lb_admin';
  /** Optional event id for logging correlation. */
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
    const tokenIssuedAt = new Date(provisioning.token_issued_at);

    const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });

    // Idempotent re-delivery — same SF tenant + same issued_at = noop
    if (
      existing &&
      existing.status === 'active' &&
      existing.sfTenantId === provisioning.sf_tenant_id &&
      existing.tokenIssuedAt.getTime() === tokenIssuedAt.getTime()
    ) {
      this.logger.log(
        `[SfConnectionLifecycle] event=connected_noop user_id=${userId} sf_tenant_id=${provisioning.sf_tenant_id}` +
          ` source=${source} reason=identical_issued_at`,
      );
      return { ok: true, noop: true, connectionId: existing.id };
    }

    const encryptedToken = EncryptionUtil.encrypt(provisioning.orchestration_token, encryptionKey);
    const encryptedWebhookSecret = EncryptionUtil.encrypt(
      provisioning.webhook_signing_secret,
      encryptionKey,
    );
    const events = Array.isArray(provisioning.webhook_events) ? provisioning.webhook_events : [];
    const tokenExpiresAt = provisioning.token_expires_at
      ? new Date(provisioning.token_expires_at)
      : null;
    const now = new Date();

    // Transaction: upsert subscription + upsert connection atomically.
    // We use the provisioning.webhook_subscription_id as the SF-side id;
    // LB needs its own row, so we either find one matching that
    // sourceInstance OR create fresh.
    await this.prisma.$transaction(async (tx) => {
      // Find or create the CrmWebhookSubscription. SF gives us its own
      // subscription id; we store that in metadata + use it as the
      // X-SF-Subscription-Id contract identifier.
      const syntheticUrl = `sf://${provisioning.source_instance ?? 'sf-default'}/${userId}`;
      const sub = await tx.crmWebhookSubscription.upsert({
        where: {
          userId_direction_webhookUrl: {
            userId,
            direction: 'inbound',
            webhookUrl: syntheticUrl,
          },
        },
        create: {
          userId,
          name: `Service Flow (${provisioning.sf_tenant_name ?? provisioning.sf_tenant_id})`,
          webhookUrl: syntheticUrl,
          secret: encryptedWebhookSecret,
          events: events,
          direction: 'inbound',
          isActive: true,
          metadata: {
            sf_subscription_id: provisioning.webhook_subscription_id,
            signature_key_id: provisioning.webhook_signature_key_id ?? null,
          },
        },
        update: {
          name: `Service Flow (${provisioning.sf_tenant_name ?? provisioning.sf_tenant_id})`,
          secret: encryptedWebhookSecret,
          events: events,
          isActive: true,
          metadata: {
            sf_subscription_id: provisioning.webhook_subscription_id,
            signature_key_id: provisioning.webhook_signature_key_id ?? null,
          },
        },
      });

      const rotationSource = source === 'oauth_exchange' ? 'handshake' : 'sf_push';

      if (existing) {
        // Reconnect or re-deliver: keep original connectedAt for
        // audit; bump everything else.
        await tx.sfConnection.update({
          where: { userId },
          data: {
            sfTenantId: provisioning.sf_tenant_id,
            sfTenantName: provisioning.sf_tenant_name ?? null,
            baseUrl: provisioning.sf_base_url,
            sourceInstance: provisioning.source_instance ?? null,
            apiRegion: provisioning.api_region ?? null,
            signatureKeyId: provisioning.webhook_signature_key_id ?? null,
            orchestrationToken: encryptedToken,
            orchestrationTokenKid: provisioning.orchestration_token_kid ?? null,
            orchestrationTokenScope: provisioning.orchestration_token_scope ?? null,
            tokenIssuedAt,
            tokenExpiresAt,
            tokenLastReceivedAt: now,
            tokenLastRotationSource: rotationSource,
            // Reconnect clears any prior grace state
            previousOrchestrationToken: null,
            previousTokenExpiresAt: null,
            inboundSubscriptionId: sub.id,
            events: events,
            isActive: true,
            status: 'active',
            disconnectInitiator: null,
            disconnectedAt: null,
            lastErrorAt: null,
            lastErrorMessage: null,
            updatedAt: now,
          },
        });
      } else {
        // No prior row — create fresh. This is the path from a
        // first-time inbound connection.connected event (not the
        // OAuth flow, which always pre-creates the pending row).
        await tx.sfConnection.create({
          data: {
            id: connectionId,
            userId,
            sfTenantId: provisioning.sf_tenant_id,
            sfTenantName: provisioning.sf_tenant_name ?? null,
            baseUrl: provisioning.sf_base_url,
            sourceInstance: provisioning.source_instance ?? null,
            apiRegion: provisioning.api_region ?? null,
            signatureKeyId: provisioning.webhook_signature_key_id ?? null,
            orchestrationToken: encryptedToken,
            orchestrationTokenKid: provisioning.orchestration_token_kid ?? null,
            orchestrationTokenScope: provisioning.orchestration_token_scope ?? null,
            tokenIssuedAt,
            tokenExpiresAt,
            tokenLastReceivedAt: now,
            tokenLastRotationSource: rotationSource,
            inboundSubscriptionId: sub.id,
            events: events,
            isActive: true,
            status: 'active',
          },
        });
      }
    });

    this.logger.log(
      `[SfConnectionLifecycle] event=connected user_id=${userId} sf_tenant_id=${provisioning.sf_tenant_id}` +
        ` source_instance=${provisioning.source_instance ?? 'null'} api_region=${provisioning.api_region ?? 'null'}` +
        ` token_kid=${provisioning.orchestration_token_kid ?? 'null'} token_len=${provisioning.orchestration_token.length}` +
        ` events=${events.length} source=${source}`,
    );

    return { ok: true, connectionId };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // applyCredentialRotated
  // ═══════════════════════════════════════════════════════════════════════

  async applyCredentialRotated(input: ApplyCredentialRotatedInput): Promise<ApplyResult> {
    const { userId, payload, eventId } = input;
    const encryptionKey = this.getEncryptionKey();
    const newIssuedAt = new Date(payload.new_token_issued_at);
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
    const newEncrypted = EncryptionUtil.encrypt(payload.new_orchestration_token, encryptionKey);
    const newExpiresAt = payload.new_token_expires_at ? new Date(payload.new_token_expires_at) : null;

    await this.prisma.sfConnection.update({
      where: { userId },
      data: {
        previousOrchestrationToken: conn.orchestrationToken,
        previousTokenExpiresAt: previousExpiresAt,
        orchestrationToken: newEncrypted,
        orchestrationTokenKid: payload.new_orchestration_token_kid ?? null,
        tokenIssuedAt: newIssuedAt,
        tokenExpiresAt: newExpiresAt,
        tokenLastReceivedAt: new Date(),
        tokenLastRotationSource: 'sf_push',
        status: 'rotating',
        updatedAt: new Date(),
      },
    });

    this.logger.log(
      `[SfConnectionLifecycle] event=rotated user_id=${userId} event_id=${eventId ?? 'null'}` +
        ` new_token_kid=${payload.new_orchestration_token_kid ?? 'null'}` +
        ` new_token_len=${payload.new_orchestration_token.length} grace_seconds=${grace}`,
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

    // Idempotent: re-revoke is fine.
    const isAlreadyTerminal =
      conn.status === 'revoked' || conn.status === 'disconnected';

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
