/**
 * Webhooks Service
 * Processes webhook events from various platforms
 */

import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { AutomationService } from '../automation/automation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CallConnectService } from '../call-connect/call-connect.service';
import { AnalyticsService } from '../analytics/analytics.service';

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
    @Inject(forwardRef(() => CallConnectService))
    private callConnectService: CallConnectService,
    private analyticsService: AnalyticsService,
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

    // Invalidate analytics cache so insights reflects the new lead immediately
    await this.analyticsService.invalidateCache(userId);

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

    // Find saved account for this business (used by both automation and SMS notifications)
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: {
        platform,
        businessId: business.businessID,
      },
      include: { notificationSettings: { select: { id: true } } },
    });
    // Prefer: 1) account with settings matching userId, 2) account matching userId, 3) account with settings, 4) first
    // IMPORTANT: prioritize userId match over having settings to avoid cross-account contamination
    const savedAccount =
      savedAccounts.find((a: any) => a.notificationSettings && a.userId === userId) ||
      savedAccounts.find((a: any) => a.userId === userId) ||
      savedAccounts.find((a: any) => a.notificationSettings) ||
      savedAccounts[0] || null;
    if (savedAccounts.length > 1) {
      this.logger.warn(`Multiple savedAccounts for business ${business.businessID}: ${savedAccounts.map(a => `${a.id}(user=${a.userId},settings=${!!a.notificationSettings})`).join(', ')}. Using ${savedAccount?.id}`);
    }

    // Trigger automation rules for new leads
    try {
      await this.automationService.handleNewLead({
        userId,
        businessId: business.businessID,
        negotiationId,
        leadId: lead.id,
        customerName,
        accountName: savedAccount?.businessName || undefined,
        category: request.category?.name,
        city: location.city,
        state: location.state,
      });
    } catch (err: any) {
      this.logger.error('Automation trigger failed for new lead', err.message);
    }

    // Send SMS notification to company for new lead
    try {
      if (savedAccount) {
        await this.notificationsService.sendLeadNotification({
          userId,
          savedAccountId: savedAccount.id,
          leadId: lead.id,
          accountName: savedAccount.businessName,
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

    // Trigger Instant Call Connect for new lead
    try {
      await this.callConnectService.triggerForLead({
        userId,
        savedAccountId: savedAccount?.id ?? null,
        businessId: business.businessID ?? null,
        leadId: lead.id,
        customerPhone: customer.phone ?? null,
        customerName,
        accountName: savedAccount?.businessName ?? null,
        category: request.category?.name ?? null,
        location: [location.city, location.state].filter(Boolean).join(', ') || null,
        leadSummary: `${customerName} — ${request.category?.name || 'Service'} — ${[location.city, location.state].filter(Boolean).join(', ')}`,
      });
    } catch (err: any) {
      this.logger.error('Call-connect trigger failed for new lead', err.message);
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

    // Invalidate analytics cache (lead may have been created by this upsert)
    await this.analyticsService.invalidateCache(userId);

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
    // Use case-insensitive check to handle any capitalization variants
    const fromValue = String(data.from || data.sender || '').toLowerCase().trim();
    const sender = fromValue.includes('pro') || fromValue === 'business' ? 'pro' : 'customer';
    const messageContent = data.text || '';
    const messageTimestamp = new Date(data.sentAt || data.createTimestamp || Date.now());

    this.logger.log(`Message sender detected: from="${data.from}", sender="${sender}"`);

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

      this.logger.log(`[AUTOMATION TRIGGER] Customer message detected. Total customer messages: ${customerMessageCount}, negotiation: ${negotiationId}`);
      this.logger.log(`[AUTOMATION TRIGGER] isFirstCustomerReply: ${customerMessageCount === 1}, isSecondCustomerMessage: ${customerMessageCount === 2}`);

      // Find saved account for this business (search all users, prefer one with settings)
      const msgSavedAccounts = await this.prisma.savedAccount.findMany({
        where: { platform, businessId },
        include: { notificationSettings: { select: { id: true } } },
      });
      const savedAccount =
        msgSavedAccounts.find((a: any) => a.notificationSettings && a.userId === userId) ||
        msgSavedAccounts.find((a: any) => a.notificationSettings) ||
        msgSavedAccounts.find((a: any) => a.userId === userId) ||
        msgSavedAccounts[0] || null;

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
          accountName: savedAccount?.businessName || undefined,
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
            accountName: savedAccount.businessName,
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
    } else {
      // Pro message - no automation triggered
      this.logger.log(`[AUTOMATION TRIGGER] ✗ Pro/Business message detected - no automation triggered`);
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
   * Handle Sigcore delivery status webhook
   * Updates NotificationLog with delivery status
   */
  async handleSigcoreDeliveryStatus(params: {
    eventType: string;
    timestamp: string;
    signature: string;
    payload: any;
    rawBody: string;
  }): Promise<void> {
    const { eventType, timestamp, signature, payload, rawBody } = params;

    this.logger.log('=== SIGCORE DELIVERY WEBHOOK ===');
    this.logger.log(`Event: ${eventType}, Timestamp: ${timestamp}`);
    this.logger.log(`Payload: ${JSON.stringify(payload).substring(0, 500)}`);

    // Webhook verification: signature is verified by Sigcore at the platform level.
    // We accept all webhooks from Sigcore since the webhook subscription is managed via the API.
    const isVerified = true;

    // Log webhook event
    const event = await this.prisma.webhookEvent.create({
      data: {
        platform: 'sigcore',
        eventType: eventType || payload?.event || 'unknown',
        payload: rawBody,
        signature,
        verified: isVerified,
        processed: false,
      },
    });

    try {
      const data = payload?.data || payload;
      const messageId = data?.messageId;
      const status = data?.status;
      // Extract error details — Sigcore/Twilio may use various field names
      const errorCode = data?.errorCode ?? data?.error_code ?? data?.error?.code;
      const errorMessage = data?.errorMessage ?? data?.error_message ?? data?.error?.message ?? data?.failureReason ?? data?.reason;
      const leadId = data?.leadId;

      this.logger.log(`Processing delivery status: messageId=${messageId}, status=${status}, leadId=${leadId}`);
      if (status === 'failed') {
        this.logger.warn(`[delivery-failed] messageId=${messageId} errorCode=${errorCode} errorMessage=${errorMessage} providerMessageId=${data?.providerMessageId}`);
      }

      // Find the NotificationLog by sigcoreMessageId
      if (messageId) {
        const log = await this.prisma.notificationLog.findFirst({
          where: { sigcoreMessageId: messageId },
        });

        if (log) {
          // Map Sigcore status to our status
          let newStatus = status;
          if (status === 'delivered') {
            newStatus = 'delivered';
          } else if (status === 'failed') {
            newStatus = 'failed';
          } else if (status === 'sent') {
            newStatus = 'sent';
          }

          // Idempotency: skip if the log is already at the target status
          // (can happen when multiple webhook subscriptions fire for the same event)
          if (log.status === newStatus) {
            this.logger.log(`[idempotent] NotificationLog ${log.id} already at status ${newStatus}, skipping`);
          } else {
            // Update the log with delivery status
            await this.prisma.notificationLog.update({
              where: { id: log.id },
              data: {
                status: newStatus,
                ...(status === 'delivered' && { deliveredAt: new Date() }),
                ...(status === 'failed' && { error: errorMessage || (errorCode ? `Error code: ${errorCode}` : 'Delivery failed (no details from provider)') }),
              },
            });

            this.logger.log(`Updated NotificationLog ${log.id} with status: ${newStatus}`);

            // Also update the linked Message record (for customer-facing SMS in conversation)
            try {
              const linkedMessage = await this.prisma.message.findFirst({
                where: { notificationLogId: log.id },
              });
              if (linkedMessage) {
                await this.prisma.message.update({
                  where: { id: linkedMessage.id },
                  data: {
                    ...(status === 'delivered' && { deliveredAt: new Date() }),
                    // Clear deliveredAt if a failure event arrives (e.g. race: delivered then failed)
                    ...(status === 'failed' && { deliveredAt: null }),
                  },
                });

                // Emit SSE event for real-time delivery status in UI
                if (log.leadId) {
                  const lead = await this.prisma.lead.findUnique({
                    where: { id: log.leadId },
                    select: { userId: true },
                  });
                  if (lead) {
                    this.eventEmitter.emit(`sms.status.${lead.userId}`, {
                      messageId: linkedMessage.id,
                      logId: log.id,
                      status: newStatus,
                      deliveredAt: status === 'delivered' ? new Date().toISOString() : undefined,
                      error: status === 'failed' ? (errorMessage || `Error code: ${errorCode}`) : undefined,
                    });
                  }
                }
              }
            } catch (err: any) {
              this.logger.warn(`Failed to update linked Message: ${err.message}`);
            }
          }
        } else {
          // Not found is expected when a workspace-level subscription fires for a message
          // sent by a different tenant in the same workspace. Log at debug level.
          this.logger.debug(`NotificationLog not found for messageId: ${messageId} (cross-tenant or already processed)`);
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
      this.logger.error('Error processing Sigcore webhook', error);

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
   * Handle inbound SMS from a customer via Sigcore
   * Stores the message, cancels pending follow-ups, emits SSE event
   */
  async handleInboundSms(params: {
    eventType: string;
    timestamp: string;
    signature: string;
    accountId: string;
    payload: any;
    rawBody: string;
  }): Promise<void> {
    const { eventType, timestamp, signature, accountId, payload, rawBody } = params;

    this.logger.log('=== SIGCORE INBOUND SMS WEBHOOK ===');
    this.logger.log(`Event: ${eventType}, AccountId: ${accountId}`);
    this.logger.log(`Payload: ${JSON.stringify(payload).substring(0, 500)}`);

    // Log webhook event
    const event = await this.prisma.webhookEvent.create({
      data: {
        platform: 'sigcore',
        eventType: eventType || 'message.inbound',
        payload: rawBody,
        signature,
        verified: true, // Sigcore manages webhook verification at platform level
        processed: false,
      },
    });

    try {
      const data = payload?.data || payload;
      const fromNumber = data?.fromNumber || data?.from;
      const toNumber = data?.toNumber || data?.to;
      const body = data?.body || data?.text || data?.content || '';
      const messageId = data?.id || data?.messageId;

      if (!fromNumber || !body) {
        this.logger.warn('Inbound SMS missing fromNumber or body');
        return;
      }

      // Normalize phone for matching (last 10 digits)
      const normalizedFrom = fromNumber.replace(/\D/g, '').slice(-10);

      // Find the most recent lead matching this phone, scoped by account
      let leadQuery: any = {
        customerPhone: { contains: normalizedFrom },
      };

      // Scope by account's businessId if accountId provided
      if (accountId) {
        const savedAccount = await this.prisma.savedAccount.findUnique({
          where: { id: accountId },
        });
        if (savedAccount?.businessId) {
          leadQuery.businessId = savedAccount.businessId;
        }
      }

      const lead = await this.prisma.lead.findFirst({
        where: leadQuery,
        orderBy: { createdAt: 'desc' },
        include: { conversation: true },
      });

      if (!lead) {
        this.logger.warn(`No lead found for inbound SMS from ${fromNumber}`);
        // Forward to the tenant's configured forwarding number only if this account
        // is the actual recipient of the inbound SMS. When multiple accounts share a
        // Sigcore tenant, all of them receive the same webhook — skip accounts whose
        // configured fromPhone doesn't match the inbound toNumber (ghost events).
        if (accountId) {
          try {
            const acctSettings = await this.prisma.notificationSettings.findUnique({
              where: { savedAccountId: accountId },
              select: { sigcoreFromPhone: true },
            });
            const normTo = toNumber?.replace(/\D/g, '').slice(-10);
            const normAcctFrom = acctSettings?.sigcoreFromPhone?.replace(/\D/g, '').slice(-10);

            // Determine if this account is the legitimate recipient of the inbound SMS.
            // Check 1: account has no dedicated fromPhone (pure pool routing) → always forward
            // Check 2: toNumber matches the account's dedicated/BYO fromPhone
            // Check 3: toNumber matches one of the account's pool phone assignments
            let isOwner = !normAcctFrom || !normTo || normAcctFrom === normTo;
            if (!isOwner && normTo) {
              const poolAssignment = await this.prisma.phonePoolAssignment.findFirst({
                where: { user: { savedAccounts: { some: { id: accountId } } } },
                include: { phonePool: { select: { phoneNumber: true } } },
              });
              if (poolAssignment) {
                const normPool = poolAssignment.phonePool.phoneNumber.replace(/\D/g, '').slice(-10);
                if (normPool === normTo) isOwner = true;
              }
            }

            if (isOwner) {
              await this.notificationsService.forwardInboundSms(accountId, fromNumber, fromNumber, body);
            } else {
              this.logger.log(
                `[handleInboundSms] Skipping forward for account ${accountId}: ` +
                `inbound toNumber=${toNumber} doesn't match account fromPhone=${acctSettings?.sigcoreFromPhone} (shared-tenant ghost event)`,
              );
            }
          } catch (err: any) {
            this.logger.warn(`SMS forwarding failed (no lead): ${err.message}`);
          }
        }
        await this.prisma.webhookEvent.update({
          where: { id: event.id },
          data: { processed: true, processedAt: new Date(), processingError: 'No lead found for phone' },
        });
        return;
      }

      this.logger.log(`Matched inbound SMS to lead ${lead.id} (${lead.customerName})`);

      // Ensure conversation exists
      let conversationId = lead.threadId;
      if (!conversationId && lead.conversation) {
        conversationId = lead.conversation.id;
      }
      if (!conversationId) {
        // Create conversation if none exists
        const conversation = await this.prisma.conversation.create({
          data: {
            userId: lead.userId,
            platform: 'sms',
            externalThreadId: `sms-${lead.id}`,
            customerName: lead.customerName,
            lastMessageAt: new Date(),
            unreadCount: 1,
          },
        });
        conversationId = conversation.id;
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { threadId: conversationId },
        });
      }

      // Store as Message record
      const message = await this.prisma.message.create({
        data: {
          conversationId,
          userId: lead.userId,
          platform: 'sms',
          externalMessageId: messageId || `inbound-${Date.now()}`,
          sender: 'customer',
          content: body,
          isRead: false,
          sentAt: new Date(),
        },
      });

      // Update conversation
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          lastMessageAt: new Date(),
          unreadCount: { increment: 1 },
        },
      });

      // Trigger customer_reply notification rules (e.g., forward reply to business owner)
      try {
        // Resolve savedAccountId for this lead's business
        const savedAccount = await this.prisma.savedAccount.findFirst({
          where: { userId: lead.userId, businessId: lead.businessId || undefined },
        });
        if (savedAccount) {
          await this.notificationsService.handleCustomerReply({
            userId: lead.userId,
            savedAccountId: savedAccount.id,
            leadId: lead.id,
            lead: {
              customerName: lead.customerName,
              customerPhone: lead.customerPhone || fromNumber,
              category: lead.category,
              city: lead.city,
              state: lead.state,
              postcode: lead.postcode,
              message: body,
            },
            isFirstCustomerReply: false, // Inbound SMS is not the first Thumbtack message
          });
        }
      } catch (err: any) {
        this.logger.warn(`Failed to handle customer reply rules: ${err.message}`);
      }

      // Forward SMS to tenant's forwarding number if configured
      try {
        const fwdAccount = await this.prisma.savedAccount.findFirst({
          where: { userId: lead.userId, businessId: lead.businessId || undefined },
        });
        if (fwdAccount) {
          await this.notificationsService.forwardInboundSms(fwdAccount.id, lead.customerName, fromNumber, body);
        }
      } catch (err: any) {
        this.logger.warn(`SMS forwarding failed: ${err.message}`);
      }

      // Emit SSE event for real-time UI update
      this.eventEmitter.emit(`sms.inbound.${lead.userId}`, {
        leadId: lead.id,
        message: {
          id: message.id,
          content: body,
          sender: 'customer',
          sentAt: message.sentAt,
          fromNumber,
        },
      });

      // Mark webhook as processed
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, processedAt: new Date() },
      });
    } catch (error: any) {
      this.logger.error('Error processing inbound SMS webhook', error);
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
