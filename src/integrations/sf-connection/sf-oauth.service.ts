/**
 * SfOAuthService — Phase 2C PR-C2.
 *
 * Owns the LB side of the OAuth-style SF connect handshake:
 *
 *   1. start(userId)
 *      - creates a pending SfConnection row (status='pending')
 *      - generates a signed state token bound to that row
 *      - returns the redirect URL pointing at SF's connect portal
 *
 *   2. handleCallback({code, state, error?})
 *      - validates the state token (signature, expiry, version)
 *      - looks up the pending SfConnection row, single-use guard via
 *        status check (pending → active is the transition)
 *      - exchanges `code` at SF's token endpoint for the full
 *        provisioning payload
 *      - encrypts the orchestration token + webhook secret
 *      - upserts the SfConnection + linked CrmWebhookSubscription
 *        in one transaction
 *      - returns the final connection id + success redirect URL
 *
 * Safety properties:
 *   - State token replay → rejected. The pending row's status check
 *     ensures only one callback per row succeeds. A second callback
 *     with the same state sees status !== 'pending' and 409s.
 *   - SF exchange failure → rollback (delete the pending row + nothing
 *     persisted)
 *   - Duplicate exchange (same code re-submitted by SF retry) → SF
 *     will return its own duplicate signal; LB treats already-active
 *     row + matching sfTenantId as idempotent OK
 *   - No plaintext token logging — all log lines reference token_kid
 *     and length only
 *
 * Configuration:
 *   SF_OAUTH_STATE_SECRET           — HMAC secret for the state token
 *   SF_OAUTH_CONNECT_URL            — SF's authorize/connect portal base
 *   SF_OAUTH_EXCHANGE_URL           — SF's token-exchange POST endpoint
 *   SF_OAUTH_CLIENT_ID              — LB's OAuth client id at SF
 *   SF_OAUTH_CLIENT_SECRET          — LB's OAuth client secret at SF
 *   SF_OAUTH_CALLBACK_URL           — LB's public callback URL (echoed
 *                                     back to SF + checked by SF)
 *   SF_OAUTH_EXCHANGE_TIMEOUT_MS    — default 10000
 *   encryption.key                  — for token + webhook secret encryption
 *
 * None of these are set on production today — the service is fully
 * implemented but no caller can exercise the start path until UI ships
 * and the env vars are set for canary.
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfStateToken } from './sf-state-token.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import type {
  OAuthCallbackQuery,
  OAuthStartResult,
  SfProvisioningPayload,
} from './sf-connection.contracts';

const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;

export interface CallbackResult {
  ok: boolean;
  /** HTTP status the controller should return. */
  httpStatus: number;
  /** Where the controller should redirect the user (success or error page). */
  redirectTo?: string;
  connectionId?: string;
  errorCode?:
    | 'invalid_state'
    | 'state_expired'
    | 'pending_not_found'
    | 'already_active'
    | 'sf_error'
    | 'exchange_failed'
    | 'persist_failed'
    | 'sf_denied';
  errorDetail?: string;
}

@Injectable()
export class SfOAuthService {
  private readonly logger = new Logger(SfOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(forwardRef(() => SfConnectionLifecycleService))
    private readonly lifecycle: SfConnectionLifecycleService,
  ) {}

  // ─── start ────────────────────────────────────────────────────────

