import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';

export interface SimulateWebhookDto {
  targetUserId: string;
  savedAccountId: string;
  eventType: 'NegotiationCreatedV4' | 'MessageCreatedV4';

  // Common
  customerFirstName?: string;
  customerLastName?: string;
  customerPhone?: string;

  // NegotiationCreatedV4
  category?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  message?: string;
  estimateTotal?: string;
  details?: Array<{ question: string; answer: string }>;

  // MessageCreatedV4
  messageText?: string;
  negotiationId?: string;
  messageSender?: 'Customer' | 'Pro';
}

@Injectable()
export class TestService {
  private readonly logger = new Logger(TestService.name);

  constructor(
    private prisma: PrismaService,
    private webhooksService: WebhooksService,
  ) {}

  async getUsers(search?: string) {
    const where: any = {};
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { name: { contains: search, mode: 'insensitive' } },
      ];
    }

    const users = await this.prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        subscriptionTier: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { users };
  }

  async getUserAccounts(userId: string) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      select: {
        id: true,
        businessId: true,
        businessName: true,
        webhookId: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { accounts };
  }

  async simulateWebhook(userId: string, dto: SimulateWebhookDto) {
    // 1. Validate account belongs to the target user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: dto.savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    this.logger.log(`Simulating ${dto.eventType} for account ${account.businessName} (${account.businessId})`);

    // 2. Generate unique IDs
    const suffix = Math.random().toString(36).substring(2, 8);
    const negotiationId = dto.negotiationId || `test-neg-${Date.now()}-${suffix}`;
    const now = new Date().toISOString();

    // 3. Build webhook payload
    let payload: any;

    if (dto.eventType === 'NegotiationCreatedV4') {
      payload = {
        event: { eventType: 'NegotiationCreatedV4' },
        data: {
          negotiationID: negotiationId,
          createdAt: now,
          status: 'Open',
          customer: {
            firstName: dto.customerFirstName || 'Test',
            lastName: dto.customerLastName || 'Customer',
            phone: dto.customerPhone || '+15555555555',
          },
          business: { businessID: account.businessId },
          request: {
            description: dto.message || 'Test lead from API Test page',
            category: { name: dto.category || 'House Cleaning' },
            location: {
              city: dto.city || 'Tampa',
              state: dto.state || 'FL',
              zipCode: dto.zipCode || '33602',
            },
            details: dto.details || [],
          },
          estimate: dto.estimateTotal ? { total: dto.estimateTotal } : undefined,
        },
      };
    } else {
      const messageId = `test-msg-${Date.now()}-${suffix}`;
      payload = {
        event: { eventType: 'MessageCreatedV4' },
        data: {
          messageID: messageId,
          negotiationID: negotiationId,
          text: dto.messageText || 'Test message from API Test page',
          from: dto.messageSender || 'Customer',
          sentAt: now,
          customer: {
            firstName: dto.customerFirstName || 'Test',
            lastName: dto.customerLastName || 'Customer',
            phone: dto.customerPhone || '+15555555555',
          },
          business: { businessID: account.businessId },
        },
      };
    }

    // 4. Snapshot before counts
    const beforeLeadCount = await this.prisma.lead.count({ where: { userId } });

    // 5. Process through the real webhook pipeline
    let webhookError: string | null = null;
    try {
      await this.webhooksService.handleThumbtackWebhook(undefined, payload);
    } catch (error: any) {
      webhookError = error.message || 'Unknown error';
      this.logger.error(`Simulation error: ${webhookError}`);
    }

    // 6. Gather results
    const afterLeadCount = await this.prisma.lead.count({ where: { userId } });

    const lead = await this.prisma.lead.findFirst({
      where: { externalRequestId: negotiationId, platform: 'thumbtack' },
      select: { id: true, status: true, customerName: true, category: true },
    });

    const automationRules = await this.prisma.automationRule.findMany({
      where: { savedAccountId: dto.savedAccountId, enabled: true },
      select: { name: true, triggerType: true },
    });

    const notifSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: dto.savedAccountId },
      include: {
        notificationRules: {
          where: { enabled: true },
          select: { name: true, triggerType: true },
        },
      },
    });

    // Check recent notification logs (within last 30 seconds to account for processing time)
    const recentLogs = await this.prisma.notificationLog.findMany({
      where: {
        leadId: lead?.id,
        createdAt: { gte: new Date(Date.now() - 30000) },
      },
      select: { id: true, status: true, ruleName: true, error: true, toPhone: true, fromPhone: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    // Build notification diagnostics - trace exactly what the webhook pipeline would have done
    const smsSent = recentLogs.length > 0;
    const smsSuccessCount = recentLogs.filter(l => l.status !== 'failed').length;
    const smsFailedCount = recentLogs.filter(l => l.status === 'failed').length;

    // Determine why SMS was not sent (if applicable)
    let smsNotSentReason: string | null = null;
    if (!smsSent && !webhookError) {
      if (!notifSettings) {
        smsNotSentReason = 'No notification settings found for this account. Go to SMS Alerts to configure.';
      } else if (!notifSettings.enabled) {
        smsNotSentReason = 'Notification settings are disabled for this account.';
      } else if (!notifSettings.callioApiKey) {
        smsNotSentReason = 'No Callio API key configured. Connect Callio in SMS Alerts > Phone Settings.';
      } else {
        const newLeadRules = (notifSettings.notificationRules || []).filter(
          (r: any) => r.triggerType === 'new_lead' && r.enabled,
        );
        if (dto.eventType === 'NegotiationCreatedV4' && newLeadRules.length === 0) {
          smsNotSentReason = 'No enabled "new_lead" SMS rules found. Create a rule in SMS Alerts.';
        } else if (dto.eventType === 'MessageCreatedV4') {
          const replyRules = (notifSettings.notificationRules || []).filter(
            (r: any) => r.triggerType === 'customer_reply' && r.enabled,
          );
          if (replyRules.length === 0) {
            smsNotSentReason = 'No enabled "customer_reply" SMS rules found.';
          } else {
            smsNotSentReason = 'Customer reply SMS only triggers on 2nd+ customer message (not first message).';
          }
        } else {
          smsNotSentReason = 'Unknown reason - check Railway logs for details.';
        }
      }
    }

    return {
      success: !webhookError,
      eventType: dto.eventType,
      negotiationId,
      payload,
      results: {
        webhookProcessed: !webhookError,
        webhookError,
        leadCreated: afterLeadCount > beforeLeadCount,
        leadId: lead?.id || null,
        leadStatus: lead?.status || null,
        leadName: lead?.customerName || null,
        sseEventEmitted: !webhookError,
        automationRulesFound: automationRules.length,
        automationRules: automationRules.map(r => ({ name: r.name, triggerType: r.triggerType })),
        notificationRulesFound: notifSettings?.notificationRules?.length || 0,
        notificationRules: (notifSettings?.notificationRules || []).map(r => ({ name: r.name, triggerType: r.triggerType })),
        callioConnected: !!notifSettings?.callioApiKey,
        smsLogs: recentLogs,
        smsSent,
        smsSuccessCount,
        smsFailedCount,
        smsNotSentReason,
        notificationDiagnostics: {
          settingsExist: !!notifSettings,
          settingsEnabled: notifSettings?.enabled ?? false,
          hasCallioApiKey: !!notifSettings?.callioApiKey,
          totalRules: notifSettings?.notificationRules?.length || 0,
          newLeadRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'new_lead' && r.enabled).length,
          customerReplyRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'customer_reply' && r.enabled).length,
        },
      },
    };
  }

  async getAccountDiagnostics(savedAccountId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId },
      select: { id: true, businessId: true, businessName: true, userId: true, webhookId: true },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    // Platform connection
    const platformConnection = await this.prisma.platform.findFirst({
      where: {
        platformName: 'thumbtack',
        userId: account.userId,
        connected: true,
      },
      select: { id: true, externalBusinessId: true, connected: true },
    });

    // Notification settings
    const notifSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: {
        notificationRules: {
          where: { enabled: true },
          select: { id: true, name: true, triggerType: true, toPhone: true, fromPhone: true, enabled: true },
        },
      },
    });

    // Automation rules
    const automationRules = await this.prisma.automationRule.findMany({
      where: { savedAccountId, enabled: true },
      select: { id: true, name: true, triggerType: true, enabled: true },
    });

    // Recent notification logs
    const recentLogs = await this.prisma.notificationLog.findMany({
      where: {
        notificationSettingsId: notifSettings?.id,
        createdAt: { gte: new Date(Date.now() - 86400000) }, // Last 24h
      },
      select: { id: true, status: true, ruleName: true, error: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    // Build health checks - only flag critical issues that prevent SMS from working
    const issues: string[] = [];
    if (!platformConnection) issues.push('No active Thumbtack connection found for this user');
    if (!account.webhookId) issues.push('No webhook registered for this account');
    if (!notifSettings) issues.push('No notification settings configured');
    else {
      if (!notifSettings.enabled) issues.push('Notification settings are disabled');
      if (!notifSettings.callioApiKey) issues.push('No Callio API key configured');
      const newLeadRules = notifSettings.notificationRules.filter(r => r.triggerType === 'new_lead');
      if (newLeadRules.length === 0) issues.push('No enabled "new_lead" SMS rules');
    }

    return {
      account: {
        id: account.id,
        businessId: account.businessId,
        businessName: account.businessName,
        hasWebhook: !!account.webhookId,
      },
      platform: {
        connected: !!platformConnection,
        externalBusinessId: platformConnection?.externalBusinessId || null,
      },
      notifications: {
        settingsExist: !!notifSettings,
        settingsEnabled: notifSettings?.enabled ?? false,
        hasCallioApiKey: !!notifSettings?.callioApiKey,
        totalRules: notifSettings?.notificationRules?.length || 0,
        newLeadRules: (notifSettings?.notificationRules || []).filter(r => r.triggerType === 'new_lead').length,
        customerReplyRules: (notifSettings?.notificationRules || []).filter(r => r.triggerType === 'customer_reply').length,
        rules: (notifSettings?.notificationRules || []).map(r => ({
          name: r.name,
          triggerType: r.triggerType,
          toPhone: r.toPhone,
          fromPhone: r.fromPhone,
        })),
      },
      automation: {
        totalRules: automationRules.length,
        rules: automationRules.map(r => ({ name: r.name, triggerType: r.triggerType })),
      },
      recentLogs: recentLogs.map(l => ({
        status: l.status,
        ruleName: l.ruleName,
        error: l.error,
        createdAt: l.createdAt,
      })),
      healthy: issues.length === 0,
      issues,
    };
  }

  async getLeadsForAccount(userId: string, savedAccountId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const leads = await this.prisma.lead.findMany({
      where: {
        userId: account.userId,
        platform: 'thumbtack',
        businessId: account.businessId,
      },
      select: {
        id: true,
        externalRequestId: true,
        customerName: true,
        category: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { leads, count: leads.length };
  }
}
