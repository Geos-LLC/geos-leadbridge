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

    // Find user by businessID - first try exact match, then find any connected user for this platform
    // This handles multiple businesses under one OAuth connection
    let platformConnection = await this.prisma.platform.findFirst({
      where: {
        platformName: platform,
        externalBusinessId: business.businessID,
      },
    });

    // If no exact match, find any connected platform for this user
    // (Thumbtack OAuth grants access to all businesses for that user)
    if (!platformConnection) {
      // Check if there's a lead already for this business to find the user
      const existingLead = await this.prisma.lead.findFirst({
        where: {
          platform,
          businessId: business.businessID,
        },
      });

      if (existingLead) {
        platformConnection = await this.prisma.platform.findFirst({
          where: {
            platformName: platform,
            userId: existingLead.userId,
            connected: true,
          },
        });
      }
    }

    // If still no match, try to find any connected Thumbtack platform
    // This is a fallback - webhook came for a business we haven't seen before
    if (!platformConnection) {
      this.logger.warn('No exact platform match, searching for any connected Thumbtack user', { businessID: business.businessID });

      // Get all connected Thumbtack platforms
      const connectedPlatforms = await this.prisma.platform.findMany({
        where: {
          platformName: platform,
          connected: true,
        },
      });

      // For now, if there's only one connected user, use that
      // In production with multiple users, you'd need a business-to-user mapping table
      if (connectedPlatforms.length === 1) {
        platformConnection = connectedPlatforms[0];
        this.logger.log('Using single connected platform for webhook', {
          userId: platformConnection.userId,
          businessID: business.businessID
        });
      } else if (connectedPlatforms.length > 1) {
        this.logger.warn('Multiple connected platforms found, cannot determine user', {
          businessID: business.businessID,
          platformCount: connectedPlatforms.length
        });
        return;
      }
    }

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
   * Creates/updates lead and stores the message in the database
   */
  private async handleMessageCreated(platform: string, data: any): Promise<void> {
    const negotiationId = data.negotiationID;
    const businessId = data.business?.businessID;
    const messageId = data.messageID;

    this.logger.log('New message received', {
      platform,
      negotiationId,
      messageId,
      businessId,
    });

    if (!businessId || !negotiationId) {
      this.logger.warn('Missing businessId or negotiationId in message webhook');
      return;
    }

    // Find user by businessID - use same fallback logic as handleNegotiationCreated
    let platformConnection = await this.prisma.platform.findFirst({
      where: {
        platformName: platform,
        externalBusinessId: businessId,
      },
    });

    // If no exact match, check if lead already exists for this business
    if (!platformConnection) {
      const existingLeadForBusiness = await this.prisma.lead.findFirst({
        where: {
          platform,
          businessId,
        },
      });

      if (existingLeadForBusiness) {
        platformConnection = await this.prisma.platform.findFirst({
          where: {
            platformName: platform,
            userId: existingLeadForBusiness.userId,
            connected: true,
          },
        });
      }
    }

    // Fallback: if only one connected platform, use that
    if (!platformConnection) {
      const connectedPlatforms = await this.prisma.platform.findMany({
        where: {
          platformName: platform,
          connected: true,
        },
      });

      if (connectedPlatforms.length === 1) {
        platformConnection = connectedPlatforms[0];
        this.logger.log('Using single connected platform for message webhook', {
          userId: platformConnection.userId,
          businessId
        });
      }
    }

    if (!platformConnection) {
      this.logger.warn('No platform connection found for business', { businessId });
      return;
    }

    const userId = platformConnection.userId;

    // Ensure lead exists
    let lead = await this.prisma.lead.findFirst({
      where: {
        platform,
        externalRequestId: negotiationId,
      },
    });

    if (!lead) {
      this.logger.log('Lead not found, creating from MessageCreatedV4', { negotiationId, businessId });

      const customer = data.customer || {};

      lead = await this.prisma.lead.create({
        data: {
          userId,
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

    // Ensure conversation exists (use negotiationId as externalThreadId)
    let conversation = await this.prisma.conversation.findUnique({
      where: {
        platform_externalThreadId: {
          platform,
          externalThreadId: negotiationId,
        },
      },
    });

    if (!conversation) {
      const customer = data.customer || {};
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          platform,
          externalThreadId: negotiationId,
          customerName: customer.name || lead.customerName || 'Unknown',
          lastMessageAt: new Date(data.createTimestamp || Date.now()),
          status: 'active',
        },
      });
      this.logger.log('Conversation created', { conversationId: conversation.id, negotiationId });

      // Link lead to conversation if not already linked
      if (!lead.threadId) {
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { threadId: conversation.id },
        });
      }
    }

    // Check if message already exists (avoid duplicates)
    const existingMessage = await this.prisma.message.findFirst({
      where: {
        platform,
        externalMessageId: messageId,
      },
    });

    if (existingMessage) {
      this.logger.log('Message already exists, skipping', { messageId });
      return;
    }

    // Determine sender (pro or customer)
    const sender = data.sender?.toLowerCase() === 'pro' ? 'pro' : 'customer';

    // Store the message
    await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        userId,
        platform,
        externalMessageId: messageId,
        sender,
        content: data.text || '',
        isRead: sender === 'pro', // Mark own messages as read
        sentAt: new Date(data.createTimestamp || Date.now()),
        rawJson: JSON.stringify(data),
      },
    });

    // Update conversation's lastMessageAt and unread count
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(data.createTimestamp || Date.now()),
        unreadCount: sender === 'customer' ? { increment: 1 } : undefined,
      },
    });

    this.logger.log('Message stored successfully', { messageId, conversationId: conversation.id });
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
