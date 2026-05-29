/**
 * SfConnectionController — Phase 2C + PR-C3.
 *
 * Endpoints (all rooted at /v1/integrations/sf/):
 *
 *   POST  /connect/start          JWT — start OAuth handshake
 *   GET   /callback               Public — SF redirects here with code+state
 *   POST  /disconnect             JWT — LB-initiated disconnect
 *   GET   /connection             JWT — user-safe status view (PR-C3, no secrets)
 *   POST  /orchestration-webhook  Public — HMAC-signed; SF pushes ALL 7
 *                                  event types here (service_*,
 *                                  connection.*, credential.*)
 *
 * The public endpoints (callback + webhook) authenticate via:
 *   - callback: signed state token (anti-CSRF, single-use)
 *   - webhook:  HMAC + timestamp window + tenant resolution
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
import { SfOAuthService } from './sf-oauth.service';
import { SfDisconnectService } from './sf-disconnect.service';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { SfConnectionStatusService } from './sf-connection-status.service';
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
}
