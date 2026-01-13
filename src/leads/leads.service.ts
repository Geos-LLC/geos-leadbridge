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
   * Note: Leads are NOT filtered by businessId - all leads for the user are shown
   * regardless of which Thumbtack account is currently connected. This allows
   * users to switch between accounts while keeping all their leads visible.
   */
  async getLeads(userId: string, platformName: string, options?: any): Promise<NormalizedLead[]> {
    console.log(`[LeadsService] getLeads called - userId: ${userId}, platform: ${platformName}, options:`, options);

    // For webhook-based platforms like Thumbtack, query local database
    if (platformName === 'thumbtack') {
      // Get all leads for this user (not filtered by businessId)
      // This allows leads to persist when switching between Thumbtack accounts
      const leads = await this.getCachedLeads(userId, {
        platform: platformName,
        limit: options?.limit,
      });
      console.log(`[LeadsService] Found ${leads.length} leads for user ${userId}`);
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

    // Debug: check if there are ANY leads in the database
    const allLeadsCount = await this.prisma.lead.count();
    console.log(`[LeadsService] Total leads in entire DB: ${allLeadsCount}`);

    return leads.map((lead) => this.convertToNormalizedLead(lead));
  }

  /**
   * Get messages for a lead/negotiation
   */
  async getMessages(userId: string, leadId: string): Promise<any[]> {
    console.log(`[LeadsService] getMessages called - userId: ${userId}, leadId: ${leadId}`);

    const lead = await this.getLead(userId, leadId);
    console.log(`[LeadsService] Found lead - externalRequestId: ${lead.externalRequestId}, platform: ${lead.platform}`);

    // Use externalRequestId (negotiationID) to fetch messages from Thumbtack
    const negotiationId = lead.externalRequestId;

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
      throw error;
    }
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

    return { lead: this.convertToNormalizedLead(storedLead), isNew };
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
