/**
 * Webhooks Controller
 * Receives webhook events from platforms
 */

import {
  Controller,
  Post,
  Get,
  Body,
  Headers,
  Query,
  UseGuards,
  UseFilters,
  HttpCode,
  HttpStatus,
  Logger,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { CallConnectService } from '../call-connect/call-connect.service';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import {
  isWebhookProcessingOwner,
  logSkippedWebhook,
  NOT_OWNER_SKIP_RESPONSE,
} from '../common/webhook-processing-owner';
import { WebhookCrashFilter } from './webhook-crash.filter';

// Controller-scoped filter: every handler below routes uncaught throws
// through the same notifyDevAlert + 500 pipeline so platform retries
// still fire and ops gets paged on a real regression.
@UseFilters(WebhookCrashFilter)
@Controller('webhooks')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private webhooksService: WebhooksService,
    private callConnectService: CallConnectService,
  ) {}

  /**
   * Thumbtack webhook endpoint
   * This endpoint is public and receives webhooks from Thumbtack
   */
  @Public()
  @Post('thumbtack')
  @HttpCode(HttpStatus.OK)
  async handleThumbtackWebhook(
    @Headers('x-thumbtack-signature') signature: string,
    @Body() payload: any,
  ) {
    if (!isWebhookProcessingOwner()) {
      logSkippedWebhook(this.logger, 'thumbtack', { eventType: payload?.event_type });
      return NOT_OWNER_SKIP_RESPONSE;
    }

    await this.webhooksService.handleThumbtackWebhook(signature, payload);

    return { received: true };
  }

  /**
   * Yelp webhook verification endpoint (GET)
   * Yelp sends GET ?verification=xxx and expects {"verification": "xxx"} in response
   */
  @Public()
  @Get('yelp')
  @HttpCode(HttpStatus.OK)
  async verifyYelpWebhook(@Query('verification') verification: string) {
    if (!verification) return { status: 'ok', platform: 'yelp' };
    return { verification };
  }

  /**
   * Yelp webhook event endpoint (POST)
   * Receives NEW_EVENT, CONSUMER_PHONE_NUMBER_OPT_IN_EVENT, etc.
   */
  @Public()
  @Post('yelp')
  @HttpCode(HttpStatus.OK)
  async handleYelpWebhook(
    @Headers('x-yelp-signature') signature: string,
    @Body() payload: any,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!isWebhookProcessingOwner()) {
      logSkippedWebhook(this.logger, 'yelp', {
        eventType: payload?.data?.event_type,
        businessId: payload?.data?.id,
        eventId: payload?.data?.event_id || payload?.data?.updates?.[0]?.event_id,
      });
      return NOT_OWNER_SKIP_RESPONSE;
    }

    await this.webhooksService.handleYelpWebhook(
      signature,
      payload,
      req.rawBody?.toString() || JSON.stringify(payload),
    );
    return { received: true };
  }

  /**
   * Sigcore webhook endpoint for SMS delivery status updates
   * Receives message.delivered, message.failed, message.status_update events
   */
  @Public()
  @Post('sigcore/delivery-status')
  @HttpCode(HttpStatus.OK)
  async handleSigcoreDeliveryStatus(
    @Headers('x-callio-event') eventType: string,
    @Headers('x-callio-timestamp') timestamp: string,
    @Headers('x-callio-signature') signature: string,
    @Body() payload: any,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!isWebhookProcessingOwner()) {
      logSkippedWebhook(this.logger, 'sigcore_delivery_status', {
        eventType: eventType || payload?.event,
        messageId: payload?.data?.messageId,
      });
      return NOT_OWNER_SKIP_RESPONSE;
    }

    await this.webhooksService.handleSigcoreDeliveryStatus({
      eventType: eventType || payload?.event,
      timestamp,
      signature,
      payload,
      rawBody: req.rawBody?.toString() || JSON.stringify(payload),
    });

    return { received: true };
  }

  /**
   * Sigcore call-connect webhook endpoint
   * Receives call_connect.* events (session status updates)
   * Signature: HMAC-SHA256 on X-Callio-Signature header
   * accountId query param identifies per-business HMAC secret
   */
  @Public()
  @Post('sigcore/call-connect')
  @HttpCode(HttpStatus.OK)
  async handleSigcoreCallConnect(
    @Headers('x-callio-signature') signature: string,
    @Query('accountId') accountId: string,
    @Body() payload: any,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!isWebhookProcessingOwner()) {
      logSkippedWebhook(this.logger, 'sigcore_call_connect', {
        eventType: payload?.event,
        accountId,
        sessionId: payload?.data?.sessionId,
      });
      return NOT_OWNER_SKIP_RESPONSE;
    }

    const rawBody = req.rawBody?.toString() || JSON.stringify(payload);

    // Verify HMAC signature (per-business secret via accountId, or env fallback)
    const valid = await this.callConnectService.verifyWebhookSignature(
      signature || '',
      rawBody,
      accountId || undefined,
    );
    if (!valid) {
      // Return 200 to avoid Sigcore retries flooding on misconfiguration
      return { received: true, error: 'invalid_signature' };
    }

    await this.callConnectService.handleWebhookEvent(payload);
    return { received: true };
  }

  /**
   * Sigcore webhook endpoint for inbound SMS from customers
   * Receives message.inbound events when a customer replies via SMS
   */
  @Public()
  @Post('sigcore/inbound-sms')
  @HttpCode(HttpStatus.OK)
  async handleSigcoreInboundSms(
    @Headers('x-callio-event') eventType: string,
    @Headers('x-callio-timestamp') timestamp: string,
    @Headers('x-callio-signature') signature: string,
    @Query('accountId') accountId: string,
    @Body() payload: any,
    @Req() req: RawBodyRequest<Request>,
  ) {
    if (!isWebhookProcessingOwner()) {
      logSkippedWebhook(this.logger, 'sigcore_inbound_sms', {
        eventType: eventType || payload?.event,
        accountId,
        messageId: payload?.data?.messageId,
        fromNumber: payload?.data?.fromNumber,
      });
      return NOT_OWNER_SKIP_RESPONSE;
    }

    await this.webhooksService.handleInboundSms({
      eventType: eventType || payload?.event,
      timestamp,
      signature,
      accountId,
      payload,
      rawBody: req.rawBody?.toString() || JSON.stringify(payload),
    });

    return { received: true };
  }

  /**
   * Get webhook events (admin/debugging)
   */
  @UseGuards(JwtAuthGuard)
  @Get('events')
  async getWebhookEvents(
    @Query('platform') platform?: string,
    @Query('eventType') eventType?: string,
    @Query('processed') processed?: boolean,
    @Query('limit') limit?: number,
  ) {
    const events = await this.webhooksService.getWebhookEvents({
      platform,
      eventType,
      processed: processed !== undefined ? processed === true : undefined,
      limit: limit ? parseInt(limit.toString(), 10) : undefined,
    });

    return {
      count: events.length,
      events,
    };
  }
}
