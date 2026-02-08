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

    // Check what happened in the webhook pipeline
    const webhookEvent = await this.prisma.webhookEvent.findFirst({
      where: { platform: 'thumbtack', receivedAt: { gte: new Date(Date.now() - 30000) } },
      orderBy: { receivedAt: 'desc' },
      select: { id: true, processed: true, processingError: true },
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

    // Check recent notification logs - search by leadId OR by notificationSettingsId (in case lead wasn't linked)
    const notifSettingsForLogs = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: dto.savedAccountId },
      select: { id: true },
    });

    const recentLogs = await this.prisma.notificationLog.findMany({
      where: {
        OR: [
          { leadId: lead?.id },
          { notificationSettingsId: notifSettingsForLogs?.id, createdAt: { gte: new Date(Date.now() - 30000) } },
        ],
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

    // === PIPELINE TRACE ===
    // Mirror the exact logic of handleNegotiationCreated + sendLeadNotification
    // to show step-by-step what the webhook pipeline did/would do
    const pipelineTrace: Array<{ step: string; status: 'pass' | 'fail' | 'skip'; detail: string }> = [];

    // Step 1: Platform connection lookup (same as handleNegotiationCreated lines 234-314)
    const businessId = account.businessId;
    let traceUserId: string | null = null;

    const platformConn = await this.prisma.platform.findFirst({
      where: { platformName: 'thumbtack', externalBusinessId: businessId },
    });
    if (platformConn) {
      traceUserId = platformConn.userId;
      pipelineTrace.push({ step: 'Platform connection (exact match)', status: 'pass', detail: `Found via externalBusinessId=${businessId}` });
    } else {
      // Try savedAccount fallback (same as handleNegotiationCreated line 266)
      const savedAcctLookup = await this.prisma.savedAccount.findFirst({
        where: { platform: 'thumbtack', businessId },
      });
      if (savedAcctLookup) {
        const fallbackConn = await this.prisma.platform.findFirst({
          where: { platformName: 'thumbtack', userId: savedAcctLookup.userId, connected: true },
        });
        if (fallbackConn) {
          traceUserId = fallbackConn.userId;
          pipelineTrace.push({ step: 'Platform connection (SavedAccount fallback)', status: 'pass', detail: `Found via savedAccount userId=${savedAcctLookup.userId}` });
        } else {
          pipelineTrace.push({ step: 'Platform connection (SavedAccount fallback)', status: 'fail', detail: `SavedAccount found but no connected platform for userId=${savedAcctLookup.userId}` });
        }
      } else {
        pipelineTrace.push({ step: 'Platform connection', status: 'fail', detail: `No platform or savedAccount found for businessId=${businessId}. Pipeline stops here - lead won't be created.` });
      }
    }

    // Step 2: SavedAccount lookup for SMS (same as handleNegotiationCreated line 396)
    let traceSavedAccount: any = null;
    if (traceUserId) {
      traceSavedAccount = await this.prisma.savedAccount.findFirst({
        where: { platform: 'thumbtack', businessId, userId: traceUserId },
      });
      if (traceSavedAccount) {
        pipelineTrace.push({ step: 'SavedAccount for SMS', status: 'pass', detail: `Found: ${traceSavedAccount.businessName} (${traceSavedAccount.id})` });
      } else {
        pipelineTrace.push({ step: 'SavedAccount for SMS', status: 'fail', detail: `No savedAccount with platform=thumbtack, businessId=${businessId}, userId=${traceUserId}. SMS skipped.` });
      }
    }

    // Step 3-8: sendLeadNotification checks (same as notifications.service.ts line 602+)
    if (traceSavedAccount) {
      // Step 3: NotificationSettings lookup
      const traceSettings = await this.prisma.notificationSettings.findUnique({
        where: { savedAccountId: traceSavedAccount.id },
        include: {
          notificationRules: {
            where: { triggerType: dto.eventType === 'NegotiationCreatedV4' ? 'new_lead' : 'customer_reply', enabled: true },
          },
        },
      });

      if (!traceSettings) {
        pipelineTrace.push({ step: 'NotificationSettings', status: 'fail', detail: `No settings for savedAccountId=${traceSavedAccount.id}. Pipeline checks user-level defaults next.` });

        // Check fallback - user-level defaults
        const userDefaults = await this.prisma.notificationSettings.findFirst({
          where: { userId: traceUserId!, savedAccountId: null },
        });
        if (userDefaults) {
          pipelineTrace.push({ step: 'User-level default settings', status: 'pass', detail: 'Found user-level defaults (fallback)' });
        } else {
          pipelineTrace.push({ step: 'User-level default settings', status: 'fail', detail: 'No user-level defaults either. SMS cannot be sent.' });
        }
      } else {
        pipelineTrace.push({ step: 'NotificationSettings', status: 'pass', detail: `Found settings (id=${traceSettings.id})` });

        // Step 4: enabled check
        if (!traceSettings.enabled) {
          pipelineTrace.push({ step: 'Settings enabled', status: 'fail', detail: 'enabled=false. SMS skipped.' });
        } else {
          pipelineTrace.push({ step: 'Settings enabled', status: 'pass', detail: 'enabled=true' });
        }

        // Step 5: Callio API key
        if (!traceSettings.callioApiKey) {
          pipelineTrace.push({ step: 'Callio API key', status: 'fail', detail: 'No API key configured. SMS cannot be sent.' });
        } else {
          pipelineTrace.push({ step: 'Callio API key', status: 'pass', detail: 'API key is set' });
        }

        // Step 6: requirePhone check
        const leadPhone = dto.customerPhone || '+15555555555';
        if (traceSettings.requirePhone && !leadPhone) {
          pipelineTrace.push({ step: 'Lead phone required', status: 'fail', detail: 'requirePhone=true but lead has no phone' });
        } else {
          pipelineTrace.push({ step: 'Lead phone required', status: 'pass', detail: `requirePhone=${traceSettings.requirePhone}, phone=${leadPhone ? 'present' : 'missing'}` });
        }

        // Step 7: Quiet hours
        const isQuiet = this.checkQuietHours(traceSettings);
        if (isQuiet) {
          pipelineTrace.push({ step: 'Quiet hours', status: 'fail', detail: `Currently in quiet hours (${traceSettings.quietHoursStart}-${traceSettings.quietHoursEnd} ${traceSettings.quietHoursTimezone})` });
        } else {
          pipelineTrace.push({ step: 'Quiet hours', status: 'pass', detail: traceSettings.quietHoursStart ? `Not in quiet hours (${traceSettings.quietHoursStart}-${traceSettings.quietHoursEnd})` : 'No quiet hours configured' });
        }

        // Step 8: Rules check
        const traceRules = traceSettings.notificationRules;
        if (traceRules.length === 0) {
          pipelineTrace.push({ step: 'Notification rules', status: 'fail', detail: `No enabled "${dto.eventType === 'NegotiationCreatedV4' ? 'new_lead' : 'customer_reply'}" rules found. SMS skipped.` });

          // Check if there are rules with wrong triggerType
          const allRules = await this.prisma.notificationRule.findMany({
            where: { notificationSettingsId: traceSettings.id },
            select: { name: true, triggerType: true, enabled: true },
          });
          if (allRules.length > 0) {
            const ruleList = allRules.map(r => `"${r.name}" (type=${r.triggerType}, enabled=${r.enabled})`).join('; ');
            pipelineTrace.push({ step: 'All rules in settings', status: 'skip', detail: ruleList });
          }
        } else {
          pipelineTrace.push({ step: 'Notification rules', status: 'pass', detail: `Found ${traceRules.length} rule(s)` });

          // Step 9: Check each rule's phone numbers
          for (const rule of traceRules) {
            const ruleToPhone = (rule as any).toPhone;
            const ruleFromPhone = (rule as any).fromPhone;
            if (!ruleToPhone) {
              pipelineTrace.push({ step: `Rule "${(rule as any).name}" phone`, status: 'fail', detail: 'No toPhone set - SMS skipped for this rule' });
            } else {
              pipelineTrace.push({ step: `Rule "${(rule as any).name}" phone`, status: 'pass', detail: `from=${ruleFromPhone || 'shared'}, to=${ruleToPhone}` });
            }
          }
        }
      }
    }

    // Determine why SMS was not sent (if applicable) - now uses pipeline trace
    let smsNotSentReason: string | null = null;
    if (!smsSent && !webhookError) {
      const failedStep = pipelineTrace.find(s => s.status === 'fail');
      if (failedStep) {
        smsNotSentReason = `Pipeline stopped at "${failedStep.step}": ${failedStep.detail}`;
      } else {
        smsNotSentReason = 'All pipeline checks passed but no SMS log found. Possible Callio API error - check Railway logs.';
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
        webhookEventId: webhookEvent?.id || null,
        webhookEventError: webhookEvent?.processingError || null,
        pipelineTrace,
        notificationDiagnostics: {
          settingsExist: !!notifSettings,
          settingsEnabled: notifSettings?.enabled ?? false,
          hasCallioApiKey: !!notifSettings?.callioApiKey,
          totalRules: notifSettings?.notificationRules?.length || 0,
          newLeadRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'new_lead').length,
          customerReplyRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'customer_reply').length,
        },
      },
    };
  }

  /**
   * Check quiet hours (mirrors NotificationsService.isQuietHours)
   */
  private checkQuietHours(settings: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietHoursTimezone: string | null;
  }): boolean {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) return false;
    try {
      const tz = settings.quietHoursTimezone || 'America/New_York';
      const now = new Date();
      const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
      const currentTime = formatter.format(now);
      const [startH, startM] = settings.quietHoursStart.split(':').map(Number);
      const [endH, endM] = settings.quietHoursEnd.split(':').map(Number);
      const [curH, curM] = currentTime.split(':').map(Number);
      const startMin = startH * 60 + startM;
      const endMin = endH * 60 + endM;
      const curMin = curH * 60 + curM;
      if (startMin > endMin) return curMin >= startMin || curMin < endMin;
      return curMin >= startMin && curMin < endMin;
    } catch { return false; }
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
