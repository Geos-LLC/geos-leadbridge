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
  async handleThumbtackWebhook(signature: string | undefined, payload: any): Promise<void> {
    const secret = this.configService.get<string>('thumbtack.webhookSecret') || '';
    const adapter = this.platformFactory.getAdapter('thumbtack');

    // Log webhook receipt for debugging
    this.logger.log('Received Thumbtack webhook', {
      hasSignature: !!signature,
      hasSecret: !!secret,
      eventType: payload?.event?.eventType || payload?.event_type || 'unknown',
    });

    // Verify signature if both signature and secret are present
    // Note: Thumbtack webhooks don't include a signature header, so we accept them without verification
    let isValid = false;
    if (signature && secret) {
      isValid = adapter.verifyWebhookSignature(signature, JSON.stringify(payload), secret);
    } else if (!signature) {
      // Thumbtack doesn't send signature headers - accept webhooks without verification
      this.logger.log('Accepting webhook without signature (Thumbtack does not sign webhooks)');
      isValid = true;
    } else if (!secret) {
      // If no secret is configured, accept the webhook
      this.logger.warn('No webhook secret configured - accepting webhook without verification');
      isValid = true;
    }

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
   * Thumbtack v4 format: { event: { eventType: "NegotiationCreatedV4", ... }, data: { negotiationID, customer, ... } }
   */
  private async processWebhookEvent(
    eventId: string,
    platform: string,
    payload: any,
  ): Promise<void> {
    // Thumbtack v4 uses event.eventType, legacy uses event_type
    const eventType = payload.event?.eventType || payload.event_type;

    this.logger.log(`Processing ${platform} webhook: ${eventType}`);

    switch (eventType) {
      // Thumbtack v4 event types
      case 'NegotiationCreatedV4':
        await this.handleNegotiationCreated(platform, payload.data);
        break;

      case 'MessageCreatedV4':
        await this.handleMessageCreated(platform, payload.data);
        break;

      // Legacy event types (backwards compatibility)
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
   * Handle NegotiationCreatedV4 webhook (Thumbtack v4)
   * Stores the lead in the database
   */
  private async handleNegotiationCreated(platform: string, data: any): Promise<void> {
    const negotiationId = data.negotiationID;
    const customer = data.customer || {};
    const request = data.request || {};
    const location = request.location || {};
    const business = data.business || {};

    this.logger.log('New negotiation received', { platform, negotiationId });

    // Find user by businessID (stored when webhook is registered)
    const platformConnection = await this.prisma.platform.findFirst({
      where: {
        platformName: platform,
        externalBusinessId: business.businessID,
      },
    });

    if (!platformConnection) {
      this.logger.warn('No user found for business', { businessID: business.businessID });
      return;
    }

    // Store the lead (threadId is optional and managed separately)
    await this.prisma.lead.upsert({
      where: {
        platform_externalRequestId: {
          platform,
          externalRequestId: negotiationId,
        },
      },
      create: {
        userId: platformConnection.userId,
        platform,
        businessId: business.businessID,
        externalRequestId: negotiationId,
        customerName: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown',
        customerPhone: customer.phone,
        message: request.description || '',
        postcode: location.zipCode,
        city: location.city,
        state: location.state,
        category: request.category?.name,
        status: data.status?.toLowerCase() || 'new',
        rawJson: JSON.stringify(data),
      },
      update: {
        customerName: `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown',
        customerPhone: customer.phone,
        message: request.description || '',
        status: data.status?.toLowerCase() || 'new',
        rawJson: JSON.stringify(data),
      },
    });

    this.logger.log('Lead stored successfully', { negotiationId });
  }

  /**
   * Handle MessageCreatedV4 webhook (Thumbtack v4)
   * Also creates the lead if it doesn't exist (in case NegotiationCreatedV4 was missed)
   */
  private async handleMessageCreated(platform: string, data: any): Promise<void> {
    const negotiationId = data.negotiationID;
    const businessId = data.business?.businessID;

    this.logger.log('New message received', {
      platform,
      negotiationId,
      messageId: data.messageID,
      businessId,
    });

    // If we have business info, ensure the lead exists
    if (businessId && negotiationId) {
      // Find user by businessID
      const platformConnection = await this.prisma.platform.findFirst({
        where: {
          platformName: platform,
          externalBusinessId: businessId,
        },
      });

      if (platformConnection) {
        // Check if lead exists, if not create it
        const existingLead = await this.prisma.lead.findFirst({
          where: {
            platform,
            externalRequestId: negotiationId,
          },
        });

        if (!existingLead) {
          this.logger.log('Lead not found, creating from MessageCreatedV4', { negotiationId, businessId });

          const customer = data.customer || {};

          await this.prisma.lead.create({
            data: {
              userId: platformConnection.userId,
              platform,
              businessId,
              externalRequestId: negotiationId,
              customerName: customer.name || `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown',
              customerPhone: customer.phone,
              message: data.text || '',
              status: 'new',
              rawJson: JSON.stringify(data),
            },
          });

          this.logger.log('Lead created from message webhook', { negotiationId });
        }
      } else {
        this.logger.warn('No platform connection found for business', { businessId });
      }
    }
  }

  /**
   * Handle new lead webhook (legacy)
   */
  private async handleNewLead(platform: string, payload: any): Promise<void> {
    this.logger.log('New lead received', { platform, requestId: payload.request_id });
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
