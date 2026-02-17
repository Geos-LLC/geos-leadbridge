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
  HttpCode,
  HttpStatus,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { WebhooksService } from './webhooks.service';
import { Public } from '../common/decorators/public.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@Controller('webhooks')
export class WebhooksController {
  constructor(private webhooksService: WebhooksService) {}

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
    await this.webhooksService.handleThumbtackWebhook(signature, payload);

    return { received: true };
  }

  /**
   * Yelp webhook endpoint (for future implementation)
   */
  @Public()
  @Post('yelp')
  @HttpCode(HttpStatus.OK)
  async handleYelpWebhook(@Headers('x-yelp-signature') _signature: string, @Body() _payload: any) {
    // Future implementation
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
