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

    return res.status(outcome.httpStatus).json({
      status: outcome.httpStatus === 200 ? 'accepted' : 'rejected',
      event_id: outcome.eventId,
      result: outcome.result,
      lead_id: outcome.leadId ?? null,
      error: outcome.error,
    });
  }

  /**
   * SF registers itself as an inbound webhook source.
   * Returns the shared secret SF should use to sign subsequent events.
   *
   * JWT-protected: called by SF's connect flow using the LB user's JWT.
   */
  @UseGuards(JwtAuthGuard)
  @Post('subscribe')
  async subscribe(
    @CurrentUser() user: any,
    @Body() body: { name?: string; sourceInstance?: string; events?: string[] },
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
    if (!['deferred', 'unmapped_status', 'dry_run'].includes(event.status)) {
      throw new BadRequestException(`cannot replay event in status ${event.status}`);
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
