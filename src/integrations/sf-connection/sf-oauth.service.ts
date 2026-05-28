/**
 * SfOAuthService — Phase 2C PR-C2.1 — canonical SF S4 flow.
 *
 * Owns the LB side of the OAuth-style SF connect handshake.
 *
 *   1. start(userId)
 *      - creates a pending SfConnection row (status='pending')
 *      - generates a signed state token bound to that row
 *      - returns the redirect URL pointing at SF's connect portal
 *
 *   2. handleCallback({code, state, error?})
 *      - validates the state token
 *      - looks up the pending row, single-use guard
 *      - **generates a fresh LB-side webhook signing secret** (32 random
 *        bytes, base64), since SF expects LB to supply it in the exchange
 *        request (SF stores it server-side and echoes only `secret_set: true`)
 *      - POSTs to SF /oauth/exchange with code + LB OAuth client
 *        credentials + LB-authored webhook block
 *      - parses `{ connected: true, provisioning: {...} }`, validates
 *        `version: '1'` + `signature_metadata.algorithm`
 *      - hands off to lifecycle service with both the SF payload AND the
 *        LB-generated webhook secret (so the lifecycle layer can encrypt
 *        and store it as the inbound subscription secret)
 *
 * 409 handling (canonical):
 *   - `code_already_used` (replay)        → look up existing connection,
 *                                            return idempotent success
 *   - `already_connected` (active tenant) → return 409 to caller; UI
 *                                            should surface "already
 *                                            connected, disconnect first"
 *
 * No plaintext token logging — log_safe writes token_kid + token_len +
 * token_prefix only.
 *
 * No plaintext webhook secret logging — log_safe writes secret_len only.
 *
 * Configuration:
 *   SF_OAUTH_STATE_SECRET           — HMAC secret for state token
 *   SF_OAUTH_CONNECT_URL            — SF authorize portal base
 *   SF_OAUTH_EXCHANGE_URL           — SF token-exchange POST endpoint
 *   SF_OAUTH_CLIENT_ID              — LB's OAuth client id at SF
 *   SF_OAUTH_CLIENT_SECRET          — LB's OAuth client secret at SF
 *   SF_OAUTH_CALLBACK_URL           — LB's public callback URL
 *   SF_OAUTH_EXCHANGE_TIMEOUT_MS    — default 10000
 *   encryption.key                  — for token + webhook secret encryption
 */

