/**
 * SfConnectionController — Phase 2C + PR-C3 + SF-initiated server-to-server (2026-05-29).
 *
 * Endpoints (all rooted at /v1/integrations/sf/):
 *
 *   POST  /connect/start          JWT — start OAuth handshake (legacy LB-initiated path)
 *   GET   /callback               Public — SF redirects here with code+state
 *   POST  /disconnect             JWT — LB-initiated disconnect
 *   GET   /connection             JWT — user-safe status view (PR-C3, no secrets)
 *   POST  /orchestration-webhook  Public — HMAC-signed; SF pushes ALL 7
 *                                  event types here (service_*,
 *                                  connection.*, credential.*)
 *   POST  /verify-credentials     Public — HMAC-signed via SF_LB_PROVISIONING_SHARED_SECRET.
 *                                  SF Communication Hub email/password flow:
 *                                  validate LB creds, return link_token.
 *   POST  /provision              Public — HMAC-signed via SF_LB_PROVISIONING_SHARED_SECRET.
 *                                  SF posts the orchestration credential + link_token;
 *                                  LB persists + returns webhook secret.
 *
 * The public endpoints authenticate via:
 *   - callback:           signed state token (anti-CSRF, single-use)
 *   - orchestration-webhook: HMAC + timestamp window + per-tenant secret
 *   - verify-credentials, provision: HMAC + timestamp window + shared secret
 */

import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SfOAuthService } from './sf-oauth.service';
import { SfDisconnectService } from './sf-disconnect.service';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { SfConnectionStatusService } from './sf-connection-status.service';
import { SfProvisioningService } from './sf-provisioning.service';
import type {
  SfProvisionRequest,
  SfVerifyCredentialsRequest,
} from './sf-provisioning.contracts';

const SF_PROV_SIGNATURE_SKEW_SECONDS = 300;
import type {
  OAuthCallbackQuery,
  SfDisconnectRequest,
} from './sf-connection.contracts';

@Controller('v1/integrations/sf')
export class SfConnectionController {
  private readonly logger = new Logger(SfConnectionController.name);

  constructor(
    private readonly oauth: SfOAuthService,
    private readonly disconnect: SfDisconnectService,
    private readonly webhook: SfConnectionWebhookService,
    private readonly status: SfConnectionStatusService,
    private readonly provisioning: SfProvisioningService,
    private readonly config: ConfigService,
  ) {}

