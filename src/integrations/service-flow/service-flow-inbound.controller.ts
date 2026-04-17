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
  Query,
} from '@nestjs/common';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
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
   */
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

    const outcome = await this.sfInbound.ingest(rawBody, {
      signature,
      timestamp,
      subscriptionId,
    });

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
    const event = await this.prisma.sfInboundEvent.findUnique({ where: { id } });
    if (!event || event.userId !== user.id) {
      return { success: false, error: 'event not found' };
    }
    if (!['deferred', 'unmapped_status', 'dry_run'].includes(event.status)) {
      return { success: false, error: `cannot replay event in status ${event.status}` };
    }
    if (!event.sfSubscriptionId) {
      return { success: false, error: 'no subscription context' };
    }
    const sub = await this.prisma.crmWebhookSubscription.findUnique({
      where: { id: event.sfSubscriptionId },
    });
    if (!sub) return { success: false, error: 'subscription missing' };

    const outcome = await this.sfInbound.process(event.payloadJson as any, sub);
    return { success: true, outcome };
  }
}
