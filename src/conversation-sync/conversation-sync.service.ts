import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';

export interface SyncPhoneNumber {
  id: string;
  phoneNumber: string;
  name?: string;
}

@Injectable()
export class ConversationSyncService {
  private readonly logger = new Logger(ConversationSyncService.name);
  private readonly sigcoreApiUrl: string;

  constructor(
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    this.sigcoreApiUrl =
      this.configService.get<string>('SIGCORE_API_URL') ||
      'https://sigcore-production.up.railway.app/api';
  }

  // ==========================================
  // Connection Management
  // ==========================================

  async getConnection(userId: string, savedAccountId: string) {
    return this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });
  }

  /**
   * Connect OpenPhone via Sigcore.
   * 1. Resolve tenant API key from existing NotificationSettings
   * 2. Call Sigcore POST /integrations/openphone/connect
   * 3. Fetch phone numbers
   * 4. Register webhook for inbound events
   * 5. Store connection in our isolated table
   */
  async connect(
    userId: string,
    savedAccountId: string,
    openPhoneApiKey: string,
    webhookBaseUrl: string,
  ): Promise<{ success: boolean; phoneNumbers?: SyncPhoneNumber[]; error?: string }> {
    this.logger.log(`[connect] Connecting OpenPhone for account ${savedAccountId}`);

    // 1. Get the Sigcore tenant API key from NotificationSettings
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreApiKey: true, sigcoreTenantId: true },
    });

    const sigcoreApiKey = settings?.sigcoreApiKey;
    if (!sigcoreApiKey) {
      return {
        success: false,
        error: 'No Sigcore tenant provisioned for this account. Please set up Lead Alerts first to provision a phone workspace.',
      };
    }

    // 2. Connect OpenPhone via Sigcore
    try {
      const connectResp = await fetch(`${this.sigcoreApiUrl}/integrations/openphone/connect`, {
        method: 'POST',
        headers: { 'x-api-key': sigcoreApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: openPhoneApiKey }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!connectResp.ok) {
        const errorText = await connectResp.text();
        this.logger.error(`[connect] Sigcore connect failed: ${connectResp.status} — ${errorText}`);
        return { success: false, error: `Failed to connect OpenPhone: ${errorText}` };
      }

      this.logger.log(`[connect] OpenPhone connected via Sigcore`);
    } catch (err: any) {
      this.logger.error(`[connect] Sigcore connect error: ${err.message}`);
      return { success: false, error: `Connection error: ${err.message}` };
    }

    // 3. Fetch phone numbers
    const phoneNumbers = await this.fetchPhoneNumbers(sigcoreApiKey);

    // 4. Register webhook for conversation sync events
    let webhookId: string | null = null;
    try {
      const webhookUrl = `${webhookBaseUrl}/api/webhooks/conversation-sync`;
      const whResp = await fetch(`${this.sigcoreApiUrl}/webhook-subscriptions`, {
        method: 'POST',
        headers: { 'x-api-key': sigcoreApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `ConversationSync-${savedAccountId}`,
          webhookUrl,
          events: ['message.inbound', 'message.sent', 'message.delivered', 'message.failed'],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (whResp.ok) {
        const whData = await whResp.json();
        webhookId = whData.id || whData.data?.id || null;
        this.logger.log(`[connect] Webhook registered: ${webhookId}`);
      } else {
        this.logger.warn(`[connect] Webhook registration failed: ${whResp.status}`);
      }
    } catch (err: any) {
      this.logger.warn(`[connect] Webhook registration error: ${err.message}`);
    }

    // 5. Upsert connection record
    await this.prisma.conversationSyncConnection.upsert({
      where: { savedAccountId },
      update: {
        userId,
        provider: 'openphone',
        providerApiKey: openPhoneApiKey,
        sigcoreApiKey,
        webhookId,
        status: 'ACTIVE',
        connectedNumbers: phoneNumbers as any,
        lastError: null,
      },
      create: {
        userId,
        savedAccountId,
        provider: 'openphone',
        providerApiKey: openPhoneApiKey,
        sigcoreApiKey,
        webhookId,
        status: 'ACTIVE',
        connectedNumbers: phoneNumbers as any,
      },
    });

    this.logger.log(`[connect] Connection saved. ${phoneNumbers.length} numbers found.`);
    return { success: true, phoneNumbers };
  }

  /**
   * Disconnect OpenPhone and clean up.
   */
  async disconnect(
    userId: string,
    savedAccountId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`[disconnect] Disconnecting account ${savedAccountId}`);

    const connection = await this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });

    if (!connection) {
      return { success: true };
    }

    // Delete webhook subscription if exists
    if (connection.sigcoreApiKey && connection.webhookId) {
      try {
        await fetch(`${this.sigcoreApiUrl}/webhook-subscriptions/${connection.webhookId}`, {
          method: 'DELETE',
          headers: { 'x-api-key': connection.sigcoreApiKey },
          signal: AbortSignal.timeout(10_000),
        });
        this.logger.log(`[disconnect] Webhook deleted: ${connection.webhookId}`);
      } catch (err: any) {
        this.logger.warn(`[disconnect] Webhook deletion failed: ${err.message}`);
      }
    }

    // Update connection status (keep record for history)
    await this.prisma.conversationSyncConnection.update({
      where: { savedAccountId },
      data: {
        status: 'DISCONNECTED',
        webhookId: null,
        connectedNumbers: undefined,
      },
    });

    this.logger.log(`[disconnect] Disconnected successfully`);
    return { success: true };
  }

  /**
   * Refresh phone numbers from Sigcore.
   */
  async refreshNumbers(
    userId: string,
    savedAccountId: string,
  ): Promise<SyncPhoneNumber[]> {
    const connection = await this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });

    if (!connection?.sigcoreApiKey || connection.status !== 'ACTIVE') {
      return [];
    }

    const phoneNumbers = await this.fetchPhoneNumbers(connection.sigcoreApiKey);

    await this.prisma.conversationSyncConnection.update({
      where: { savedAccountId },
      data: { connectedNumbers: phoneNumbers as any },
    });

    return phoneNumbers;
  }

  // ==========================================
  // Step 1: Sync OpenPhone → Sigcore
  // ==========================================

  /**
   * Trigger Sigcore to pull conversations from OpenPhone.
   * Returns immediately — sync runs in background on Sigcore side.
   */
  async triggerOpenPhoneSync(
    savedAccountId: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`[triggerOpenPhoneSync] Starting for account ${savedAccountId}`);

    const connection = await this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });

    if (!connection?.sigcoreApiKey || connection.status !== 'ACTIVE') {
      return { success: false, error: 'Not connected' };
    }

    try {
      const resp = await fetch(`${this.sigcoreApiUrl}/integrations/sync`, {
        method: 'POST',
        headers: { 'x-api-key': connection.sigcoreApiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ syncMessages: true }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this.logger.error(`[triggerOpenPhoneSync] Failed: ${resp.status} — ${errorText}`);
        return { success: false, error: `Sync trigger failed: ${resp.status}` };
      }

      this.logger.log(`[triggerOpenPhoneSync] Sigcore sync triggered (202)`);
      return { success: true };
    } catch (err: any) {
      this.logger.error(`[triggerOpenPhoneSync] Error: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Get sync progress from Sigcore.
   */
  async getSyncStatus(
    savedAccountId: string,
  ): Promise<{ status: string; progress?: number; total?: number; error?: string }> {
    const connection = await this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });

    if (!connection?.sigcoreApiKey || connection.status !== 'ACTIVE') {
      return { status: 'disconnected' };
    }

    try {
      const resp = await fetch(`${this.sigcoreApiUrl}/integrations/sync/status`, {
        headers: { 'x-api-key': connection.sigcoreApiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        return { status: 'unknown', error: `Status check failed: ${resp.status}` };
      }

      const data = await resp.json();
      return {
        status: data.status || data.state || 'unknown',
        progress: data.progress ?? data.synced ?? undefined,
        total: data.total ?? undefined,
      };
    } catch (err: any) {
      return { status: 'error', error: err.message };
    }
  }

  // ==========================================
  // Step 2: Match Sigcore conversations → Leads
  // ==========================================

  /**
   * Fetch conversations from Sigcore and match to leads by customerPhone.
   * Only stores matched conversations + messages locally.
   */
  async matchLeadConversations(
    userId: string,
    savedAccountId: string,
  ): Promise<{ synced: number; totalConversations: number; totalLeads: number; error?: string }> {
    this.logger.log(`[matchLeadConversations] Starting for account ${savedAccountId}`);

    const connection = await this.prisma.conversationSyncConnection.findUnique({
      where: { savedAccountId },
    });

    if (!connection?.sigcoreApiKey || connection.status !== 'ACTIVE') {
      return { synced: 0, totalConversations: 0, totalLeads: 0, error: 'Not connected' };
    }

    try {
      // Get all leads with phone numbers for this account
      const account = await this.prisma.savedAccount.findUnique({
        where: { id: savedAccountId },
        select: { userId: true },
      });
      if (!account) return { synced: 0, totalConversations: 0, totalLeads: 0, error: 'Account not found' };

      const leads = await this.prisma.lead.findMany({
        where: {
          userId: account.userId,
          customerPhone: { not: null },
        },
        select: { id: true, customerPhone: true, customerName: true },
      });

      if (leads.length === 0) {
        return { synced: 0, totalConversations: 0, totalLeads: 0 };
      }

      // Build a phone → lead lookup (normalize phones)
      const phoneToLead = new Map<string, { id: string; name: string }>();
      for (const lead of leads) {
        if (!lead.customerPhone) continue;
        const normalized = this.normalizePhone(lead.customerPhone);
        if (normalized) {
          phoneToLead.set(normalized, { id: lead.id, name: lead.customerName });
        }
      }

      // Fetch conversations from Sigcore
      const resp = await fetch(`${this.sigcoreApiUrl}/conversations?limit=200`, {
        headers: { 'x-api-key': connection.sigcoreApiKey },
        signal: AbortSignal.timeout(30_000),
      });

      if (!resp.ok) {
        const errorText = await resp.text();
        this.logger.error(`[syncLeadConversations] Sigcore fetch failed: ${resp.status} — ${errorText}`);
        return { synced: 0, totalConversations: 0, totalLeads: leads.length, error: `Fetch failed: ${resp.status}` };
      }

      const result = await resp.json();
      const conversations = result.data || result || [];

      let syncedCount = 0;

      for (const conv of conversations) {
        const sigcoreConvId = conv.id || conv.externalId;
        if (!sigcoreConvId) continue;

        // Match participant phone to a lead
        const participantPhone = conv.participantPhoneNumber || conv.to || '';
        const normalizedParticipant = this.normalizePhone(participantPhone);
        const matchedLead = normalizedParticipant ? phoneToLead.get(normalizedParticipant) : null;

        if (!matchedLead) continue; // Skip conversations that don't match any lead

        const businessPhone = conv.phoneNumber || conv.from || '';

        // Upsert lead conversation
        const leadConv = await this.prisma.leadConversation.upsert({
          where: {
            connectionId_sigcoreConversationId: {
              connectionId: connection.id,
              sigcoreConversationId: sigcoreConvId,
            },
          },
          update: {
            lastMessageAt: conv.lastActivityAt ? new Date(conv.lastActivityAt) : undefined,
            lastMessagePreview: conv.lastMessagePreview || conv.lastMessage?.body || undefined,
            customerName: matchedLead.name || undefined,
          },
          create: {
            connectionId: connection.id,
            leadId: matchedLead.id,
            sigcoreConversationId: sigcoreConvId,
            phoneNumber: businessPhone,
            customerPhone: participantPhone,
            customerName: matchedLead.name || null,
            lastMessageAt: conv.lastActivityAt ? new Date(conv.lastActivityAt) : null,
            lastMessagePreview: conv.lastMessagePreview || conv.lastMessage?.body || null,
          },
        });

        // Sync messages for this conversation
        await this.syncLeadMessages(connection.sigcoreApiKey, leadConv.id, sigcoreConvId);
        syncedCount++;
      }

      this.logger.log(`[matchLeadConversations] Synced ${syncedCount} of ${conversations.length} conversations for ${leads.length} leads`);
      return { synced: syncedCount, totalConversations: conversations.length, totalLeads: leads.length };
    } catch (err: any) {
      this.logger.error(`[matchLeadConversations] Error: ${err.message}`);
      return { synced: 0, totalConversations: 0, totalLeads: 0, error: err.message };
    }
  }

  /**
   * Sync messages for a single lead conversation from Sigcore.
   */
  private async syncLeadMessages(
    apiKey: string,
    leadConversationId: string,
    sigcoreConversationId: string,
  ): Promise<void> {
    try {
      const resp = await fetch(
        `${this.sigcoreApiUrl}/conversations/${sigcoreConversationId}/messages`,
        {
          headers: { 'x-api-key': apiKey },
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!resp.ok) return;

      const result = await resp.json();
      const messages = result.data || result || [];
      let count = 0;

      for (const msg of messages) {
        const externalId = msg.id || msg.providerMessageId;
        if (!externalId) continue;

        await this.prisma.leadSmsMessage.upsert({
          where: {
            leadConversationId_externalId: {
              leadConversationId,
              externalId,
            },
          },
          update: {
            status: msg.status || 'delivered',
          },
          create: {
            leadConversationId,
            externalId,
            direction: msg.direction || 'in',
            body: msg.body || '',
            fromNumber: msg.fromNumber || msg.from || '',
            toNumber: msg.toNumber || msg.to || '',
            status: msg.status || 'delivered',
            sentAt: msg.createdAt ? new Date(msg.createdAt) : new Date(),
          },
        });
        count++;
      }

      // Update message count
      await this.prisma.leadConversation.update({
        where: { id: leadConversationId },
        data: { messageCount: count },
      });
    } catch (err: any) {
      this.logger.warn(`[syncLeadMessages] Failed for ${sigcoreConversationId}: ${err.message}`);
    }
  }

  // ==========================================
  // Read Lead Conversations & Messages (from local DB)
  // ==========================================

  /**
   * Get all SMS conversations for a specific lead (for activity timeline).
   */
  async getLeadConversations(leadId: string) {
    return this.prisma.leadConversation.findMany({
      where: { leadId },
      orderBy: { lastMessageAt: 'desc' },
      include: {
        messages: {
          orderBy: { sentAt: 'asc' },
        },
      },
    });
  }

  /**
   * Get SMS activity for a lead — flat list of messages sorted by time,
   * ready to merge into the lead activity timeline.
   */
  async getLeadSmsActivity(leadId: string) {
    return this.prisma.leadSmsMessage.findMany({
      where: {
        leadConversation: { leadId },
      },
      orderBy: { sentAt: 'asc' },
      include: {
        leadConversation: {
          select: { phoneNumber: true, customerPhone: true },
        },
      },
    });
  }

  // ==========================================
  // Webhook Handler — store messages for matching leads
  // ==========================================

  async handleInboundWebhook(payload: any): Promise<void> {
    const fromNumber = payload.data?.fromNumber || payload.data?.from;
    const toNumber = payload.data?.toNumber || payload.data?.to;
    const sigcoreConvId = payload.data?.conversationId;

    if (!sigcoreConvId) {
      this.logger.debug(`[handleInboundWebhook] No conversationId in payload`);
      return;
    }

    // Find matching lead conversation
    const leadConv = await this.prisma.leadConversation.findFirst({
      where: { sigcoreConversationId: sigcoreConvId },
    });

    if (!leadConv) {
      this.logger.debug(`[handleInboundWebhook] No lead conversation for sigcore conv ${sigcoreConvId}`);
      return;
    }

    const externalId = payload.data?.messageId || payload.data?.providerMessageId || `wh-${Date.now()}`;
    const direction = payload.event?.includes('inbound') ? 'in' : 'out';

    await this.prisma.leadSmsMessage.upsert({
      where: {
        leadConversationId_externalId: {
          leadConversationId: leadConv.id,
          externalId,
        },
      },
      update: { status: payload.data?.status || 'delivered' },
      create: {
        leadConversationId: leadConv.id,
        externalId,
        direction,
        body: payload.data?.body || '',
        fromNumber: fromNumber || '',
        toNumber: toNumber || '',
        status: payload.data?.status || 'delivered',
        sentAt: payload.data?.createdAt ? new Date(payload.data.createdAt) : new Date(),
      },
    });

    // Update conversation preview
    await this.prisma.leadConversation.update({
      where: { id: leadConv.id },
      data: {
        lastMessageAt: new Date(),
        lastMessagePreview: (payload.data?.body || '').substring(0, 200),
        messageCount: { increment: 1 },
      },
    });
  }

  // ==========================================
  // Private Helpers
  // ==========================================

  private normalizePhone(phone: string): string | null {
    if (!phone) return null;
    const cleaned = phone.replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.length === 10) return `+1${cleaned}`;
    if (cleaned.length === 11 && cleaned.startsWith('1')) return `+${cleaned}`;
    return cleaned || null;
  }

  private async fetchPhoneNumbers(apiKey: string): Promise<SyncPhoneNumber[]> {
    try {
      const resp = await fetch(`${this.sigcoreApiUrl}/integrations/openphone/numbers`, {
        headers: { 'x-api-key': apiKey },
        signal: AbortSignal.timeout(10_000),
      });

      if (!resp.ok) {
        this.logger.warn(`[fetchPhoneNumbers] Failed: ${resp.status}`);
        return [];
      }

      const result = await resp.json();
      const phones = result.data || result.phoneNumbers || result || [];

      return phones.map((p: any) => ({
        id: p.id || p.phoneNumberId || p.phoneNumber,
        phoneNumber: p.phoneNumber || p.number || p.formattedNumber || '',
        name: p.name || p.friendlyName || p.label || null,
      }));
    } catch (err: any) {
      this.logger.error(`[fetchPhoneNumbers] Error: ${err.message}`);
      return [];
    }
  }
}