  // ─── POST /connect/start (JWT) ───────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('connect/start')
  async startConnect(@CurrentUser() user: any) {
    try {
      const result = await this.oauth.start(user.id);
      return {
        success: true,
        redirectUrl: result.redirectUrl,
        connectionId: result.pendingConnectionId,
      };
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).slice(0, 200);
      this.logger.warn(`[SfConnection] event=start_failed user_id=${user.id} err=${msg}`);
      return { success: false, error: msg };
    }
  }

  // ─── GET /callback (Public — state-validated) ────────────────────

  @Public()
  @Get('callback')
  async handleCallback(
    @Query() query: OAuthCallbackQuery,
    @Res() res: Response,
  ): Promise<Response> {
    const result = await this.oauth.handleCallback(query);
    if (result.redirectTo) {
      res.redirect(result.httpStatus < 400 ? 302 : 303, result.redirectTo);
      return res;
    }
    return res.status(result.httpStatus).json({
      success: result.ok,
      connectionId: result.connectionId ?? null,
      error: result.errorCode ?? null,
      detail: result.errorDetail ?? null,
    });
  }

  // ─── GET /connection (JWT) — PR-C3 user-safe status view ────────

  @UseGuards(JwtAuthGuard)
  @Get('connection')
  async getConnectionStatus(@CurrentUser() user: any) {
    return this.status.getStatusForUser(user.id);
  }

  // ─── POST /disconnect (JWT) ──────────────────────────────────────

  @UseGuards(JwtAuthGuard)
  @Post('disconnect')
  async disconnectEndpoint(
    @CurrentUser() user: any,
    @Body() body: Partial<SfDisconnectRequest>,
  ) {
    const result = await this.disconnect.disconnect({
      userId: user.id,
      request: {
        initiator: body?.initiator === 'lb_admin' ? 'lb_admin' : 'lb_user',
        reason: typeof body?.reason === 'string' ? body.reason.slice(0, 200) : undefined,
      },
    });
    return result;
  }

  // ─── POST /orchestration-webhook (Public — HMAC) ─────────────────
  //
  // Single endpoint for all 7 SF-pushed event types. Header set per
  // S4 contract: X-SF-Signature / X-SF-Timestamp / X-SF-Event-Id /
  // X-SF-Event-Type / X-SF-Tenant-Id / X-SF-Kid.

  @Public()
  @Post('orchestration-webhook')
  async receiveWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-sf-signature') signature: string,
    @Headers('x-sf-timestamp') timestamp: string,
    @Headers('x-sf-event-id') eventId: string,
    @Headers('x-sf-event-type') eventType: string,
    @Headers('x-sf-tenant-id') tenantId: string,
    @Headers('x-sf-kid') kid: string,
  ): Promise<Response> {
    const rawBuf = (req as any).rawBody as Buffer | undefined;
    const rawBody: string =
      rawBuf?.toString('utf8') ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    let outcome;
    try {
      outcome = await this.webhook.ingest(rawBody, {
        signature,
        timestamp,
        eventId,
        eventType,
        tenantId,
        kid,
      });
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).slice(0, 300);
      this.logger.error(
        `[SfConnectionWebhook] result=exception error=${msg} sf_tenant_id=${tenantId ?? 'null'}`,
      );
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        status: 'error',
        error: msg,
      });
    }
    return res.status(outcome.httpStatus).json({
      status: outcome.httpStatus < 300 ? 'accepted' : 'rejected',
      event_id: outcome.eventId,
      event_type: outcome.eventType ?? null,
      result: outcome.result,
      sf_tenant_id: outcome.sfTenantId ?? null,
      error: outcome.error,
    });
  }

  // ─── POST /verify-credentials (Public, HMAC-signed) ──────────────
  //
  // SF Communication Hub flow step 1: SF posts the LB email/password
  // that the tenant typed into the SF UI. LB validates and returns a
  // short-lived single-use link_token bound to the LB user_id.

  @Public()
  @Post('verify-credentials')
  async verifyCredentials(@Req() req: Request, @Res() res: Response): Promise<Response> {
    const rawBody = this.getRawBody(req);
    const hmacCheck = this.verifyProvisioningHmac(rawBody, req.headers);
    if (!hmacCheck.ok) {
      this.logger.warn(`[SfProvisioning] event=verify_hmac_rejected reason=${hmacCheck.reason}`);
      return res.status(401).json({ ok: false, error: hmacCheck.reason });
    }

    let body: SfVerifyCredentialsRequest;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    const result = await this.provisioning.verifyCredentials(body);
    // Status mapping: 200 on success; 401 on invalid_credentials; 429 on
    // rate_limited; 400 on missing_fields; 500 on config_error. We always
    // return the JSON contract (caller checks `ok` field).
    let httpStatus = 200;
    if (!result.ok) {
      if (result.error === 'invalid_credentials' || result.error === 'no_password_set') httpStatus = 401;
      else if (result.error === 'rate_limited') httpStatus = 429;
      else if (result.error === 'missing_fields') httpStatus = 400;
      else if (result.error === 'config_error') httpStatus = 500;
    }
    return res.status(httpStatus).json(result);
  }

  // ─── POST /provision (Public, HMAC-signed) ──────────────────────
  //
  // SF Communication Hub flow step 2: SF presents the link_token + the
  // full provisioning payload (SF-minted credential + endpoints + sig
  // metadata + events). LB validates, claims the nonce, persists via
  // the existing lifecycle writer, and returns the LB-generated webhook
  // secret one time.

  @Public()
  @Post('provision')
  async provision(@Req() req: Request, @Res() res: Response): Promise<Response> {
    const rawBody = this.getRawBody(req);
    const hmacCheck = this.verifyProvisioningHmac(rawBody, req.headers);
    if (!hmacCheck.ok) {
      this.logger.warn(`[SfProvisioning] event=provision_hmac_rejected reason=${hmacCheck.reason}`);
      return res.status(401).json({ ok: false, error: hmacCheck.reason });
    }

    let body: SfProvisionRequest;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_json' });
    }
    const result = await this.provisioning.provision(body);
    let httpStatus = 200;
    if (!result.ok) {
      if (result.error === 'link_token_invalid' || result.error === 'link_token_expired') httpStatus = 401;
      else if (result.error === 'link_token_already_consumed') httpStatus = 409;
      else if (result.error === 'lb_user_already_connected_elsewhere') httpStatus = 409;
      else if (result.error === 'invalid_provisioning_payload') httpStatus = 400;
      else if (result.error === 'lifecycle_rejected') httpStatus = 422;
      else if (result.error === 'config_error') httpStatus = 500;
    }
    return res.status(httpStatus).json(result);
  }

  // ─── helpers ────────────────────────────────────────────────────

  private getRawBody(req: Request): string {
    const rawBuf = (req as any).rawBody as Buffer | undefined;
    return (
      rawBuf?.toString('utf8') ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    );
  }

  /**
   * Verify HMAC + timestamp for the SF→LB provisioning channel. Same
   * canonical signing pattern as inbound webhooks (`${ts}.${rawBody}`
   * HMAC-SHA256) but uses the SHARED `SF_LB_PROVISIONING_SHARED_SECRET`
   * rather than a per-connection secret.
   *
   * Required headers (DELIBERATELY DIFFERENT from the inbound webhook
   * channel — the two channels use different secrets, so distinct header
   * names prevent any chance of cross-channel signature confusion):
   *
   *   X-SF-LB-Timestamp  unix epoch seconds (string)
   *   X-SF-LB-Signature  hex HMAC over `${ts}.${rawBody}` using shared secret
   *
   * The inbound webhook channel (orchestration-webhook) continues to use
   * the original `X-SF-Timestamp` / `X-SF-Signature` headers with the
   * per-tenant webhook secret. That channel is unchanged.
   */
  private verifyProvisioningHmac(
    rawBody: string,
    headers: Record<string, any>,
  ): { ok: true } | { ok: false; reason: string } {
    const pick = (k: string): string | null => {
      const v = headers[k] ?? headers[k.toLowerCase()];
      if (!v) return null;
      return Array.isArray(v) ? (v[0] ?? null) : String(v);
    };
    const ts = pick('x-sf-lb-timestamp');
    const sig = pick('x-sf-lb-signature');
    if (!ts || !sig) return { ok: false, reason: 'missing_headers' };

    const secret = this.config.get<string>('SF_LB_PROVISIONING_SHARED_SECRET', '') ?? '';
    if (!secret) {
      this.logger.error('[SfProvisioning] event=config_missing var=SF_LB_PROVISIONING_SHARED_SECRET');
      return { ok: false, reason: 'config_missing' };
    }

    const tsNum = parseInt(ts, 10);
    if (!Number.isFinite(tsNum)) return { ok: false, reason: 'invalid_timestamp' };
    const drift = Math.floor(Date.now() / 1000) - tsNum;
    if (Math.abs(drift) > SF_PROV_SIGNATURE_SKEW_SECONDS) {
      return { ok: false, reason: 'timestamp_drift' };
    }

    const expected = crypto.createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
    const received = sig.startsWith('sha256=') ? sig.slice('sha256='.length) : sig;
    if (expected.length !== received.length) return { ok: false, reason: 'signature_mismatch' };
    try {
      if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'))) {
        return { ok: false, reason: 'signature_mismatch' };
      }
    } catch {
      return { ok: false, reason: 'signature_mismatch' };
    }
    return { ok: true };
  }
}
