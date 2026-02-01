/**
 * Notifications Service
 * Manages SMS notification settings and sends notifications via Callio
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

export interface UpdateNotificationSettingsDto {
  enabled?: boolean;
  destinationPhone?: string;
  senderMode?: 'shared' | 'dedicated' | 'openphone';
  callioApiKey?: string;
  callioFromPhone?: string;
  callioWorkspaceId?: string;
  template?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursTimezone?: string;
  requirePhone?: boolean;
}

// Notification Rule DTOs
export interface CreateNotificationRuleDto {
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone: string; // Callio phone number to send FROM
  toPhone: string;   // Destination phone number to send TO
  template: string;
  enabled?: boolean;
}

export interface UpdateNotificationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone?: string;
  toPhone?: string;
  template?: string;
  enabled?: boolean;
}

export interface NotificationRuleResponse {
  id: string;
  notificationSettingsId: string;
  name: string;
  triggerType: string;
  replyTriggerMode: string | null;
  fromPhone: string | null;
  toPhone: string | null;
  template: string;
  enabled: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Account info (included when fetching all rules)
  savedAccountId?: string;
  savedAccount?: {
    id: string;
    businessId: string;
    businessName: string;
  };
}

export interface CustomerReplyContext {
  userId: string;
  savedAccountId: string;
  leadId: string;
  lead: {
    customerName: string;
    customerPhone?: string | null;
    category?: string | null;
    city?: string | null;
    state?: string | null;
    postcode?: string | null;
    message?: string | null;
    rawJson?: string | null;
  };
  isFirstCustomerReply: boolean;
  isSecondCustomerMessage?: boolean;
}

export interface CallioPhoneNumber {
  id: string;
  phoneNumber: string;
  provider: 'twilio' | 'openphone' | string;
  friendlyName?: string;
  capabilities?: string[];
  // A2P Compliance fields
  a2pStatus?: 'pending' | 'approved' | 'rejected' | 'not_required' | string;
  a2pBrandId?: string;
  a2pCampaignId?: string;
  smsEnabled?: boolean;
  mmsEnabled?: boolean;
  voiceEnabled?: boolean;
}

export interface NotificationSettingsResponse {
  id: string;
  savedAccountId: string;
  enabled: boolean;
  destinationPhone: string | null;
  senderMode: string;
  callioApiKey: string | null; // Will be masked in response
  callioFromPhone: string | null;
  callioWorkspaceId: string | null;
  callioConnected: boolean; // Whether API key is configured
  template: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  requirePhone: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationLogResponse {
  id: string;
  leadId: string | null;
  notificationRuleId: string | null;
  ruleName: string | null;
  toPhone: string;
  fromPhone: string | null;
  provider: string | null;
  status: string;
  error: string | null;
  messageBody: string;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
}

export interface SendNotificationContext {
  userId: string;
  savedAccountId: string;
  leadId: string;
  lead: {
    customerName: string;
    customerPhone?: string | null;
    category?: string | null;
    city?: string | null;
    state?: string | null;
    postcode?: string | null;
    message?: string | null;
    rawJson?: string | null;
  };
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get notification settings for a saved account
   */
  async getSettings(
    userId: string,
    savedAccountId: string,
  ): Promise<NotificationSettingsResponse | null> {
    // Verify the account belongs to the user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return null;
    }

    // Auto-fix legacy records where enabled was incorrectly set to false
    // The global enabled flag should always be true (individual rules have their own toggle)
    if (!settings.enabled) {
      settings = await this.prisma.notificationSettings.update({
        where: { id: settings.id },
        data: { enabled: true },
      });
      this.logger.log(`[getSettings] Auto-fixed enabled=false for account ${savedAccountId}`);
    }

    return this.formatSettings(settings);
  }

  /**
   * Create or update notification settings for a saved account
   */
  async upsertSettings(
    userId: string,
    savedAccountId: string,
    data: UpdateNotificationSettingsDto,
  ): Promise<NotificationSettingsResponse> {
    // Verify the account belongs to the user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      create: {
        savedAccountId,
        enabled: data.enabled ?? true,  // Default to enabled (rules have their own toggle)
        destinationPhone: data.destinationPhone,
        senderMode: data.senderMode ?? 'shared',
        callioApiKey: data.callioApiKey,
        callioFromPhone: data.callioFromPhone,
        callioWorkspaceId: data.callioWorkspaceId,
        template: data.template ?? 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        quietHoursTimezone: data.quietHoursTimezone ?? 'America/New_York',
        requirePhone: data.requirePhone ?? true,
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.destinationPhone !== undefined && { destinationPhone: data.destinationPhone }),
        ...(data.senderMode !== undefined && { senderMode: data.senderMode }),
        ...(data.callioApiKey !== undefined && { callioApiKey: data.callioApiKey }),
        ...(data.callioFromPhone !== undefined && { callioFromPhone: data.callioFromPhone }),
        ...(data.callioWorkspaceId !== undefined && { callioWorkspaceId: data.callioWorkspaceId }),
        ...(data.template !== undefined && { template: data.template }),
        ...(data.quietHoursStart !== undefined && { quietHoursStart: data.quietHoursStart }),
        ...(data.quietHoursEnd !== undefined && { quietHoursEnd: data.quietHoursEnd }),
        ...(data.quietHoursTimezone !== undefined && { quietHoursTimezone: data.quietHoursTimezone }),
        ...(data.requirePhone !== undefined && { requirePhone: data.requirePhone }),
      },
    });

    return this.formatSettings(settings);
  }

  /**
   * Get notification logs for a saved account
   */
  async getLogs(
    userId: string,
    savedAccountId: string,
    limit: number = 50,
  ): Promise<NotificationLogResponse[]> {
    // Verify the account belongs to the user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return [];
    }

    const logs = await this.prisma.notificationLog.findMany({
      where: { notificationSettingsId: settings.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return logs.map(this.formatLog);
  }

  /**
   * Get all notification logs across all accounts for a user
   */
  async getAllLogs(
    userId: string,
    limit: number = 100,
  ): Promise<(NotificationLogResponse & { savedAccountId?: string; savedAccount?: { id: string; businessId: string; businessName: string } })[]> {
    // Get all saved accounts for this user with their notification settings
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      include: {
        notificationSettings: {
          include: {
            notificationLogs: {
              orderBy: { createdAt: 'desc' },
              take: limit, // Fetch full limit per account, will be sorted and limited at the end
            },
          },
        },
      },
    });

    const allLogs: (NotificationLogResponse & { savedAccountId?: string; savedAccount?: { id: string; businessId: string; businessName: string } })[] = [];

    for (const account of accounts) {
      if (account.notificationSettings?.notificationLogs) {
        for (const log of account.notificationSettings.notificationLogs) {
          allLogs.push({
            ...this.formatLog(log),
            savedAccountId: account.id,
            savedAccount: {
              id: account.id,
              businessId: account.businessId,
              businessName: account.businessName,
            },
          });
        }
      }
    }

    // Sort by creation date (newest first) and limit
    return allLogs
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  // ==========================================
  // Notification Rule CRUD
  // ==========================================

  /**
   * Get all notification rules across all accounts for a user
   */
  async getAllRules(userId: string): Promise<NotificationRuleResponse[]> {
    // Get all saved accounts for this user
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId },
      include: {
        notificationSettings: {
          include: {
            notificationRules: {
              orderBy: { createdAt: 'desc' },
            },
          },
        },
      },
    });

    // Auto-fix any accounts with enabled=false (legacy bug)
    for (const account of accounts) {
      if (account.notificationSettings && !account.notificationSettings.enabled) {
        await this.prisma.notificationSettings.update({
          where: { id: account.notificationSettings.id },
          data: { enabled: true },
        });
        this.logger.log(`[getAllRules] Auto-fixed enabled=false for account ${account.id}`);
      }
    }

    const allRules: NotificationRuleResponse[] = [];

    for (const account of accounts) {
      if (account.notificationSettings?.notificationRules) {
        for (const rule of account.notificationSettings.notificationRules) {
          allRules.push({
            ...this.formatRule(rule),
            savedAccountId: account.id,
            savedAccount: {
              id: account.id,
              businessId: account.businessId,
              businessName: account.businessName,
            },
          });
        }
      }
    }

    // Sort by creation date (newest first)
    return allRules.sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  }

  /**
   * Get all notification rules for a saved account
   */
  async getRules(
    userId: string,
    savedAccountId: string,
  ): Promise<NotificationRuleResponse[]> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return [];
    }

    const rules = await this.prisma.notificationRule.findMany({
      where: { notificationSettingsId: settings.id },
      orderBy: { createdAt: 'desc' },
    });

    return rules.map(this.formatRule);
  }

  /**
   * Create a new notification rule
   */
  async createRule(
    userId: string,
    savedAccountId: string,
    data: CreateNotificationRuleDto,
  ): Promise<NotificationRuleResponse> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    // Ensure settings exist (enabled: true since individual rules have their own toggle)
    const settings = await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      create: { savedAccountId, enabled: true },
      update: { enabled: true },  // Auto-fix legacy records with enabled=false
    });

    const rule = await this.prisma.notificationRule.create({
      data: {
        notificationSettingsId: settings.id,
        name: data.name,
        triggerType: data.triggerType,
        replyTriggerMode: data.replyTriggerMode,
        fromPhone: data.fromPhone,
        toPhone: data.toPhone,
        template: data.template,
        enabled: data.enabled ?? true,
      },
    });

    this.logger.log(`Created notification rule: ${rule.id} - ${rule.name}`);
    return this.formatRule(rule);
  }

  /**
   * Update an existing notification rule
   */
  async updateRule(
    userId: string,
    savedAccountId: string,
    ruleId: string,
    data: UpdateNotificationRuleDto,
  ): Promise<NotificationRuleResponse> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      throw new NotFoundException('Settings not found');
    }

    const existing = await this.prisma.notificationRule.findFirst({
      where: { id: ruleId, notificationSettingsId: settings.id },
    });

    if (!existing) {
      throw new NotFoundException('Notification rule not found');
    }

    this.logger.log(`[updateRule] Updating rule ${ruleId} with data: ${JSON.stringify(data)}`);
    this.logger.log(`[updateRule] Previous enabled value: ${existing.enabled}`);

    const rule = await this.prisma.notificationRule.update({
      where: { id: ruleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
        ...(data.replyTriggerMode !== undefined && { replyTriggerMode: data.replyTriggerMode }),
        ...(data.fromPhone !== undefined && { fromPhone: data.fromPhone }),
        ...(data.toPhone !== undefined && { toPhone: data.toPhone }),
        ...(data.template !== undefined && { template: data.template }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
    });

    this.logger.log(`[updateRule] Updated rule ${rule.id}, new enabled: ${rule.enabled}`);
    return this.formatRule(rule);
  }

  /**
   * Delete a notification rule
   */
  async deleteRule(
    userId: string,
    savedAccountId: string,
    ruleId: string,
  ): Promise<void> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      throw new NotFoundException('Settings not found');
    }

    const existing = await this.prisma.notificationRule.findFirst({
      where: { id: ruleId, notificationSettingsId: settings.id },
    });

    if (!existing) {
      throw new NotFoundException('Notification rule not found');
    }

    await this.prisma.notificationRule.delete({
      where: { id: ruleId },
    });

    this.logger.log(`Deleted notification rule: ${ruleId}`);
  }

  // ==========================================
  // Notification Triggers
  // ==========================================

  /**
   * Send notification for a new lead
   * Called by webhook handler when a new lead is created
   * Uses rule-based system - finds all enabled "new_lead" rules and sends SMS for each
   */
  async sendLeadNotification(context: SendNotificationContext): Promise<void> {
    const { userId, savedAccountId, leadId, lead } = context;

    this.logger.log(`Checking notification rules for account ${savedAccountId}`);

    // Get settings for this account
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: {
        notificationRules: {
          where: { triggerType: 'new_lead', enabled: true },
        },
      },
    });

    if (!settings) {
      this.logger.log(`No notification settings for account ${savedAccountId}`);
      return;
    }

    if (!settings.enabled) {
      this.logger.log(`Notifications disabled for account ${savedAccountId}`);
      return;
    }

    if (!settings.callioApiKey) {
      this.logger.warn(`No Callio API key configured for account ${savedAccountId}`);
      return;
    }

    // Check if lead has phone (if required)
    if (settings.requirePhone && !lead.customerPhone) {
      this.logger.log(`Lead ${leadId} has no phone, skipping notification`);
      return;
    }

    // Check quiet hours
    if (this.isQuietHours(settings)) {
      this.logger.log(`Currently in quiet hours for account ${savedAccountId}`);
      return;
    }

    // Get enabled new_lead rules
    const rules = settings.notificationRules;

    // If no rules exist, check for legacy settings (backward compatibility)
    if (rules.length === 0) {
      // Only use legacy if destinationPhone is configured
      if (!settings.destinationPhone) {
        this.logger.log(`No new_lead rules and no legacy destination phone for account ${savedAccountId}`);
        return;
      }
      this.logger.log(`No new_lead rules found, using legacy template`);
      await this.sendNotificationWithRule(settings, null, context);
      return;
    }

    this.logger.log(`Found ${rules.length} new_lead rules`);

    // Send notification for each enabled rule
    for (const rule of rules) {
      await this.sendNotificationWithRule(settings, rule, context);
    }
  }

  /**
   * Handle customer reply event - sends SMS for "customer_reply" rules
   */
  async handleCustomerReply(context: CustomerReplyContext): Promise<void> {
    const { userId, savedAccountId, leadId, lead, isFirstCustomerReply, isSecondCustomerMessage } = context;

    this.logger.log(`Checking customer reply notification rules for account ${savedAccountId}`);

    // Skip the first customer message - only trigger on actual replies (2nd+ messages)
    if (isFirstCustomerReply) {
      this.logger.log(`Skipping first customer message - notifications only trigger on replies`);
      return;
    }

    // Get settings for this account
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: {
        notificationRules: {
          where: { triggerType: 'customer_reply', enabled: true },
        },
      },
    });

    if (!settings) {
      this.logger.log(`No notification settings for account ${savedAccountId}`);
      return;
    }

    if (!settings.enabled) {
      this.logger.log(`Notifications disabled for account ${savedAccountId}`);
      return;
    }

    if (!settings.callioApiKey) {
      this.logger.warn(`No Callio API key configured for account ${savedAccountId}`);
      return;
    }

    // Check quiet hours
    if (this.isQuietHours(settings)) {
      this.logger.log(`Currently in quiet hours for account ${savedAccountId}`);
      return;
    }

    const rules = settings.notificationRules;

    if (rules.length === 0) {
      this.logger.log(`No customer_reply rules for account ${savedAccountId}`);
      return;
    }

    this.logger.log(`Found ${rules.length} customer_reply rules`);

    for (const rule of rules) {
      // Check reply trigger mode
      if (rule.replyTriggerMode === 'first_only' && isSecondCustomerMessage !== true) {
        this.logger.log(`Skipping rule ${rule.id} - only triggers on first reply`);
        continue;
      }

      await this.sendNotificationWithRule(settings, rule, { userId, savedAccountId, leadId, lead });
    }
  }

  /**
   * Send a notification using a specific rule (or legacy template)
   */
  private async sendNotificationWithRule(
    settings: any,
    rule: any | null,
    context: SendNotificationContext,
  ): Promise<void> {
    const { userId, savedAccountId, leadId, lead } = context;

    // Use rule's phone numbers (required for new rules) or fallback to settings (legacy)
    const toPhone = rule?.toPhone || settings.destinationPhone;
    const fromPhone = rule?.fromPhone || settings.callioFromPhone;
    const template = rule?.template || settings.template;
    const ruleName = rule?.name || 'Legacy Alert';
    const ruleId = rule?.id || null;

    // Validate phone numbers
    if (!toPhone) {
      this.logger.warn(`No destination phone for rule ${ruleName}`);
      return;
    }

    // Render the message template
    const messageBody = this.renderTemplate(template, lead);

    this.logger.log(`Sending notification for rule: ${ruleName} from ${fromPhone} to ${toPhone}`);

    // Create notification log entry
    const logEntry = await this.prisma.notificationLog.create({
      data: {
        notificationSettingsId: settings.id,
        notificationRuleId: ruleId,
        ruleName: ruleName,
        leadId,
        toPhone: toPhone,
        fromPhone: fromPhone,
        status: 'pending',
        messageBody,
        metadata: JSON.stringify({ userId, savedAccountId, ruleId }),
      },
    });

    // Send via Callio
    try {
      const result = await this.sendViaCallio({
        to: toPhone,
        body: messageBody,
        fromPhone: fromPhone,
        apiKey: settings.callioApiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        callioWorkspaceId: settings.callioWorkspaceId,
        metadata: {
          tenantId: savedAccountId,
          leadId,
          ruleId,
          ruleName,
        },
      });

      // Update log with result
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: result.status,
          fromPhone: result.fromPhone,
          provider: result.provider,
          callioMessageId: result.messageId,
          callioConversationId: result.conversationId,
          sentAt: new Date(),
        },
      });

      // Update rule stats if applicable
      if (ruleId) {
        await this.prisma.notificationRule.update({
          where: { id: ruleId },
          data: {
            triggerCount: { increment: 1 },
            lastTriggeredAt: new Date(),
          },
        });
      }

      this.logger.log(`Notification sent for rule ${ruleName} to ${settings.destinationPhone}`);
    } catch (error: any) {
      // Update log with error
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: 'failed',
          error: error.message || 'Unknown error',
        },
      });

      this.logger.error(`Failed to send notification for rule ${ruleName}`, error);
    }
  }

  /**
   * Send test notification for a specific rule
   */
  async sendTestNotification(
    userId: string,
    savedAccountId: string,
    ruleId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Get full settings from database (not masked response)
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      return { success: false, error: 'Saved account not found' };
    }

    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return { success: false, error: 'Notification settings not configured' };
    }

    // Auto-fix legacy records where enabled was incorrectly set to false
    if (!settings.enabled) {
      settings = await this.prisma.notificationSettings.update({
        where: { id: settings.id },
        data: { enabled: true },
      });
      this.logger.log(`[sendTestNotification] Auto-fixed enabled=false for account ${savedAccountId}`);
    }

    if (!settings.callioApiKey) {
      return { success: false, error: 'No Callio API key configured. Please connect to Callio first.' };
    }

    // Get rule if specified
    let rule = null;
    if (ruleId) {
      rule = await this.prisma.notificationRule.findFirst({
        where: { id: ruleId, notificationSettingsId: settings.id },
      });
      if (!rule) {
        return { success: false, error: 'Rule not found' };
      }
    }

    // Use rule's phone numbers (preferred) or fallback to settings (legacy)
    const toPhone = rule?.toPhone || settings.destinationPhone;
    const fromPhone = rule?.fromPhone || settings.callioFromPhone;

    if (!toPhone) {
      return { success: false, error: 'No destination phone configured for this rule' };
    }

    const testLead = {
      customerName: 'Test Customer',
      customerPhone: '+15551234567',
      category: 'House Cleaning',
      city: 'Tampa',
      state: 'FL',
      postcode: '33602',
      message: 'I need my house cleaned weekly. Looking for someone reliable.',
      rawJson: JSON.stringify({
        request: {
          details: {
            serviceDescription: 'Weekly house cleaning service',
            addOns: ['Deep clean', 'Laundry'],
            frequency: 'Weekly',
          },
        },
      }),
    };

    const template = rule?.template || settings.template;
    const ruleName = rule?.name || 'Test';
    const messageBody = this.renderTemplate(template, testLead);

    // Create notification log entry
    const logEntry = await this.prisma.notificationLog.create({
      data: {
        notificationSettingsId: settings.id,
        notificationRuleId: rule?.id,
        ruleName: `[TEST] ${ruleName}`,
        toPhone: toPhone,
        fromPhone: fromPhone,
        status: 'pending',
        messageBody: `[TEST] ${messageBody}`,
        metadata: JSON.stringify({ test: true, ruleId: rule?.id }),
      },
    });

    try {
      const result = await this.sendViaCallio({
        to: toPhone,
        body: `[TEST] ${messageBody}`,
        fromPhone: fromPhone,
        apiKey: settings.callioApiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        callioWorkspaceId: settings.callioWorkspaceId,
        metadata: {
          tenantId: savedAccountId,
          test: true,
          ruleId: rule?.id,
        },
      });

      // Update log with success
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: result.status,
          fromPhone: result.fromPhone,
          provider: result.provider,
          callioMessageId: result.messageId,
          callioConversationId: result.conversationId,
          sentAt: new Date(),
        },
      });

      return { success: true };
    } catch (error: any) {
      // Update log with error
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: 'failed',
          error: error.message || 'Unknown error',
        },
      });

      return { success: false, error: error.message || 'Failed to send test notification' };
    }
  }

  /**
   * Render message template with lead data
   */
  private renderTemplate(
    template: string,
    lead: {
      customerName: string;
      customerPhone?: string | null;
      category?: string | null;
      city?: string | null;
      state?: string | null;
      postcode?: string | null;
      message?: string | null;
      rawJson?: string | null;
    },
  ): string {
    let message = template;

    // Replace basic variables
    message = message.replace(/\{\{lead\.name\}\}/gi, lead.customerName || 'Unknown');
    message = message.replace(/\{\{lead\.phone\}\}/gi, lead.customerPhone || 'Not provided');
    message = message.replace(/\{\{lead\.service\}\}/gi, lead.category || 'Not specified');

    const location = [lead.city, lead.state].filter(Boolean).join(', ') || 'Not specified';
    message = message.replace(/\{\{lead\.location\}\}/gi, location);

    // Replace new variables
    message = message.replace(/\{\{lead\.zip\}\}/gi, lead.postcode || 'Not provided');
    message = message.replace(/\{\{lead\.message\}\}/gi, lead.message || 'No message');

    // Parse rawJson for additional fields
    let serviceDescription = 'Not specified';
    let addons = 'None';
    let frequency = 'Not specified';

    if (lead.rawJson) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const request = raw.request || {};
        const details = request.details || [];

        // Details is an array of {question, answer} objects
        // Use the description field as service description
        if (request.description) {
          serviceDescription = request.description;
        }

        // Find specific answers from details array
        const cleaningTypeAnswer = this.findAnswerInDetails(details, ['Cleaning type', 'Type of cleaning', 'Service type']);
        if (cleaningTypeAnswer) {
          serviceDescription = cleaningTypeAnswer;
        }

        const addOnsAnswer = this.findAnswerInDetails(details, ['Add-ons', 'Additional services', 'Extras']);
        if (addOnsAnswer) {
          addons = addOnsAnswer;
        }

        const frequencyAnswer = this.findAnswerInDetails(details, ['Frequency', 'Service frequency', 'How often']);
        if (frequencyAnswer) {
          frequency = frequencyAnswer;
        }
      } catch (err) {
        // Failed to parse rawJson, use defaults
      }
    }

    message = message.replace(/\{\{lead\.serviceDescription\}\}/gi, serviceDescription);
    message = message.replace(/\{\{lead\.addons\}\}/gi, addons);
    message = message.replace(/\{\{lead\.frequency\}\}/gi, frequency);

    return message;
  }

  /**
   * Check if current time is within quiet hours
   */
  private isQuietHours(settings: {
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
    quietHoursTimezone: string | null;
  }): boolean {
    if (!settings.quietHoursStart || !settings.quietHoursEnd) {
      return false;
    }

    try {
      const timezone = settings.quietHoursTimezone || 'America/New_York';
      const now = new Date();

      // Get current time in the specified timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentTime = formatter.format(now);

      const [startHour, startMin] = settings.quietHoursStart.split(':').map(Number);
      const [endHour, endMin] = settings.quietHoursEnd.split(':').map(Number);
      const [currentHour, currentMin] = currentTime.split(':').map(Number);

      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;
      const currentMinutes = currentHour * 60 + currentMin;

      // Handle overnight quiet hours (e.g., 22:00 to 08:00)
      if (startMinutes > endMinutes) {
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }

      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } catch {
      return false;
    }
  }

  /**
   * Fetch phone numbers from Callio API
   */
  async getCallioPhoneNumbers(
    userId: string,
    savedAccountId: string,
  ): Promise<CallioPhoneNumber[]> {
    // Verify the account belongs to the user and get settings
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      throw new NotFoundException('Saved account not found');
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings?.callioApiKey) {
      return [];
    }

    try {
      const endpoint = 'https://callio-production-47ac.up.railway.app/api/v1/phone-numbers';
      this.logger.log(`[getPhoneNumbers] Hitting endpoint: ${endpoint}`);

      const response = await fetch(
        endpoint,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${settings.callioApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log(`[getPhoneNumbers] Response status: ${response.status}`);

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`[getPhoneNumbers] Callio API error: ${response.status} - ${error}`);
        throw new Error(`Failed to fetch phone numbers: ${response.status}`);
      }

      const result = await response.json();
      this.logger.log(`Callio phone numbers response: ${JSON.stringify(result)}`);

      // Handle different response formats from Callio API
      const phones = result.data || result.phoneNumbers || result || [];
      this.logger.log(`Raw phones array (getPhoneNumbers): ${JSON.stringify(phones)}`);

      return phones
        .map((phone: any) => this.mapCallioPhoneNumber(phone))
        .filter((p: any) => p.phoneNumber && p.phoneNumber.length > 5);
    } catch (error: any) {
      this.logger.error('Failed to fetch Callio phone numbers', error);
      throw new Error(error.message || 'Failed to connect to Callio');
    }
  }

  /**
   * Map Callio API phone response to CallioPhoneNumber interface
   */
  private mapCallioPhoneNumber(phone: any): CallioPhoneNumber {
    const phoneNumber = phone.phoneNumber || phone.phone_number || phone.number || phone.e164;
    const a2p = phone.a2pCompliance || phone.a2p || {};
    const caps = phone.capabilities || {};

    // Map Callio campaignStatus to our a2pStatus
    let a2pStatus: string | undefined;
    const campaignStatus = a2p.campaignStatus || a2p.status || a2p.a2pStatus || phone.a2pStatus;
    if (campaignStatus) {
      switch (campaignStatus.toUpperCase()) {
        case 'VERIFIED':
        case 'APPROVED':
          a2pStatus = 'approved';
          break;
        case 'PENDING':
        case 'IN_PROGRESS':
          a2pStatus = 'pending';
          break;
        case 'REJECTED':
        case 'FAILED':
          a2pStatus = 'rejected';
          break;
        case 'NOT_REGISTERED':
          a2pStatus = a2p.isRegistered === false ? 'not_required' : 'pending';
          break;
        default:
          a2pStatus = campaignStatus.toLowerCase();
      }
    }

    return {
      id: phone.id || phone._id || phoneNumber || String(Math.random()),
      phoneNumber: phoneNumber,
      provider: phone.provider || phone.carrier || phone.type || 'unknown',
      friendlyName: phone.friendlyName || phone.friendly_name || phone.name || phone.label || '',
      capabilities: Array.isArray(caps) ? caps : Object.keys(caps).filter(k => caps[k]),
      // A2P Compliance
      a2pStatus,
      a2pBrandId: a2p.brandId || a2p.brand_id,
      a2pCampaignId: a2p.campaignId || a2p.campaign_id || a2p.messagingServiceSid,
      // Capabilities as booleans
      smsEnabled: caps.sms ?? caps.SMS ?? phone.smsEnabled ?? true,
      mmsEnabled: caps.mms ?? caps.MMS ?? phone.mmsEnabled ?? false,
      voiceEnabled: caps.voice ?? caps.Voice ?? phone.voiceEnabled ?? true,
    };
  }

  /**
   * Validate Callio API key by attempting to fetch phone numbers
   */
  async validateCallioApiKey(apiKey: string): Promise<{ valid: boolean; phoneNumbers: CallioPhoneNumber[] }> {
    const endpoint = 'https://callio-production-47ac.up.railway.app/api/v1/phone-numbers';
    this.logger.log(`[validateCallioApiKey] Hitting endpoint: ${endpoint}`);

    try {
      const response = await fetch(
        endpoint,
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      this.logger.log(`[validateCallioApiKey] Response status: ${response.status}`);

      if (!response.ok) {
        this.logger.error(`[validateCallioApiKey] Failed with status: ${response.status}`);
        return { valid: false, phoneNumbers: [] };
      }

      const result = await response.json();
      this.logger.log(`Callio validate response: ${JSON.stringify(result)}`);

      // Handle different response formats from Callio API
      const phones = result.data || result.phoneNumbers || result || [];
      this.logger.log(`Raw phones array: ${JSON.stringify(phones)}`);

      const phoneNumbers = phones
        .map((phone: any) => {
          this.logger.log(`Mapping phone: ${JSON.stringify(phone)}`);
          return this.mapCallioPhoneNumber(phone);
        })
        .filter((p: any) => {
          const valid = p.phoneNumber && p.phoneNumber.length > 5;
          if (!valid) {
            this.logger.log(`Filtered out invalid phone: ${JSON.stringify(p)}`);
          }
          return valid;
        });

      this.logger.log(`Final phoneNumbers: ${JSON.stringify(phoneNumbers)}`);
      return { valid: true, phoneNumbers };
    } catch {
      return { valid: false, phoneNumbers: [] };
    }
  }

  /**
   * Create a webhook subscription in Callio for delivery status updates
   */
  async createCallioWebhook(apiKey: string, webhookUrl: string): Promise<{ webhookId: string | null; error?: string }> {
    const endpoint = 'https://callio-production-47ac.up.railway.app/api/v1/webhook-subscriptions';
    this.logger.log(`[createCallioWebhook] Creating webhook subscription at: ${endpoint}`);
    this.logger.log(`[createCallioWebhook] Webhook URL: ${webhookUrl}`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'LeadBridge Delivery Status',
          webhookUrl: webhookUrl,
          events: ['message.sent', 'message.delivered', 'message.failed'],
        }),
      });

      this.logger.log(`[createCallioWebhook] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[createCallioWebhook] Failed: ${response.status} - ${errorText}`);
        return { webhookId: null, error: `Failed to create webhook: ${response.status}` };
      }

      const result = await response.json();
      this.logger.log(`[createCallioWebhook] Result: ${JSON.stringify(result)}`);

      const webhookId = result.data?.id || result.id || result.subscriptionId;
      return { webhookId };
    } catch (error: any) {
      this.logger.error('[createCallioWebhook] Error:', error.message);
      return { webhookId: null, error: error.message };
    }
  }

  /**
   * Delete a webhook subscription from Callio
   */
  async deleteCallioWebhook(apiKey: string, webhookId: string): Promise<{ success: boolean; error?: string }> {
    const endpoint = `https://callio-production-47ac.up.railway.app/api/v1/webhook-subscriptions/${webhookId}`;
    this.logger.log(`[deleteCallioWebhook] Deleting webhook subscription: ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      });

      this.logger.log(`[deleteCallioWebhook] Response status: ${response.status}`);

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        this.logger.error(`[deleteCallioWebhook] Failed: ${response.status} - ${errorText}`);
        return { success: false, error: `Failed to delete webhook: ${response.status}` };
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error('[deleteCallioWebhook] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Connect to Callio - validates API key, creates webhook, and stores settings
   */
  async connectCallio(
    savedAccountId: string,
    apiKey: string,
    webhookBaseUrl: string,
  ): Promise<{ success: boolean; phoneNumbers: CallioPhoneNumber[]; error?: string }> {
    this.logger.log(`[connectCallio] Connecting account ${savedAccountId}`);

    // 1. Validate the API key
    const validation = await this.validateCallioApiKey(apiKey);
    if (!validation.valid) {
      return { success: false, phoneNumbers: [], error: 'Invalid API key' };
    }

    // 2. Create webhook for delivery status
    const webhookUrl = `${webhookBaseUrl}/api/webhooks/callio/delivery-status`;
    const webhookResult = await this.createCallioWebhook(apiKey, webhookUrl);

    if (webhookResult.error) {
      this.logger.warn(`[connectCallio] Webhook creation failed: ${webhookResult.error}`);
      // Continue anyway - webhook can be created manually later
    }

    // 3. Store the API key and webhook ID
    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        callioApiKey: apiKey,
        callioWebhookId: webhookResult.webhookId,
        enabled: true,  // Ensure notifications are enabled when connecting
      },
      create: {
        savedAccountId,
        callioApiKey: apiKey,
        callioWebhookId: webhookResult.webhookId,
        enabled: true,
      },
    });

    this.logger.log(`[connectCallio] Connected successfully. WebhookId: ${webhookResult.webhookId}`);
    return { success: true, phoneNumbers: validation.phoneNumbers };
  }

  /**
   * Disconnect from Callio - deletes webhook and clears settings
   */
  async disconnectCallio(savedAccountId: string): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`[disconnectCallio] Disconnecting account ${savedAccountId}`);

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return { success: true }; // Already disconnected
    }

    // Delete webhook if exists
    if (settings.callioApiKey && settings.callioWebhookId) {
      const deleteResult = await this.deleteCallioWebhook(settings.callioApiKey, settings.callioWebhookId);
      if (!deleteResult.success) {
        this.logger.warn(`[disconnectCallio] Failed to delete webhook: ${deleteResult.error}`);
      }
    }

    // Clear Callio settings
    await this.prisma.notificationSettings.update({
      where: { savedAccountId },
      data: {
        callioApiKey: null,
        callioFromPhone: null,
        callioWebhookId: null,
      },
    });

    this.logger.log(`[disconnectCallio] Disconnected successfully`);
    return { success: true };
  }

  /**
   * Send message via Callio API
   */
  private async sendViaCallio(params: {
    to: string;
    body: string;
    fromPhone?: string | null;
    apiKey: string;
    senderMode: 'shared' | 'dedicated' | 'openphone';
    callioWorkspaceId?: string | null;
    metadata: Record<string, any>;
  }): Promise<{
    status: string;
    messageId?: string;
    conversationId?: string;
    provider?: string;
    fromPhone?: string;
  }> {
    this.logger.log(`Sending via Callio to: ${params.to}`);

    const requestBody: any = {
      to: params.to,
      body: params.body,
      channel: 'sms',
      metadata: params.metadata,
    };

    // Set sender configuration - mode must be: shared, dedicated, or openphone
    requestBody.sender = {
      mode: params.senderMode || 'shared',
    };

    // If a specific phone number is selected, include it (must be valid phone number)
    if (params.fromPhone && params.fromPhone.length > 5 && params.fromPhone.match(/^\+?\d{10,}/)) {
      requestBody.sender.fromNumber = params.fromPhone;
    }

    const endpoint = 'https://callio-production-47ac.up.railway.app/api/v1/messages/send';
    this.logger.log(`[sendViaCallio] Hitting endpoint: ${endpoint}`);
    this.logger.log(`[sendViaCallio] Request body: ${JSON.stringify(requestBody)}`);

    try {
      const response = await fetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );

      this.logger.log(`[sendViaCallio] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[sendViaCallio] Callio API error: ${response.status} - ${errorText}`);
        throw new Error(`Callio API error: ${response.status}`);
      }

      const result = await response.json();
      const data = result.data || {};

      this.logger.log(`SMS sent via Callio: ${data.messageId}`);

      return {
        status: data.status || 'sent',
        messageId: data.messageId,
        conversationId: data.conversationId,
        provider: data.provider,
        fromPhone: data.fromNumber,
      };
    } catch (error: any) {
      this.logger.error('Failed to send via Callio', error);
      throw new Error(error.message || 'Failed to send message via Callio');
    }
  }

  /**
   * Format settings for response
   * API key is masked for security
   */
  private formatSettings(settings: any): NotificationSettingsResponse {
    // Mask API key - show only last 4 characters
    let maskedApiKey: string | null = null;
    if (settings.callioApiKey) {
      const key = settings.callioApiKey;
      maskedApiKey = key.length > 4 ? `****${key.slice(-4)}` : '****';
    }

    return {
      id: settings.id,
      savedAccountId: settings.savedAccountId,
      enabled: settings.enabled,
      destinationPhone: settings.destinationPhone,
      senderMode: settings.senderMode,
      callioApiKey: maskedApiKey,
      callioFromPhone: settings.callioFromPhone,
      callioWorkspaceId: settings.callioWorkspaceId,
      callioConnected: !!settings.callioApiKey,
      template: settings.template,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      quietHoursTimezone: settings.quietHoursTimezone,
      requirePhone: settings.requirePhone,
      createdAt: settings.createdAt.toISOString(),
      updatedAt: settings.updatedAt.toISOString(),
    };
  }

  /**
   * Format log for response
   */
  private formatLog(log: any): NotificationLogResponse {
    return {
      id: log.id,
      leadId: log.leadId,
      notificationRuleId: log.notificationRuleId,
      ruleName: log.ruleName,
      toPhone: log.toPhone,
      fromPhone: log.fromPhone,
      provider: log.provider,
      status: log.status,
      error: log.error,
      messageBody: log.messageBody,
      createdAt: log.createdAt.toISOString(),
      sentAt: log.sentAt?.toISOString() || null,
      deliveredAt: log.deliveredAt?.toISOString() || null,
    };
  }

  /**
   * Format rule for response
   */
  private formatRule(rule: any): NotificationRuleResponse {
    return {
      id: rule.id,
      notificationSettingsId: rule.notificationSettingsId,
      name: rule.name,
      triggerType: rule.triggerType,
      replyTriggerMode: rule.replyTriggerMode,
      fromPhone: rule.fromPhone,
      toPhone: rule.toPhone,
      template: rule.template,
      enabled: rule.enabled,
      triggerCount: rule.triggerCount,
      lastTriggeredAt: rule.lastTriggeredAt?.toISOString() || null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    };
  }

  /**
   * Helper to find an answer from details array by question
   */
  private findAnswerInDetails(details: any[], questionVariants: string[]): string | null {
    if (!Array.isArray(details)) return null;

    for (const item of details) {
      if (item.question && item.answer) {
        const question = String(item.question).toLowerCase();
        for (const variant of questionVariants) {
          if (question.includes(variant.toLowerCase())) {
            return String(item.answer);
          }
        }
      }
    }
    return null;
  }
}
