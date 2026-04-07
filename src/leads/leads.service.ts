/**
 * Leads Service
 * Manages lead retrieval and synchronization across platforms
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { NormalizedLead } from '../common/dto/normalized.dto';
import { TemplatesService } from '../templates/templates.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);
  constructor(
    private prisma: PrismaService,
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
    private templatesService: TemplatesService,
    private analyticsService: AnalyticsService,
    private conversationContext: ConversationContextService,
  ) {}

  /**
   * Get businesses for a user from a specific platform (Thumbtack)
   */
  async getBusinesses(userId: string, platformName: string): Promise<any[]> {
    const credentials = await this.platformService.getCredentials(userId, platformName);
    const adapter = this.platformFactory.getAdapter(platformName) as any;

    if (typeof adapter.getBusinesses === 'function') {
      return await adapter.getBusinesses(credentials);
    }

    return [];
  }

  /**
   * Get leads for a user from a specific platform
   * For Thumbtack: leads come via webhooks, so we query the local database
   * For other platforms: may fetch from API and store locally
   *
   * Returns ALL leads for the user across all connected accounts.
   * Frontend handles filtering by businessId if needed.
   */
  async getLeads(userId: string, platformName: string, options?: any): Promise<NormalizedLead[]> {
    console.log(`[LeadsService] getLeads called - userId: ${userId}, platform: ${platformName}, options:`, options);

    // For webhook-based platforms (Thumbtack, Yelp), query local database
    if (platformName === 'thumbtack' || platformName === 'yelp') {
      // Return ALL leads for the user (no businessId filter)
      // Frontend filters by businessId if needed for account switching
      const leads = await this.getCachedLeads(userId, {
        platform: platformName,
        // No businessId filter - return all accounts' leads
        limit: options?.limit,
      });
      console.log(`[LeadsService] Found ${leads.length} leads for user ${userId} (all accounts)`);
      return leads;
    }

    // For API-based platforms, fetch from adapter and cache
    const credentials = await this.platformService.getCredentials(userId, platformName);
    const adapter = this.platformFactory.getAdapter(platformName);

    const leads = await adapter.getLeads(credentials, options);

    // Store/update leads in database
    for (const lead of leads) {
      await this.upsertLead(userId, lead);
    }

    return leads;
  }

  /**
   * Get all leads for a user from all connected platforms
   */
  async getAllLeads(userId: string, options?: any): Promise<NormalizedLead[]> {
    const platforms = await this.platformService.getUserPlatforms(userId);
    const connectedPlatforms = platforms.filter((p) => p.connected);

    const allLeads: NormalizedLead[] = [];

    for (const platform of connectedPlatforms) {
      try {
        const leads = await this.getLeads(userId, platform.platformName, options);
        allLeads.push(...leads);
      } catch (error) {
        console.error(`Error fetching leads from ${platform.platformName}:`, error.message);
      }
    }

    // Sort by creation date, newest first
    return allLeads.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  /**
   * Get a single lead by ID
   */
  async getLead(userId: string, leadId: string): Promise<NormalizedLead> {
    const lead = await this.prisma.lead.findFirst({
      where: {
        id: leadId,
        userId,
      },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    return this.convertToNormalizedLead(lead);
  }

  /**
   * Get lead from cached database
   * Returns all leads (no limit) to support date filtering across full history
   */
  async getCachedLeads(
    userId: string,
    filters?: { platform?: string; status?: string; businessId?: string; limit?: number },
  ) {
    const queryOptions: any = {
      where: {
        userId,
        ...(filters?.platform && { platform: filters.platform }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.businessId && { businessId: filters.businessId }),
      },
      include: {
        conversation: {
          select: {
            lastMessageAt: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    };

    // Only apply limit if explicitly specified
    // Note: We don't use a default limit to allow date filtering across all leads
    if (filters?.limit) {
      queryOptions.take = filters.limit;
    }

    const leads = await this.prisma.lead.findMany(queryOptions);

    return leads.map((lead) => this.convertToNormalizedLead(lead));
  }

  /**
   * Get messages for a lead/negotiation
   * All messages come from the database (stored via webhooks)
   * No API fallback needed - webhooks handle all connected accounts
   */
  async getMessages(userId: string, leadId: string): Promise<any[]> {
    console.log(`[LeadsService] getMessages called - userId: ${userId}, leadId: ${leadId}`);

    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] Found lead - externalRequestId: ${lead.externalRequestId}, platform: ${lead.platform}, businessId: ${lead.businessId}`);

    const negotiationId = lead.externalRequestId;

    // For Yelp leads, fetch from Yelp API first, fallback to local DB
    if (lead.platform === 'yelp') {
      const yelpMessages = await this.getYelpMessages(userId, lead);
      if (yelpMessages.length > 0) return yelpMessages;
      // Fallback: if API returned nothing (token error), use locally synced messages
      if (lead.threadId) {
        const localMsgs = await this.getLocalMessages(userId, 'yelp', lead.externalRequestId);
        if (localMsgs.length > 0) {
          console.log(`[LeadsService] Yelp API returned 0 messages, using ${localMsgs.length} from local DB`);
          return localMsgs;
        }
      }
      return [];
    }

    // Get messages from database (stored via webhooks)
    const messages = await this.getLocalMessages(userId, lead.platform, negotiationId);
    console.log(`[LeadsService] Found ${messages.length} messages in database for negotiation ${negotiationId}`);

    return messages;
  }

  private async getYelpMessages(userId: string, lead: any): Promise<any[]> {
    try {
      // Get OAuth credentials for this business
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: { userId, platform: 'yelp', businessId: lead.businessId },
      });

      if (!savedAccount?.credentialsJson) {
        console.log(`[LeadsService] No Yelp credentials for business ${lead.businessId}`);
        return [];
      }

      const encryptionKey = this.configService.get<string>('encryption.key') || '';
      let creds = EncryptionUtil.decryptObject<any>(savedAccount.credentialsJson, encryptionKey);
      const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;
      let events: any[];
      try {
        events = await yelpAdapter.getLeadEvents({ accessToken: creds.accessToken }, lead.externalRequestId);
      } catch (fetchErr: any) {
        const is401 = fetchErr.message?.includes('401') || fetchErr.response?.status === 401;
        if (is401 && creds.refreshToken) {
          console.log(`[LeadsService] Yelp token expired for ${lead.businessId}, refreshing...`);
          const refreshed = await yelpAdapter.refreshAccessToken(creds.refreshToken);
          creds = { ...creds, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || creds.refreshToken, expiresAt: refreshed.expiresAt };
          await this.prisma.savedAccount.update({
            where: { id: savedAccount.id },
            data: { credentialsJson: EncryptionUtil.encryptObject(creds, encryptionKey) },
          });
          console.log(`[LeadsService] Yelp token refreshed for ${lead.businessId}`);
          events = await yelpAdapter.getLeadEvents({ accessToken: creds.accessToken }, lead.externalRequestId);
        } else {
          throw fetchErr;
        }
      }

      // Convert Yelp events to message format expected by frontend.
      // Skip RAQ_SUBMIT (initial lead request) — it duplicates the lead data shown above.
      const textEvents = events.filter((e: any) => e.event_type === 'TEXT');
      const messages = textEvents.map((e: any) => ({
        id: e.id,
        conversationId: lead.externalRequestId,
        platform: 'yelp',
        externalMessageId: e.id,
        sender: e.user_type === 'CONSUMER' ? 'customer' : 'pro',
        content: e.event_content?.text || e.event_content?.fallback_text || e.text || '',
        isRead: true,
        sentAt: e.time_created,
      }));

      // Sync Yelp messages to local Message table (non-blocking)
      // This enables buildContext() to find conversation history for AI previews
      if (messages.length > 0 && lead.threadId) {
        this.syncYelpMessagesToLocal(userId, lead, messages).catch(err =>
          console.error(`[LeadsService] Yelp message sync failed: ${err.message}`),
        );
      }

      return messages;
    } catch (err: any) {
      console.error(`[LeadsService] Failed to fetch Yelp messages: ${err.message}`);
      return [];
    }
  }

  /**
   * Sync Yelp API messages to local Message table + ThreadContext.
   * Idempotent: skips messages that already exist (by externalMessageId).
   */
  private async syncYelpMessagesToLocal(userId: string, lead: any, messages: any[]): Promise<void> {
    const conversationId = lead.threadId;
    if (!conversationId) return;

    for (const msg of messages) {
      const exists = await this.prisma.message.findFirst({
        where: { platform: 'yelp', externalMessageId: msg.externalMessageId },
      });
      if (exists) continue;

      await this.prisma.message.create({
        data: {
          conversationId,
          userId,
          platform: 'yelp',
          externalMessageId: msg.externalMessageId,
          sender: msg.sender,
          content: msg.content,
          isRead: true,
          sentAt: new Date(msg.sentAt),
          rawJson: JSON.stringify(msg),
        },
      });

      // Update thread context
      await this.conversationContext.recordMessage({
        conversationId,
        leadId: lead.id,
        platform: 'yelp',
        sender: msg.sender === 'customer' ? 'customer' : 'pro',
        content: msg.content,
        timestamp: new Date(msg.sentAt),
      }).catch(() => {});
    }
  }

  /**
   * Get messages from local database (stored via webhooks)
   */
  private async getLocalMessages(userId: string, platform: string, negotiationId: string): Promise<any[]> {
    // Find conversation by negotiationId (stored as externalThreadId)
    const conversation = await this.prisma.conversation.findUnique({
      where: {
        platform_externalThreadId: {
          platform,
          externalThreadId: negotiationId,
        },
      },
    });

    if (!conversation) {
      return [];
    }

    const messages = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
      },
      orderBy: { sentAt: 'asc' },
    });

    // Convert to the format expected by frontend
    return messages.map(msg => {
      // Parse rawJson to get attachments and other data
      let raw: Record<string, any> = {};
      try {
        raw = msg.rawJson ? JSON.parse(msg.rawJson) : {};
      } catch (_e) {
        // Ignore parse errors
      }

      return {
        id: msg.id,
        conversationId: msg.conversationId,
        platform: msg.platform,
        externalMessageId: msg.externalMessageId,
        sender: msg.sender,
        content: msg.content,
        isRead: msg.isRead,
        sentAt: msg.sentAt.toISOString(),
        deliveredAt: msg.deliveredAt?.toISOString(),
        notificationLogId: (msg as any).notificationLogId || null,
        attachments: raw.attachments || [],
        raw,
      };
    });
  }

  /**
   * Send a message to a lead
   * Also stores the sent message locally to ensure it appears even if webhook is delayed
   * Uses account-specific credentials when available for multi-account support
   */
  async sendMessage(
    userId: string,
    leadId: string,
    message: string,
  ): Promise<any> {
    const lead = await this.getLead(userId, leadId);

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (lead.businessId) {
      const accountCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (accountCreds) {
        console.log(`[LeadsService] Using account-specific credentials for sending message (business: ${lead.businessId})`);
        credentials = accountCreds;
      } else {
        credentials = await this.platformService.getCredentials(userId, lead.platform);
      }
    } else {
      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }
    const adapter = this.platformFactory.getAdapter(lead.platform);

    // Send message via platform adapter
    let sentMessage;
    try {
      sentMessage = await adapter.sendMessage(credentials, lead.externalRequestId, message);
    } catch (err: any) {
      // Surface platform errors as 403 (auth/access) or 502 (upstream failure)
      const is403 = err.message?.includes('403') || err.message?.includes('NO_BUSINESS_ACCESS') || err.message?.includes('no_business_access');
      const is401 = err.message?.includes('401') || err.message?.includes('expired');
      if (is403 || is401) {
        throw new BadRequestException(`${lead.platform} access denied — reconnect your account to re-authorize (${err.message})`);
      }
      throw new BadRequestException(`Failed to send message: ${err.message}`);
    }

    // Store the sent message locally
    // This ensures it appears immediately even if webhook is delayed
    try {
      // Find or create conversation
      let conversation = await this.prisma.conversation.findUnique({
        where: {
          platform_externalThreadId: {
            platform: lead.platform,
            externalThreadId: lead.externalRequestId,
          },
        },
      });

      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            userId,
            platform: lead.platform,
            externalThreadId: lead.externalRequestId,
            customerName: lead.customerName,
            lastMessageAt: new Date(),
            status: 'active',
          },
        });
      }

      // Link lead to conversation if not already linked (needed for Yelp leads
      // created before conversation support, and for lastMessageAt sorting)
      if (!lead.threadId) {
        await this.prisma.lead.update({
          where: { id: leadId },
          data: { threadId: conversation.id },
        }).catch(() => {}); // non-critical
      }

      // Check if message already exists (webhook might have already stored it)
      const existingMessage = await this.prisma.message.findFirst({
        where: {
          platform: lead.platform,
          externalMessageId: sentMessage.externalMessageId,
        },
      });

      if (!existingMessage) {
        await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            userId,
            platform: lead.platform,
            externalMessageId: sentMessage.externalMessageId,
            sender: 'pro',
            content: message,
            isRead: true,
            sentAt: new Date(sentMessage.sentAt),
            rawJson: JSON.stringify(sentMessage),
          },
        });
        console.log(`[LeadsService] Stored sent message locally: ${sentMessage.externalMessageId}`);

        // Update thread context so AI previews have conversation history
        this.conversationContext.recordMessage({
          conversationId: conversation.id,
          leadId: leadId,
          platform: lead.platform,
          sender: 'pro',
          senderType: 'user',
          content: message,
        }).catch(err => console.error(`[LeadsService] recordMessage failed: ${err.message}`));
      }

      // Update conversation's lastMessageAt
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { lastMessageAt: new Date() },
      });

      // Track trial usage: Increment counter if this is first reply to this lead
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          trialStartDate: true,
          trialEndDate: true,
          subscriptionTier: true,
          trialLeadsHandled: true,
        },
      });

      // Only count if user is on trial (has trial dates, no subscription)
      if (user && user.trialStartDate && user.trialEndDate && !user.subscriptionTier) {
        // Check if this is the first message from pro to this lead
        const previousProMessages = await this.prisma.message.count({
          where: {
            conversationId: conversation.id,
            sender: 'pro',
            userId: userId,
          },
        });

        // If this is the first reply to this lead, increment trial counter
        if (previousProMessages === 1) {  // === 1 because we just created one above
          await this.prisma.user.update({
            where: { id: userId },
            data: { trialLeadsHandled: { increment: 1 } },
          });
          console.log(`[LeadsService] Trial lead tracked: ${user.trialLeadsHandled + 1} leads handled`);
        }
      }
    } catch (err) {
      // Log but don't fail - message was sent successfully
      console.error('[LeadsService] Failed to store sent message locally:', err.message);
    }

    return sentMessage;
  }

  /**
   * Send a quote to a lead
   * Uses account-specific credentials when available for multi-account support
   */
  async sendQuote(
    userId: string,
    leadId: string,
    amount: number,
    description?: string,
  ): Promise<any> {
    const lead = await this.getLead(userId, leadId);

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (lead.businessId) {
      const accountCreds = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (accountCreds) {
        console.log(`[LeadsService] Using account-specific credentials for sending quote (business: ${lead.businessId})`);
        credentials = accountCreds;
      } else {
        credentials = await this.platformService.getCredentials(userId, lead.platform);
      }
    } else {
      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }
    const adapter = this.platformFactory.getAdapter(lead.platform);

    const quote = await adapter.sendQuote(credentials, lead.externalRequestId, {
      amount,
      description,
    });

    // Update lead status to quoted
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { status: 'quoted' },
    });

    return quote;
  }

  /**
   * Update lead status
   */
  async updateLeadStatus(userId: string, leadId: string, status: string): Promise<NormalizedLead> {
    const lead = await this.prisma.lead.updateMany({
      where: {
        id: leadId,
        userId,
      },
      data: { status },
    });

    if (lead.count === 0) {
      throw new NotFoundException('Lead not found');
    }

    return this.getLead(userId, leadId);
  }

  /**
   * Sync lead status from Thumbtack API
   * Fetches fresh data from Thumbtack and updates local database
   * Uses account-specific credentials when available for multi-account support
   */
  async syncLeadStatus(userId: string, leadId: string): Promise<NormalizedLead> {
    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] syncLeadStatus - leadId: ${leadId}, negotiationId: ${lead.externalRequestId}`);

    // Get account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string } | null = null;
    if (lead.businessId) {
      credentials = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
      if (credentials) {
        console.log(`[LeadsService] Using account-specific credentials for sync (business: ${lead.businessId})`);
      }
    }

    // Fall back to platform credentials
    if (!credentials) {
      // Check if current connection matches the lead's business
      const platform = await this.prisma.platform.findFirst({
        where: {
          userId,
          platformName: lead.platform,
          connected: true,
        },
      });

      const isConnectedToRightAccount = platform?.externalBusinessId === lead.businessId;

      if (!isConnectedToRightAccount) {
        console.log(`[LeadsService] No credentials available for lead's account, cannot sync status`);
        return lead; // Return existing lead without sync
      }

      credentials = await this.platformService.getCredentials(userId, lead.platform);
    }

    try {
      const adapter = this.platformFactory.getAdapter(lead.platform) as any;

      if (typeof adapter.getLead !== 'function') {
        console.log(`[LeadsService] Adapter does not support getLead`);
        return lead;
      }

      // Fetch fresh negotiation data from Thumbtack
      const freshLead = await adapter.getLead(credentials, lead.externalRequestId);
      console.log(`[LeadsService] Fresh lead status from Thumbtack: ${freshLead.status}`);

      // Update local database with fresh status
      if (freshLead.status !== lead.status) {
        await this.prisma.lead.update({
          where: { id: leadId },
          data: {
            status: freshLead.status,
            updatedAt: new Date(),
          },
        });
        console.log(`[LeadsService] Updated lead status: ${lead.status} -> ${freshLead.status}`);
      }

      return this.getLead(userId, leadId);
    } catch (error) {
      console.error(`[LeadsService] Error syncing lead status:`, error.message);
      return lead; // Return existing lead on error
    }
  }

  /**
   * Store/update lead in database
   * Note: threadId is NOT set here because it references Conversation.id (foreign key)
   * The negotiationID is stored in externalRequestId instead
   * Uses the original createdAt from the platform (Thumbtack) if available
   */
  private async upsertLead(userId: string, lead: NormalizedLead): Promise<void> {
    await this.prisma.lead.upsert({
      where: {
        platform_externalRequestId: {
          platform: lead.platform,
          externalRequestId: lead.externalRequestId,
        },
      },
      create: {
        userId,
        platform: lead.platform,
        businessId: lead.businessId,
        externalRequestId: lead.externalRequestId,
        customerName: lead.customerName,
        customerPhone: lead.customerPhone,
        customerEmail: lead.customerEmail,
        message: lead.message,
        budget: lead.budget,
        postcode: lead.postcode,
        city: lead.city,
        state: lead.state,
        category: lead.category,
        status: lead.status,
        // threadId intentionally NOT set - it's a FK to Conversation table
        rawJson: JSON.stringify(lead.raw),
        // Use original createdAt from platform if available
        createdAt: lead.createdAt || new Date(),
      },
      update: {
        userId, // Update userId in case lead was imported by different user before
        businessId: lead.businessId,
        customerName: lead.customerName,
        customerPhone: lead.customerPhone,
        customerEmail: lead.customerEmail,
        message: lead.message,
        budget: lead.budget,
        postcode: lead.postcode,
        city: lead.city,
        state: lead.state,
        category: lead.category,
        status: lead.status,
        // threadId intentionally NOT updated - it's a FK to Conversation table
        rawJson: JSON.stringify(lead.raw),
        // Update createdAt to use original platform date (in case it was imported with wrong date before)
        createdAt: lead.createdAt || undefined,
      },
    });
  }

  /**
   * Import a single Thumbtack negotiation by ID
   * Returns { lead, isNew } to indicate if this was a new import or update
   * Also imports and stores all messages for the negotiation
   * @param accountId - Optional saved account ID to associate the lead with the correct business
   */
  async importThumbtackNegotiation(userId: string, negotiationId: string, accountId?: string): Promise<{ lead: NormalizedLead; isNew: boolean }> {
    console.log(`[LeadsService] importThumbtackNegotiation - userId: ${userId}, negotiationId: ${negotiationId}, accountId: ${accountId}`);

    // If accountId provided, verify it belongs to this user and get the businessId and credentials
    let targetBusinessId: string | undefined;
    let accountCredentials: { accessToken: string; refreshToken?: string } | null = null;
    if (accountId) {
      const savedAccount = await this.prisma.savedAccount.findFirst({
        where: {
          id: accountId,
          userId,
          platform: 'thumbtack',
        },
      });
      if (savedAccount) {
        targetBusinessId = savedAccount.businessId;
        console.log(`[LeadsService] Using saved account: ${savedAccount.businessName} (businessId: ${targetBusinessId})`);

        // Get account-specific credentials with automatic token refresh
        try {
          accountCredentials = await this.platformService.getAccountCredentialsByBusinessId(userId, 'thumbtack', savedAccount.businessId);
          if (accountCredentials) {
            console.log(`[LeadsService] Using account-specific credentials for import (auto-refreshed if needed)`);
          }
        } catch (err) {
          console.warn(`[LeadsService] Failed to get account credentials:`, err.message);
        }
      } else {
        console.warn(`[LeadsService] Account ${accountId} not found for user ${userId}`);
      }
    }

    // Check if lead already exists in DB (regardless of userId - could be from webhook or different user)
    const existingLead = await this.prisma.lead.findFirst({
      where: {
        platform: 'thumbtack',
        externalRequestId: negotiationId,
      },
    });

    const isNew = !existingLead;
    console.log(`[LeadsService] Lead ${isNew ? 'is new' : 'already exists in DB'}${existingLead ? ` (owner: ${existingLead.userId})` : ''}`);

    // Use account-specific credentials if available, otherwise fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    if (accountCredentials) {
      credentials = accountCredentials;
    } else {
      credentials = await this.platformService.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    // Fetch negotiation from Thumbtack API
    let lead;
    try {
      lead = await adapter.getLead(credentials, negotiationId);
      console.log(`[LeadsService] Fetched lead from Thumbtack:`, JSON.stringify(lead));
    } catch (err: any) {
      const errMsg = err.message?.toLowerCase() || '';
      // Check if it's a token/auth error - re-throw with the message from adapter
      if (errMsg.includes('login required') || errMsg.includes('session') ||
          errMsg.includes('token') || errMsg.includes('unauthorized') || errMsg.includes('invalid') ||
          errMsg.includes('expired') || errMsg.includes('not active') || err.response?.status === 401) {
        throw err; // Re-throw the error from adapter which has a clear message
      }

      // When Thumbtack service is deleted, try to recover lead data from local sources
      if (err.message?.startsWith('THUMBTACK_SERVICE_DELETED')) {
        console.log(`[LeadsService] Service deleted for ${negotiationId} — attempting recovery from local sources`);

        // Source 1: ThumbtackLeadId — extension-scraped data includes customerName
        const capturedData = await this.prisma.thumbtackLeadId.findFirst({
          where: { userId, thumbtackId: negotiationId },
        });

        // Source 2: WebhookEvent — full payload if Thumbtack delivered this lead via webhook
        const webhookEvent = await this.prisma.webhookEvent.findFirst({
          where: { platform: 'thumbtack', eventType: 'NegotiationCreatedV4', payload: { contains: negotiationId } },
          orderBy: { receivedAt: 'desc' },
        });

        if (capturedData?.customerName || webhookEvent) {
          let customerName = capturedData?.customerName || 'Unknown';
          let createdAt = capturedData?.capturedAt || new Date();
          let message = '';
          let raw: any = null;
          let recoveredBusinessId = targetBusinessId;

          if (webhookEvent) {
            try {
              const wPayload = JSON.parse(webhookEvent.payload);
              const wData = wPayload.data || {};
              const cust = wData.customer || {};
              const req = wData.request || {};
              customerName = `${cust.firstName || ''} ${cust.lastName || ''}`.trim() || customerName;
              message = req.description || '';
              recoveredBusinessId = wData.business?.businessID || recoveredBusinessId;
              createdAt = wData.createdAt ? new Date(wData.createdAt) : createdAt;
              raw = wData;
            } catch { /* ignore parse errors */ }
          }

          lead = {
            id: '',
            platform: 'thumbtack',
            businessId: recoveredBusinessId,
            externalRequestId: negotiationId,
            customerName,
            message,
            status: capturedData?.thumbtackStatus || 'Unknown',
            createdAt,
            updatedAt: new Date(),
            raw,
          } as NormalizedLead;

          console.log(`[LeadsService] Recovered lead from local data: ${customerName} (${negotiationId})`);
          // Mark as needing page scrape — full details unavailable from API
          await this.prisma.thumbtackLeadId.updateMany({
            where: { userId, thumbtackId: negotiationId },
            data: { needsRefetch: true },
          });
          // Fall through — upsertLead below will store this recovered lead
        } else {
          throw err; // No local data to recover from — let controller skip gracefully
        }
      } else {
        // Re-throw other errors as-is
        throw err;
      }
    }

    // If we have a target businessId, verify the lead belongs to that business
    if (targetBusinessId && lead.businessId && lead.businessId !== targetBusinessId) {
      console.warn(`[LeadsService] Lead businessId (${lead.businessId}) doesn't match selected account (${targetBusinessId})`);
      // Still proceed - the API response tells us the actual businessId
    }

    // Store in database (upsert will update userId if different)
    await this.upsertLead(userId, lead);
    console.log(`[LeadsService] Lead upserted to database`);

    // Return the stored lead with DB ID
    const storedLead = await this.prisma.lead.findFirst({
      where: {
        platform: 'thumbtack',
        externalRequestId: negotiationId,
      },
    });

    if (!storedLead) {
      throw new NotFoundException('Lead not found after import');
    }

    // Copy thumbtackStatus from the extension-collected ThumbtackLeadId record
    const collectedLead = await this.prisma.thumbtackLeadId.findFirst({
      where: { userId, thumbtackId: negotiationId },
    });
    if (collectedLead?.thumbtackStatus && collectedLead.thumbtackStatus !== storedLead.thumbtackStatus) {
      await this.prisma.lead.update({
        where: { id: storedLead.id },
        data: { thumbtackStatus: collectedLead.thumbtackStatus },
      });
      console.log(`[LeadsService] Copied thumbtackStatus "${collectedLead.thumbtackStatus}" to lead`);
    }

    // Also import messages for this negotiation using account-specific credentials if available
    await this.importMessagesForNegotiation(userId, 'thumbtack', negotiationId, storedLead.customerName, accountCredentials || undefined);

    // Invalidate analytics cache so insights reflects the new lead immediately
    if (isNew) {
      await this.analyticsService.invalidateCache(userId);
    }

    return { lead: this.convertToNormalizedLead(storedLead), isNew };
  }

  /**
   * Import and store messages for a negotiation from the API
   * @param accountCredentials - Optional account-specific credentials (for multi-login support)
   */
  private async importMessagesForNegotiation(
    userId: string,
    platform: string,
    negotiationId: string,
    customerName: string,
    accountCredentials?: { accessToken: string; refreshToken?: string },
  ): Promise<number> {
    console.log(`[LeadsService] Importing messages for negotiation: ${negotiationId}`);

    try {
      // Use account-specific credentials if provided, otherwise fall back to platform credentials
      let credentials: { accessToken: string; refreshToken?: string };
      if (accountCredentials) {
        console.log(`[LeadsService] Using account-specific credentials`);
        credentials = accountCredentials;
      } else {
        console.log(`[LeadsService] Getting credentials for user: ${userId}, platform: ${platform}`);
        credentials = await this.platformService.getCredentials(userId, platform);
      }
      console.log(`[LeadsService] Got credentials, accessToken present: ${!!credentials.accessToken}`);

      const adapter = this.platformFactory.getAdapter(platform) as any;

      if (typeof adapter.getConversation !== 'function') {
        console.log(`[LeadsService] Adapter does not support getConversation`);
        return 0;
      }

      console.log(`[LeadsService] Calling adapter.getConversation for negotiation: ${negotiationId}`);
      const messages = await adapter.getConversation(credentials, negotiationId);
      console.log(`[LeadsService] Fetched ${messages.length} messages from API`);

      if (messages.length === 0) {
        console.log(`[LeadsService] No messages found for negotiation ${negotiationId}`);
        return 0;
      }

      // Ensure conversation exists
      let conversation = await this.prisma.conversation.findUnique({
        where: {
          platform_externalThreadId: {
            platform,
            externalThreadId: negotiationId,
          },
        },
      });

      if (!conversation) {
        conversation = await this.prisma.conversation.create({
          data: {
            userId,
            platform,
            externalThreadId: negotiationId,
            customerName: customerName || 'Unknown',
            lastMessageAt: new Date(),
            status: 'active',
          },
        });
        console.log(`[LeadsService] Created conversation: ${conversation.id}`);

        // Link lead to conversation
        await this.prisma.lead.updateMany({
          where: {
            platform,
            externalRequestId: negotiationId,
          },
          data: { threadId: conversation.id },
        });
      }

      // Store each message using upsert to handle race conditions
      let importedCount = 0;
      for (const msg of messages) {
        try {
          await this.prisma.message.upsert({
            where: {
              platform_externalMessageId: {
                platform,
                externalMessageId: msg.externalMessageId,
              },
            },
            create: {
              conversationId: conversation.id,
              userId,
              platform,
              externalMessageId: msg.externalMessageId,
              sender: msg.sender?.toLowerCase() || 'customer',
              content: msg.content || '',
              isRead: true, // Imported messages are considered read
              sentAt: new Date(msg.sentAt),
              rawJson: JSON.stringify(msg.raw || msg), // Include full raw data with attachments
            },
            update: {
              // Update rawJson to include latest data (attachments, etc)
              rawJson: JSON.stringify(msg.raw || msg),
            },
          });
          importedCount++;
        } catch (error) {
          console.error(`[LeadsService] Error upserting message ${msg.externalMessageId}:`, error.message);
        }
      }

      // Update conversation's lastMessageAt
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date(lastMsg.sentAt) },
        });
      }

      console.log(`[LeadsService] Imported ${importedCount} messages for negotiation ${negotiationId}`);
      return importedCount;
    } catch (error) {
      console.error(`[LeadsService] Error importing messages:`, error.message);
      console.error(`[LeadsService] Full error:`, error);

      // Check if this is a 403 error (wrong account credentials)
      if (error.message?.includes('403') || error.message?.includes('Forbidden')) {
        throw new BadRequestException(
          'Cannot resync - this lead belongs to a different account. New messages still arrive via webhooks automatically.'
        );
      }

      // For other errors, don't throw - lead import succeeded, messages are optional
      return 0;
    }
  }

  /**
   * Patch a lead's details with data scraped from the Thumbtack page.
   * Used when the API was unavailable (service deleted) and the extension
   * scraped the individual lead page to fill in missing fields.
   */
  async patchLeadDetails(
    userId: string,
    thumbtackId: string,
    details: {
      budget?: number;
      city?: string;
      state?: string;
      postcode?: string;
      message?: string;
    },
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { platform: 'thumbtack', externalRequestId: thumbtackId, userId },
    });

    if (!lead) throw new NotFoundException(`Lead not found for thumbtackId ${thumbtackId}`);

    const updateData: any = {};
    if (details.budget != null) updateData.budget = details.budget;
    if (details.city) updateData.city = details.city;
    if (details.state) updateData.state = details.state;
    if (details.postcode) updateData.postcode = details.postcode;
    if (details.message) updateData.message = details.message;

    if (Object.keys(updateData).length > 0) {
      await this.prisma.lead.update({ where: { id: lead.id }, data: updateData });
    }

    // Mark as no longer needing scrape
    await this.prisma.thumbtackLeadId.updateMany({
      where: { userId, thumbtackId },
      data: { needsRefetch: false },
    });

    return { ok: true, leadId: lead.id };
  }

  /**
   * Import multiple Thumbtack negotiations
   */
  async importThumbtackNegotiations(
    userId: string,
    negotiationIds: string[],
    accountId?: string,
  ): Promise<{ imported: number; failed: number; errors: string[] }> {
    const results = { imported: 0, failed: 0, errors: [] as string[] };

    for (const negotiationId of negotiationIds) {
      try {
        await this.importThumbtackNegotiation(userId, negotiationId, accountId);
        results.imported++;
      } catch (error) {
        results.failed++;
        results.errors.push(`${negotiationId}: ${error.message}`);
      }
    }

    return results;
  }

  /**
   * Convert database lead to normalized format
   */
  private convertToNormalizedLead(lead: any): NormalizedLead {
    // Get lastMessageAt from conversation if available, otherwise use lead's createdAt
    const lastMessageAt = lead.conversation?.lastMessageAt || lead.createdAt;

    return {
      id: lead.id,
      platform: lead.platform,
      businessId: lead.businessId, // Include businessId for multi-account filtering
      externalRequestId: lead.externalRequestId,
      customerName: lead.customerName,
      customerPhone: lead.customerPhone,
      customerEmail: lead.customerEmail,
      message: lead.message,
      budget: lead.budget ? parseFloat(lead.budget.toString()) : undefined,
      postcode: lead.postcode,
      city: lead.city,
      state: lead.state,
      category: lead.category,
      status: lead.status as any,
      threadId: lead.threadId,
      createdAt: lead.createdAt,
      updatedAt: lead.updatedAt,
      lastMessageAt: lastMessageAt, // Include lastMessageAt for sorting and display
      raw: lead.rawJson ? JSON.parse(lead.rawJson) : undefined,
    };
  }

  /**
   * Clean up duplicate messages in a conversation
   * Keeps only the first message for each unique content+timestamp combo
   */
  async cleanupDuplicateMessages(conversationId: string): Promise<{ deleted: number }> {
    console.log(`[LeadsService] Cleaning up duplicate messages for conversation: ${conversationId}`);

    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
    });

    const seen = new Map<string, string>(); // content+timestamp -> message id
    const toDelete: string[] = [];

    for (const msg of messages) {
      // Create a key from content and approximate timestamp (within 1 second)
      const timestamp = Math.floor(new Date(msg.sentAt).getTime() / 1000);
      const key = `${msg.content}:${timestamp}`;

      if (seen.has(key)) {
        // This is a duplicate, mark for deletion
        toDelete.push(msg.id);
      } else {
        seen.set(key, msg.id);
      }
    }

    if (toDelete.length > 0) {
      await this.prisma.message.deleteMany({
        where: { id: { in: toDelete } },
      });
      console.log(`[LeadsService] Deleted ${toDelete.length} duplicate messages`);
    }

    return { deleted: toDelete.length };
  }

  /**
   * Re-sync messages for a lead
   * If connected to the correct account, imports messages from Thumbtack API.
   * Also cleans up old synthetic messages.
   */

  /**
   * Re-fetch lead data from platform API (fixes "Unknown" leads from token failures)
   */
  async refetchLeadFromPlatform(userId: string, leadId: string): Promise<{ updated: boolean; customerName?: string }> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, userId } });
    if (!lead) throw new Error('Lead not found');

    const credentials = lead.businessId
      ? await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId)
      : await this.platformService.getCredentials(userId, lead.platform);

    if (!credentials) return { updated: false, customerName: lead.customerName };

    const adapter = this.platformFactory.getAdapter(lead.platform) as any;
    if (typeof adapter.getLead !== 'function') return { updated: false };

    this.logger.log(`Refetching lead ${leadId} (${lead.platform}/${lead.externalRequestId}) from API...`);
    const freshLead = await adapter.getLead(credentials, lead.externalRequestId);
    this.logger.log(`Refetch result: name=${freshLead.customerName}, category=${freshLead.category}, msg=${(freshLead.message || '').substring(0, 50)}`);

    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        customerName: freshLead.customerName || lead.customerName,
        customerPhone: freshLead.customerPhone || lead.customerPhone || undefined,
        customerEmail: freshLead.customerEmail || lead.customerEmail || undefined,
        message: freshLead.message || lead.message || undefined,
        category: freshLead.category || lead.category || undefined,
        city: freshLead.city || lead.city || undefined,
        state: freshLead.state || lead.state || undefined,
        postcode: freshLead.postcode || lead.postcode || undefined,
        status: freshLead.status || lead.status || undefined,
        rawJson: JSON.stringify(freshLead.raw || {}),
      },
    });

    this.logger.log(`Refetched lead ${leadId}: ${lead.customerName} → ${freshLead.customerName}`);
    return { updated: true, customerName: freshLead.customerName };
  }

  async resyncMessages(userId: string, leadId: string): Promise<{ cleaned: number; imported: number; statusUpdated: boolean }> {
    console.log(`[LeadsService] resyncMessages called - leadId: ${leadId}, userId: ${userId}`);

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId },
    });

    if (!lead) {
      console.log(`[LeadsService] Lead not found: ${leadId}`);
      throw new NotFoundException('Lead not found');
    }

    // Re-fetch lead data if it's broken (Unknown name or missing data)
    if (lead.customerName === 'Unknown' || !lead.message || !lead.category) {
      try {
        const result = await this.refetchLeadFromPlatform(userId, leadId);
        this.logger.log(`Lead refetched during resync: updated=${result.updated}, name=${result.customerName}`);
      } catch (err: any) {
        this.logger.error(`Lead refetch FAILED during resync: ${err.message}`, err.stack);
      }
    }

    console.log(`[LeadsService] Found lead: ${lead.externalRequestId}, platform: ${lead.platform}, businessId: ${lead.businessId}`);

    // Get or create conversation
    let conversation = await this.prisma.conversation.findFirst({
      where: {
        platform: lead.platform,
        externalThreadId: lead.externalRequestId,
      },
    });

    if (!conversation) {
      // Create conversation if it doesn't exist
      conversation = await this.prisma.conversation.create({
        data: {
          userId,
          platform: lead.platform,
          externalThreadId: lead.externalRequestId,
          customerName: lead.customerName,
          lastMessageAt: new Date(),
          status: 'active',
        },
      });
      console.log(`[LeadsService] Created conversation: ${conversation.id}`);
    }

    // Clean up old synthetic messages (those with _initial suffix)
    const cleanedCount = await this.cleanupSyntheticMessages(conversation.id, lead.externalRequestId);

    // Try to get account-specific credentials first (with automatic token refresh)
    // Using PlatformService methods ensures expired tokens are refreshed automatically
    let accountCredentials: { accessToken: string; refreshToken?: string } | null = null;

    if (lead.businessId) {
      try {
        // This method handles token refresh automatically
        accountCredentials = await this.platformService.getAccountCredentialsByBusinessId(userId, lead.platform, lead.businessId);
        if (accountCredentials) {
          console.log(`[LeadsService] Using account-specific credentials for business ${lead.businessId}`);
        }
      } catch (err: any) {
        console.warn(`[LeadsService] Failed to get account credentials:`, err.message);
      }
    }

    // If no account credentials, try platform credentials as fallback (also with token refresh)
    if (!accountCredentials) {
      try {
        // getCredentials handles token refresh automatically
        accountCredentials = await this.platformService.getCredentials(userId, lead.platform);
        console.log(`[LeadsService] Using platform credentials as fallback`);
      } catch (err: any) {
        console.warn(`[LeadsService] Failed to get platform credentials:`, err.message);
      }
    }

    const hasCredentials = !!accountCredentials;
    console.log(`[LeadsService] Has credentials: ${hasCredentials} for business ${lead.businessId || 'unknown'}`);

    let importedCount = 0;
    let statusUpdated = false;

    // If we have credentials, import messages and sync lead status from API
    if (hasCredentials && accountCredentials) {
      try {
        importedCount = await this.importMessagesForNegotiation(
          userId,
          lead.platform,
          lead.externalRequestId,
          lead.customerName,
          accountCredentials,
        );
        console.log(`[LeadsService] Imported ${importedCount} messages from API`);
      } catch (error) {
        console.error(`[LeadsService] Error importing messages:`, error.message);
        // Don't throw - return what we have
      }

      // Also sync lead status from API
      try {
        const adapter = this.platformFactory.getAdapter(lead.platform) as any;
        if (typeof adapter.getLead === 'function') {
          const freshLead = await adapter.getLead(accountCredentials, lead.externalRequestId);
          console.log(`[LeadsService] Fresh lead status from Thumbtack: ${freshLead.status}`);

          if (freshLead.status && freshLead.status !== lead.status) {
            await this.prisma.lead.update({
              where: { id: leadId },
              data: {
                status: freshLead.status,
                updatedAt: new Date(),
              },
            });
            console.log(`[LeadsService] Updated lead status: ${lead.status} -> ${freshLead.status}`);
            statusUpdated = true;
          }
        }
      } catch (error) {
        console.error(`[LeadsService] Error syncing lead status:`, error.message);
        // Don't throw - messages imported successfully
      }
    } else {
      // No credentials available - just return current message count
      const messageCount = await this.prisma.message.count({
        where: { conversationId: conversation.id },
      });
      console.log(`[LeadsService] No credentials available. Current messages in DB: ${messageCount}`);
      importedCount = messageCount;
    }

    return { cleaned: cleanedCount, imported: importedCount, statusUpdated };
  }

  /**
   * Clean up old synthetic messages that were created before MessageCreatedV4 webhook
   * These have externalMessageId ending with '_initial' and duplicate the real first message
   */
  private async cleanupSyntheticMessages(conversationId: string, negotiationId: string): Promise<number> {
    // Find and delete synthetic messages (those with _initial suffix in externalMessageId)
    const syntheticMessageId = `${negotiationId}_initial`;

    const deleted = await this.prisma.message.deleteMany({
      where: {
        conversationId,
        externalMessageId: syntheticMessageId,
      },
    });

    if (deleted.count > 0) {
      console.log(`[LeadsService] Deleted ${deleted.count} synthetic message(s) for negotiation ${negotiationId}`);
    }

    return deleted.count;
  }

  /**
   * Clean up all synthetic messages across all conversations
   * One-time migration helper
   */
  async cleanupAllSyntheticMessages(): Promise<{ deleted: number }> {
    console.log(`[LeadsService] Cleaning up all synthetic messages...`);

    // Delete all messages where externalMessageId ends with '_initial'
    const deleted = await this.prisma.message.deleteMany({
      where: {
        externalMessageId: {
          endsWith: '_initial',
        },
      },
    });

    console.log(`[LeadsService] Deleted ${deleted.count} synthetic messages`);
    return { deleted: deleted.count };
  }

  /**
   * Migrate lead dates - reads createdAt from rawJson and updates the lead
   * One-time migration to fix leads that were imported with wrong dates
   */
  async migrateLeadDates(userId: string): Promise<{ updated: number; skipped: number; errors: string[] }> {
    console.log(`[LeadsService] Migrating lead dates for user: ${userId}`);

    const leads = await this.prisma.lead.findMany({
      where: { userId },
      select: { id: true, rawJson: true, createdAt: true, customerName: true },
    });

    let updated = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const lead of leads) {
      try {
        if (!lead.rawJson) {
          skipped++;
          continue;
        }

        const rawData = JSON.parse(lead.rawJson);
        const originalCreatedAt = rawData.createdAt;

        if (!originalCreatedAt) {
          skipped++;
          continue;
        }

        const newDate = new Date(originalCreatedAt);

        // Only update if the date is different (more than 1 day difference)
        const diffMs = Math.abs(lead.createdAt.getTime() - newDate.getTime());
        const diffDays = diffMs / (1000 * 60 * 60 * 24);

        if (diffDays > 1) {
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { createdAt: newDate },
          });
          console.log(`[LeadsService] Updated ${lead.customerName}: ${lead.createdAt.toISOString()} -> ${newDate.toISOString()}`);
          updated++;
        } else {
          skipped++;
        }
      } catch (err: any) {
        errors.push(`${lead.id}: ${err.message}`);
      }
    }

    console.log(`[LeadsService] Migration complete - updated: ${updated}, skipped: ${skipped}, errors: ${errors.length}`);
    return { updated, skipped, errors };
  }

  /**
   * Preview bulk message for multiple leads
   * Returns personalized messages for each lead
   */
  async previewBulkMessage(
    userId: string,
    leadIds: string[],
    templateContent: string,
  ): Promise<{
    leadId: string;
    customerName: string;
    personalizedMessage: string;
    canSend: boolean;
    error?: string;
  }[]> {
    console.log(`[LeadsService] previewBulkMessage - userId: ${userId}, leadIds: ${leadIds.length}, template: ${templateContent.substring(0, 50)}...`);

    const previews = [];

    for (const leadId of leadIds) {
      try {
        const lead = await this.prisma.lead.findFirst({
          where: { id: leadId, userId },
        });

        if (!lead) {
          previews.push({
            leadId,
            customerName: 'Unknown',
            personalizedMessage: '',
            canSend: false,
            error: 'Lead not found',
          });
          continue;
        }

        // Check if lead has a conversation thread
        const hasThread = !!lead.threadId;

        const personalizedMessage = this.templatesService.personalizeMessage(templateContent, {
          customerName: lead.customerName,
          category: lead.category,
          city: lead.city,
          state: lead.state,
        });

        previews.push({
          leadId,
          customerName: lead.customerName,
          personalizedMessage,
          canSend: hasThread,
          error: hasThread ? undefined : 'No conversation thread - cannot send message',
        });
      } catch (error) {
        previews.push({
          leadId,
          customerName: 'Unknown',
          personalizedMessage: '',
          canSend: false,
          error: error.message,
        });
      }
    }

    return previews;
  }

  /**
   * Send bulk messages to multiple leads
   * Uses throttling (500ms delay) to avoid rate limits
   */
  async sendBulkMessages(
    userId: string,
    leadIds: string[],
    templateContent: string,
    templateId?: string,
  ): Promise<{
    total: number;
    successful: number;
    failed: number;
    results: { leadId: string; success: boolean; error?: string }[];
  }> {
    console.log(`[LeadsService] sendBulkMessages - userId: ${userId}, leadIds: ${leadIds.length}`);

    const results: { leadId: string; success: boolean; error?: string }[] = [];
    let successful = 0;
    let failed = 0;

    for (let i = 0; i < leadIds.length; i++) {
      const leadId = leadIds[i];

      try {
        const lead = await this.prisma.lead.findFirst({
          where: { id: leadId, userId },
        });

        if (!lead) {
          results.push({ leadId, success: false, error: 'Lead not found' });
          failed++;
          continue;
        }

        if (!lead.threadId) {
          results.push({ leadId, success: false, error: 'No conversation thread' });
          failed++;
          continue;
        }

        // Personalize the message for this lead
        const personalizedMessage = this.templatesService.personalizeMessage(templateContent, {
          customerName: lead.customerName,
          category: lead.category,
          city: lead.city,
          state: lead.state,
        });

        // Send the message
        await this.sendMessage(userId, leadId, personalizedMessage);

        results.push({ leadId, success: true });
        successful++;

        // Throttle: wait 500ms between sends (except for last one)
        if (i < leadIds.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch (error) {
        results.push({ leadId, success: false, error: error.message });
        failed++;
      }
    }

    // Record template usage if a template ID was provided
    if (templateId) {
      await this.templatesService.recordUsage(userId, templateId);
    }

    console.log(`[LeadsService] Bulk send complete: ${successful} successful, ${failed} failed`);

    return {
      total: leadIds.length,
      successful,
      failed,
      results,
    };
  }
}
