/**
 * Leads Service
 * Manages lead retrieval and synchronization across platforms
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { PlatformService } from '../platforms/platform.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { NormalizedLead } from '../common/dto/normalized.dto';

@Injectable()
export class LeadsService {
  constructor(
    private prisma: PrismaService,
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
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

    // For webhook-based platforms like Thumbtack, query local database
    if (platformName === 'thumbtack') {
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
   */
  async getCachedLeads(
    userId: string,
    filters?: { platform?: string; status?: string; businessId?: string; limit?: number },
  ) {
    console.log(`[LeadsService] getCachedLeads - userId: ${userId}, filters:`, filters);

    const leads = await this.prisma.lead.findMany({
      where: {
        userId,
        ...(filters?.platform && { platform: filters.platform }),
        ...(filters?.status && { status: filters.status }),
        ...(filters?.businessId && { businessId: filters.businessId }),
      },
      orderBy: { createdAt: 'desc' },
      take: filters?.limit || 50,
    });

    console.log(`[LeadsService] getCachedLeads found ${leads.length} leads in DB`);

    // Debug: also check how many leads exist total for this user (without filters)
    const totalLeads = await this.prisma.lead.count({ where: { userId } });
    console.log(`[LeadsService] Total leads for user ${userId}: ${totalLeads}`);

    // Debug: show businessIds of all leads for this user
    const allUserLeads = await this.prisma.lead.findMany({
      where: { userId },
      select: { id: true, businessId: true, customerName: true },
    });
    console.log(`[LeadsService] All leads for user with their businessIds:`,
      allUserLeads.map(l => ({ id: l.id.slice(0, 8), businessId: l.businessId, name: l.customerName })));

    // Debug: check if there are ANY leads in the database
    const allLeadsCount = await this.prisma.lead.count();
    console.log(`[LeadsService] Total leads in entire DB: ${allLeadsCount}`);

    return leads.map((lead) => this.convertToNormalizedLead(lead));
  }

  /**
   * Get messages for a lead/negotiation
   * First checks local database, then falls back to API if connected to the right account
   */
  async getMessages(userId: string, leadId: string): Promise<any[]> {
    console.log(`[LeadsService] getMessages called - userId: ${userId}, leadId: ${leadId}`);

    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] Found lead - externalRequestId: ${lead.externalRequestId}, platform: ${lead.platform}, businessId: ${lead.businessId}`);

    const negotiationId = lead.externalRequestId;

    // First, check if we have messages stored locally (from webhooks)
    const localMessages = await this.getLocalMessages(userId, lead.platform, negotiationId);

    if (localMessages.length > 0) {
      console.log(`[LeadsService] Found ${localMessages.length} messages in local database`);
      return localMessages;
    }

    // Check if current connection matches the lead's business
    const platform = await this.prisma.platform.findFirst({
      where: {
        userId,
        platformName: lead.platform,
        connected: true,
      },
    });

    const isConnectedToRightAccount = platform?.externalBusinessId === lead.businessId;
    console.log(`[LeadsService] Connected businessId: ${platform?.externalBusinessId}, Lead businessId: ${lead.businessId}, Match: ${isConnectedToRightAccount}`);

    // If not connected to the right account, return empty (can't fetch from API)
    if (!isConnectedToRightAccount) {
      console.log(`[LeadsService] Not connected to lead's account, returning empty messages`);
      return [];
    }

    // Try to fetch from API
    try {
      const credentials = await this.platformService.getCredentials(userId, lead.platform);
      const adapter = this.platformFactory.getAdapter(lead.platform) as any;

      if (typeof adapter.getConversation === 'function') {
        console.log(`[LeadsService] Fetching conversation for negotiationId: ${negotiationId}`);
        const messages = await adapter.getConversation(credentials, negotiationId);
        console.log(`[LeadsService] Got ${messages.length} messages from adapter`);
        return messages;
      }

      console.log(`[LeadsService] Adapter does not have getConversation method`);
      return [];
    } catch (error) {
      console.error(`[LeadsService] Error fetching messages:`, error.message);
      console.error(`[LeadsService] Full error:`, error.response?.data || error);
      // Return empty array instead of throwing - lead from another account
      return [];
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
    return messages.map(msg => ({
      id: msg.id,
      conversationId: msg.conversationId,
      platform: msg.platform,
      externalMessageId: msg.externalMessageId,
      sender: msg.sender,
      content: msg.content,
      isRead: msg.isRead,
      sentAt: msg.sentAt.toISOString(),
      deliveredAt: msg.deliveredAt?.toISOString(),
    }));
  }

  /**
   * Send a message to a lead
   */
  async sendMessage(
    userId: string,
    leadId: string,
    message: string,
  ): Promise<any> {
    const lead = await this.getLead(userId, leadId);

    if (!lead.threadId) {
      throw new NotFoundException('No conversation thread found for this lead');
    }

    const credentials = await this.platformService.getCredentials(userId, lead.platform);
    const adapter = this.platformFactory.getAdapter(lead.platform);

    return await adapter.sendMessage(credentials, lead.threadId, message);
  }

  /**
   * Send a quote to a lead
   */
  async sendQuote(
    userId: string,
    leadId: string,
    amount: number,
    description?: string,
  ): Promise<any> {
    const lead = await this.getLead(userId, leadId);

    const credentials = await this.platformService.getCredentials(userId, lead.platform);
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
   * Only works if connected to the lead's business account
   */
  async syncLeadStatus(userId: string, leadId: string): Promise<NormalizedLead> {
    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] syncLeadStatus - leadId: ${leadId}, negotiationId: ${lead.externalRequestId}`);

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
      console.log(`[LeadsService] Not connected to lead's account, cannot sync status`);
      return lead; // Return existing lead without sync
    }

    try {
      const credentials = await this.platformService.getCredentials(userId, lead.platform);
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
      },
    });
  }

  /**
   * Import a single Thumbtack negotiation by ID
   * Returns { lead, isNew } to indicate if this was a new import or update
   * Also imports and stores all messages for the negotiation
   */
  async importThumbtackNegotiation(userId: string, negotiationId: string): Promise<{ lead: NormalizedLead; isNew: boolean }> {
    console.log(`[LeadsService] importThumbtackNegotiation - userId: ${userId}, negotiationId: ${negotiationId}`);

    // Check if lead already exists in DB (regardless of userId - could be from webhook or different user)
    const existingLead = await this.prisma.lead.findFirst({
      where: {
        platform: 'thumbtack',
        externalRequestId: negotiationId,
      },
    });

    const isNew = !existingLead;
    console.log(`[LeadsService] Lead ${isNew ? 'is new' : 'already exists in DB'}${existingLead ? ` (owner: ${existingLead.userId})` : ''}`);

    const credentials = await this.platformService.getCredentials(userId, 'thumbtack');
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    // Fetch negotiation from Thumbtack API
    const lead = await adapter.getLead(credentials, negotiationId);
    console.log(`[LeadsService] Fetched lead from Thumbtack:`, JSON.stringify(lead));

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

    // Also import messages for this negotiation
    await this.importMessagesForNegotiation(userId, 'thumbtack', negotiationId, storedLead.customerName);

    return { lead: this.convertToNormalizedLead(storedLead), isNew };
  }

  /**
   * Import and store messages for a negotiation from the API
   */
  private async importMessagesForNegotiation(
    userId: string,
    platform: string,
    negotiationId: string,
    customerName: string,
  ): Promise<void> {
    console.log(`[LeadsService] Importing messages for negotiation: ${negotiationId}`);

    try {
      const credentials = await this.platformService.getCredentials(userId, platform);
      const adapter = this.platformFactory.getAdapter(platform) as any;

      if (typeof adapter.getConversation !== 'function') {
        console.log(`[LeadsService] Adapter does not support getConversation`);
        return;
      }

      const messages = await adapter.getConversation(credentials, negotiationId);
      console.log(`[LeadsService] Fetched ${messages.length} messages from API`);

      if (messages.length === 0) {
        return;
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

      // Store each message (skip duplicates)
      for (const msg of messages) {
        const existingMsg = await this.prisma.message.findFirst({
          where: {
            platform,
            externalMessageId: msg.externalMessageId,
          },
        });

        if (existingMsg) {
          continue; // Skip duplicate
        }

        await this.prisma.message.create({
          data: {
            conversationId: conversation.id,
            userId,
            platform,
            externalMessageId: msg.externalMessageId,
            sender: msg.sender?.toLowerCase() || 'customer',
            content: msg.content || '',
            isRead: true, // Imported messages are considered read
            sentAt: new Date(msg.sentAt),
            rawJson: JSON.stringify(msg),
          },
        });
      }

      // Update conversation's lastMessageAt
      const lastMsg = messages[messages.length - 1];
      if (lastMsg) {
        await this.prisma.conversation.update({
          where: { id: conversation.id },
          data: { lastMessageAt: new Date(lastMsg.sentAt) },
        });
      }

      console.log(`[LeadsService] Imported ${messages.length} messages for negotiation ${negotiationId}`);
    } catch (error) {
      console.error(`[LeadsService] Error importing messages:`, error.message);
      // Don't throw - lead import succeeded, messages are optional
    }
  }

  /**
   * Import multiple Thumbtack negotiations
   */
  async importThumbtackNegotiations(
    userId: string,
    negotiationIds: string[],
  ): Promise<{ imported: number; failed: number; errors: string[] }> {
    const results = { imported: 0, failed: 0, errors: [] as string[] };

    for (const negotiationId of negotiationIds) {
      try {
        await this.importThumbtackNegotiation(userId, negotiationId);
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
      raw: lead.rawJson ? JSON.parse(lead.rawJson) : undefined,
    };
  }
}
