/**
 * Webhooks Service
 * Processes webhook events from various platforms
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformFactory } from '../platforms/platform.factory';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private prisma: PrismaService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
  ) {}

  /**
   * Handle incoming webhook from Thumbtack
   */
  async handleThumbtackWebhook(signature: string, payload: any): Promise<void> {
    const secret = this.configService.get<string>('thumbtack.webhookSecret') || '';
    const adapter = this.platformFactory.getAdapter('thumbtack');

    // Verify signature
    const isValid = adapter.verifyWebhookSignature(signature, JSON.stringify(payload), secret);

    // Log webhook event
    const event = await this.prisma.webhookEvent.create({
      data: {
        platform: 'thumbtack',
        eventType: payload.event_type || 'unknown',
        payload: JSON.stringify(payload),
        signature,
        verified: isValid,
        processed: false,
      },
    });

    if (!isValid) {
      this.logger.warn('Invalid webhook signature', { eventId: event.id });
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processingError: 'Invalid signature',
          processedAt: new Date(),
        },
      });
      return;
    }

    // Process the event
    try {
      await this.processWebhookEvent(event.id, 'thumbtack', payload);
    } catch (error) {
      this.logger.error('Error processing webhook', error);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processingError: error.message,
          processedAt: new Date(),
        },
      });
    }
  }

  /**
   * Process webhook event based on type
   */
  private async processWebhookEvent(
    eventId: string,
    platform: string,
    payload: any,
  ): Promise<void> {
    const eventType = payload.event_type;

    this.logger.log(`Processing ${platform} webhook: ${eventType}`);

    switch (eventType) {
      case 'request.created':
        await this.handleNewLead(platform, payload);
        break;

      case 'request.message.created':
      case 'message.created':
        await this.handleNewMessage(platform, payload);
        break;

      case 'request.status.changed':
        await this.handleStatusChange(platform, payload);
        break;

      case 'negotiation.updated':
        await this.handleNegotiationUpdate(platform, payload);
        break;

      default:
        this.logger.warn(`Unhandled webhook event type: ${eventType}`);
    }

    // Mark as processed
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: {
        processed: true,
        processedAt: new Date(),
      },
    });
  }

  /**
   * Handle new lead webhook
   */
  private async handleNewLead(platform: string, payload: any): Promise<void> {
    this.logger.log('New lead received', { platform, requestId: payload.request_id });

    // Find the user associated with this webhook
    // In production, you'd have a mapping from platform external ID to user ID
    // For now, we'll just log it

    // The lead will be fetched when the user next calls GET /leads
    // Or you could implement a background job to sync leads periodically
  }

  /**
   * Handle new message webhook
   */
  private async handleNewMessage(platform: string, payload: any): Promise<void> {
    this.logger.log('New message received', { platform, threadId: payload.thread_id });

    // Update conversation unread count
    // Notify user via WebSocket/Push notification (future enhancement)
  }

  /**
   * Handle status change webhook
   */
  private async handleStatusChange(platform: string, payload: any): Promise<void> {
    this.logger.log('Lead status changed', {
      platform,
      requestId: payload.request_id,
      status: payload.status,
    });

    // Update lead status in database
    await this.prisma.lead.updateMany({
      where: {
        platform,
        externalRequestId: payload.request_id,
      },
      data: {
        status: payload.status,
      },
    });
  }

  /**
   * Handle negotiation update webhook
   */
  private async handleNegotiationUpdate(platform: string, payload: any): Promise<void> {
    this.logger.log('Negotiation updated', { platform, requestId: payload.request_id });

    // Update quote/negotiation in database
  }

  /**
   * Get webhook events (for debugging/monitoring)
   */
  async getWebhookEvents(filters?: {
    platform?: string;
    eventType?: string;
    processed?: boolean;
    limit?: number;
  }) {
    return this.prisma.webhookEvent.findMany({
      where: {
        ...(filters?.platform && { platform: filters.platform }),
        ...(filters?.eventType && { eventType: filters.eventType }),
        ...(filters?.processed !== undefined && { processed: filters.processed }),
      },
      orderBy: { receivedAt: 'desc' },
      take: filters?.limit || 100,
    });
  }
}