import { Inject, Injectable, Logger, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../common/utils/prisma.service';
import { SfStateToken } from './sf-state-token.util';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import type {
  OAuthCallbackQuery,
  OAuthStartResult,
  SfExchangeRequest,
  SfExchangeResponse,
  SfProvisioningPayload,
} from './sf-connection.contracts';

const DEFAULT_EXCHANGE_TIMEOUT_MS = 10_000;
const SF_LOCKED_VERSION = '1';
const SF_LOCKED_SIGNATURE_ALGORITHM = 'hmac-sha256-hex';
const SF_LOCKED_SIGNATURE_SKEW = 300;
const SF_LOCKED_SCOPE = 'lb_orchestration';

export interface CallbackResult {
  ok: boolean;
  httpStatus: number;
  redirectTo?: string;
  connectionId?: string;
  /** When 409 code_already_used: existing connection id we resolved. */
  resolvedExistingConnectionId?: string | null;
  errorCode?:
    | 'invalid_state'
    | 'state_expired'
    | 'pending_not_found'
    | 'already_active'
    | 'sf_denied'
    | 'exchange_failed'
    | 'exchange_invalid_client'
    | 'exchange_invalid_code'
    | 'exchange_code_expired'
    | 'exchange_redirect_mismatch'
    | 'exchange_webhook_rejected'
    | 'exchange_already_connected'
    | 'exchange_service_unavailable'
    | 'invalid_provisioning_payload'
    | 'persist_failed';
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

    const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });
    let connectionId: string;
    if (existing) {
      if (existing.status === 'active' || existing.status === 'rotating') {
        throw new Error('already_connected');
      }
      await this.prisma.sfConnection.update({
        where: { userId },
        data: {
          status: 'pending',
          updatedAt: new Date(),
          lastErrorAt: null,
          lastErrorMessage: null,
          disconnectInitiator: null,
        },
      });
      connectionId = existing.id;
    } else {
      const now = new Date();
      const fresh = await this.prisma.sfConnection.create({
        data: {
          id: crypto.randomUUID(),
          userId,
          sfTenantId: 'pending',
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

    // Build the SF authorize URL with SF-required query params per S4 spec:
    //   client_id, redirect_uri, state, scope, response_type
    const url = new URL(connectUrl);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('state', state);
    url.searchParams.set('scope', SF_LOCKED_SCOPE);
    url.searchParams.set('response_type', 'code');

    this.logger.log(
      `[SfOAuth] event=start user_id=${userId} pending_connection_id=${connectionId}`,
    );

    return { redirectUrl: url.toString(), pendingConnectionId: connectionId, state };
  }

  // ─── callback ─────────────────────────────────────────────────────

  async handleCallback(q: OAuthCallbackQuery): Promise<CallbackResult> {
    // SF reported error in the redirect
    if (q.error) {
      this.logger.warn(
        `[SfOAuth] event=callback_sf_error code=${this.safe(q.error)} desc="${this.safe(q.error_description)}"`,
      );
      if (q.state) {
        const v = SfStateToken.validate(q.state, this.getStateSecret());
        if (v.ok && v.envelope) {
          await this.markPendingErrored(v.envelope.cid, `sf_denied:${this.safe(q.error)}`).catch(() => {});
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

    const v = SfStateToken.validate(q.state, this.getStateSecret());
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

    // ── Generate LB-side webhook secret (canonical: LB authors) ────
    const webhookSecret = crypto.randomBytes(32).toString('base64');  // 44 chars
    const subscriptionId = `lb_sub_${pendingConnectionId}`;
    const stateRef = `lb_conn_${pendingConnectionId}`;
    const callbackUrl = this.config.get<string>('SF_OAUTH_CALLBACK_URL');
    if (!callbackUrl) {
      return {
        ok: false, httpStatus: 500,
        errorCode: 'exchange_failed', errorDetail: 'SF_OAUTH_CALLBACK_URL missing',
        redirectTo: this.errorRedirect('exchange_failed'),
      };
    }
    const webhookUrl = this.deriveWebhookUrl(callbackUrl);

    // ── Exchange code at SF ───────────────────────────────────────
    let exchange: { ok: true; payload: SfProvisioningPayload } | { ok: false; status: number; bodyError?: string; priorCredentialId?: number | null; rawBody?: any };
    try {
      exchange = await this.exchangeCode(
        {
          code: q.code,
          redirect_uri: callbackUrl,
          webhook: { url: webhookUrl, secret: webhookSecret, subscription_id: subscriptionId, state_ref: stateRef },
        },
        userId,
      );
    } catch (e: any) {
      const msg = this.safe(e?.message);
      this.logger.error(
        `[SfOAuth] event=exchange_threw user_id=${userId} pending_connection_id=${pendingConnectionId} err=${msg}`,
      );
      await this.markPendingErrored(pendingConnectionId, `exchange_threw:${msg}`).catch(() => {});
      return {
        ok: false, httpStatus: 502,
        errorCode: 'exchange_failed', errorDetail: msg,
        redirectTo: this.errorRedirect('exchange_failed'),
      };
    }

    if (!exchange.ok) {
      const { status, bodyError, priorCredentialId } = exchange;

      // 409 code_already_used — SF says LB has already consumed this code.
      // Look up the existing connection by prior_credential_id (if SF gave us
      // one) or fall through to the userId-keyed lookup. Treat as idempotent
      // success when we find an active row.
      if (status === 409 && bodyError === 'code_already_used') {
        const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });
        if (existing && (existing.status === 'active' || existing.status === 'rotating')) {
          this.logger.log(
            `[SfOAuth] event=code_already_used_idempotent_ok user_id=${userId}` +
              ` prior_credential_id=${priorCredentialId ?? 'null'} existing_connection_id=${existing.id}`,
          );
          return {
            ok: true,
            httpStatus: 200,
            connectionId: existing.id,
            resolvedExistingConnectionId: existing.id,
            redirectTo: this.successRedirect(),
          };
        }
        // No active row to resolve to — treat as failure.
        await this.markPendingErrored(pendingConnectionId, `code_already_used_no_existing`).catch(() => {});
        return {
          ok: false, httpStatus: 409,
          errorCode: 'exchange_invalid_code',
          errorDetail: `code_already_used (no_existing_active)`,
          redirectTo: this.errorRedirect('exchange_invalid_code'),
        };
      }

      // 409 already_connected — tenant has an active credential at SF but
      // LB doesn't know about it (or out of sync). Caller should disconnect first.
      if (status === 409 && bodyError === 'already_connected') {
        await this.markPendingErrored(pendingConnectionId, 'already_connected').catch(() => {});
        return {
          ok: false, httpStatus: 409,
          errorCode: 'exchange_already_connected',
          errorDetail: 'tenant already has active credential at SF',
          redirectTo: this.errorRedirect('already_connected'),
        };
      }

      // Other errors — map to specific code for UI handling
      const code = this.mapExchangeError(status, bodyError);
      await this.markPendingErrored(pendingConnectionId, `${code}:${bodyError ?? 'unknown'}`).catch(() => {});
      return {
        ok: false, httpStatus: status >= 500 ? 502 : 400,
        errorCode: code,
        errorDetail: `${bodyError ?? 'http_' + status}`,
        redirectTo: this.errorRedirect(code),
      };
    }

    const payload = exchange.payload;

    // ── Validate provisioning payload (locked fields) ────────────
    const validation = this.validateProvisioningPayload(payload);
    if (!validation.ok) {
      await this.markPendingErrored(pendingConnectionId, `invalid_payload:${validation.reason}`).catch(() => {});
      this.logger.error(
        `[SfOAuth] event=invalid_provisioning_payload user_id=${userId} reason=${validation.reason}`,
      );
      return {
        ok: false, httpStatus: 502,
        errorCode: 'invalid_provisioning_payload',
        errorDetail: validation.reason,
        redirectTo: this.errorRedirect('invalid_provisioning_payload'),
      };
    }

    // ── Persist (lifecycle service) ───────────────────────────────
    try {
      await this.lifecycle.applyConnectionConnected({
        userId,
        connectionId: pendingConnectionId,
        provisioning: payload,
        webhookSecretPlaintext: webhookSecret,
        webhookUrl,
        webhookSubscriptionId: subscriptionId,
        webhookStateRef: stateRef,
        source: 'oauth_exchange',
      });
    } catch (e: any) {
      const msg = this.safe(e?.message);
      this.logger.error(
        `[SfOAuth] event=persist_failed user_id=${userId} err=${msg}`,
      );
      await this.markPendingErrored(pendingConnectionId, `persist_failed:${msg}`).catch(() => {});
      return {
        ok: false, httpStatus: 500,
        errorCode: 'persist_failed', errorDetail: msg,
        redirectTo: this.errorRedirect('persist_failed'),
      };
    }

    this.logger.log(
      `[SfOAuth] event=connected user_id=${userId} connection_id=${pendingConnectionId}` +
        ` sf_tenant_id=${payload.tenant.sf_tenant_id} source_instance=${payload.tenant.source_instance}` +
        ` token_kid=${payload.credential.kid} token_prefix=${payload.credential.token_prefix}` +
        ` token_len=${payload.credential.token.length}`,
    );

    return {
      ok: true,
      httpStatus: 200,
      connectionId: pendingConnectionId,
      redirectTo: this.successRedirect(),
    };
  }

  // ─── exchangeCode (internal) ──────────────────────────────────────

  /**
   * POST the auth code at SF's /oauth/exchange endpoint. LB authors the
   * webhook block (URL + secret + subscription_id + state_ref) — SF
   * stores the secret server-side and echoes only `secret_set: true`.
   *
   * Returns a discriminated result instead of throwing on non-2xx so the
   * caller can route on the specific SF error code. Network/parse
   * failures still throw.
   */
  private async exchangeCode(
    args: {
      code: string;
      redirect_uri: string;
      webhook: SfExchangeRequest['webhook'];
    },
    userId: string,
  ): Promise<
    | { ok: true; payload: SfProvisioningPayload }
    | { ok: false; status: number; bodyError?: string; priorCredentialId?: number | null; rawBody?: any }
  > {
    const exchangeUrl = this.config.get<string>('SF_OAUTH_EXCHANGE_URL');
    const clientId = this.config.get<string>('SF_OAUTH_CLIENT_ID');
    const clientSecret = this.config.get<string>('SF_OAUTH_CLIENT_SECRET');
    if (!exchangeUrl || !clientId || !clientSecret) {
      throw new Error('SF OAuth exchange not configured');
    }
    const timeoutMs = this.parseInt('SF_OAUTH_EXCHANGE_TIMEOUT_MS', DEFAULT_EXCHANGE_TIMEOUT_MS);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = require('axios');
    const correlationId = crypto.randomUUID();

    const body: SfExchangeRequest = {
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      redirect_uri: args.redirect_uri,
      webhook: args.webhook,
    };

    this.logger.log(
      `[SfOAuth] event=exchange_attempt correlation_id=${correlationId} user_id=${userId}` +
        ` webhook_url=${args.webhook.url} subscription_id=${args.webhook.subscription_id ?? 'null'}` +
        ` webhook_secret_len=${args.webhook.secret.length}`,
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
      data: body,
      validateStatus: () => true,
    });
    const latencyMs = Date.now() - start;

    if (response.status >= 200 && response.status < 300) {
      const parsed = response.data as SfExchangeResponse;
      if (!parsed || typeof parsed !== 'object' || parsed.connected !== true || !parsed.provisioning) {
        // SF returned 2xx but with a shape we don't recognize. Treat as error.
        this.logger.error(
          `[SfOAuth] event=exchange_success_but_malformed correlation_id=${correlationId} status_code=${response.status}`,
        );
        return { ok: false, status: response.status, bodyError: 'malformed_2xx_response', rawBody: parsed };
      }
      // Be defensive in logging — if SF returned 2xx with a partially
      // malformed payload, the validator (validateProvisioningPayload)
      // catches it; the log line must not throw on the way there.
      const p = parsed.provisioning as any;
      this.logger.log(
        `[SfOAuth] event=exchange_success correlation_id=${correlationId} status_code=${response.status}` +
          ` latency_ms=${latencyMs} sf_tenant_id=${p?.tenant?.sf_tenant_id ?? 'null'}` +
          ` token_kid=${p?.credential?.kid ?? 'null'} token_prefix=${p?.credential?.token_prefix ?? 'null'}` +
          ` token_len=${typeof p?.credential?.token === 'string' ? p.credential.token.length : 0}`,
      );
      return { ok: true, payload: parsed.provisioning };
    }

    // Non-2xx — parse SF's error body
    const bodyError = typeof response.data?.error === 'string' ? response.data.error : undefined;
    const priorCredentialId =
      typeof response.data?.prior_credential_id === 'number'
        ? response.data.prior_credential_id
        : null;
    this.logger.warn(
      `[SfOAuth] event=exchange_failure correlation_id=${correlationId} status_code=${response.status}` +
        ` latency_ms=${latencyMs} error=${this.safe(bodyError ?? 'http_' + response.status)}` +
        (priorCredentialId !== null ? ` prior_credential_id=${priorCredentialId}` : ''),
    );
    return { ok: false, status: response.status, bodyError, priorCredentialId, rawBody: response.data };
  }

  // ─── Validation ──────────────────────────────────────────────────

  private validateProvisioningPayload(
    p: SfProvisioningPayload,
  ): { ok: true } | { ok: false; reason: string } {
    if (!p || typeof p !== 'object') return { ok: false, reason: 'not_object' };
    if (p.version !== SF_LOCKED_VERSION) return { ok: false, reason: `bad_version_${p.version}` };
    if (!p.tenant || typeof p.tenant.sf_tenant_id !== 'number') {
      return { ok: false, reason: 'missing_tenant_sf_tenant_id' };
    }
    if (typeof p.tenant.sf_base_url !== 'string' || !p.tenant.sf_base_url) {
      return { ok: false, reason: 'missing_tenant_sf_base_url' };
    }
    if (!p.credential || typeof p.credential.token !== 'string' || !p.credential.token) {
      return { ok: false, reason: 'missing_credential_token' };
    }
    if (typeof p.credential.kid !== 'string' || !p.credential.kid) {
      return { ok: false, reason: 'missing_credential_kid' };
    }
    if (p.credential.scope !== SF_LOCKED_SCOPE) {
      return { ok: false, reason: `bad_scope_${p.credential.scope}` };
    }
    if (typeof p.credential.issued_at !== 'string' || !p.credential.issued_at) {
      return { ok: false, reason: 'missing_credential_issued_at' };
    }
    if (!p.signature_metadata || p.signature_metadata.algorithm !== SF_LOCKED_SIGNATURE_ALGORITHM) {
      return { ok: false, reason: `bad_signature_algorithm` };
    }
    if (p.signature_metadata.max_clock_skew_seconds !== SF_LOCKED_SIGNATURE_SKEW) {
      return { ok: false, reason: `bad_signature_skew_${p.signature_metadata.max_clock_skew_seconds}` };
    }
    if (!p.webhook || p.webhook.secret_set !== true) {
      return { ok: false, reason: 'webhook_secret_set_not_true' };
    }
    if (!Array.isArray(p.event_types)) {
      return { ok: false, reason: 'missing_event_types' };
    }
    if (!p.endpoints || typeof p.endpoints.availability !== 'string') {
      return { ok: false, reason: 'missing_endpoints' };
    }
    return { ok: true };
  }

  // ─── helpers ──────────────────────────────────────────────────────

  /**
   * Derive the webhook URL from the OAuth callback URL — both live under
   * /v1/integrations/sf on the same host. Lets us configure one env
   * (SF_OAUTH_CALLBACK_URL) instead of two.
   */
  private deriveWebhookUrl(callbackUrl: string): string {
    return callbackUrl.replace(/\/callback(\?.*)?$/, '/orchestration-webhook');
  }

  private mapExchangeError(status: number, bodyError?: string): NonNullable<CallbackResult['errorCode']> {
    if (bodyError === 'invalid_client' || status === 401) return 'exchange_invalid_client';
    if (bodyError === 'invalid_code' || bodyError === 'invalid_request') return 'exchange_invalid_code';
    if (bodyError === 'code_expired') return 'exchange_code_expired';
    if (bodyError === 'redirect_uri_mismatch') return 'exchange_redirect_mismatch';
    if (
      bodyError === 'invalid_webhook' ||
      bodyError?.startsWith('webhook_')
    ) return 'exchange_webhook_rejected';
    if (bodyError === 'service_unavailable' || bodyError === 'signing_key_not_configured' || status >= 500) {
      return 'exchange_service_unavailable';
    }
    return 'exchange_failed';
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
    return this.config.get<string>('SF_OAUTH_SUCCESS_REDIRECT') ?? '/settings/integrations?sf=connected';
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
