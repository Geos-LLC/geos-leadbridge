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
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';
import { EncryptionUtil } from '../common/utils/encryption.util';

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  // In-memory deduplication cache to prevent processing same webhook multiple times
  // Key: "eventType:negotiationId", Value: timestamp of first processing
  private processingCache: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 30 * 1000; // 30 seconds TTL
  private readonly _recentInboundSmsIds = new Set<string>();

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
    private conversationContextService: ConversationContextService,
    private followUpEngine: FollowUpEngineService,
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
    const _whStart = Date.now();
    const secret = this.configService.get<string>('thumbtack.webhookSecret') || '';
    const adapter = this.platformFactory.getAdapter('thumbtack');

    // Log webhook receipt for debugging - include businessId to identify which account
    const businessId = payload?.data?.business?.businessID;
    const negotiationId = payload?.data?.negotiationID;
    const messageId = payload?.data?.messageID;
    const eventType = payload?.event?.eventType || payload?.event_type || 'unknown';

    this.logger.log(`=== WEBHOOK RECEIVED === (+${Date.now() - _whStart}ms)`);
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

    this.logger.log(`[timing] webhook DB write: +${Date.now() - _whStart}ms`);

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

    // Check for duplicate webhook — in-memory (same process) + DB (cross-instance).
    // DB check prevents staging+production from both processing the same event.
    if (uniqueId && this.isDuplicateWebhook(eventType, uniqueId)) {
      this.logger.log(`Skipping duplicate ${eventType} webhook for ${uniqueId} (in-memory)`);
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: { processed: true, processingError: 'Duplicate (in-memory)', processedAt: new Date() },
      });
      return;
    }
    if (uniqueId) {
      const alreadyProcessed = await this.prisma.webhookEvent.findFirst({
        where: {
          platform,
          eventType,
          processed: true,
          processingError: null, // successfully processed, not a duplicate itself
          id: { not: eventId },  // exclude current event
          payload: { contains: uniqueId },
        },
        select: { id: true },
      });
      if (alreadyProcessed) {
        this.logger.log(`Skipping duplicate ${eventType} webhook for ${uniqueId} (DB: already processed by ${alreadyProcessed.id})`);
        await this.prisma.webhookEvent.update({
          where: { id: eventId },
          data: { processed: true, processingError: 'Duplicate (cross-instance)', processedAt: new Date() },
        });
        return;
      }
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
    const _ncStart = Date.now();
    const negotiationId = data.negotiationID;
    const customer = data.customer || {};
    const request = data.request || {};
    const location = request.location || {};
    const business = data.business || {};

    this.logger.log(`NegotiationCreated: ${negotiationId}, business: ${business.businessID}`);

    // Resolve user via SavedAccount (source of truth for business→user mapping).
    // SavedAccount is created during account setup and always has the correct userId.
    // NOTE: Do NOT use Platform.connected — it's a stale legacy flag that breaks lookups.
    const accountForLookup = await this.prisma.savedAccount.findFirst({
      where: { platform, businessId: business.businessID },
      select: { userId: true, id: true, businessName: true },
    });

    let userId: string;

    if (accountForLookup) {
      userId = accountForLookup.userId;
      this.logger.log(`User resolved via SavedAccount: userId=${userId} account=${accountForLookup.businessName}`);
    } else {
      // Fallback: try existing lead or Platform table
      const existingLead = await this.prisma.lead.findFirst({
        where: { platform, businessId: business.businessID },
        select: { userId: true },
      });
      if (existingLead) {
        userId = existingLead.userId;
        this.logger.log(`User resolved via existing lead: userId=${userId}`);
      } else {
        const platformRecord = await this.prisma.platform.findFirst({
          where: { platformName: platform, externalBusinessId: business.businessID },
        });
        if (platformRecord) {
          userId = platformRecord.userId;
          this.logger.log(`User resolved via Platform record: userId=${userId}`);
        } else {
          this.logger.warn('No user found for business', { businessID: business.businessID });
          return;
        }
      }
    }

    this.logger.log(`[timing] user resolved: +${Date.now() - _ncStart}ms`);
    const customerName = `${customer.firstName || ''} ${customer.lastName || ''}`.trim() || 'Unknown';

    // Parse original createdAt from Thumbtack data
    const originalCreatedAt = data.createdAt ? new Date(data.createdAt) : new Date();

    // Run lead upsert + savedAccount lookup in parallel — they're independent
    const [lead, savedAccounts] = await Promise.all([
      this.prisma.lead.upsert({
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
      }),
      this.prisma.savedAccount.findMany({
        where: { platform, businessId: business.businessID },
        include: { notificationSettings: { select: { id: true } } },
      }),
    ]);

    this.logger.log(`[timing] lead upsert + savedAccount: +${Date.now() - _ncStart}ms, negotiation: ${negotiationId}`);

    // Emit SSE event for real-time frontend updates (sync, instant)
    this.eventEmitter.emit(`lead.created.${userId}`, lead);

    // STRICT: only use savedAccounts belonging to the resolved userId — never cross-account
    const userAccounts = savedAccounts.filter((a: any) => a.userId === userId);
    const savedAccount =
      userAccounts.find((a: any) => a.notificationSettings) ||
      userAccounts[0] || null;
    if (savedAccounts.length > userAccounts.length) {
      this.logger.warn(`Cross-account savedAccounts filtered out for business ${business.businessID}: ${savedAccounts.length} total, ${userAccounts.length} for user ${userId}. Dropped: ${savedAccounts.filter(a => a.userId !== userId).map(a => `${a.id}(user=${a.userId})`).join(', ')}`);
    }
    if (userAccounts.length > 1) {
      this.logger.warn(`Multiple savedAccounts for user ${userId}, business ${business.businessID}: ${userAccounts.map(a => `${a.id}(settings=${!!a.notificationSettings})`).join(', ')}. Using ${savedAccount?.id}`);
    }
    // Ensure conversation exists BEFORE automation fires — automation needs threadId to send platform messages
    await this.ensureConversationForLead(userId, platform, negotiationId, customerName, lead.id);

    // Fire automation, SMS notification, and call connect in parallel — all independent
    const automationPromise = (async () => {
      try {
        await this.automationService.handleNewLead({
          userId,
          businessId: business.businessID,
          negotiationId,
          leadId: lead.id,
          customerName,
          customerMessage: request.description || undefined,
          accountName: savedAccount?.businessName || undefined,
          category: request.category?.name,
          city: location.city,
          state: location.state,
        });
      } catch (err: any) {
        this.logger.error('Automation trigger failed for new lead', err.message);
      }
    })();

    const smsPromise = (async () => {
      try {
        if (savedAccount) {
          this.logger.log(`[timing] SMS notification starting: +${Date.now() - _ncStart}ms`);
          await this.notificationsService.sendLeadNotification({
            userId,
            savedAccountId: savedAccount.id,
            leadId: lead.id,
            accountName: savedAccount.businessName,
            platform: 'thumbtack',
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
        this.logger.error(`SMS notification failed for new lead (+${Date.now() - _ncStart}ms)`, err.message);
      }
    })();

    const callPromise = (async () => {
      try {
        this.logger.log(`[timing] call connect starting: +${Date.now() - _ncStart}ms`);
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
        this.logger.error(`Call-connect trigger failed for new lead (+${Date.now() - _ncStart}ms)`, err.message);
      }
    })();

    await Promise.all([automationPromise, smsPromise, callPromise]);
    this.logger.log(`[timing] all parallel tasks done: +${Date.now() - _ncStart}ms`);

    // Non-critical deferred work — runs after notifications/call are already firing
    this.analyticsService.invalidateCache(userId).catch(err =>
      this.logger.error('Analytics cache invalidation failed', err.message),
    );
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

    // Resolve user via SavedAccount (source of truth), same pattern as handleNegotiationCreated
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: { platform, businessId },
      select: { userId: true, id: true, businessName: true },
    });

    let userId: string;

    if (savedAccount) {
      userId = savedAccount.userId;
    } else {
      // Fallback: existing lead or Platform record
      const existingLead = await this.prisma.lead.findFirst({
        where: { platform, businessId },
        select: { userId: true },
      });
      if (existingLead) {
        userId = existingLead.userId;
      } else {
        const platformRecord = await this.prisma.platform.findFirst({
          where: { platformName: platform, externalBusinessId: businessId },
        });
        if (platformRecord) {
          userId = platformRecord.userId;
        } else {
          this.logger.warn('No user found for business in MessageCreated', { businessId });
          return;
        }
      }
    }

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

    // Update thread context (conversation intelligence layer)
    try {
      await this.conversationContextService.recordMessage({
        conversationId: conversation.id,
        leadId: lead?.id,
        platform,
        sender,
        content: messageContent,
        timestamp: messageTimestamp,
      });
    } catch (err: any) {
      this.logger.warn(`Failed to update thread context: ${err.message}`);
    }

    // Backfill missing pro messages: when a customer replies, fetch the full thread
    // from Thumbtack to capture messages sent directly on the platform
    if (sender === 'customer' && platform === 'thumbtack') {
      try {
        const account = await this.prisma.savedAccount.findFirst({
          where: { userId, platform, businessId },
          select: { credentialsJson: true },
        });
        if (account?.credentialsJson) {
          const encKey = this.configService.get<string>('encryption.key') || '';
          const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, encKey);
          if (creds.accessToken) {
            const adapter = this.platformFactory.getAdapter(platform);
            const allMessages = await adapter.getConversation(creds, negotiationId);
            let backfilled = 0;
            for (const msg of allMessages) {
              if (msg.sender !== 'pro' || !msg.externalMessageId) continue;
              try {
                await this.prisma.message.upsert({
                  where: { platform_externalMessageId: { platform, externalMessageId: msg.externalMessageId } },
                  create: {
                    conversationId: conversation.id,
                    userId,
                    platform,
                    externalMessageId: msg.externalMessageId,
                    sender: 'pro',
                    content: msg.content || '',
                    isRead: true,
                    sentAt: msg.sentAt || new Date(),
                    rawJson: JSON.stringify(msg.raw || {}),
                  },
                  update: {},
                });
                backfilled++;
              } catch { /* duplicate — skip */ }
            }
            if (backfilled > 0) {
              this.logger.log(`Backfilled ${backfilled} pro messages for negotiation ${negotiationId}`);
            }
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to backfill pro messages for ${negotiationId}: ${err.message}`);
      }
    }

    // Stop follow-up sequences on customer reply (synchronous, idempotent)
    if (sender === 'customer') {
      try {
        await this.followUpEngine.handleCustomerReply(conversation.id);
      } catch (err: any) {
        this.logger.warn(`Failed to stop follow-up on customer reply: ${err.message}`);
      }
    }

    // Evaluate thread for follow-up enrollment after pro/AI message
    if (sender === 'pro') {
      try {
        await this.followUpEngine.evaluateThread(conversation.id, platform);
      } catch (err: any) {
        this.logger.warn(`Failed to evaluate thread for follow-up: ${err.message}`);
      }
    }

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
            platform: 'thumbtack',
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
      const conversationMetadata: Record<string, unknown> = data?.conversationMetadata || {};
      const conversationPurpose = conversationMetadata?.purpose as string | undefined;

      if (!fromNumber || !body) {
        this.logger.warn('Inbound SMS missing fromNumber or body');
        return;
      }

      // Deduplicate: skip if we already saw this messageId FOR THIS ACCOUNT
      // (shared tenants deliver the same webhook to multiple accounts)
      if (messageId && accountId) {
        const dedupKey = `${accountId}:${messageId}`;
        if (this._recentInboundSmsIds.has(dedupKey)) {
          this.logger.log(`[handleInboundSms] Skipping duplicate messageId=${messageId} for account ${accountId}`);
          await this.prisma.webhookEvent.update({ where: { id: event.id }, data: { processed: true } });
          return;
        }
        this._recentInboundSmsIds.add(dedupKey);
        setTimeout(() => this._recentInboundSmsIds.delete(dedupKey), 60_000);
      }

      // Normalize phone for matching (last 10 digits)
      const normalizedFrom = fromNumber.replace(/\D/g, '').slice(-10);

      // Detect agent replying to the bot number — send a helpful guidance SMS
      if (accountId) {
        const nsSettings = await this.prisma.notificationSettings.findUnique({
          where: { savedAccountId: accountId },
          select: { destinationPhone: true, sigcoreApiKey: true },
        });
        const normDestination = nsSettings?.destinationPhone?.replace(/\D/g, '').slice(-10);
        if (normDestination && normDestination === normalizedFrom && nsSettings?.sigcoreApiKey) {
          this.logger.log(
            `[handleInboundSms] Agent phone ${fromNumber} texted the bot number — sending guidance reply`,
          );
          try {
            const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app');
            await fetch(`${sigcoreUrl}/api/v1/messages`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': nsSettings.sigcoreApiKey,
              },
              body: JSON.stringify({
                to: fromNumber,
                body: 'This is your LeadBridge number. To reply to a customer, text them directly from your phone or use the Lead Activity page on leadbridge360.com.',
                fromNumber: toNumber,
                metadata: { purpose: 'agent_guidance', savedAccountId: accountId },
              }),
              signal: AbortSignal.timeout(15_000),
            });
          } catch (err: any) {
            this.logger.warn(`[handleInboundSms] Failed to send agent guidance SMS: ${err.message}`);
          }
          await this.prisma.webhookEvent.update({
            where: { id: event.id },
            data: { processed: true, processedAt: new Date(), processingError: 'Agent replied to bot number — guidance sent' },
          });
          return;
        }
      }

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
            // Only forward when the customer texted a bot number (TenantPhoneNumber).
            // Messages to BYO/OpenPhone or other numbers are NOT forwarded.
            const acctUser = await this.prisma.savedAccount.findUnique({
              where: { id: accountId },
              select: { userId: true },
            });
            const normTo = toNumber?.replace(/\D/g, '').slice(-10);
            const botPhone = normTo && acctUser
              ? await this.prisma.tenantPhoneNumber.findFirst({
                  where: { userId: acctUser.userId, status: 'ACTIVE', phoneNumber: { endsWith: normTo } },
                  select: { phoneNumber: true },
                })
              : null;

            const noFwdPurposes = new Set(['sms_forwarding', 'agent_notification', 'agent_guidance', 'icc_forward']);
            if (botPhone && (!conversationPurpose || !noFwdPurposes.has(conversationPurpose))) {
              this.logger.log(`[handleInboundSms] Forwarding no-lead inbound from ${fromNumber} — toNumber ${toNumber} matches bot phone ${botPhone.phoneNumber} for account ${accountId}`);
              await this.notificationsService.forwardInboundSms(accountId, fromNumber, fromNumber, body);
            } else if (botPhone) {
              this.logger.log(`[handleInboundSms] Skipping no-lead forward for purpose=${conversationPurpose}`);
            } else {
              this.logger.log(
                `[handleInboundSms] Skipping no-lead forward for account ${accountId}: toNumber=${toNumber} is not a bot number`,
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
            platform: savedAccount.platform,
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

      // Forward SMS to agent only when the customer texted the bot number (dedicated number).
      // Skip forwarding when:
      // - Purpose indicates this is NOT a customer-originating message (sms_forwarding, agent_notification, etc.)
      // - toNumber doesn't match a dedicated bot number for this account — LeadBridge only forwards
      //   messages that arrive on numbers it controls (TenantPhoneNumber). Messages to BYO/OpenPhone
      //   numbers or other numbers are NOT forwarded (the agent receives those natively).
      const noForwardPurposes = new Set(['sms_forwarding', 'agent_notification', 'agent_guidance', 'icc_forward']);
      if (conversationPurpose && noForwardPurposes.has(conversationPurpose)) {
        this.logger.log(
          `[handleInboundSms] Skipping forward for purpose=${conversationPurpose} (lead=${lead.id})`,
        );
      } else {
        try {
          const fwdAccount = await this.prisma.savedAccount.findFirst({
            where: { userId: lead.userId, businessId: lead.businessId || undefined },
          });
          if (fwdAccount) {
            // Only forward when the customer texted a bot number (TenantPhoneNumber) owned by this user.
            // This prevents forwarding messages that arrived on BYO/OpenPhone or unrelated numbers.
            const normToNumber = toNumber?.replace(/\D/g, '').slice(-10);
            const botPhone = normToNumber
              ? await this.prisma.tenantPhoneNumber.findFirst({
                  where: { userId: lead.userId, status: 'ACTIVE', phoneNumber: { endsWith: normToNumber } },
                  select: { phoneNumber: true },
                })
              : null;

            if (botPhone) {
              this.logger.log(
                `[handleInboundSms] toNumber ${toNumber} matches bot phone ${botPhone.phoneNumber} — forwarding to agent (lead=${lead.id})`,
              );
              await this.notificationsService.forwardInboundSms(fwdAccount.id, lead.customerName, fromNumber, body);
            } else {
              this.logger.log(
                `[handleInboundSms] Skipping forward — toNumber ${toNumber} is not a bot number for user ${lead.userId} (lead=${lead.id})`,
              );
            }
          }
        } catch (err: any) {
          this.logger.warn(`SMS forwarding failed: ${err.message}`);
        }
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

  // ==========================================
  // Yelp Webhook Handling
  // ==========================================

  /**
   * Handle incoming webhook from Yelp
   * Yelp sends POST for: NEW_EVENT, CONSUMER_PHONE_NUMBER_OPT_IN_EVENT, etc.
   */
  async handleYelpWebhook(signature: string | undefined, payload: any, rawBody: string): Promise<void> {
    const secret = this.configService.get<string>('yelp.webhookSecret') || '';
    const adapter = this.platformFactory.getAdapter('yelp');

    // Determine event type — may be at top level or inside data.updates array
    const updates = payload?.data?.updates || (payload?.data?.event_type ? [payload.data] : []);
    const eventType = payload?.data?.event_type || updates[0]?.event_type || 'unknown';
    const businessId = payload?.data?.id;

    this.logger.log(`Yelp webhook received: eventType=${eventType} business=${businessId}`);

    // Verify signature if both are present
    let isValid = true;
    if (signature && secret) {
      isValid = adapter.verifyWebhookSignature(signature, rawBody, secret);
    }

    const event = await this.prisma.webhookEvent.create({
      data: {
        platform: 'yelp',
        eventType,
        payload: JSON.stringify(payload),
        signature,
        verified: isValid,
        processed: false,
      },
    });

    if (!isValid) {
      this.logger.warn('Invalid Yelp webhook signature');
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, processingError: 'Invalid signature', processedAt: new Date() },
      });
      return;
    }

    try {
      // Handle each update in the payload (Yelp may batch updates)
      if (updates.length > 0) {
        for (const update of updates) {
          await this.processYelpUpdate(update.event_type || eventType, businessId, update, payload);
        }
      } else {
        await this.processYelpUpdate(eventType, businessId, payload?.data, payload);
      }

      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, processedAt: new Date() },
      });
    } catch (error: any) {
      const errMsg = error?.message || String(error) || 'unknown';
      const errStack = error?.stack?.split('\n').slice(0, 3).join(' | ') || 'no stack';
      this.logger.error(`Error processing Yelp webhook: msg=${errMsg} stack=${errStack} name=${error?.name} code=${error?.code}`);
      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processed: true, processingError: error.message, processedAt: new Date() },
      });
    }
  }

  private async processYelpUpdate(eventType: string, businessId: string, data: any, _fullPayload: any): Promise<void> {
    switch (eventType) {
      case 'NEW_EVENT':
        await this.handleYelpNewEvent(businessId, data);
        break;
      case 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT':
        this.logger.log(`Yelp consumer phone opt-in: business=${businessId} lead=${data?.lead_id} data=${JSON.stringify(data).substring(0, 500)}`);
        // Store phone number on the lead
        if (data?.lead_id) {
          const phoneNumber = data?.phone_number || data?.consumer_phone_number || data?.event_content?.phone_number;
          if (phoneNumber) {
            await this.prisma.lead.updateMany({
              where: { externalRequestId: data.lead_id, platform: 'yelp' },
              data: { customerPhone: phoneNumber },
            });
            this.logger.log(`Yelp phone stored for lead ${data.lead_id}: ${phoneNumber}`);
          }
        }
        break;
      case 'CONSUMER_PHONE_NUMBER_OPT_OUT_EVENT':
        this.logger.log(`Yelp consumer phone opt-out: business=${businessId} lead=${data?.lead_id}`);
        break;
      default:
        this.logger.warn(`Unhandled Yelp event type: ${eventType}`);
    }
  }

  private async handleYelpNewEvent(businessId: string, data: any): Promise<void> {
    this.logger.log(`[Yelp NEW_EVENT] businessId=${businessId} data=${JSON.stringify(data).substring(0, 500)}`);
    const leadId = data?.lead_id;
    const eventId = data?.event_id;

    if (!leadId || !businessId) {
      this.logger.warn(`Yelp NEW_EVENT missing lead_id or business_id — data: ${JSON.stringify(data)}`);
      return;
    }

    // Deduplicate by event_id — in-memory (same process)
    if (eventId && this.isDuplicateWebhook('yelp.NEW_EVENT', eventId)) {
      return;
    }
    // Cross-instance dedup: check if a webhookEvent for this eventId was already
    // successfully processed (processed=true, no error) within the last 60 seconds.
    // The 60s window is enough for the first instance to finish and mark processed.
    if (eventId) {
      const alreadyDone = await this.prisma.webhookEvent.findFirst({
        where: {
          platform: 'yelp',
          processed: true,
          processingError: null,
          receivedAt: { gte: new Date(Date.now() - 60_000) },
          payload: { contains: eventId },
        },
        select: { id: true },
      });
      if (alreadyDone) {
        this.logger.log(`Skipping duplicate Yelp NEW_EVENT ${eventId} (cross-instance: already processed)`);
        return;
      }
    }

    // Find saved account for this business
    this.logger.log(`[Yelp] Step 1: Finding saved account for business ${businessId}`);
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: { platform: 'yelp', businessId },
    });

    if (!savedAccount) {
      this.logger.warn(`No saved Yelp account for business ${businessId} — add it via POST /v1/yelp/businesses`);
      return;
    }

    const userId = savedAccount.userId;
    this.logger.log(`[Yelp] Step 2: Found account ${savedAccount.id} for user ${userId}, decrypting credentials`);

    // Use per-business OAuth token if available, fallback to API key
    let accessToken = this.configService.get<string>('yelp.apiKey') || '';
    const encryptionKey = this.configService.get<string>('encryption.key') || '';
    let creds: any = null;
    if (savedAccount.credentialsJson) {
      try {
        creds = EncryptionUtil.decryptObject<any>(savedAccount.credentialsJson, encryptionKey);
        if (creds.accessToken) {
          accessToken = creds.accessToken;
          this.logger.log(`[Yelp] Using OAuth token (${accessToken.substring(0, 10)}...)`);
        }
      } catch (err: any) {
        this.logger.warn(`Failed to decrypt Yelp credentials for business ${businessId}, using API key: ${err.message}`);
      }
    }

    this.logger.log(`[Yelp] Step 3: Fetching lead ${leadId}`);
    const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;
    let leadData: any;
    try {
      try {
        leadData = await yelpAdapter.getLead({ accessToken }, leadId);
        this.logger.log(`[Yelp] Lead fetched: customer=${leadData.customerName}, category=${leadData.category}`);
      } catch (fetchErr: any) {
        // Auto-refresh token on 401 and retry
        const is401 = fetchErr.message?.includes('401') || fetchErr.response?.status === 401;
        if (is401 && creds?.refreshToken) {
          this.logger.log(`[Yelp] Token 401 for ${businessId}, refreshing...`);
          const refreshed = await yelpAdapter.refreshAccessToken(creds.refreshToken);
          accessToken = refreshed.accessToken;
          const updatedCreds = { ...creds, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || creds.refreshToken, expiresAt: refreshed.expiresAt };
          const freshEncrypted = EncryptionUtil.encryptObject(updatedCreds, encryptionKey);
          // Update THIS account + ALL sibling Yelp accounts for the same user
          await this.prisma.savedAccount.updateMany({
            where: { userId, platform: 'yelp' },
            data: { credentialsJson: freshEncrypted },
          });
          this.logger.log(`[Yelp] Token refreshed and synced to all Yelp accounts for user ${userId}`);
          leadData = await yelpAdapter.getLead({ accessToken }, leadId);
          this.logger.log(`[Yelp] Lead fetched after refresh: customer=${leadData.customerName}`);
        } else {
          throw fetchErr;
        }
      }
    } catch (err: any) {
      this.logger.error(`Failed to fetch Yelp lead ${leadId}: ${err.message} status=${err.response?.status}`);
      // Log to SystemErrorLog so health check detects dead token
      const is401 = err.message?.includes('401') || err.response?.status === 401;
      if (is401) {
        await this.prisma.systemErrorLog.create({
          data: {
            category: 'token_refresh',
            message: `yelp token failed for business ${businessId} — ${err.message}`,
            userId,
            accountId: savedAccount.id,
            accountName: savedAccount.businessName,
            context: JSON.stringify({ platform: 'yelp', businessId, leadId }),
          },
        }).catch(() => {});
      }
      // Still upsert a minimal lead so we don't lose it
      leadData = {
        platform: 'yelp',
        externalRequestId: leadId,
        businessId,
        customerName: 'Unknown',
        message: '',
        status: 'new',
        createdAt: new Date(),
        updatedAt: new Date(),
        raw: data,
      };
    }

    // Check if this is an existing lead (customer reply) vs new lead
    const existingLead = await this.prisma.lead.findUnique({
      where: { platform_externalRequestId: { platform: 'yelp', externalRequestId: leadId } },
    });

    // Ensure conversation exists for this Yelp lead (same pattern as Thumbtack).
    // This powers lastMessageAt sorting — without it, Yelp leads stay stuck at createdAt.
    const conversation = await this.prisma.conversation.upsert({
      where: { platform_externalThreadId: { platform: 'yelp', externalThreadId: leadId } },
      create: {
        userId,
        platform: 'yelp',
        externalThreadId: leadId,
        customerName: leadData.customerName || 'Unknown',
        lastMessageAt: new Date(),
        status: 'active',
      },
      update: {
        lastMessageAt: new Date(),
      },
    });

    const lead = await this.prisma.lead.upsert({
      where: { platform_externalRequestId: { platform: 'yelp', externalRequestId: leadId } },
      create: {
        userId,
        platform: 'yelp',
        businessId,
        externalRequestId: leadId,
        threadId: conversation.id,
        customerName: leadData.customerName,
        customerPhone: leadData.customerPhone,
        customerEmail: leadData.customerEmail,
        message: leadData.message,
        city: leadData.city,
        state: leadData.state,
        postcode: leadData.postcode,
        category: leadData.category,
        status: leadData.status || 'new',
        rawJson: JSON.stringify(leadData.raw || data),
      },
      update: {
        customerName: leadData.customerName,
        customerPhone: leadData.customerPhone || undefined,
        customerEmail: leadData.customerEmail || undefined,
        message: leadData.message || undefined,
        status: leadData.status || undefined,
        rawJson: JSON.stringify(leadData.raw || data),
        threadId: conversation.id,
      },
    });

    // Emit SSE for real-time frontend update
    this.eventEmitter.emit(`lead.created.${userId}`, lead);

    // Update thread context (conversation intelligence layer)
    try {
      await this.conversationContextService.recordMessage({
        conversationId: lead.threadId || '',
        leadId: lead.id,
        platform: 'yelp',
        sender: existingLead ? 'customer' : 'customer', // Yelp NEW_EVENT is always customer-initiated
        content: leadData.message || '',
        timestamp: leadData.createdAt || new Date(),
      });
    } catch (err: any) {
      this.logger.warn(`Failed to update Yelp thread context: ${err.message}`);
    }

    // Auto-detect phone number in customer message and save to lead if missing
    if (!lead.customerPhone && leadData.message) {
      const phoneMatch = leadData.message.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
      if (phoneMatch) {
        const digits = phoneMatch[1].replace(/\D/g, '');
        const normalized = digits.length === 11 && digits.startsWith('1') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : null;
        if (normalized) {
          await this.prisma.lead.update({ where: { id: lead.id }, data: { customerPhone: normalized } }).catch(() => {});
          this.logger.log(`[Yelp] Auto-detected phone ${normalized} from message for lead ${leadId}`);
        }
      }
    }

    // Cross-instance dedup: if the lead existed before our upsert OR was created
    // more than 10s ago (another instance just created it), skip new-lead notifications.
    const isNewLead = !existingLead && (Date.now() - new Date(lead.createdAt).getTime()) < 10_000;

    // Stop follow-up sequences on Yelp customer reply (synchronous, idempotent)
    if (existingLead && lead.threadId) {
      try {
        await this.followUpEngine.handleCustomerReply(lead.threadId);
      } catch (err: any) {
        this.logger.warn(`Failed to stop Yelp follow-up on customer reply: ${err.message}`);
      }
    }

    if (!isNewLead && existingLead) {
      // Customer replied — conversation.lastMessageAt already updated above
      this.logger.log(`Yelp customer reply on lead ${leadId}`);
      try {
        await this.automationService.handleCustomerReply({
          userId,
          businessId,
          negotiationId: leadId,
          leadId: lead.id,
          customerName: leadData.customerName,
          customerMessage: leadData.message || undefined,
          accountName: savedAccount.businessName,
          isFirstCustomerReply: false,
          isSecondCustomerMessage: false,
        });
      } catch (err: any) {
        this.logger.error(`Yelp reply automation failed: ${err.message}`);
      }
      return;
    }

    if (!isNewLead) {
      // Lead upserted (existed or race lost) — skip new-lead notifications
      this.logger.log(`Yelp lead ${leadId} — skipping notifications (existed=${!!existingLead}, age=${Date.now() - new Date(lead.createdAt).getTime()}ms)`);
      return;
    }

    // Skip notifications if lead data is garbage (token failure)
    if (leadData.customerName === 'Unknown' && !leadData.message && !leadData.category) {
      this.logger.warn(`Yelp lead ${leadId} has no data (token failure?) — skipping notifications`);
      return;
    }

    // New lead — trigger new_lead automation + SMS notification
    this.logger.log(`Yelp new lead: ${leadId} customer=${leadData.customerName} business=${savedAccount.businessName}`);

    const automationPromise = (async () => {
      try {
        await this.automationService.handleNewLead({
          userId,
          businessId,
          negotiationId: leadId,
          leadId: lead.id,
          customerName: leadData.customerName,
          customerMessage: leadData.message || undefined,
          accountName: savedAccount.businessName,
          category: leadData.category,
          city: leadData.city,
          state: leadData.state,
        });
      } catch (err: any) {
        this.logger.error(`Yelp automation trigger failed: ${err.message}`);
      }
    })();

    const smsPromise = (async () => {
      try {
        await this.notificationsService.sendLeadNotification({
          userId,
          savedAccountId: savedAccount.id,
          leadId: lead.id,
          accountName: savedAccount.businessName,
          platform: 'yelp',
          lead: {
            customerName: leadData.customerName,
            customerPhone: leadData.customerPhone,
            category: leadData.category,
            city: leadData.city,
            state: leadData.state,
            message: leadData.message,
          },
        });
      } catch (err: any) {
        this.logger.error(`Yelp SMS notification failed: ${err.message}`);
      }
    })();

    await Promise.all([automationPromise, smsPromise]);

    // Evaluate thread for follow-up enrollment (after auto-reply fires)
    if (lead.threadId) {
      try {
        await this.followUpEngine.evaluateThread(lead.threadId, 'yelp');
      } catch (err: any) {
        this.logger.warn(`Failed to evaluate Yelp thread for follow-up: ${err.message}`);
      }
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