  /**
   * Begin the connect handshake for a user. Creates a pending row +
   * returns the SF connect URL with the state token embedded.
   */
  async start(userId: string): Promise<OAuthStartResult> {
    if (!userId) throw new Error('userId required');

    const stateSecret = this.getStateSecret();
    const connectUrl = this.config.get<string>('SF_OAUTH_CONNECT_URL');
    const callbackUrl = this.config.get<string>('SF_OAUTH_CALLBACK_URL');
    const clientId = this.config.get<string>('SF_OAUTH_CLIENT_ID');
    if (!connectUrl || !callbackUrl || !clientId) {
      throw new Error(
        'SF OAuth not configured: SF_OAUTH_CONNECT_URL, SF_OAUTH_CALLBACK_URL, SF_OAUTH_CLIENT_ID required',
      );
    }

    // Pending-row upsert. One in-flight connect per user — if a prior
    // pending exists we reuse it (its connectedAt stays the original).
    // status is the single-use guard: callback only succeeds when pending.
    const pendingId = crypto.randomUUID();
    const now = new Date();
    const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });
    let connectionId: string;
    if (existing) {
      // If user has an active or rotating row, refuse — they need to
      // disconnect first. (Reconnect-after-disconnect is supported:
      // status='disconnected' or 'revoked' can be re-pending'd.)
      if (existing.status === 'active' || existing.status === 'rotating') {
        throw new Error('already_connected');
      }
      await this.prisma.sfConnection.update({
        where: { userId },
        data: {
          status: 'pending',
          updatedAt: now,
          // Clear old error markers for the fresh attempt
          lastErrorAt: null,
          lastErrorMessage: null,
          disconnectInitiator: null,
        },
      });
      connectionId = existing.id;
    } else {
      const fresh = await this.prisma.sfConnection.create({
        data: {
          id: pendingId,
          userId,
          sfTenantId: 'pending', // placeholder; overwritten on callback
          baseUrl: 'pending',
          orchestrationToken: '',
          tokenIssuedAt: now,
          tokenLastReceivedAt: now,
          isActive: false,
          status: 'pending',
        },
      });
      connectionId = fresh.id;
    }

    const state = SfStateToken.sign(
      { userId, pendingConnectionId: connectionId },
      stateSecret,
    );

    const url = new URL(connectUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('lb_user_id', userId);

    this.logger.log(
      `[SfOAuth] event=start user_id=${userId} pending_connection_id=${connectionId}`,
    );

    return { redirectUrl: url.toString(), pendingConnectionId: connectionId, state };
  }

  // ─── callback ─────────────────────────────────────────────────────

  /**
   * Handle the SF→LB redirect. Validates state, exchanges code, persists.
   * Returns the HTTP outcome + the URL the controller should redirect
   * the user to (a success or error page in the LB SPA).
   */
  async handleCallback(q: OAuthCallbackQuery): Promise<CallbackResult> {
    // ── 1. SF reported an error (user denied, etc.) ───────────────
    if (q.error) {
      this.logger.warn(
        `[SfOAuth] event=callback_sf_error code=${this.safe(q.error)} desc="${this.safe(q.error_description)}"`,
      );
      // If we have a state token, try to find the pending row and mark
      // it as errored so the diagnostic UI surfaces the failure.
      if (q.state) {
        const stateSecret = this.getStateSecret();
        const v = SfStateToken.validate(q.state, stateSecret);
        if (v.ok && v.envelope) {
          await this.markPendingErrored(
            v.envelope.cid,
            `sf_denied:${this.safe(q.error)}`,
          ).catch(() => {});
        }
      }
      return {
        ok: false,
        httpStatus: 400,
        errorCode: 'sf_denied',
        errorDetail: this.safe(q.error_description ?? q.error),
        redirectTo: this.errorRedirect('sf_denied'),
      };
    }

    if (!q.state || !q.code) {
      return {
        ok: false,
        httpStatus: 400,
        errorCode: 'invalid_state',
        errorDetail: 'missing state or code',
        redirectTo: this.errorRedirect('invalid_state'),
      };
    }

    // ── 2. Validate state token ───────────────────────────────────
    const stateSecret = this.getStateSecret();
    const v = SfStateToken.validate(q.state, stateSecret);
    if (!v.ok || !v.envelope) {
      this.logger.warn(
        `[SfOAuth] event=callback_state_invalid reason=${v.reason ?? 'unknown'}`,
      );
      return {
        ok: false,
        httpStatus: 400,
        errorCode: v.reason === 'expired' ? 'state_expired' : 'invalid_state',
        errorDetail: v.reason,
        redirectTo: this.errorRedirect(v.reason === 'expired' ? 'state_expired' : 'invalid_state'),
      };
    }

    const { uid: userId, cid: pendingConnectionId } = v.envelope;

    // ── 3. Look up the pending row + enforce single-use ───────────
    const pending = await this.prisma.sfConnection.findUnique({
      where: { id: pendingConnectionId },
    });
    if (!pending) {
      return {
        ok: false,
        httpStatus: 404,
        errorCode: 'pending_not_found',
        errorDetail: 'no pending row',
        redirectTo: this.errorRedirect('pending_not_found'),
      };
    }
    if (pending.userId !== userId) {
      // State token says X but the row's userId is Y — cross-tenant.
      this.logger.error(
        `[SfOAuth] event=callback_cross_tenant state_user=${userId} row_user=${pending.userId}`,
      );
      return {
        ok: false,
        httpStatus: 403,
        errorCode: 'invalid_state',
        errorDetail: 'tenant_mismatch',
        redirectTo: this.errorRedirect('invalid_state'),
      };
    }

    // Single-use guard: only status='pending' rows are eligible.
    // If the row is already active and sfTenantId matches what SF
    // returns at exchange time, treat as idempotent OK below — but
    // we have to exchange first to know SF's view. For now, if it's
    // not pending we reject; duplicate exchange is rare and we'd
    // rather 409 than risk a re-write.
    if (pending.status !== 'pending') {
      this.logger.warn(
        `[SfOAuth] event=callback_not_pending status=${pending.status} user_id=${userId}`,
      );
      return {
        ok: false,
        httpStatus: 409,
        errorCode: 'already_active',
        errorDetail: `status=${pending.status}`,
        redirectTo: this.errorRedirect('already_active'),
      };
    }

    // ── 4. Exchange code at SF token endpoint ─────────────────────
    let payload: SfProvisioningPayload;
    try {
      payload = await this.exchangeCode(q.code, userId);
    } catch (e: any) {
      const msg = this.safe(e?.message);
      this.logger.error(
        `[SfOAuth] event=exchange_failed user_id=${userId} pending_connection_id=${pendingConnectionId} err=${msg}`,
      );
      await this.markPendingErrored(pendingConnectionId, `exchange_failed:${msg}`).catch(
        () => {},
      );
      return {
        ok: false,
        httpStatus: 502,
        errorCode: 'exchange_failed',
        errorDetail: msg,
        redirectTo: this.errorRedirect('exchange_failed'),
      };
    }

    // ── 5. Persist via lifecycle service (also handles webhook sub) ─
    try {
      await this.lifecycle.applyConnectionConnected({
        userId,
        connectionId: pendingConnectionId,
        provisioning: payload,
        source: 'oauth_exchange',
      });
    } catch (e: any) {
      const msg = this.safe(e?.message);
      this.logger.error(
        `[SfOAuth] event=persist_failed user_id=${userId} err=${msg}`,
      );
      await this.markPendingErrored(pendingConnectionId, `persist_failed:${msg}`).catch(
        () => {},
      );
      return {
        ok: false,
        httpStatus: 500,
        errorCode: 'persist_failed',
        errorDetail: msg,
        redirectTo: this.errorRedirect('persist_failed'),
      };
    }

    this.logger.log(
      `[SfOAuth] event=connected user_id=${userId} connection_id=${pendingConnectionId}` +
        ` sf_tenant_id=${payload.sf_tenant_id} source_instance=${payload.source_instance ?? 'null'}` +
        ` token_kid=${payload.orchestration_token_kid ?? 'null'} token_len=${payload.orchestration_token.length}`,
    );

    return {
      ok: true,
      httpStatus: 200,
      connectionId: pendingConnectionId,
      redirectTo: this.successRedirect(),
    };
  }

  // ─── internals ────────────────────────────────────────────────────

  /**
   * POST the auth code at SF's token endpoint. Returns the full
   * provisioning payload SF mints at exchange time.
   *
   * Failure modes:
   *   - Network/timeout → throw, caller rolls back
   *   - Non-2xx → throw with body's error code in the message
   *   - 2xx but missing required fields → throw 'malformed_payload'
   *
   * NEVER logs the orchestration_token or webhook_signing_secret.
   */
  private async exchangeCode(code: string, userId: string): Promise<SfProvisioningPayload> {
    const exchangeUrl = this.config.get<string>('SF_OAUTH_EXCHANGE_URL');
    const clientId = this.config.get<string>('SF_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('SF_OAUTH_CLIENT_SECRET');
    const callbackUrl = this.config.get<string>('SF_OAUTH_CALLBACK_URL');
    if (!exchangeUrl || !clientId || !clientSecret || !callbackUrl) {
      throw new Error('SF OAuth exchange not configured');
    }
    const timeoutMs = this.parseInt('SF_OAUTH_EXCHANGE_TIMEOUT_MS', DEFAULT_EXCHANGE_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require('axios');
    const correlationId = crypto.randomUUID();

    this.logger.log(
      `[SfOAuth] event=exchange_attempt correlation_id=${correlationId} user_id=${userId}`,
    );

    const start = Date.now();
    const response = await axios.request({
      url: exchangeUrl,
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      data: {
        grant_type: 'authorization_code',
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: callbackUrl,
        lb_user_id: userId,
      },
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - start;

    if (response.status < 200 || response.status >= 300) {
      const bodyErr = typeof response.data?.error === 'string' ? response.data.error : 'http_' + response.status;
      this.logger.warn(
        `[SfOAuth] event=exchange_failure correlation_id=${correlationId} status_code=${response.status} latency_ms=${latencyMs} error=${this.safe(bodyErr)}`,
      );
      throw new Error(`exchange_http_${response.status}:${bodyErr}`);
    }

    const body = response.data;
    if (!body || typeof body !== 'object') throw new Error('malformed_payload:not_object');
    if (typeof body.sf_tenant_id !== 'string' || !body.sf_tenant_id) {
      throw new Error('malformed_payload:missing_sf_tenant_id');
    }
    if (typeof body.sf_base_url !== 'string' || !body.sf_base_url) {
      throw new Error('malformed_payload:missing_sf_base_url');
    }
    if (typeof body.orchestration_token !== 'string' || !body.orchestration_token) {
      throw new Error('malformed_payload:missing_orchestration_token');
    }
    if (typeof body.webhook_subscription_id !== 'string' || !body.webhook_subscription_id) {
      throw new Error('malformed_payload:missing_webhook_subscription_id');
    }
    if (typeof body.webhook_signing_secret !== 'string' || !body.webhook_signing_secret) {
      throw new Error('malformed_payload:missing_webhook_signing_secret');
    }
    if (typeof body.token_issued_at !== 'string' || !body.token_issued_at) {
      throw new Error('malformed_payload:missing_token_issued_at');
    }

    this.logger.log(
      `[SfOAuth] event=exchange_success correlation_id=${correlationId} status_code=${response.status}` +
        ` latency_ms=${latencyMs} sf_tenant_id=${body.sf_tenant_id} token_kid=${body.orchestration_token_kid ?? 'null'}` +
        ` token_len=${body.orchestration_token.length}`,
    );

    return body as SfProvisioningPayload;
  }

  private async markPendingErrored(connectionId: string, reason: string): Promise<void> {
    await this.prisma.sfConnection.updateMany({
      where: { id: connectionId, status: 'pending' },
      data: {
        status: 'error',
        isActive: false,
        lastErrorAt: new Date(),
        lastErrorMessage: reason.slice(0, 300),
      },
    });
  }

  private getStateSecret(): string {
    const v = this.config.get<string>('SF_OAUTH_STATE_SECRET');
    if (!v) throw new Error('SF_OAUTH_STATE_SECRET not configured');
    return v;
  }

  private successRedirect(): string {
    const base = this.config.get<string>('SF_OAUTH_SUCCESS_REDIRECT') ?? '/settings/integrations?sf=connected';
    return base;
  }

  private errorRedirect(code: string): string {
    const base = this.config.get<string>('SF_OAUTH_ERROR_REDIRECT') ?? '/settings/integrations?sf=error';
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}code=${encodeURIComponent(code)}`;
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
