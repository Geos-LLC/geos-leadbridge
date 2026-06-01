/**
 * SfConnectionStatusService — PR-C3.
 *
 * Read-only, user-safe view of the SF connection for the Settings → Integrations UI.
 *
 * Returns NO secrets:
 *   - orchestrationToken (encrypted at rest; never decrypted here)
 *   - webhook signing secret (encrypted at rest; lives on CrmWebhookSubscription)
 *   - encryption key material
 *
 * Returns only metadata safe to display to the tenant user:
 *   - status / isActive / disconnect lineage
 *   - sfTenantId / sfTenantName / sourceInstance
 *   - signatureKeyId / tokenPrefix (the 13-char safe prefix, never the full token)
 *   - connection lifecycle timestamps
 *   - rotation-pending signal (R1) so the UI can show an "auto-refresh in progress" badge
 *     without revealing the new credential
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/utils/prisma.service';

export interface SfConnectionStatusResponse {
  /** Whether LB has a connection row that is currently usable for outbound. */
  connected: boolean;
  /** Raw lifecycle status: 'pending' | 'active' | 'rotating' | 'disconnected' | 'revoked' | 'error' | 'none' (no row). */
  status: string;
  sfTenantId: string | null;
  sfTenantName: string | null;
  sourceInstance: string | null;
  signatureKeyId: string | null;
  /** 13-char safe prefix of the orchestration token. Safe to display; not the full token. */
  tokenPrefix: string | null;
  /** When LB last received a token from SF (handshake or refresh). */
  tokenLastReceivedAt: Date | null;
  /** SF-declared token expiry (informational; SF is the authority). */
  tokenExpiresAt: Date | null;
  connectedAt: Date | null;
  disconnectedAt: Date | null;
  /** Who initiated the most recent disconnect: 'lb_user' | 'sf_authority' | 'lb_admin' | null. */
  disconnectInitiator: string | null;
  lastErrorMessage: string | null;
  /** R1: SF has notified LB of a credential rotation. Bearer remains valid until graceExpiresAt. */
  rotationPending: boolean;
  pendingRotationGraceExpiresAt: Date | null;
}

@Injectable()
export class SfConnectionStatusService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatusForUser(userId: string): Promise<SfConnectionStatusResponse> {
    const conn = await this.prisma.sfConnection.findUnique({
      where: { userId },
      select: {
        isActive: true,
        status: true,
        sfTenantId: true,
        sfTenantName: true,
        sourceInstance: true,
        signatureKeyId: true,
        tokenPrefix: true,
        tokenLastReceivedAt: true,
        tokenExpiresAt: true,
        connectedAt: true,
        disconnectedAt: true,
        disconnectInitiator: true,
        lastErrorMessage: true,
        rotationPending: true,
        pendingRotationGraceExpiresAt: true,
      },
    });

    if (!conn) {
      return {
        connected: false,
        status: 'none',
        sfTenantId: null,
        sfTenantName: null,
        sourceInstance: null,
        signatureKeyId: null,
        tokenPrefix: null,
        tokenLastReceivedAt: null,
        tokenExpiresAt: null,
        connectedAt: null,
        disconnectedAt: null,
        disconnectInitiator: null,
        lastErrorMessage: null,
        rotationPending: false,
        pendingRotationGraceExpiresAt: null,
      };
    }

    const connected = conn.isActive && (conn.status === 'active' || conn.status === 'rotating');

    return {
      connected,
      status: conn.status,
      sfTenantId: conn.sfTenantId,
      sfTenantName: conn.sfTenantName ?? null,
      sourceInstance: conn.sourceInstance ?? null,
      signatureKeyId: conn.signatureKeyId ?? null,
      tokenPrefix: conn.tokenPrefix ?? null,
      tokenLastReceivedAt: conn.tokenLastReceivedAt ?? null,
      tokenExpiresAt: conn.tokenExpiresAt ?? null,
      connectedAt: conn.connectedAt ?? null,
      disconnectedAt: conn.disconnectedAt ?? null,
      disconnectInitiator: conn.disconnectInitiator ?? null,
      lastErrorMessage: conn.lastErrorMessage ?? null,
      rotationPending: conn.rotationPending ?? false,
      pendingRotationGraceExpiresAt: conn.pendingRotationGraceExpiresAt ?? null,
    };
  }
}
