/**
 * Webhooks Service
 * Processes webhook events from various platforms
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as crypto from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { AutomationService } from '../automation/automation.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  // In-memory deduplication cache to prevent processing same webhook multiple times
  // Key: "eventType:negotiationId", Value: timestamp of first processing
  private processingCache: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds TTL

  constructor(
    private prisma: PrismaService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
    private eventEmitter: EventEmitter2,
    @Inject(forwardRef(() => AutomationService))
    private automationService: AutomationService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
  ) {
    // Clean up expired cache entries every minute
    setInterval(() => this.cleanupProcessingCache(), 60 * 1000);
  }

  /**
   * Clean up expired entries from processing cache
   */
  private cleanupProcessingCache(): void {
    const now = Date.now();
    for (const [key, timestamp] of this.processingCache.entries()) {
      if (now - timestamp > this.CACHE_TTL_MS) {
        this.processingCache.delete(key);
      }
    }
  }

  /**
   * Check if webhook event is being or was recently processed
   * Returns true if this is a duplicate that should be skipped
   */
  private isDuplicateWebhook(eventType: string, uniqueId: string): boolean {
    const cacheKey = `${eventType}:${uniqueId}`;
    const existing = this.processingCache.get(cacheKey);
    const now = Date.now();

    if (existing && (now - existing) < this.CACHE_TTL_MS) {
      this.logger.log(`Duplicate webhook detected, skipping: ${cacheKey} (age: ${now - existing}ms)`);
      return true;
    }

    // Mark as being processed
    this.processingCache.set(cacheKey, now);
    this.logger.log(`Processing new webhook: ${cacheKey}`);
    return false;
  }

  /**
   * Handle incoming webhook from Thumbtack
   */
  async handleThumbtackWebhook(signature: string | undefined, payload: any): Promise<void> {
    const secret = this.configService.get<string>('thumbtack.webhookSecret') || '';
    const adapter = this.platformFactory.getAdapter('thumbtack');

    // Log webhook receipt for debugging - include businessId to identify which account
    const businessId = payload?.data?.business?.businessID;
    const negotiationId = payload?.data?.negotiationID;
    const messageId = payload?.data?.messageID;
    const eventType = payload?.event?.eventType || payload?.event_type || 'unknown';

    this.logger.log('=== WEBHOOK RECEIVED ===');
    this.logger.log(`Event: ${eventType}, negotiation: ${negotiationId}, message: ${messageId}, business: ${businessId}`);

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
        eventType,
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

    // Get unique ID for deduplication (negotiationID for v4 events, request_id for legacy)
    const negotiationId = payload.data?.negotiationID;
    const messageId = payload.data?.messageID;
    const requestId = payload.request_id;
    const uniqueId = messageId || negotiationId || requestId;

    // Check for duplicate webhook (same event received multiple times from different subscriptions)
    if (uniqueId && this.isDuplicateWebhook(eventType, uniqueId)) {
      this.logger.log(`Skipping duplicate ${eventType} webhook for ${uniqueId}`);
      // Mark as processed but note it was a duplicate
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          processed: true,
          processingError: 'Duplicate webhook - already processed',
          processedAt: new Date(),
        },
      });
      return;
    }

    this.logger.log(`Processing: ${eventType}, negId: ${negotiationId}, msgId: ${messageId}`);

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

    this.logger.log(`NegotiationCreated: ${negotiationId}, business: ${business.businessID}`);

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

    // Fallback: check SavedAccount table for businessId -> userId mapping
    // This handles multi-account scenarios where the businessId isn't the currently connected one
    if (!platformConnection) {
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: {
          platform,
          businessId: business.businessID,
        },
      });

      if (savedAccount) {
        this.logger.log('Found user via SavedAccount lookup for negotiation', {
          userId: savedAccount.userId,
          businessID: business.businessID,
        });
        platformConnection = await this.prisma.platform.findFirst({
          where: {
            platformName: platform,
            userId: savedAccount.userId,
            connected: true,
          },
        });
      }
    }

    // Last resort: try to find any connected Thumbtack platform
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

    const userId = platformConnection.userId;
    const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown';

    // Parse original createdAt from Thumbtack data
    const originalCreatedAt = data.createdAt ? new Date(data.createdAt) : new Date();

    // Store the lead
    // Note: Keep status as-is from Thumbtack API (Open, Picked, Canceled, Completed)
    const lead = await this.prisma.lead.upsert({
      where: {
        platform_externalRequestId: {
          platform,
          externalRequestId: negotiationId,
        },
      },
      create: {
        userId,
        platform,
        businessId: business.businessID,
        externalRequestId: negotiationId,
        customerName,
        customerPhone: customer.phone,
        message: request.description || '',
        postcode: location.zipCode,
        city: location.city,
        state: location.state,
        category: request.category?.name,
        status: data.status || 'Open',
        rawJson: JSON.stringify(data),
        createdAt: originalCreatedAt,
      },
      update: {
        customerName,
        customerPhone: customer.phone,
        message: request.description || '',
        status: data.status || 'Open',
        rawJson: JSON.stringify(data),
        createdAt: originalCreatedAt,
      },
    });

    this.logger.log('Lead stored successfully', { negotiationId });

    // Emit SSE event for real-time frontend updates
    this.eventEmitter.emit(`lead.created.${userId}`, lead);

    // Create conversation (messages will arrive via MessageCreatedV4 webhook)
    await this.ensureConversationForLead(
      userId,
      platform,
      negotiationId,
      customerName,
      lead.id,
    );

    // Trigger automation rules for new leads
    try {
      await this.automationService.handleNewLead({
        userId,
        businessId: business.businessID,
        negotiationId,
        leadId: lead.id,
        customerName,
        category: request.category?.name,
        city: location.city,
        state: location.state,
      });
    } catch (err: any) {
      this.logger.error('Automation trigger failed for new lead', err.message);
    }

    // Send SMS notification to company for new lead
    try {
      // Find the saved account for this business to get notification settings
      // Prefer the account that actually has notification settings configured
      const savedAccounts = await this.prisma.savedAccount.findMany({
        where: {
          platform,
          businessId: business.businessID,
          userId,
        },
        include: { notificationSettings: { select: { id: true } } },
      });
      const savedAccount = savedAccounts.find((a: any) => a.notificationSettings) || savedAccounts[0] || null;
      if (savedAccounts.length > 1) {
        this.logger.warn(`Multiple savedAccounts for business ${business.businessID}: ${savedAccounts.map(a => a.id).join(', ')}. Using ${savedAccount?.id}`);
      }

      if (savedAccount) {
        await this.notificationsService.sendLeadNotification({
          userId,
          savedAccountId: savedAccount.id,
          leadId: lead.id,
          lead: {
            customerName,
            customerPhone: customer.phone,
            category: request.category?.name,
            city: location.city,
            state: location.state,
            postcode: location.zipCode,
            message: request.description || '',
            rawJson: JSON.stringify(data),
          },
        });
      } else {
        this.logger.log('No saved account found for SMS notification', { businessId: business.businessID });
      }
    } catch (err: any) {
      this.logger.error('SMS notification failed for new lead', err.message);
    }
  }

  /**
   * Create conversation for a new negotiation (messages come via MessageCreatedV4 webhook)
   */
  private async ensureConversationForLead(
    userId: string,
    platform: string,
    negotiationId: string,
    customerName: string,
    leadId: string,
  ): Promise<void> {
    // Use upsert to handle race conditions when multiple webhooks arrive simultaneously
    const conversation = await this.prisma.conversation.upsert({
      where: {
        platform_externalThreadId: {
          platform,
          externalThreadId: negotiationId,
        },
      },
      create: {
        userId,
        platform,
        externalThreadId: negotiationId,
        customerName,
        lastMessageAt: new Date(),
        status: 'active',
      },
      update: {
        // No-op update - conversation already exists
      },
    });

    this.logger.log('Conversation ensured for negotiation', { conversationId: conversation.id, negotiationId });

    // Link lead to conversation if not already linked
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (lead && !lead.threadId) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { threadId: conversation.id },
      });
    }

    this.logger.log('Conversation ready', { conversationId: conversation.id, negotiationId });
  }

  /**
   * Handle MessageCreatedV4 webhook (Thumbtack v4)
   * Creates/updates lead and stores the message in the database
   */
  private async handleMessageCreated(platform: string, data: any): Promise<void> {
    const negotiationId = data.negotiationID;
    const businessId = data.business?.businessID;
    const messageId = data.messageID;
    const messageFrom = data.from;

    this.logger.log(`MessageCreated: msgId=${messageId}, negId=${negotiationId}, from=${messageFrom}`);

    if (!businessId || !negotiationId) {
      this.logger.warn(`Missing businessId or negotiationId: biz=${businessId}, neg=${negotiationId}`);
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

    // Fallback: check SavedAccount table for businessId -> userId mapping
    // This handles multi-account scenarios where the businessId isn't the currently connected one
    if (!platformConnection) {
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: {
          platform,
          businessId,
        },
      });

      if (savedAccount) {
        this.logger.log('Found user via SavedAccount lookup', {
          userId: savedAccount.userId,
          businessId,
        });
        platformConnection = await this.prisma.platform.findFirst({
          where: {
            platformName: platform,
            userId: savedAccount.userId,
            connected: true,
          },
        });
      }
    }

    // Last resort fallback: if only one connected platform, use that
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

    // Ensure lead exists using upsert to handle race conditions
    const customer = data.customer || {};
    const customerName = customer.displayName || customer.name || `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown';

    const lead = await this.prisma.lead.upsert({
      where: {
        platform_externalRequestId: {
          platform,
          externalRequestId: negotiationId,
        },
      },
      create: {
        userId,
        platform,
        businessId,
        externalRequestId: negotiationId,
        customerName,
        customerPhone: customer.phone,
        message: data.text || '',
        status: 'Open', // Default to Open for new leads created from message
        rawJson: JSON.stringify(data),
      },
      update: {
        // Update customer name if we have a better one
        customerName,
      },
    });

    this.logger.log('Lead ensured via upsert', { negotiationId, leadId: lead.id });

    // Ensure conversation exists using upsert to handle race conditions
    const messageTimestampForConv = new Date(data.sentAt || data.createTimestamp || Date.now());

    const conversation = await this.prisma.conversation.upsert({
      where: {
        platform_externalThreadId: {
          platform,
          externalThreadId: negotiationId,
        },
      },
      create: {
        userId,
        platform,
        externalThreadId: negotiationId,
        customerName: customerName || lead.customerName || 'Unknown',
        lastMessageAt: messageTimestampForConv,
        status: 'active',
      },
      update: {
        // Update lastMessageAt if this message is newer
        lastMessageAt: messageTimestampForConv,
      },
    });

    this.logger.log('Conversation ensured via upsert', { conversationId: conversation.id, negotiationId });

    // Link lead to conversation if not already linked
    if (!lead.threadId) {
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { threadId: conversation.id },
      });
    }

    // Determine sender (pro or customer)
    // Thumbtack uses "from" field with values "Customer" or "Pro"
    const fromValue = (data.from || data.sender || '').toLowerCase();
    const sender = fromValue === 'pro' ? 'pro' : 'customer';
    const messageContent = data.text || '';
    const messageTimestamp = new Date(data.sentAt || data.createTimestamp || Date.now());

    // Use upsert to handle race conditions and duplicates atomically
    try {
      await this.prisma.message.upsert({
        where: {
          platform_externalMessageId: {
            platform,
            externalMessageId: messageId,
          },
        },
        create: {
          conversationId: conversation.id,
          userId,
          platform,
          externalMessageId: messageId,
          sender,
          content: messageContent,
          isRead: sender === 'pro', // Mark own messages as read
          sentAt: messageTimestamp,
          rawJson: JSON.stringify(data),
        },
        update: {
          // No-op update - message already exists
        },
      });
    } catch (error) {
      // Handle unique constraint violation (race condition)
      if (error.code === 'P2002') {
        this.logger.log('Message already exists (race condition handled)', { messageId });
        return;
      }
      throw error;
    }

    // Update conversation's lastMessageAt and unread count
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        lastMessageAt: new Date(data.createTimestamp || Date.now()),
        unreadCount: sender === 'customer' ? { increment: 1 } : undefined,
      },
    });

    this.logger.log('Message stored successfully', { messageId, conversationId: conversation.id });

    // Trigger automation rules and SMS notifications for customer replies (excludes first message)
    if (sender === 'customer') {
      // Count customer messages to determine reply position
      const customerMessageCount = await this.prisma.message.count({
        where: { conversationId: conversation.id, sender: 'customer' },
      });

      // Find saved account for this business (prefer one with notification settings)
      const msgSavedAccounts = await this.prisma.savedAccount.findMany({
        where: { userId, platform, businessId },
        include: { notificationSettings: { select: { id: true } } },
      });
      const savedAccount = msgSavedAccounts.find((a: any) => a.notificationSettings) || msgSavedAccounts[0] || null;

      // Trigger automation rules (Thumbtack auto-reply)
      try {
        await this.automationService.handleCustomerReply({
          userId,
          businessId,
          negotiationId,
          leadId: lead.id,
          isFirstCustomerReply: customerMessageCount === 1,
          isSecondCustomerMessage: customerMessageCount === 2, // First actual reply after initial message
          customerName: lead.customerName,
          category: lead.category || undefined,
          city: lead.city || undefined,
          state: lead.state || undefined,
        });
      } catch (err: any) {
        this.logger.error('Automation trigger failed for customer reply', err.message);
      }

      // Trigger SMS notifications for customer replies
      if (savedAccount) {
        try {
          await this.notificationsService.handleCustomerReply({
            userId,
            savedAccountId: savedAccount.id,
            leadId: lead.id,
            lead: {
              customerName: lead.customerName,
              customerPhone: lead.customerPhone,
              category: lead.category,
              city: lead.city,
              state: lead.state,
              postcode: lead.postcode,
              message: lead.message,
              rawJson: lead.rawJson,
            },
            isFirstCustomerReply: customerMessageCount === 1,
            isSecondCustomerMessage: customerMessageCount === 2,
          });
        } catch (err: any) {
          this.logger.error('SMS notification trigger failed for customer reply', err.message);
        }
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
   * Verify Callio webhook signature using HMAC-SHA256
   */
  private verifyCallioSignature(rawBody: string, signature: string, secret: string): boolean {
    if (!signature || !secret) {
      return false;
    }
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  }

  /**
   * Handle Callio delivery status webhook
   * Updates NotificationLog with delivery status
   */
  async handleCallioDeliveryStatus(params: {
    eventType: string;
    timestamp: string;
    tenantId: string;
    signature: string;
    payload: any;
    rawBody: string;
  }): Promise<void> {
    const { eventType, timestamp, tenantId, signature, payload, rawBody } = params;

    this.logger.log('=== CALLIO WEBHOOK RECEIVED ===');
    this.logger.log(`Event: ${eventType}, Tenant: ${tenantId}, Timestamp: ${timestamp}`);
    this.logger.log(`Payload: ${JSON.stringify(payload)}`);

    // Verify signature
    const webhookSecret = this.configService.get<string>('callio.webhookSecret');
    let isVerified = false;

    if (webhookSecret && signature) {
      try {
        isVerified = this.verifyCallioSignature(rawBody, signature, webhookSecret);
        this.logger.log(`Signature verification: ${isVerified ? 'PASSED' : 'FAILED'}`);
      } catch (err: any) {
        this.logger.warn('Signature verification error:', err.message);
        isVerified = false;
      }
    } else if (!webhookSecret) {
      // If no secret configured, accept webhook (development mode)
      this.logger.warn('No CALLIO_WEBHOOK_SECRET configured - accepting webhook without verification');
      isVerified = true;
    } else if (!signature) {
      this.logger.warn('No signature header received - rejecting webhook');
      isVerified = false;
    }

    // Log webhook event
    const event = await this.prisma.webhookEvent.create({
      data: {
        platform: 'callio',
        eventType: eventType || payload?.event || 'unknown',
        payload: rawBody,
        signature,
        verified: isVerified,
        processed: false,
      },
    });

    // Reject if signature verification failed (when secret is configured)
    if (!isVerified && webhookSecret) {
      this.logger.warn('Rejecting Callio webhook due to invalid signature', { eventId: event.id });
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

    try {
      const data = payload?.data || payload;
      const messageId = data?.messageId;
      const status = data?.status;
      const errorCode = data?.errorCode;
      const errorMessage = data?.errorMessage;
      const leadId = data?.leadId;

      this.logger.log(`Processing delivery status: messageId=${messageId}, status=${status}, leadId=${leadId}`);

      // Find the NotificationLog by callioMessageId
      if (messageId) {
        const log = await this.prisma.notificationLog.findFirst({
          where: { callioMessageId: messageId },
        });

        if (log) {
          // Map Callio status to our status
          let newStatus = status;
          if (status === 'delivered') {
            newStatus = 'delivered';
          } else if (status === 'failed') {
            newStatus = 'failed';
          } else if (status === 'sent') {
            newStatus = 'sent';
          }

          // Update the log with delivery status
          await this.prisma.notificationLog.update({
            where: { id: log.id },
            data: {
              status: newStatus,
              ...(status === 'delivered' && { deliveredAt: new Date() }),
              ...(status === 'failed' && { error: errorMessage || `Error code: ${errorCode}` }),
            },
          });

          this.logger.log(`Updated NotificationLog ${log.id} with status: ${newStatus}`);
        } else {
          this.logger.warn(`NotificationLog not found for messageId: ${messageId}`);
        }
      }

      // Mark webhook as processed
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processedAt: new Date(),
        },
      });
    } catch (error: any) {
      this.logger.error('Error processing Callio webhook', error);

      // Mark webhook as failed
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: {
          processed: true,
          processedAt: new Date(),
          processingError: error.message || 'Unknown error',
        },
      });
    }
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
