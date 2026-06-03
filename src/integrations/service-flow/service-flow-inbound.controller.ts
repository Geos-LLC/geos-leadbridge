/**
 * Service Flow inbound controller.
 *
 * Public (no JWT) endpoint for SF → LB job status events. Authentication is
 * HMAC (X-SF-Signature + X-SF-Timestamp + X-SF-Subscription-Id).
 *
 * Also exposes admin endpoints (JWT-protected) for subscription registration
 * and event replay.
 */

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Headers,
  Req,
  Res,
  UseGuards,
  Logger,
  NotFoundException,
  BadRequestException,
  Query,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/utils/prisma.service';
import { SfInboundStatusService } from './sf-inbound-status.service';
import { isReplayEligible } from './sf-event-replay';

@Controller('v1/integrations/service-flow')
export class ServiceFlowInboundController {
  private readonly logger = new Logger(ServiceFlowInboundController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sfInbound: SfInboundStatusService,
  ) {}

  /**
   * Inbound webhook from Service Flow. Signature-verified.
   *
   * @Public() bypasses the global JwtAuthGuard — this endpoint authenticates
   * via HMAC headers (X-SF-Signature + X-SF-Timestamp + X-SF-Subscription-Id)
   * inside SfInboundStatusService.ingest, not via the JWT bearer scheme used
   * by the rest of the API.
   */
  @Public()
  @Post('job-status')
  async receive(
    @Req() req: Request,
    @Res() res: Response,
    @Headers('x-sf-signature') signature: string,
    @Headers('x-sf-timestamp') timestamp: string,
    @Headers('x-sf-subscription-id') subscriptionId: string,
  ): Promise<Response> {
    // We need the RAW body for HMAC. Nest stores it on req.rawBody as a
    // Buffer when main.ts was created with `rawBody: true`.
    // Fall back to re-stringifying req.body if rawBody is missing.
    const rawBuf = (req as any).rawBody as Buffer | undefined;
    const rawBody: string =
      rawBuf?.toString('utf8') ??
      (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    let outcome;
    let parsedEventId: string | null = null;
    try {
      // Pre-parse event_id so we can persist a processingError row when ingest
      // throws downstream — without this, exceptions are log-only and the
      // failed count in /v1/integrations/health stays at zero.
      try {
        const parsed = JSON.parse(rawBody);
        if (parsed && typeof parsed.event_id === 'string') parsedEventId = parsed.event_id;
      } catch {
        // body wasn't valid JSON; ingest will reject it cleanly
      }

      outcome = await this.sfInbound.ingest(rawBody, {
        signature,
        timestamp,
        subscriptionId,
      });
    } catch (err: any) {
      const code = err?.code ?? 'unknown';
      const msgRaw = (err?.message ?? String(err)).slice(0, 300).replace(/\s+/g, ' ');
      const stack = (err?.stack ?? '').split('\n').slice(0, 6).join(' | ');
      const meta = err?.meta ? JSON.stringify(err.meta).slice(0, 500) : 'none';

      // Standardised k=v line so dashboards/alerts pick this up.
      this.logger.error(
        `[SfInbound] event_id=${parsedEventId ?? 'null'} lead_id=null result=exception error=${msgRaw} code=${code} sub_id=${subscriptionId ?? 'null'}`,
      );
      this.logger.error(`[SfInbound] event_id=${parsedEventId ?? 'null'} meta=${meta}`);
      this.logger.error(`[SfInbound] event_id=${parsedEventId ?? 'null'} stack=${stack}`);

      // Best-effort: persist a row so the failed count is queryable.
      if (parsedEventId) {
        try {
          await this.prisma.sfInboundEvent.create({
            data: {
              eventId: parsedEventId,
              eventType: 'unknown',
              occurredAt: new Date(),
              status: 'noop',
              result: `exception:${code}`,
              processingError: msgRaw,
              payloadJson: { error: msgRaw, code },
              sfSubscriptionId: subscriptionId ?? null,
            },
          });
        } catch {
          // unique constraint on eventId means a partial record may already
          // exist; nothing actionable to do here.
        }
      }
      throw err;
    }

    // Enrichment fields are passed through verbatim so SF's lifecycle_drift
    // classifier can read `skipReason` + `currentStatus` directly without an
    // extra round-trip. Older callers ignore unknown fields.
    return res.status(outcome.httpStatus).json({
      status: outcome.httpStatus === 200 ? 'accepted' : 'rejected',
      event_id: outcome.eventId,
      result: outcome.result,
      lead_id: outcome.leadId ?? null,
      error: outcome.error,
      skipReason: outcome.skipReason ?? null,
      currentStatus: outcome.currentStatus ?? null,
      currentPlatformStatus: outcome.currentPlatformStatus ?? null,
      sfJobId: outcome.sfJobId ?? null,
      externalRequestId: outcome.externalRequestId ?? null,
      platform: outcome.platform ?? null,
    });
  }

  /**
   * SF registers itself as an inbound webhook source.
   * Returns the shared secret SF should use to sign subsequent events.
   *
   * JWT-protected: called by SF's connect flow using the LB user's JWT.
   *
   * NOTE on the canonical reconnect flow:
   *   The CANONICAL path for SF to (re)establish a tenant on LB is
   *   POST /v1/integrations/sf/provision (Communication Hub server-to-
   *   server) which creates a full sf_connection row with orchestration
   *   credentials. This /subscribe endpoint is a LEGACY path that
   *   creates only the webhook subscription.
   *
   *   Defensive sf_connection upsert (added 2026-06-03 after the Spotless
   *   reconnect incident — sf_connection row was missing, sf_managed
   *   guard inactive, manual status writes were not blocked):
   *   if the caller supplies sfTenantId in the body, OR an existing
   *   (possibly disconnected) sf_connection row exists for this user,
   *   we (re)activate it and link the new subscription id. This ensures
   *   the sf_managed guard fires even when SF's reconnect uses this
   *   legacy endpoint instead of /provision.
   */
  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  async subscribe(
    @CurrentUser() user: any,
    @Body() body: { name?: string; sourceInstance?: string; events?: string[];
      /** Optional. When provided (or already present on an existing row), the
       *  endpoint also (re)activates the sf_connection row so sf_managed
       *  guard fires for manual status writes. */
      sfTenantId?: string;
      /** Optional. Persisted on first create only — used by future
       *  orchestration client calls. */
      baseUrl?: string;
    },
  ) {
    const secret = crypto.randomBytes(32).toString('hex');
    const syntheticUrl = `sf://${body.sourceInstance || 'sf-default'}/${user.id}`;

    const sub = await this.prisma.crmWebhookSubscription.upsert({
      where: {
        userId_direction_webhookUrl: {
          userId: user.id,
          direction: 'inbound',
          webhookUrl: syntheticUrl,
        },
      },
      create: {
        userId: user.id,
        name: body.name || 'Service Flow Inbound',
        webhookUrl: syntheticUrl,
        secret,
        events: body.events ?? ['job.status_changed'],
        direction: 'inbound',
      },
      update: {
        name: body.name || 'Service Flow Inbound',
        events: body.events ?? ['job.status_changed'],
        secret,
        isActive: true,
      },
    });

    // ─── Defensive sf_connection upsert ─────────────────────────────
    // Three cases:
    //   (A) Existing row (any status) → reactivate; preserve credentials.
    //   (B) No row, body.sfTenantId provided → create minimal row.
    //   (C) No row, no sfTenantId → log warning, skip. The subscription
    //       is created; sf_managed guard cannot fire for this user
    //       until /provision is called or /subscribe is re-called with
    //       sfTenantId.
    await this.ensureSfConnectionForSubscribe(user.id, sub.id, body.sfTenantId, body.baseUrl);

    return {
      success: true,
      subscription: {
        id: sub.id,
        direction: sub.direction,
        events: sub.events,
        secret, // returned once on registration for SF to store
      },
    };
  }

  private async ensureSfConnectionForSubscribe(
    userId: string,
    subscriptionId: string,
    sfTenantIdFromBody: string | undefined,
    baseUrlFromBody: string | undefined,
  ): Promise<void> {
    const existing = await this.prisma.sfConnection.findUnique({ where: { userId } });
    if (existing) {
      // Reactivate. Preserve sfTenantId / baseUrl / credentials. Only
      // overwrite sfTenantId if the body explicitly contradicts the
      // existing row (operator changed tenants).
      await this.prisma.sfConnection.update({
        where: { userId },
        data: {
          status: 'active',
          isActive: true,
          inboundSubscriptionId: subscriptionId,
          disconnectInitiator: null,
          disconnectedAt: null,
          ...(sfTenantIdFromBody && existing.sfTenantId !== sfTenantIdFromBody
            ? { sfTenantId: sfTenantIdFromBody } : {}),
          ...(baseUrlFromBody && !existing.baseUrl
            ? { baseUrl: baseUrlFromBody } : {}),
          updatedAt: new Date(),
        },
      });
      this.logger.log(
        `[ServiceFlowInbound] event=subscribe_sf_connection_reactivated user_id=${userId} ` +
          `sf_tenant_id=${existing.sfTenantId} sub_id=${subscriptionId}`,
      );
      return;
    }
    if (!sfTenantIdFromBody) {
      this.logger.warn(
        `[ServiceFlowInbound] event=subscribe_sf_connection_skipped user_id=${userId} ` +
          `reason=no_existing_row_no_tenant_id sf_managed_inactive=true sub_id=${subscriptionId}`,
      );
      return;
    }
    // Minimal-mode create. No orchestration credentials — these come from
    // /provision later if SF wants the full orchestration API. The sf_managed
    // guard only checks (userId, isActive, status); these three fields are
    // enough to make it fire.
    const now = new Date();
    await this.prisma.sfConnection.create({
      data: {
        userId,
        sfTenantId: sfTenantIdFromBody,
        baseUrl: baseUrlFromBody || '',
        orchestrationToken: '', // sentinel: subscription-only mode, no orchestration credentials
        tokenIssuedAt: now,
        tokenLastReceivedAt: now,
        tokenLastRotationSource: 'subscribe_endpoint',
        inboundSubscriptionId: subscriptionId,
        events: [],
        isActive: true,
        status: 'active',
      },
    });
    this.logger.log(
      `[ServiceFlowInbound] event=subscribe_sf_connection_created user_id=${userId} ` +
        `sf_tenant_id=${sfTenantIdFromBody} mode=subscription_only sub_id=${subscriptionId}`,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Get('events')
  async listEvents(
    @CurrentUser() user: any,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    const take = Math.min(parseInt(limit ?? '50', 10) || 50, 200);
    const rows = await this.prisma.sfInboundEvent.findMany({
      where: { userId: user.id, ...(status ? { status } : {}) },
      orderBy: { receivedAt: 'desc' },
      take,
    });
    return { success: true, count: rows.length, events: rows };
  }

  @UseGuards(JwtAuthGuard)
  @Post('events/:id/replay')
  async replay(@CurrentUser() user: any, @Param('id') id: string) {
    // Cross-tenant access (event belongs to another user OR doesn't exist) returns
    // NotFoundException so the response is 404, not a 200 with success:false.
    const event = await this.prisma.sfInboundEvent.findFirst({
      where: { id, userId: user.id },
    });
    if (!event) throw new NotFoundException('event not found');
    // Replay-eligibility lives in sf-event-replay.ts so the matrix (status +
    // result string) is unit-testable without bootstrapping Nest.
    const eligibility = isReplayEligible({ status: event.status, result: event.result });
    if (!eligibility.replayable) {
      throw new BadRequestException(
        `cannot replay event (${eligibility.reason})`,
      );
    }
    if (!event.sfSubscriptionId) {
      throw new BadRequestException('no subscription context');
    }
    // The subscription is the tenant's own SF inbound subscription — re-verify
    // ownership defensively rather than trusting a foreign event row.
    const sub = await this.prisma.crmWebhookSubscription.findFirst({
      where: { id: event.sfSubscriptionId, userId: user.id },
    });
    if (!sub) throw new NotFoundException('subscription missing');

    const outcome = await this.sfInbound.process(event.payloadJson as any, sub);
    return { success: true, outcome };
  }
}
