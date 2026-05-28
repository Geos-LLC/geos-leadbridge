/**
 * SfConnectionController — Phase 2C PR-C2.
 *
 * Endpoints (all rooted at /v1/integrations/sf/):
 *
 *   POST  /connect/start             JWT — start the OAuth handshake
 *   GET   /callback                  Public — SF redirects here with code+state
 *   POST  /disconnect                JWT — LB-initiated disconnect
 *   POST  /connection-webhook        Public — HMAC-signed; SF pushes
 *                                    connection.connected / credential.rotated /
 *                                    connection.revoked
 *
 * The public endpoints (callback + webhook) authenticate via:
 *   - callback: signed state token (anti-CSRF, single-use)
 *   - webhook: HMAC signature + timestamp window + subscription lookup
 *
 * No new state in the controller — everything is delegated to services.
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
    // Browser redirect on success or failure — the SPA renders the
    // outcome page based on the `code` query param we include.
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

  // ─── POST /connection-webhook (Public — HMAC) ────────────────────

  @Public()
  @Post('connection-webhook')
  async receiveWebhook(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-sf-signature') signature: string,
    @Headers('x-sf-timestamp') timestamp: string,
    @Headers('x-sf-subscription-id') subscriptionId: string,
    @Headers('x-sf-event-id') eventId: string,
    @Headers('x-sf-signature-kid') signatureKid: string,
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
        subscriptionId,
        eventId,
        signatureKid,
      });
    } catch (err: any) {
      const msg = (err?.message ?? String(err)).slice(0, 300);
      this.logger.error(
        `[SfConnectionWebhook] result=exception error=${msg} sub_id=${subscriptionId ?? 'null'}`,
      );
      return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        status: 'error',
        error: msg,
      });
    }
    return res.status(outcome.httpStatus).json({
      status: outcome.httpStatus < 300 ? 'accepted' : 'rejected',
      event_id: outcome.eventId,
      result: outcome.result,
      sf_tenant_id: outcome.sfTenantId ?? null,
      error: outcome.error,
    });
  }
}
