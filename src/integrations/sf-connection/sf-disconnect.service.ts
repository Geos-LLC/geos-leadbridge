/**
 * SfDisconnectService — Phase 2C PR-C2.
 *
 * Handles the LB-initiated disconnect path:
 *
 *   1. Look up the SfConnection by userId
 *   2. Best-effort POST to SF revoke endpoint with the current Bearer
 *      token (the token is decrypted just-in-time, never logged)
 *   3. Hand off to SfConnectionLifecycleService.applyConnectionRevoked
 *      with initiator='lb_user' or 'lb_admin' — that updates the row
 *      to status='disconnected' and deactivates the inbound subscription
 *
 * Idempotency:
 *   - Calling disconnect on an already-disconnected/revoked row is OK
 *     — returns success without calling SF again
 *   - Calling disconnect on a row that SF already remote-revoked (we
 *     received the connection.revoked event first) returns success
 *     too, since the local state matches
 *   - Calling disconnect on a pending row marks it disconnected (the
 *     pending handshake is effectively abandoned)
 *
 * Never throws to the controller.
 *
 * No plaintext token in logs.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import type {
  SfDisconnectRequest,
  SfDisconnectResponse,
} from './sf-connection.contracts';

const DEFAULT_REVOKE_TIMEOUT_MS = 5_000;

export interface DisconnectInput {
  userId: string;
  request: SfDisconnectRequest;
}

@Injectable()
export class SfDisconnectService {
  private readonly logger = new Logger(SfDisconnectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly lifecycle: SfConnectionLifecycleService,
  ) {}

  async disconnect(input: DisconnectInput): Promise<SfDisconnectResponse> {
    const { userId, request } = input;
    const conn = await this.prisma.sfConnection.findUnique({ where: { userId } });

    // ── 1. No connection — nothing to do (idempotent) ────────────
    if (!conn) {
      this.logger.log(
        `[SfDisconnect] event=noop user_id=${userId} reason=no_connection`,
      );
      return { success: true, remote_revoked: false, status: 'disconnected' };
    }

    // ── 2. Already terminal — idempotent ─────────────────────────
    if (conn.status === 'disconnected' || conn.status === 'revoked') {
      this.logger.log(
        `[SfDisconnect] event=noop user_id=${userId} reason=already_${conn.status}`,
      );
      return {
        success: true,
        remote_revoked: conn.status === 'revoked',
        status: conn.status,
      };
    }

    // ── 3. Best-effort remote revoke ─────────────────────────────
    // We don't bail on remote failure — local state must reach
    // disconnected regardless. SF's connection.revoked webhook may
    // arrive later; the lifecycle service handles re-revoke idempotently.
    let remoteOk = false;
    let remoteErr: string | undefined;
    try {
      remoteOk = await this.attemptRemoteRevoke(conn, request);
    } catch (e: any) {
      remoteErr = this.safe(e?.message);
    }

    // ── 4. Apply local state ─────────────────────────────────────
    const initiator = request.initiator;
    await this.lifecycle.applyConnectionRevoked({
      userId,
      payload: {
        reason: remoteOk ? 'lb_initiated' : `lb_initiated_remote_failed${remoteErr ? ':' + remoteErr : ''}`,
        detail: request.reason ?? null,
      },
      initiator,
    });

    this.logger.log(
      `[SfDisconnect] event=completed user_id=${userId} initiator=${initiator}` +
        ` remote_revoked=${remoteOk} remote_err=${remoteErr ?? 'none'}`,
    );

    return {
      success: true,
      remote_revoked: remoteOk,
      status: 'disconnected',
    };
  }

  /**
   * Decrypt the orchestration token and call SF's revoke endpoint.
   * Returns true on 2xx, false on any non-2xx. Throws on network /
   * timeout / decrypt failures.
   *
   * NEVER logs the decrypted token. Logs token_len + token_kid only.
   */
  private async attemptRemoteRevoke(
    conn: {
      id: string;
      baseUrl: string;
      orchestrationToken: string;
      orchestrationTokenKid: string | null;
      sfTenantId: string;
      userId: string;
    },
    request: SfDisconnectRequest,
  ): Promise<boolean> {
    if (!conn.baseUrl || !conn.orchestrationToken) {
      this.logger.warn(
        `[SfDisconnect] event=remote_skipped user_id=${conn.userId} reason=missing_creds`,
      );
      return false;
    }
    const encryptionKey = this.config.get<string>('encryption.key');
    if (!encryptionKey) {
      this.logger.error(
        `[SfDisconnect] event=remote_failed user_id=${conn.userId} reason=encryption_key_unset`,
      );
      return false;
    }
    let token: string;
    try {
      token = EncryptionUtil.decrypt(conn.orchestrationToken, encryptionKey);
    } catch (e: any) {
      this.logger.warn(
        `[SfDisconnect] event=remote_skipped user_id=${conn.userId} reason=decrypt_failed`,
      );
      return false;
    }

    const url = conn.baseUrl.replace(/\/$/, '') + '/api/integrations/leadbridge/orchestration/disconnect';
    const timeoutMs = this.parseInt('SF_OAUTH_REVOKE_TIMEOUT_MS', DEFAULT_REVOKE_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require('axios');

    const start = Date.now();
    const response = await axios.request({
      url,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'X-LB-User-Id': conn.userId,
      },
      data: {
        sf_tenant_id: conn.sfTenantId,
        initiator: request.initiator,
        reason: request.reason ?? null,
      },
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - start;
    const ok = response.status >= 200 && response.status < 300;

    this.logger.log(
      `[SfDisconnect] event=remote_${ok ? 'success' : 'failure'} user_id=${conn.userId}` +
        ` status_code=${response.status} latency_ms=${latencyMs} token_kid=${conn.orchestrationTokenKid ?? 'null'} token_len=${token.length}`,
    );
    return ok;
  }

  private parseInt(envName: string, def: number): number {
    const raw = this.config.get<string>(envName);
    if (raw == null) return def;
    const n = parseInt(String(raw), 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  private safe(s: any): string {
    if (typeof s !== 'string') return String(s ?? '');
    return s.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
}
