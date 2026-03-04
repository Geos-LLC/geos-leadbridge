/**
 * Notifications Service
 * Manages SMS notification settings and sends notifications via Sigcore
 */

import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';

export interface UpdateNotificationSettingsDto {
  enabled?: boolean;
  destinationPhone?: string;
  senderMode?: 'shared' | 'dedicated' | 'openphone';
  sigcoreApiKey?: string;
  sigcoreFromPhone?: string;
  sigcoreWorkspaceId?: string;
  template?: string;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  quietHoursTimezone?: string;
  requirePhone?: boolean;
  smsForwardingNumber?: string | null;
  callForwardingNumber?: string | null;
}

// Notification Rule DTOs
export interface CreateNotificationRuleDto {
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone: string; // Sigcore phone number to send FROM
  toPhone: string;   // Destination phone number to send TO
  sendToCustomer?: boolean; // If true, send to lead's phone instead of toPhone
  template: string;
  templateId?: string; // Optional link to MessageTemplate
  delayMinutes?: number; // Delay before sending (0 = immediate)
  stopOnCustomerReply?: boolean;
  stopOnLeadClosed?: boolean;
  stopOnOptOut?: boolean;
  enabled?: boolean;
}

export interface UpdateNotificationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  fromPhone?: string;
  toPhone?: string;
  sendToCustomer?: boolean;
  template?: string;
  templateId?: string;
  delayMinutes?: number;
  stopOnCustomerReply?: boolean;
  stopOnLeadClosed?: boolean;
  stopOnOptOut?: boolean;
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
  sendToCustomer: boolean;
  template: string;
  templateId: string | null;
  delayMinutes: number;
  stopOnCustomerReply: boolean;
  stopOnLeadClosed: boolean;
  stopOnOptOut: boolean;
  messageTemplate: { id: string; name: string; content: string } | null;
  enabled: boolean;
  triggerCount: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Last SMS delivery status
  lastSmsStatus: string | null; // 'sent' | 'delivered' | 'failed' | 'pending' | 'queued' | null
  lastSmsError: string | null;
  lastSmsAt: string | null;
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
  accountName?: string;
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

export interface SigcorePhoneNumber {
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
  sigcoreApiKey: string | null; // Will be masked in response
  sigcoreFromPhone: string | null;
  sigcoreWorkspaceId: string | null;
  sigcoreConnected: boolean; // Whether provider is connected and tenant is provisioned
  sigcoreProvisioned: boolean; // Whether Sigcore tenant has been provisioned for this account
  sigcoreProvider: string | null; // 'openphone' | 'twilio' | null
  template: string;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursTimezone: string | null;
  requirePhone: boolean;
  smsForwardingNumber: string | null;
  callForwardingNumber: string | null;
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
  accountName?: string;
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

  private readonly appSigcoreApiKey: string;

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    this.appSigcoreApiKey = this.configService.get<string>('SIGCORE_API_KEY', '');
  }

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

    // Validate sigcoreFromPhone ownership — prevent setting another user's number
    if (data.sigcoreFromPhone) {
      const ownsPhone = await this.validatePhoneOwnership(userId, data.sigcoreFromPhone);
      if (!ownsPhone) {
        throw new BadRequestException('Phone number does not belong to this account');
      }
    }

    const settings = await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      create: {
        savedAccountId,
        enabled: data.enabled ?? true,  // Default to enabled (rules have their own toggle)
        destinationPhone: data.destinationPhone,
        senderMode: data.senderMode ?? 'shared',
        sigcoreApiKey: data.sigcoreApiKey,
        sigcoreFromPhone: data.sigcoreFromPhone,
        sigcoreWorkspaceId: data.sigcoreWorkspaceId,
        template: data.template ?? 'New lead: {{lead.name}}, Price {{lead.price}}\nLocation: {{lead.location}}, {{lead.zip}}\nService: {{lead.service}} {{lead.bedrooms}} bed /{{lead.bathrooms}} bath\nFrequency: {{lead.frequency}}\nDescription: {{lead.serviceDescription}}\nAdd-ons: {{lead.addons}}\nPets: {{lead.pets}}\nMessage: {{lead.message}}\nPhone: {{lead.phone}}',
        quietHoursStart: data.quietHoursStart,
        quietHoursEnd: data.quietHoursEnd,
        quietHoursTimezone: data.quietHoursTimezone ?? 'America/New_York',
        requirePhone: data.requirePhone ?? true,
        smsForwardingNumber: data.smsForwardingNumber,
        callForwardingNumber: data.callForwardingNumber,
      },
      update: {
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.destinationPhone !== undefined && { destinationPhone: data.destinationPhone }),
        ...(data.senderMode !== undefined && { senderMode: data.senderMode }),
        ...(data.sigcoreApiKey !== undefined && { sigcoreApiKey: data.sigcoreApiKey }),
        ...(data.sigcoreFromPhone !== undefined && { sigcoreFromPhone: data.sigcoreFromPhone }),
        ...(data.sigcoreWorkspaceId !== undefined && { sigcoreWorkspaceId: data.sigcoreWorkspaceId }),
        ...(data.template !== undefined && { template: data.template }),
        ...(data.quietHoursStart !== undefined && { quietHoursStart: data.quietHoursStart }),
        ...(data.quietHoursEnd !== undefined && { quietHoursEnd: data.quietHoursEnd }),
        ...(data.quietHoursTimezone !== undefined && { quietHoursTimezone: data.quietHoursTimezone }),
        ...(data.requirePhone !== undefined && { requirePhone: data.requirePhone }),
        ...(data.smsForwardingNumber !== undefined && { smsForwardingNumber: data.smsForwardingNumber }),
        ...(data.callForwardingNumber !== undefined && { callForwardingNumber: data.callForwardingNumber }),
      },
    });

    // Sync call forwarding number to Sigcore tenant metadata
    if (data.callForwardingNumber !== undefined && settings.sigcoreTenantId) {
      this.syncCallForwardingToSigcore(settings.sigcoreTenantId, data.callForwardingNumber).catch(err => {
        this.logger.warn(`[upsertSettings] Failed to sync callForwardingNumber to Sigcore: ${err.message}`);
      });
    }

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

  /**
   * Get notification logs for a specific lead across all accounts
   * Used by the unified timeline in Messages page
   */
  async getLogsByLead(
    userId: string,
    leadId: string,
    limit: number = 50,
  ): Promise<NotificationLogResponse[]> {
    // Verify the lead belongs to the user
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId },
    });

    if (!lead) {
      throw new NotFoundException('Lead not found');
    }

    const logs = await this.prisma.notificationLog.findMany({
      where: { leadId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    return logs.map(this.formatLog);
  }

  /**
   * Send an ad-hoc SMS message to a lead's customer
   * Called from Messages page when user selects SMS channel
   */
  async sendAdHocSms(
    userId: string,
    savedAccountId: string,
    leadId: string,
    messageBody: string,
  ): Promise<{ success: boolean; error?: string; logId?: string }> {
    // 1. Verify account belongs to user
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });
    if (!account) {
      return { success: false, error: 'Account not found' };
    }

    // 2. Get the lead and verify it belongs to user
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, userId },
    });
    if (!lead) {
      return { success: false, error: 'Lead not found' };
    }
    if (!lead.customerPhone) {
      return { success: false, error: 'Lead has no phone number' };
    }

    // 3. Get notification settings for this account (need API key and fromPhone)
    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    // Fallback: copy API credentials (not fromPhone) from another account of the same user
    if (!settings || !settings.sigcoreApiKey) {
      const fallback = await this.prisma.notificationSettings.findFirst({
        where: {
          savedAccount: { userId },
          sigcoreApiKey: { not: null },
        },
      });
      if (fallback) {
        // Use fallback credentials but keep original fromPhone to avoid cross-account contamination
        const originalFromPhone = settings?.sigcoreFromPhone || null;
        settings = fallback;
        if (originalFromPhone) {
          (settings as any).sigcoreFromPhone = originalFromPhone;
        }
      }
    }

    if (!settings) {
      return { success: false, error: 'No SMS settings configured. Set up SMS in Notification Settings.' };
    }

    const apiKey = settings.sigcoreApiKey;
    if (!apiKey) {
      return { success: false, error: 'No Sigcore API key configured. Please provision your phone workspace first.' };
    }

    // Resolve fromPhone: settings phone or any pool phone (pool numbers are shared)
    let fromPhone = settings.sigcoreFromPhone;
    if (!fromPhone) {
      const poolPhone = await this.prisma.phonePool.findFirst({
        where: { status: { not: 'RELEASED' } },
        orderBy: { provisionedAt: 'desc' },
      });
      if (poolPhone) fromPhone = poolPhone.phoneNumber;
    }

    // 4. Create log entry
    const logEntry = await this.prisma.notificationLog.create({
      data: {
        notificationSettingsId: settings.id,
        notificationRuleId: null,
        ruleName: 'Manual SMS',
        leadId,
        toPhone: lead.customerPhone,
        fromPhone,
        status: 'pending',
        messageBody,
        metadata: JSON.stringify({ userId, savedAccountId, manual: true }),
      },
    });

    // 5. Send via Sigcore
    try {
      const result = await this.sendViaSigcore({
        to: lead.customerPhone,
        body: messageBody,
        fromPhone,
        apiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        sigcoreProvider: settings.sigcoreProvider,
        sigcoreWorkspaceId: settings.sigcoreWorkspaceId,
        metadata: {
          tenantId: savedAccountId,
          leadId,
          manual: true,
        },
      });

      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: result.status,
          fromPhone: result.fromPhone,
          provider: result.provider,
          sigcoreMessageId: result.messageId,
          sigcoreConversationId: result.conversationId,
          sentAt: new Date(),
        },
      });

      // Store ad-hoc SMS as a Message record in the Conversation
      if (lead.threadId) {
        try {
          await this.prisma.message.create({
            data: {
              conversationId: lead.threadId,
              userId: lead.userId,
              platform: 'sms',
              externalMessageId: result.messageId || `sms-adhoc-${logEntry.id}`,
              sender: 'pro',
              content: messageBody,
              isRead: true,
              sentAt: new Date(),
              notificationLogId: logEntry.id,
            },
          });
          await this.prisma.conversation.update({
            where: { id: lead.threadId },
            data: { lastMessageAt: new Date() },
          });
        } catch (err: any) {
          this.logger.warn(`Failed to store ad-hoc SMS as Message: ${err.message}`);
        }
      }

      return { success: true, logId: logEntry.id };
    } catch (error: any) {
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: { status: 'failed', error: error.message || 'Unknown error' },
      });
      return { success: false, error: error.message, logId: logEntry.id };
    }
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
              include: {
                messageTemplate: true,
                notificationLogs: {
                  orderBy: { createdAt: 'desc' },
                  take: 1,
                },
              },
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
      include: {
        messageTemplate: true,
        notificationLogs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    return rules.map(r => this.formatRule(r));
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
    // If creating new settings, auto-copy sigcoreApiKey from user's other accounts
    let existingSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!existingSettings) {
      // Provision a dedicated Sigcore tenant for this account.
      // Each account gets its own workspace so Call Connect settings, phone numbers,
      // and webhooks are isolated — no cross-account contamination.
      try {
        await this.ensureSigcoreTenantProvisioned(userId, savedAccountId);
        this.logger.log(`[createRule] Provisioned dedicated Sigcore tenant for account ${savedAccountId}`);
      } catch (err: any) {
        this.logger.warn(`[createRule] Sigcore tenant provisioning failed (will create basic settings): ${err.message}`);
      }

      existingSettings = await this.prisma.notificationSettings.findUnique({
        where: { savedAccountId },
      });

      if (!existingSettings) {
        existingSettings = await this.prisma.notificationSettings.create({
          data: { savedAccountId, enabled: true },
        });
      }

      // Copy user preferences (provider, senderMode) from another account — but NOT credentials.
      // Credentials are per-tenant from provisioning above.
      const otherSettings = await this.prisma.notificationSettings.findFirst({
        where: {
          savedAccount: { userId },
          NOT: { savedAccountId },
        },
        select: { sigcoreProvider: true, senderMode: true },
      });

      if (otherSettings?.sigcoreProvider || otherSettings?.senderMode) {
        existingSettings = await this.prisma.notificationSettings.update({
          where: { savedAccountId },
          data: {
            enabled: true,
            ...(otherSettings.sigcoreProvider && { sigcoreProvider: otherSettings.sigcoreProvider }),
            ...(otherSettings.senderMode && { senderMode: otherSettings.senderMode }),
          },
        });
      }
    } else if (existingSettings.sigcoreTenantId) {
      // Re-provision if this account shares a tenant with another account (self-heal)
      const sharedCount = await this.prisma.notificationSettings.count({
        where: {
          sigcoreTenantId: existingSettings.sigcoreTenantId,
          NOT: { savedAccountId },
        },
      });
      if (sharedCount > 0) {
        try {
          await this.ensureSigcoreTenantProvisioned(userId, savedAccountId);
          this.logger.log(`[createRule] Re-provisioned shared tenant for account ${savedAccountId}`);
        } catch (err: any) {
          this.logger.warn(`[createRule] Sigcore re-provisioning failed: ${err.message}`);
        }
      }
    } else if (!existingSettings.enabled) {
      existingSettings = await this.prisma.notificationSettings.update({
        where: { savedAccountId },
        data: { enabled: true },
      });
    }

    const settings = existingSettings;

    // Validate fromPhone ownership — prevent setting another user's number
    if (data.fromPhone) {
      const ownsPhone = await this.validatePhoneOwnership(userId, data.fromPhone);
      if (!ownsPhone) {
        throw new BadRequestException('Phone number does not belong to this account');
      }
    }

    const rule = await this.prisma.notificationRule.create({
      data: {
        notificationSettingsId: settings.id,
        name: data.name,
        triggerType: data.triggerType,
        replyTriggerMode: data.replyTriggerMode,
        fromPhone: data.fromPhone,
        toPhone: data.toPhone,
        sendToCustomer: data.sendToCustomer ?? false,
        template: data.template,
        templateId: data.templateId || null,
        delayMinutes: data.delayMinutes ?? 0,
        stopOnCustomerReply: data.stopOnCustomerReply ?? true,
        stopOnLeadClosed: data.stopOnLeadClosed ?? true,
        stopOnOptOut: data.stopOnOptOut ?? true,
        enabled: data.enabled ?? true,
      },
      include: {
        messageTemplate: true,
        notificationLogs: {
          orderBy: { createdAt: 'desc' as const },
          take: 1,
        },
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

    // Re-provision if this account still shares a Sigcore tenant with another account
    // (from the old auto-copy logic). This self-heals on any rule save.
    if (settings.sigcoreTenantId) {
      const sharedCount = await this.prisma.notificationSettings.count({
        where: {
          sigcoreTenantId: settings.sigcoreTenantId,
          NOT: { savedAccountId },
        },
      });
      if (sharedCount > 0) {
        try {
          await this.ensureSigcoreTenantProvisioned(userId, savedAccountId);
          this.logger.log(`[updateRule] Re-provisioned shared tenant for account ${savedAccountId}`);
        } catch (err: any) {
          this.logger.warn(`[updateRule] Sigcore re-provisioning failed: ${err.message}`);
        }
      }
    }

    const existing = await this.prisma.notificationRule.findFirst({
      where: { id: ruleId, notificationSettingsId: settings.id },
    });

    if (!existing) {
      throw new NotFoundException('Notification rule not found');
    }

    this.logger.log(`[updateRule] Updating rule ${ruleId} with data: ${JSON.stringify(data)}`);
    this.logger.log(`[updateRule] Previous enabled value: ${existing.enabled}`);

    // Validate fromPhone ownership — prevent setting another user's number
    if (data.fromPhone) {
      const ownsPhone = await this.validatePhoneOwnership(userId, data.fromPhone);
      if (!ownsPhone) {
        throw new BadRequestException('Phone number does not belong to this account');
      }
    }

    const rule = await this.prisma.notificationRule.update({
      where: { id: ruleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
        ...(data.replyTriggerMode !== undefined && { replyTriggerMode: data.replyTriggerMode }),
        ...(data.fromPhone !== undefined && { fromPhone: data.fromPhone }),
        ...(data.toPhone !== undefined && { toPhone: data.toPhone }),
        ...(data.sendToCustomer !== undefined && { sendToCustomer: data.sendToCustomer }),
        ...(data.template !== undefined && { template: data.template }),
        ...(data.templateId !== undefined && { templateId: data.templateId || null }),
        ...(data.delayMinutes !== undefined && { delayMinutes: data.delayMinutes }),
        ...(data.stopOnCustomerReply !== undefined && { stopOnCustomerReply: data.stopOnCustomerReply }),
        ...(data.stopOnLeadClosed !== undefined && { stopOnLeadClosed: data.stopOnLeadClosed }),
        ...(data.stopOnOptOut !== undefined && { stopOnOptOut: data.stopOnOptOut }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
      },
      include: {
        messageTemplate: true,
        notificationLogs: {
          orderBy: { createdAt: 'desc' as const },
          take: 1,
        },
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
   *
   * Fallback logic: If no account-specific settings exist, uses user-level default settings
   */
  async sendLeadNotification(context: SendNotificationContext): Promise<void> {
    const { userId, savedAccountId, leadId, lead } = context;

    this.logger.log(`Checking notification rules for account ${savedAccountId}`);

    // First try to get account-specific settings
    const notifRuleInclude = {
      notificationRules: {
        where: { triggerType: 'new_lead', enabled: true },
        include: { messageTemplate: true },
      },
    };

    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: notifRuleInclude,
    });

    // Fallback: If no account-specific settings, try user-level default settings
    if (!settings) {
      this.logger.log(`No account-specific settings for ${savedAccountId}, checking user-level defaults for user ${userId}`);
      settings = await this.prisma.notificationSettings.findFirst({
        where: {
          userId: userId,
          savedAccountId: null,
        },
        include: notifRuleInclude,
      });

      if (settings) {
        this.logger.log(`Using user-level default settings for user ${userId}`);
      }
    } else {
      this.logger.log(`Using account-specific settings for ${savedAccountId} (enabled: ${settings.enabled}, sigcoreApiKey: ${settings.sigcoreApiKey ? 'set' : 'NOT SET'}, rules: ${settings.notificationRules.length})`);
    }

    // NOTE: Previously had a Fallback 2 that used settings from another account of the same user.
    // This caused cross-account contamination (e.g., Lavanda Cleaning receiving Spotless Homes leads).
    // Each account must use its own settings — no cross-account fallback.

    if (!settings) {
      this.logger.warn(`No notification settings found for account ${savedAccountId} or user ${userId}. SMS alerts not configured for this account.`);
      return;
    }

    if (!settings.enabled) {
      this.logger.log(`Notifications disabled for account ${savedAccountId}`);
      return;
    }

    if (!settings.sigcoreApiKey) {
      this.logger.warn(`No Sigcore API key configured for account ${savedAccountId}. Provision Sigcore workspace in SMS Alerts settings.`);
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

    // Filter out follow-up rules (delayMinutes > 0) — only immediate rules should fire
    const immediateRules = rules.filter(r => !r.delayMinutes || r.delayMinutes <= 0);
    const skippedCount = rules.length - immediateRules.length;
    this.logger.log(`Found ${rules.length} new_lead rules (${immediateRules.length} immediate, ${skippedCount} follow-ups skipped)`);

    for (const rule of immediateRules) {
      await this.sendNotificationWithRule(settings, rule, context);
    }
  }

  /**
   * Forward an inbound SMS to the tenant's configured forwarding number (e.g. OpenPhone).
   * No-ops if no forwarding number is configured.
   */
  async forwardInboundSms(
    savedAccountId: string,
    customerName: string,
    fromNumber: string,
    body: string,
  ): Promise<void> {
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });
    if (!settings?.smsForwardingNumber || !settings.sigcoreApiKey) return;

    const fromPhone = settings.sigcoreFromPhone;
    if (!fromPhone) {
      this.logger.warn(`[forwardInboundSms] No fromPhone configured for account ${savedAccountId}`);
      return;
    }

    const forwardBody = `SMS from ${customerName} (${fromNumber}):\n${body}`;
    this.logger.log(`[forwardInboundSms] Forwarding to ${settings.smsForwardingNumber} for account ${savedAccountId}`);

    await this.sendViaSigcore({
      to: settings.smsForwardingNumber,
      body: forwardBody,
      fromPhone,
      apiKey: settings.sigcoreApiKey,
      senderMode: (settings.senderMode as 'shared' | 'dedicated' | 'openphone') || 'dedicated',
      sigcoreProvider: settings.sigcoreProvider,
      sigcoreWorkspaceId: settings.sigcoreWorkspaceId,
      metadata: { type: 'sms_forwarding', savedAccountId },
    });
  }

  /**
   * Sync callForwardingNumber to the Sigcore tenant's metadata so incoming calls
   * can be forwarded without LeadBridge being in the loop.
   */
  private async syncCallForwardingToSigcore(
    sigcoreTenantId: string,
    callForwardingNumber: string | null,
  ): Promise<void> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) return;

    const resp = await fetch(`${sigcoreUrl}/tenants/${sigcoreTenantId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': platformKey,
      },
      body: JSON.stringify({
        metadata: { callForwardingNumber: callForwardingNumber || null },
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore tenant update failed (${resp.status}): ${text}`);
    }
    this.logger.log(`[syncCallForwardingToSigcore] Synced callForwardingNumber=${callForwardingNumber || 'none'} to tenant ${sigcoreTenantId}`);
  }

  /**
   * Handle customer reply event - sends SMS for "customer_reply" rules
   * Fallback logic: If no account-specific settings exist, uses user-level default settings
   */
  async handleCustomerReply(context: CustomerReplyContext): Promise<void> {
    const { userId, savedAccountId, leadId, lead, isFirstCustomerReply, isSecondCustomerMessage } = context;

    this.logger.log(`Checking customer reply notification rules for account ${savedAccountId}`);

    // Skip the first customer message - only trigger on actual replies (2nd+ messages)
    if (isFirstCustomerReply) {
      this.logger.log(`Skipping first customer message - notifications only trigger on replies`);
      return;
    }

    // First try to get account-specific settings
    const replyRuleInclude = {
      notificationRules: {
        where: { triggerType: 'customer_reply', enabled: true },
        include: { messageTemplate: true },
      },
    };

    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      include: replyRuleInclude,
    });

    // Fallback: If no account-specific settings, try user-level default settings
    if (!settings) {
      this.logger.log(`No account-specific settings for ${savedAccountId}, checking user-level defaults for user ${userId}`);
      settings = await this.prisma.notificationSettings.findFirst({
        where: {
          userId: userId,
          savedAccountId: null,
        },
        include: replyRuleInclude,
      });

      if (settings) {
        this.logger.log(`Using user-level default settings for user ${userId}`);
      }
    } else {
      this.logger.log(`Using account-specific settings for ${savedAccountId} (enabled: ${settings.enabled}, sigcoreApiKey: ${settings.sigcoreApiKey ? 'set' : 'NOT SET'}, rules: ${settings.notificationRules.length})`);
    }

    // NOTE: No cross-account fallback — each account must use its own settings.

    if (!settings) {
      this.logger.warn(`No notification settings found for account ${savedAccountId} or user ${userId}. SMS alerts not configured for this account.`);
      return;
    }

    if (!settings.enabled) {
      this.logger.log(`Notifications disabled for account ${savedAccountId}`);
      return;
    }

    if (!settings.sigcoreApiKey) {
      this.logger.warn(`No Sigcore API key configured for account ${savedAccountId}. Provision Sigcore workspace in SMS Alerts settings.`);
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

      await this.sendNotificationWithRule(settings, rule, { userId, savedAccountId, leadId, accountName: context.accountName, lead });
    }
  }

  /**
   * Validate that a phone number belongs to a specific user.
   * Checks pool assignments, tenant (purchased) phones, and notification settings.
   */
  private async validatePhoneOwnership(userId: string, phoneNumber: string): Promise<boolean> {
    // 1. Pool phones are shared across all tenants — any non-released pool number is valid for any user
    const poolPhone = await this.prisma.phonePool.findFirst({
      where: { phoneNumber, status: { not: 'RELEASED' } },
    });
    if (poolPhone) return true;

    // 2. Check user-purchased tenant phones
    const tenantPhone = await this.prisma.tenantPhoneNumber.findFirst({
      where: { userId, phoneNumber, status: 'ACTIVE' },
    });
    if (tenantPhone) return true;

    // 3. Check if it's the user's sigcoreFromPhone in any of their notification settings
    const settingsMatch = await this.prisma.notificationSettings.findFirst({
      where: {
        sigcoreFromPhone: phoneNumber,
        savedAccount: { userId },
      },
    });
    if (settingsMatch) return true;

    return false;
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
    // If sendToCustomer is true, send SMS to the lead's phone instead of the configured toPhone
    const toPhone = rule?.sendToCustomer
      ? (lead?.customerPhone || null)
      : (rule?.toPhone || settings.destinationPhone);
    let fromPhone = rule?.fromPhone || settings.sigcoreFromPhone;
    let fromPhoneSource = rule?.fromPhone ? 'rule' : settings.sigcoreFromPhone ? 'settings' : 'none';

    // Fallback: use any pool phone if no explicit fromPhone configured (pool phones are shared)
    if (!fromPhone) {
      const poolPhone = await this.prisma.phonePool.findFirst({
        where: { status: { not: 'RELEASED' } },
        orderBy: { provisionedAt: 'desc' },
      });
      if (poolPhone) {
        fromPhone = poolPhone.phoneNumber;
        fromPhoneSource = 'pool';
        this.logger.log(`Using pool phone ${fromPhone} as fromPhone for rule`);
      }
    }

    // Ownership guard: NEVER send SMS from a phone number that doesn't belong to this user
    if (fromPhone) {
      const ownsPhone = await this.validatePhoneOwnership(userId, fromPhone);
      if (!ownsPhone) {
        this.logger.warn(
          `[sendNotificationWithRule] BLOCKED: user ${userId} does not own fromPhone ${fromPhone} (source: ${fromPhoneSource})`,
        );
        return;
      }
    }

    const template = rule?.messageTemplate?.content || rule?.template || settings.template;
    const ruleName = rule?.name || 'Legacy Alert';
    const ruleId = rule?.id || null;

    // Validate phone numbers
    if (!toPhone) {
      this.logger.warn(`No destination phone for rule ${ruleName}`);
      return;
    }

    // Render the message template
    const messageBody = this.renderTemplate(template, lead, context.accountName);

    this.logger.log(
      `[sendNotificationWithRule] rule=${ruleName} sendToCustomer=${!!rule?.sendToCustomer} ` +
      `fromPhone=${fromPhone} (source=${fromPhoneSource}) toPhone=${toPhone} ` +
      `senderMode=${settings.senderMode} sigcoreProvider=${settings.sigcoreProvider} ` +
      `rule.fromPhone=${rule?.fromPhone || 'null'} settings.sigcoreFromPhone=${settings.sigcoreFromPhone || 'null'} ` +
      `apiKeyType=${settings.sigcoreApiKey ? 'tenant' : 'MISSING'}`,
    );

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

    // Send via Sigcore
    try {
      // Determine the correct API key: if fromPhone is a shared pool number (Twilio),
      // use the platform key so Sigcore routes through Twilio — not the tenant's provider
      // (which may be OpenPhone and would replace the fromNumber with its own number).
      let apiKey = settings.sigcoreApiKey;
      const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
      if (fromPhone && platformKey) {
        const isPoolPhone = await this.prisma.phonePool.findFirst({
          where: { phoneNumber: fromPhone, status: { not: 'RELEASED' } },
          select: { id: true },
        });
        if (isPoolPhone) {
          this.logger.log(`[sendNotificationWithRule] fromPhone ${fromPhone} is a shared pool number — using platform key`);
          apiKey = platformKey;
        }

        // OpenPhone numbers use the tenant's own Sigcore API key (already set above)
      }
      if (!apiKey) {
        this.logger.error(`No Sigcore API key for rule ${ruleName} - tenant key not configured`);
        throw new Error('No Sigcore API key configured. Please provision your phone workspace first.');
      }

      const keyType = apiKey === platformKey ? 'platform' : 'tenant';
      this.logger.log(
        `[sendNotificationWithRule] Sending via Sigcore: keyType=${keyType} fromPhone=${fromPhone} ` +
        `keyPrefix=${apiKey.substring(0, 12)}...`,
      );

      const result = await this.sendViaSigcore({
        to: toPhone,
        body: messageBody,
        fromPhone: fromPhone,
        apiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        sigcoreProvider: settings.sigcoreProvider,
        sigcoreWorkspaceId: settings.sigcoreWorkspaceId,
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
          sigcoreMessageId: result.messageId,
          sigcoreConversationId: result.conversationId,
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

      // Store customer-facing SMS as a Message record in the Conversation
      if (rule?.sendToCustomer && leadId) {
        try {
          const leadRecord = await this.prisma.lead.findUnique({
            where: { id: leadId },
            select: { threadId: true, userId: true },
          });
          if (leadRecord?.threadId) {
            await this.prisma.message.create({
              data: {
                conversationId: leadRecord.threadId,
                userId: leadRecord.userId,
                platform: 'sms',
                externalMessageId: result.messageId || `sms-rule-${logEntry.id}`,
                sender: 'pro',
                content: messageBody,
                isRead: true,
                sentAt: new Date(),
                notificationLogId: logEntry.id,
              },
            });
            await this.prisma.conversation.update({
              where: { id: leadRecord.threadId },
              data: { lastMessageAt: new Date() },
            });
          }
        } catch (err: any) {
          this.logger.warn(`Failed to store customer SMS as Message: ${err.message}`);
        }
      }

      this.logger.log(`Notification sent for rule ${ruleName} to ${toPhone}`);
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
    toPhoneOverride?: string,
    templateOverride?: string,
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

    const sigcoreApiKey = settings.sigcoreApiKey;
    this.logger.log(`[sendTestNotification] Using tenant Sigcore API key (key starts: ${sigcoreApiKey?.substring(0, 8)}...)`);
    if (!sigcoreApiKey) {
      return { success: false, error: 'No Sigcore API key configured. Please provision your phone workspace first.' };
    }

    // Get rule if specified
    let rule = null;
    if (ruleId) {
      rule = await this.prisma.notificationRule.findFirst({
        where: { id: ruleId, notificationSettingsId: settings.id },
        include: { messageTemplate: true },
      });
      if (!rule) {
        return { success: false, error: 'Rule not found' };
      }
    }

    // Use override (CT test), then rule's phone numbers, then settings fallback
    const toPhone = toPhoneOverride || rule?.toPhone || settings.destinationPhone;
    let fromPhone = rule?.fromPhone || settings.sigcoreFromPhone;

    if (!toPhone) {
      return { success: false, error: 'No destination phone configured for this rule' };
    }

    // Load test customer data from admin config (set on Phone Pool admin page)
    const adminCfg = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const td = (adminCfg?.testData as Record<string, string> | null) ?? {};

    const testLead = {
      customerName: td.customerName || 'Test Customer',
      customerPhone: '+15551234567',
      category: td.category || 'House Cleaning',
      city: td.city || 'Tampa',
      state: td.state || 'FL',
      postcode: td.zip || '33602',
      message: td.message || 'I need my house cleaned weekly. Looking for someone reliable.',
      rawJson: JSON.stringify({
        request: {
          details: {
            serviceDescription: td.serviceDescription || 'Weekly house cleaning service',
            addOns: td.addons
              ? td.addons.split(',').map((s: string) => s.trim()).filter(Boolean)
              : ['Deep clean', 'Laundry'],
            frequency: td.frequency || 'Weekly',
            ...(td.bedrooms && { bedrooms: td.bedrooms }),
            ...(td.bathrooms && { bathrooms: td.bathrooms }),
            ...(td.price && { price: td.price }),
            ...(td.pets && { pets: td.pets }),
            ...(td.estimate && { estimate: td.estimate }),
            ...(td.dates && { dates: td.dates }),
          },
        },
      }),
    };

    const template = templateOverride || rule?.messageTemplate?.content || rule?.template || settings.template;
    const ruleName = rule?.name || 'Test';
    const accountLabel = account.businessName ? `[${account.businessName}] ` : '';
    const messageBody = `${accountLabel}${this.renderTemplate(template, testLead, account.businessName)}`;

    // Apply the same pool-phone / OpenPhone fallback as sendNotificationWithRule
    let effectiveApiKey = sigcoreApiKey;
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (fromPhone && platformKey) {
      const isPoolPhone = await this.prisma.phonePool.findFirst({
        where: { phoneNumber: fromPhone, status: { not: 'RELEASED' } },
        select: { id: true },
      });
      if (isPoolPhone) {
        this.logger.log(`[sendTestNotification] fromPhone ${fromPhone} is a pool number — using platform key`);
        effectiveApiKey = platformKey;
      }
      // OpenPhone numbers use the tenant's own Sigcore API key (already set above)
    }

    // Create notification log entry (after fallback so fromPhone is correct)
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
      const result = await this.sendViaSigcore({
        to: toPhone,
        body: `[TEST] ${messageBody}`,
        fromPhone: fromPhone,
        apiKey: effectiveApiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        sigcoreProvider: settings.sigcoreProvider,
        sigcoreWorkspaceId: settings.sigcoreWorkspaceId,
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
          sigcoreMessageId: result.messageId,
          sigcoreConversationId: result.conversationId,
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
    accountName?: string,
  ): string {
    let message = template;

    // Replace account variables — support {{account.name}}, {account.name}, and {accountName}
    message = message.replace(/\{\{account\.name\}\}/gi, accountName || 'Your Business');
    message = message.replace(/\{account\.name\}/gi, accountName || 'Your Business');
    message = message.replace(/\{accountName\}/gi, accountName || 'Your Business');

    // Replace basic variables — support both {{lead.x}} and {lead.x} single-brace syntax
    message = message.replace(/\{\{lead\.name\}\}/gi, lead.customerName || 'Unknown');
    message = message.replace(/\{lead\.name\}/gi, lead.customerName || 'Unknown');
    message = message.replace(/\{customerName\}/gi, lead.customerName || 'Unknown');
    message = message.replace(/\{\{lead\.phone\}\}/gi, lead.customerPhone || 'Not provided');
    message = message.replace(/\{lead\.phone\}/gi, lead.customerPhone || 'Not provided');
    message = message.replace(/\{\{lead\.service\}\}/gi, lead.category || 'Not specified');
    message = message.replace(/\{lead\.service\}/gi, lead.category || 'Not specified');

    const location = [lead.city, lead.state].filter(Boolean).join(', ') || 'Not specified';
    message = message.replace(/\{\{lead\.location\}\}/gi, location);
    message = message.replace(/\{lead\.location\}/gi, location);

    // Replace new variables
    message = message.replace(/\{\{lead\.zip\}\}/gi, lead.postcode || 'Not provided');
    message = message.replace(/\{lead\.zip\}/gi, lead.postcode || 'Not provided');
    message = message.replace(/\{\{lead\.message\}\}/gi, lead.message || 'No message');
    message = message.replace(/\{lead\.message\}/gi, lead.message || 'No message');

    // Parse rawJson for additional fields
    let serviceDescription = 'Not specified';
    let addons = 'None';
    let frequency = 'Not specified';
    let bedrooms = 'Not specified';
    let bathrooms = 'Not specified';
    let price = 'Not specified';
    let pets = 'Not specified';
    let estimate = 'Not specified';
    let dates = 'Not specified';

    if (lead.rawJson) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const request = raw.request || {};
        const details = request.details || [];

        // Log details for debugging which fields Thumbtack sends
        if (details.length > 0) {
          this.logger.debug(
            `Lead template details (${details.length} items): ${JSON.stringify(details.map((d: any) => ({ q: d.question, a: d.answer })))}`,
          );
        } else {
          this.logger.debug('Lead template: no request.details in webhook payload');
        }

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

        // Extract add-ons (expanded search patterns to match Thumbtack's varying question formats)
        const addOnsAnswer = this.findAnswerInDetails(details, [
          'Add-on', 'Add on', 'Additional service', 'Extra', 'Include',
          'Special request', 'Other service', 'Also need',
        ]);
        if (addOnsAnswer) {
          addons = addOnsAnswer;
        }

        const frequencyAnswer = this.findAnswerInDetails(details, ['Frequency', 'Service frequency', 'How often']);
        if (frequencyAnswer) {
          frequency = frequencyAnswer;
        }

        // Extract bedrooms
        const bedroomsAnswer = this.findAnswerInDetails(details, ['Bedrooms', 'Number of bedrooms', 'How many bedrooms', 'Bedroom']);
        if (bedroomsAnswer) {
          bedrooms = bedroomsAnswer;
        }

        // Extract bathrooms
        const bathroomsAnswer = this.findAnswerInDetails(details, ['Bathrooms', 'Number of bathrooms', 'How many bathrooms', 'Bathroom']);
        if (bathroomsAnswer) {
          bathrooms = bathroomsAnswer;
        }

        // Extract pets
        const petsAnswer = this.findAnswerInDetails(details, ['Pets', 'Do you have pets', 'Pet', 'Animals']);
        if (petsAnswer) {
          pets = petsAnswer;
        }

        // Extract dates/schedule
        const datesAnswer = this.findAnswerInDetails(details, [
          'Date', 'When', 'Schedule', 'Preferred date', 'Start date',
          'What day', 'Move date', 'Moving date', 'Event date', 'Project date',
          'Availability', 'Timeline', 'Time frame', 'Timeframe',
        ]);
        if (datesAnswer) {
          dates = datesAnswer;
        }

        // Extract lead price from raw object
        if (raw.leadPrice) {
          price = raw.leadPrice;
        }

        // Extract estimate/quote from raw object
        if (raw.estimate?.total) {
          estimate = raw.estimate.total;
        }
      } catch (_err) {
        // Failed to parse rawJson, use defaults
      }
    }

    message = message.replace(/\{\{lead\.serviceDescription\}\}/gi, serviceDescription);
    message = message.replace(/\{lead\.serviceDescription\}/gi, serviceDescription);
    message = message.replace(/\{\{lead\.addons\}\}/gi, addons);
    message = message.replace(/\{lead\.addons\}/gi, addons);
    message = message.replace(/\{\{lead\.frequency\}\}/gi, frequency);
    message = message.replace(/\{lead\.frequency\}/gi, frequency);
    message = message.replace(/\{\{lead\.bedrooms\}\}/gi, bedrooms);
    message = message.replace(/\{lead\.bedrooms\}/gi, bedrooms);
    message = message.replace(/\{\{lead\.bathrooms\}\}/gi, bathrooms);
    message = message.replace(/\{lead\.bathrooms\}/gi, bathrooms);
    message = message.replace(/\{\{lead\.price\}\}/gi, price);
    message = message.replace(/\{lead\.price\}/gi, price);
    message = message.replace(/\{\{lead\.pets\}\}/gi, pets);
    message = message.replace(/\{lead\.pets\}/gi, pets);
    message = message.replace(/\{\{lead\.estimate\}\}/gi, estimate);
    message = message.replace(/\{lead\.estimate\}/gi, estimate);
    message = message.replace(/\{\{lead\.dates\}\}/gi, dates);
    message = message.replace(/\{lead\.dates\}/gi, dates);

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
   * Fetch phone numbers from Sigcore API (provider-aware)
   */
  async getSigcorePhoneNumbers(
    userId: string,
    savedAccountId: string,
  ): Promise<SigcorePhoneNumber[]> {
    // Verify the account belongs to the user and get settings
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      this.logger.error(`[getSigcorePhoneNumbers] Saved account ${savedAccountId} not found for user ${userId}`);
      throw new NotFoundException('Saved account not found');
    }

    this.logger.log(`[getSigcorePhoneNumbers] Looking up notification settings for account ${savedAccountId}`);
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      this.logger.warn(`[getSigcorePhoneNumbers] No notification settings found for account ${savedAccountId}`);
      return [];
    }

    const effectiveApiKey = settings.sigcoreApiKey;
    if (!effectiveApiKey) {
      this.logger.warn(`[getSigcorePhoneNumbers] No API key found for account ${savedAccountId}`);
      return [];
    }

    const provider = settings.sigcoreProvider || 'openphone';
    this.logger.log(`[getSigcorePhoneNumbers] Fetching phone numbers for provider: ${provider}`);

    if (provider === 'twilio' && settings.sigcoreFromPhone) {
      // For Twilio, return the configured phone number from settings
      return [{
        id: 'twilio-configured',
        phoneNumber: settings.sigcoreFromPhone,
        provider: 'twilio',
        friendlyName: 'Twilio Number',
        capabilities: ['sms', 'voice'],
        smsEnabled: true,
        mmsEnabled: false,
        voiceEnabled: true,
      }];
    }

    // For OpenPhone, fetch via conversations endpoint
    return this.fetchOpenPhoneNumbers(effectiveApiKey);
  }

  /**
   * Map Sigcore API phone response to SigcorePhoneNumber interface
   */
  private mapSigcorePhoneNumber(phone: any): SigcorePhoneNumber {
    const phoneNumber = phone.phoneNumber || phone.phone_number || phone.number || phone.e164;
    const a2p = phone.a2pCompliance || phone.a2p || {};
    const caps = phone.capabilities || {};

    // Map Sigcore campaignStatus to our a2pStatus
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

    // Toll-free numbers (800, 833, 844, 855, 866, 877, 888) require separate
    // SMS verification — default smsEnabled to false for them unless explicitly set.
    const digits = (phoneNumber || '').replace(/\D/g, '');
    const isTollFree = /^1?(800|833|844|855|866|877|888)/.test(digits);
    const smsDefault = isTollFree ? false : true;

    return {
      id: phone.phoneNumberId || phone.id || phone._id || phoneNumber || String(Math.random()),
      phoneNumber: phoneNumber,
      provider: phone.provider || phone.carrier || phone.type || 'unknown',
      friendlyName: phone.phoneNumberName || phone.friendlyName || phone.friendly_name || phone.name || phone.label || '',
      capabilities: Array.isArray(caps) ? caps : Object.keys(caps).filter(k => caps[k]),
      // A2P Compliance
      a2pStatus,
      a2pBrandId: a2p.brandId || a2p.brand_id,
      a2pCampaignId: a2p.campaignId || a2p.campaign_id || a2p.messagingServiceSid,
      // Capabilities as booleans
      smsEnabled: caps.sms ?? caps.SMS ?? phone.smsEnabled ?? smsDefault,
      mmsEnabled: caps.mms ?? caps.MMS ?? phone.mmsEnabled ?? false,
      voiceEnabled: caps.voice ?? caps.Voice ?? phone.voiceEnabled ?? true,
    };
  }

  /**
   * Validate Sigcore tenant API key by attempting to list webhook subscriptions
   */
  async validateSigcoreApiKey(apiKey: string): Promise<{ valid: boolean }> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const endpoint = `${sigcoreUrl}/v1/webhook-subscriptions`;
    this.logger.log(`[validateSigcoreApiKey] Validating key via: ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });

      this.logger.log(`[validateSigcoreApiKey] Response status: ${response.status}`);

      if (!response.ok) {
        this.logger.error(`[validateSigcoreApiKey] Failed with status: ${response.status}`);
        return { valid: false };
      }

      return { valid: true };
    } catch {
      return { valid: false };
    }
  }

  /**
   * Connect a provider (OpenPhone or Twilio) via Sigcore integration endpoints
   */
  async connectProviderViaSigcore(
    tenantApiKey: string,
    provider: 'openphone' | 'twilio',
    credentials: {
      apiKey?: string; // OpenPhone API key
      accountSid?: string; // Twilio
      authToken?: string; // Twilio
      phoneNumber?: string; // Twilio
    },
  ): Promise<{ success: boolean; error?: string; data?: any; sigcoreAuthFailed?: boolean }> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');

    if (provider === 'openphone') {
      const endpoint = `${sigcoreUrl}/integrations/openphone/connect`;
      this.logger.log(`[connectProvider] Connecting OpenPhone via: ${endpoint}`);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'x-api-key': tenantApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ apiKey: credentials.apiKey }),
        });

        this.logger.log(`[connectProvider] OpenPhone response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`[connectProvider] OpenPhone connect failed: ${response.status} - ${errorText}`);
          // 401 means the Sigcore API key is invalid/expired — not an OpenPhone key problem.
          if (response.status === 401) {
            return { success: false, sigcoreAuthFailed: true, error: `Sigcore API key rejected (401). The stored key may be expired.` };
          }
          return { success: false, error: `Failed to connect OpenPhone: ${response.status} — ${errorText}` };
        }

        const result = await response.json();
        this.logger.log(`[connectProvider] OpenPhone connected: ${JSON.stringify(result)}`);
        return { success: true, data: result };
      } catch (error: any) {
        this.logger.error(`[connectProvider] OpenPhone error: ${error.message}`);
        return { success: false, error: error.message };
      }
    } else {
      // Twilio
      const endpoint = `${sigcoreUrl}/integrations/twilio`;
      this.logger.log(`[connectProvider] Connecting Twilio via: ${endpoint}`);

      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'x-api-key': tenantApiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            accountSid: credentials.accountSid,
            authToken: credentials.authToken,
            phoneNumber: credentials.phoneNumber,
          }),
        });

        this.logger.log(`[connectProvider] Twilio response status: ${response.status}`);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger.error(`[connectProvider] Twilio connect failed: ${response.status} - ${errorText}`);
          if (response.status === 401) {
            return { success: false, sigcoreAuthFailed: true, error: `Sigcore API key rejected (401). The stored key may be expired.` };
          }
          return { success: false, error: `Failed to connect Twilio: ${response.status} — ${errorText}` };
        }

        const result = await response.json();
        this.logger.log(`[connectProvider] Twilio connected: ${JSON.stringify(result)}`);
        return { success: true, data: result };
      } catch (error: any) {
        this.logger.error(`[connectProvider] Twilio error: ${error.message}`);
        return { success: false, error: error.message };
      }
    }
  }

  /**
   * Create a webhook subscription in Sigcore for delivery status updates
   */
  async createSigcoreWebhook(
    apiKey: string,
    webhookUrl: string,
    options?: { name?: string; events?: string[] },
  ): Promise<{ webhookId: string | null; error?: string }> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const endpoint = `${sigcoreUrl}/v1/webhook-subscriptions`;
    this.logger.log(`[createSigcoreWebhook] Creating webhook subscription at: ${endpoint}`);
    this.logger.log(`[createSigcoreWebhook] Webhook URL: ${webhookUrl}`);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: options?.name ?? 'LeadBridge Delivery Notifications',
          webhookUrl: webhookUrl,
          events: options?.events ?? ['message.sent', 'message.delivered', 'message.failed'],
        }),
      });

      this.logger.log(`[createSigcoreWebhook] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[createSigcoreWebhook] Failed: ${response.status} - ${errorText}`);
        return { webhookId: null, error: `Failed to create webhook: ${response.status}` };
      }

      const result = await response.json();
      this.logger.log(`[createSigcoreWebhook] Result: ${JSON.stringify(result)}`);

      const webhookId = result.data?.id || result.id || result.subscriptionId;
      return { webhookId };
    } catch (error: any) {
      this.logger.error('[createSigcoreWebhook] Error:', error.message);
      return { webhookId: null, error: error.message };
    }
  }

  /**
   * Delete a webhook subscription from Sigcore
   */
  async deleteSigcoreWebhook(apiKey: string, webhookId: string): Promise<{ success: boolean; error?: string }> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const endpoint = `${sigcoreUrl}/v1/webhook-subscriptions/${webhookId}`;
    this.logger.log(`[deleteSigcoreWebhook] Deleting webhook subscription: ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
      });

      this.logger.log(`[deleteSigcoreWebhook] Response status: ${response.status}`);

      if (!response.ok && response.status !== 404) {
        const errorText = await response.text();
        this.logger.error(`[deleteSigcoreWebhook] Failed: ${response.status} - ${errorText}`);
        return { success: false, error: `Failed to delete webhook: ${response.status}` };
      }

      return { success: true };
    } catch (error: any) {
      this.logger.error('[deleteSigcoreWebhook] Error:', error.message);
      return { success: false, error: error.message };
    }
  }

  /**
   * Provision a Sigcore tenant for a saved account (idempotent).
   * Uses the workspace-level SIGCORE_API_KEY to call Sigcore's provision endpoint.
   * Stores the resulting tenant API key in NotificationSettings for future use.
   */
  async ensureSigcoreTenantProvisioned(
    userId: string,
    savedAccountId: string,
  ): Promise<{ apiKey: string; tenantId: string }> {
    // Check if already provisioned
    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    // Remember the old tenantId before potential re-provisioning (needed for integration migration)
    const oldTenantId = settings?.sigcoreTenantId || null;

    if (settings?.sigcoreTenantId && settings?.sigcoreApiKey) {
      // Check if this tenant ID is shared with another account (from old auto-copy logic).
      // Each account must have its OWN tenant to avoid Call Connect / SMS cross-contamination.
      const sharedCount = await this.prisma.notificationSettings.count({
        where: {
          sigcoreTenantId: settings.sigcoreTenantId,
          NOT: { savedAccountId },
        },
      });

      if (sharedCount === 0) {
        this.logger.log(`[ensureSigcoreTenantProvisioned] Already provisioned for account ${savedAccountId} (tenantId: ${settings.sigcoreTenantId})`);
        return { apiKey: settings.sigcoreApiKey, tenantId: settings.sigcoreTenantId };
      }

      // Shared tenant detected — force re-provision with a dedicated tenant
      this.logger.warn(
        `[ensureSigcoreTenantProvisioned] Account ${savedAccountId} shares tenantId ${settings.sigcoreTenantId} with ${sharedCount} other account(s) — re-provisioning`,
      );
    }

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');

    if (!platformKey) {
      throw new Error('SIGCORE_API_KEY not configured. Cannot provision Sigcore tenant.');
    }

    this.logger.log(`[ensureSigcoreTenantProvisioned] Provisioning Sigcore tenant for account ${savedAccountId}`);

    const resp = await fetch(`${sigcoreUrl}/tenants/provision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': platformKey,
      },
      body: JSON.stringify({
        externalTenantId: savedAccountId,
        displayName: `Account ${savedAccountId}`,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      if (resp.status === 403 && text.includes('Tenant keys cannot provision')) {
        throw new Error(
          'SIGCORE_API_KEY is a tenant-scoped key. A workspace-level API key is required. ' +
          'Please update SIGCORE_API_KEY in Railway environment variables.',
        );
      }
      throw new Error(`Sigcore provision failed (${resp.status}): ${text}`);
    }

    const { data } = await resp.json();

    // Upsert settings with the new tenant credentials
    // Also set sigcoreWorkspaceId so Call Connect can use it as businessId
    settings = await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
      },
      create: {
        savedAccountId,
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
        enabled: false,
      },
    });

    this.logger.log(`[ensureSigcoreTenantProvisioned] Provisioned tenant ${data.tenantId} for account ${savedAccountId}`);

    // If re-provisioning from a shared tenant, copy integrations (OpenPhone, etc.) from the
    // old tenant to the new one. Without this, the TenantIntegration in Sigcore still references
    // the old tenantId, and messages would fall back to Twilio instead of OpenPhone.
    if (oldTenantId && oldTenantId !== data.tenantId) {
      try {
        const copyResp = await fetch(`${sigcoreUrl}/tenants/${data.tenantId}/copy-integrations`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': platformKey,
          },
          body: JSON.stringify({ fromTenantId: oldTenantId }),
        });
        if (copyResp.ok) {
          const copyResult = await copyResp.json();
          this.logger.log(
            `[ensureSigcoreTenantProvisioned] Copied ${copyResult.data?.copied || 0} integrations from tenant ${oldTenantId} to ${data.tenantId}`,
          );
        } else {
          this.logger.warn(`[ensureSigcoreTenantProvisioned] Failed to copy integrations: ${copyResp.status}`);
        }
      } catch (err: any) {
        this.logger.warn(`[ensureSigcoreTenantProvisioned] Could not copy integrations: ${err.message}`);
      }
    }

    return { apiKey: data.apiKey, tenantId: data.tenantId };
  }

  /**
   * Search available Twilio phone numbers via Sigcore (workspace key)
   */
  async searchSigcoreAvailableNumbers(
    _userId: string,
    savedAccountId: string,
    country: string = 'US',
    areaCode?: string,
    locality?: string,
  ): Promise<any[]> {
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true },
    });
    if (!settings?.sigcoreTenantId) throw new Error('SIGCORE_TENANT_NOT_PROVISIONED');

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY') || '';
    const params = new URLSearchParams({ country, smsCapable: 'true', voiceCapable: 'true' });
    if (areaCode) params.append('areaCode', areaCode);
    if (locality) params.append('locality', locality);

    const resp = await fetch(`${sigcoreUrl}/tenants/phone-numbers/search?${params}`, {
      headers: { 'x-api-key': platformKey, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`Sigcore search failed: ${resp.status}`);
    const json = await resp.json();
    return json.data || [];
  }

  /**
   * Purchase a Twilio phone number for a tenant via Sigcore (workspace key)
   */
  async purchaseSigcorePhoneNumber(
    _userId: string,
    savedAccountId: string,
    phoneNumber: string,
    friendlyName?: string,
  ): Promise<{ phoneNumber: string; allocationId: string }> {
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true },
    });
    if (!settings?.sigcoreTenantId) throw new Error('SIGCORE_TENANT_NOT_PROVISIONED');

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY') || '';

    const resp = await fetch(`${sigcoreUrl}/tenants/${settings.sigcoreTenantId}/phone-numbers/purchase`, {
      method: 'POST',
      headers: { 'x-api-key': platformKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, friendlyName }),
    });
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore purchase failed: ${resp.status} — ${text}`);
    }
    const json = await resp.json();
    const allocation = json.data?.allocation || json.data;
    const allocationId = allocation?.id || allocation?.allocationId || '';

    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: { sigcoreFromPhone: phoneNumber, sigcoreProvider: 'twilio' },
      create: { savedAccountId, sigcoreFromPhone: phoneNumber, sigcoreProvider: 'twilio' },
    });

    this.logger.log(`[purchaseSigcorePhoneNumber] Purchased ${phoneNumber} for account ${savedAccountId}`);
    return { phoneNumber, allocationId };
  }

  /**
   * Save/validate API key separately (one-time setup)
   */
  async saveApiKey(
    savedAccountId: string,
    apiKey: string,
  ): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`[saveApiKey] Saving API key for account ${savedAccountId}`);

    const validation = await this.validateSigcoreApiKey(apiKey);
    if (!validation.valid) {
      return { success: false, error: 'Invalid API key. Please check your key and try again.' };
    }

    // Save to this account only (tenant isolation: each account has its own key)
    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: { sigcoreApiKey: apiKey, enabled: true },
      create: { savedAccountId, sigcoreApiKey: apiKey, enabled: true },
    });

    return { success: true };
  }

  /**
   * Connect to Sigcore - uses stored or provided API key, connects provider, creates webhook
   */
  async connectSigcore(
    savedAccountId: string,
    apiKey: string | null,
    webhookBaseUrl: string,
    provider?: 'openphone' | 'twilio',
    providerCredentials?: {
      apiKey?: string; // OpenPhone API key
      accountSid?: string; // Twilio
      authToken?: string; // Twilio
      phoneNumber?: string; // Twilio phone number
    },
  ): Promise<{ success: boolean; phoneNumbers: SigcorePhoneNumber[]; error?: string }> {
    this.logger.log(`[connectSigcore] Connecting account ${savedAccountId} with provider ${provider || 'none'}`);

    // 1. Use provided API key, or fall back to stored tenant key. App-level key is NOT used here.
    let effectiveApiKey = apiKey;
    if (!effectiveApiKey) {
      const settings = await this.prisma.notificationSettings.findUnique({
        where: { savedAccountId },
        select: { sigcoreApiKey: true },
      });
      effectiveApiKey = settings?.sigcoreApiKey || null;
    }

    if (!effectiveApiKey) {
      return { success: false, phoneNumbers: [], error: 'No API key configured. Please provision your phone workspace first.' };
    }

    this.logger.log(`[connectSigcore] Using tenant API key prefix: ${effectiveApiKey.substring(0, 8)}...`);

    // 2. Connect provider if specified
    if (provider && providerCredentials) {
      const providerResult = await this.connectProviderViaSigcore(effectiveApiKey, provider, providerCredentials);

      if (!providerResult.success) {
        return { success: false, phoneNumbers: [], error: providerResult.error || `Failed to connect ${provider}` };
      }
    }

    // 3. Create webhook for delivery status — skip if one is already registered for this account
    //    to prevent accumulating duplicate subscriptions when connectSigcore is called repeatedly.
    const existingSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreWebhookId: true },
    });

    let deliveryWebhookId: string | null = existingSettings?.sigcoreWebhookId || null;
    if (!deliveryWebhookId) {
      const webhookUrl = `${webhookBaseUrl}/api/webhooks/sigcore/delivery-status`;
      const webhookResult = await this.createSigcoreWebhook(effectiveApiKey, webhookUrl);
      if (webhookResult.error) {
        this.logger.warn(`[connectSigcore] Webhook creation failed: ${webhookResult.error}`);
        // Continue anyway - webhook can be created manually later
      }
      deliveryWebhookId = webhookResult.webhookId;
    } else {
      this.logger.log(`[connectSigcore] Delivery webhook already registered (${deliveryWebhookId}), skipping creation`);
    }

    // 4. Store the provider, webhook ID, and Twilio phone number
    const fromPhone = (provider === 'twilio' && providerCredentials?.phoneNumber) ? providerCredentials.phoneNumber : null;
    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        sigcoreApiKey: effectiveApiKey,
        sigcoreProvider: provider || null,
        sigcoreWebhookId: deliveryWebhookId,
        ...(fromPhone && { sigcoreFromPhone: fromPhone }),
        enabled: true,
      },
      create: {
        savedAccountId,
        sigcoreApiKey: effectiveApiKey,
        sigcoreProvider: provider || null,
        sigcoreWebhookId: deliveryWebhookId,
        sigcoreFromPhone: fromPhone,
        enabled: true,
      },
    });

    this.logger.log(`[connectSigcore] Connected successfully. Provider: ${provider}, WebhookId: ${deliveryWebhookId}`);

    // 5. Fetch phone numbers for the connected provider
    let phoneNumbers: SigcorePhoneNumber[] = [];
    if (provider === 'openphone') {
      phoneNumbers = await this.fetchOpenPhoneNumbers(effectiveApiKey);
    } else if (provider === 'twilio' && fromPhone) {
      // For Twilio, return the configured phone number
      phoneNumbers = [{
        id: 'twilio-configured',
        phoneNumber: fromPhone,
        provider: 'twilio',
        friendlyName: 'Twilio Number',
        capabilities: ['sms', 'voice'],
        smsEnabled: true,
        mmsEnabled: false,
        voiceEnabled: true,
      }];
    }

    return { success: true, phoneNumbers };
  }

  /**
   * Fetch phone numbers from OpenPhone via Sigcore conversations endpoint
   */
  async fetchOpenPhoneNumbers(tenantApiKey: string): Promise<SigcorePhoneNumber[]> {
    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    // Use the dedicated phone-numbers endpoint so ALL configured numbers appear,
    // not just those with recent conversations (conversations?days=1 missed inactive numbers).
    const endpoint = `${sigcoreUrl}/integrations/openphone/numbers`;
    this.logger.log(`[fetchOpenPhoneNumbers] Fetching from: ${endpoint}`);

    try {
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          'x-api-key': tenantApiKey,
          'Content-Type': 'application/json',
        },
      });

      this.logger.log(`[fetchOpenPhoneNumbers] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[fetchOpenPhoneNumbers] Failed: ${response.status} - ${errorText}`);
        return [];
      }

      const result = await response.json();
      this.logger.log(`[fetchOpenPhoneNumbers] Result: ${JSON.stringify(result).substring(0, 500)}`);

      const phones = result.data || result.phoneNumbers || result || [];
      // Deduplicate by id first, then by phoneNumber, to guard against the /numbers
      // endpoint returning the same number in multiple contexts (e.g. shared phone numbers
      // across OpenPhone users, or multiple integrations returning overlapping numbers).
      const seenIds = new Set<string>();
      const seenNumbers = new Set<string>();
      return phones
        .map((phone: any) => this.mapSigcorePhoneNumber(phone))
        .filter((p: any) => {
          if (!p.phoneNumber || p.phoneNumber.length <= 5) return false;
          if (seenIds.has(p.id)) return false;
          if (seenNumbers.has(p.phoneNumber)) return false;
          seenIds.add(p.id);
          seenNumbers.add(p.phoneNumber);
          return true;
        });
    } catch (error: any) {
      this.logger.error(`[fetchOpenPhoneNumbers] Error: ${error.message}`);
      return [];
    }
  }

  /**
   * Disconnect from Sigcore - deletes webhook and clears settings
   */
  async disconnectSigcore(savedAccountId: string): Promise<{ success: boolean; error?: string }> {
    this.logger.log(`[disconnectSigcore] Disconnecting account ${savedAccountId}`);

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return { success: true }; // Already disconnected
    }

    const effectiveApiKey = settings.sigcoreApiKey;

    // 1. Disconnect provider integration via Sigcore API
    if (effectiveApiKey && settings.sigcoreProvider) {
      await this.disconnectProviderViaSigcore(effectiveApiKey, settings.sigcoreProvider);
    }

    // 2. Delete webhook if exists
    if (effectiveApiKey && settings.sigcoreWebhookId) {
      const deleteResult = await this.deleteSigcoreWebhook(effectiveApiKey, settings.sigcoreWebhookId);
      if (!deleteResult.success) {
        this.logger.warn(`[disconnectSigcore] Failed to delete webhook: ${deleteResult.error}`);
      }
    }

    // 3. Clear provider/webhook settings but KEEP the API key for re-connection
    await this.prisma.notificationSettings.update({
      where: { savedAccountId },
      data: {
        sigcoreFromPhone: null,
        sigcoreWebhookId: null,
        sigcoreProvider: null,
      },
    });

    this.logger.log(`[disconnectSigcore] Disconnected successfully`);
    return { success: true };
  }

  /**
   * Delete the Sigcore tenant for a saved account.
   * Called before account deletion to cascade-clean phone numbers, integrations, and API keys.
   */
  async deleteSigcoreTenant(savedAccountId: string): Promise<void> {
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true },
    });

    if (!settings?.sigcoreTenantId) return;

    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) {
      this.logger.warn('[deleteSigcoreTenant] No SIGCORE_API_KEY — skipping');
      return;
    }

    const baseUrl = this.configService.get<string>('SIGCORE_API_URL') || 'https://sigcore-production.up.railway.app';
    const url = `${baseUrl}/api/tenants/${settings.sigcoreTenantId}`;

    try {
      const resp = await fetch(url, {
        method: 'DELETE',
        headers: { 'x-api-key': platformKey },
      });
      if (resp.ok || resp.status === 404) {
        this.logger.log(`[deleteSigcoreTenant] Deleted Sigcore tenant ${settings.sigcoreTenantId} for account ${savedAccountId}`);
      } else {
        this.logger.warn(`[deleteSigcoreTenant] Failed: ${resp.status} ${resp.statusText}`);
      }
    } catch (err: any) {
      this.logger.warn(`[deleteSigcoreTenant] Error: ${err.message}`);
    }
  }

  /**
   * Disconnect provider integration via Sigcore API
   */
  private async disconnectProviderViaSigcore(tenantApiKey: string, provider: string): Promise<void> {
    const baseUrl = 'https://sigcore-production.up.railway.app';
    const endpoint = provider === 'openphone'
      ? `${baseUrl}/api/integrations/openphone/disconnect`
      : `${baseUrl}/api/integrations/twilio`;

    this.logger.log(`[disconnectProvider] Calling ${endpoint} for provider ${provider}`);

    try {
      const response = await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          'x-api-key': tenantApiKey,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.warn(`[disconnectProvider] Failed: ${response.status} - ${errorText}`);
      } else {
        this.logger.log(`[disconnectProvider] Successfully disconnected ${provider}`);
      }
    } catch (error: any) {
      this.logger.error(`[disconnectProvider] Error: ${error.message}`);
    }
  }

  // ==========================================
  // Customer Texting Settings
  // ==========================================

  /**
   * Get customer texting configuration for an account
   * Returns the customerTextingEnabled flag and all sendToCustomer rules
   */
  async getCustomerTextingSettings(
    userId: string,
    savedAccountId: string,
  ): Promise<{
    enabled: boolean;
    fromPhone: string | null;
    autoReplyTemplate: string;
  }> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });
    if (!account) throw new NotFoundException('Account not found');

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    // Get customer texting auto-reply rule (sendToCustomer: true, delayMinutes: 0)
    const autoReplyRule = settings
      ? await this.prisma.notificationRule.findFirst({
          where: {
            notificationSettingsId: settings.id,
            sendToCustomer: true,
            delayMinutes: 0,
          },
        })
      : null;

    // Resolve fromPhone: prefer the rule's fromPhone (what actually fires at send time),
    // then settings.sigcoreFromPhone, then first pool phone as last resort.
    let fromPhone: string | null = autoReplyRule?.fromPhone || settings?.sigcoreFromPhone || null;
    if (!fromPhone) {
      const poolPhone = await this.prisma.phonePool.findFirst({
        where: { status: { not: 'RELEASED' } },
        orderBy: { provisionedAt: 'desc' },
      });
      if (poolPhone) fromPhone = poolPhone.phoneNumber;
    }

    return {
      enabled: settings?.customerTextingEnabled ?? false,
      fromPhone,
      autoReplyTemplate: autoReplyRule?.template || 'Hi {{lead.name}}, this is {{account.name}}. We just received your request for {{lead.service}} in {{lead.location}}. When would be a good time to call you?',
    };
  }

  /**
   * Save customer texting configuration for an account
   * Creates/updates sendToCustomer notification rules
   */
  async saveCustomerTextingSettings(
    userId: string,
    savedAccountId: string,
    dto: {
      enabled: boolean;
      fromPhone?: string;
      autoReplyTemplate: string;
    },
  ): Promise<{ success: boolean }> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });
    if (!account) throw new NotFoundException('Account not found');

    // Ensure NotificationSettings exists
    let settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });
    if (!settings) {
      settings = await this.prisma.notificationSettings.create({
        data: {
          savedAccountId,
          userId,
          enabled: true,
          customerTextingEnabled: dto.enabled,
          ...(dto.fromPhone && { sigcoreFromPhone: dto.fromPhone }),
        },
      });
    } else {
      await this.prisma.notificationSettings.update({
        where: { id: settings.id },
        data: {
          customerTextingEnabled: dto.enabled,
          ...(dto.fromPhone !== undefined && { sigcoreFromPhone: dto.fromPhone }),
        },
      });
    }

    // Delete existing customer-texting rules for this account
    await this.prisma.notificationRule.deleteMany({
      where: {
        notificationSettingsId: settings.id,
        sendToCustomer: true,
      },
    });

    if (!dto.enabled) {
      return { success: true };
    }

    // Resolve fromPhone: use the phone the user just selected (dto.fromPhone),
    // then fall back to settings sigcoreFromPhone, then pool phone as last resort.
    // dto.fromPhone takes priority because settings object was loaded before the update above.
    let fromPhone = dto.fromPhone || settings.sigcoreFromPhone;
    if (!fromPhone) {
      const poolPhone = await this.prisma.phonePool.findFirst({
        where: { status: { not: 'RELEASED' } },
        orderBy: { provisionedAt: 'desc' },
      });
      if (poolPhone) fromPhone = poolPhone.phoneNumber;
    }

    // Create auto-reply rule (immediate, no follow-ups)
    await this.prisma.notificationRule.create({
      data: {
        notificationSettingsId: settings.id,
        name: 'Auto-Reply to Customer',
        triggerType: 'new_lead',
        fromPhone,
        sendToCustomer: true,
        template: dto.autoReplyTemplate,
        delayMinutes: 0,
        enabled: true,
      },
    });

    // Register inbound SMS webhook with Sigcore (if not already registered)
    if (!settings.inboundSmsWebhookId) {
      try {
        const apiKey = settings.sigcoreApiKey;
        if (apiKey) {
          const appBaseUrl = this.configService.get<string>('APP_BASE_URL', 'https://www.leadbridge360.com');
          const webhookUrl = `${appBaseUrl}/api/webhooks/sigcore/inbound-sms?accountId=${savedAccountId}`;
          const result = await this.createSigcoreWebhook(apiKey, webhookUrl, {
            name: 'LeadBridge Inbound SMS',
            events: ['sms.message.received', 'message.inbound'],
          });
          if (result.webhookId) {
            await this.prisma.notificationSettings.update({
              where: { id: settings.id },
              data: { inboundSmsWebhookId: result.webhookId },
            });
            this.logger.log(`Registered inbound SMS webhook: ${result.webhookId}`);
          }
        }
      } catch (err: any) {
        this.logger.warn(`Failed to register inbound SMS webhook: ${err.message}`);
      }
    }

    return { success: true };
  }

  /**
   * Send message via Sigcore API
   */
  private async sendViaSigcore(params: {
    to: string;
    body: string;
    fromPhone?: string | null;
    apiKey: string;
    senderMode: 'shared' | 'dedicated' | 'openphone';
    sigcoreProvider?: string | null;
    sigcoreWorkspaceId?: string | null;
    metadata: Record<string, any>;
  }): Promise<{
    status: string;
    messageId?: string;
    conversationId?: string;
    provider?: string;
    fromPhone?: string;
  }> {
    this.logger.log(`Sending via Sigcore to: ${params.to}`);

    // Guard: prevent sending SMS from a number to the same number
    if (params.fromPhone && params.to) {
      const normFrom = params.fromPhone.replace(/\D/g, '').slice(-10);
      const normTo = params.to.replace(/\D/g, '').slice(-10);
      if (normFrom.length >= 10 && normFrom === normTo) {
        this.logger.error(
          `[sendViaSigcore] BLOCKED: from=${params.fromPhone} and to=${params.to} are the same number. ` +
          `Rule: ${params.metadata?.ruleName || 'unknown'}`,
        );
        throw new Error(`Cannot send SMS: from (${params.fromPhone}) and to (${params.to}) are the same phone number`);
      }
    }

    const requestBody: any = {
      toNumber: params.to,
      body: params.body,
      channel: 'sms',
    };

    // If a specific phone number is selected, include it (must be valid E.164 phone number)
    if (params.fromPhone && params.fromPhone.length > 5 && params.fromPhone.match(/^\+?\d{10,}/)) {
      requestBody.fromNumber = params.fromPhone;
    }

    // For OpenPhone: look up the Sigcore phone number ID.
    // Sigcore routes OpenPhone messages by phone ID — using E.164 fromNumber alone causes 500.
    // When phoneNumberId is resolved, remove fromNumber to avoid conflicts (Sigcore expects one or the other).
    const isOpenPhone = params.sigcoreProvider === 'openphone' || params.senderMode === 'openphone';
    if (isOpenPhone && params.fromPhone) {
      try {
        const opPhones = await this.fetchOpenPhoneNumbers(params.apiKey);
        const match = opPhones.find(p => p.phoneNumber === params.fromPhone);
        if (match) {
          requestBody.phoneNumberId = match.id;
          delete requestBody.fromNumber; // Sigcore uses phoneNumberId for routing, not fromNumber
          this.logger.log(`[sendViaSigcore] OpenPhone: resolved phoneNumberId=${match.id} for ${params.fromPhone}, removed fromNumber`);
        } else {
          this.logger.warn(`[sendViaSigcore] OpenPhone: no ID found for ${params.fromPhone}, sending with fromNumber only`);
        }
      } catch (e: any) {
        this.logger.warn(`[sendViaSigcore] OpenPhone ID lookup failed: ${e.message}, sending with fromNumber only`);
      }
    }

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const endpoint = `${sigcoreUrl}/v1/messages`;
    this.logger.log(`[sendViaSigcore] Hitting endpoint: ${endpoint}`);
    this.logger.log(`[sendViaSigcore] Request body: ${JSON.stringify(requestBody)}`);

    try {
      const response = await fetch(
        endpoint,
        {
          method: 'POST',
          headers: {
            'x-api-key': params.apiKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );

      this.logger.log(`[sendViaSigcore] Response status: ${response.status}`);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`[sendViaSigcore] Sigcore API error: ${response.status} - ${errorText}`);
        throw new Error(`Sigcore API error: ${response.status}`);
      }

      const result = await response.json();
      const data = result.data || result;

      this.logger.log(`SMS sent via Sigcore: ${JSON.stringify(data).substring(0, 500)}`);

      return {
        status: data.status || 'sent',
        messageId: data.id || data.providerMessageId,
        conversationId: data.conversationId,
        provider: data.provider,
        fromPhone: data.fromNumber,
      };
    } catch (error: any) {
      this.logger.error('Failed to send via Sigcore', error);
      throw new Error(error.message || 'Failed to send message via Sigcore');
    }
  }

  /**
   * Format settings for response
   * API key is masked for security
   */
  private formatSettings(settings: any): NotificationSettingsResponse {
    // Mask API key - show only last 4 characters
    let maskedApiKey: string | null = null;
    if (settings.sigcoreApiKey) {
      const key = settings.sigcoreApiKey;
      maskedApiKey = key.length > 4 ? `****${key.slice(-4)}` : '****';
    }

    return {
      id: settings.id,
      savedAccountId: settings.savedAccountId,
      enabled: settings.enabled,
      destinationPhone: settings.destinationPhone,
      senderMode: settings.senderMode,
      sigcoreApiKey: maskedApiKey,
      sigcoreFromPhone: settings.sigcoreFromPhone,
      sigcoreWorkspaceId: settings.sigcoreWorkspaceId,
      sigcoreConnected: !!settings.sigcoreTenantId && !!settings.sigcoreProvider,
      sigcoreProvisioned: !!settings.sigcoreTenantId,
      sigcoreProvider: settings.sigcoreProvider || null,
      template: settings.template,
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      quietHoursTimezone: settings.quietHoursTimezone,
      requirePhone: settings.requirePhone,
      smsForwardingNumber: settings.smsForwardingNumber || null,
      callForwardingNumber: settings.callForwardingNumber || null,
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
    // Last log is included via notificationLogs relation (take: 1, orderBy: desc)
    const lastLog = rule.notificationLogs?.[0] || null;
    return {
      id: rule.id,
      notificationSettingsId: rule.notificationSettingsId,
      name: rule.name,
      triggerType: rule.triggerType,
      replyTriggerMode: rule.replyTriggerMode,
      fromPhone: rule.fromPhone,
      toPhone: rule.toPhone,
      sendToCustomer: rule.sendToCustomer ?? false,
      template: rule.template,
      templateId: rule.templateId || null,
      delayMinutes: rule.delayMinutes ?? 0,
      stopOnCustomerReply: rule.stopOnCustomerReply ?? true,
      stopOnLeadClosed: rule.stopOnLeadClosed ?? true,
      stopOnOptOut: rule.stopOnOptOut ?? true,
      messageTemplate: rule.messageTemplate ? {
        id: rule.messageTemplate.id,
        name: rule.messageTemplate.name,
        content: rule.messageTemplate.content,
      } : null,
      enabled: rule.enabled,
      triggerCount: rule.triggerCount,
      lastTriggeredAt: rule.lastTriggeredAt?.toISOString() || null,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
      lastSmsStatus: lastLog?.status || null,
      lastSmsError: lastLog?.error || null,
      lastSmsAt: lastLog?.createdAt?.toISOString() || null,
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

  // ==========================================
  // Tenant Phone Number Management
  // ==========================================

  async getPhonePricing(): Promise<{ priceMonthly: number | null; gracePeriodDays: number }> {
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    return {
      priceMonthly: config?.phonePriceMonthly ? Number(config.phonePriceMonthly) : null,
      gracePeriodDays: config?.phoneGracePeriodDays ?? 30,
    };
  }

  async listTenantPhoneNumbers(userId: string) {
    return this.prisma.tenantPhoneNumber.findMany({
      where: { userId, status: { not: 'RELEASED' } },
      orderBy: { purchasedAt: 'desc' },
    });
  }

  async purchaseTenantPhoneNumber(
    userId: string,
    savedAccountId: string,
    phoneNumber: string,
    friendlyName?: string,
  ): Promise<{ success: boolean; tenantPhone?: any; error?: string }> {
    this.logger.log(`[purchaseTenantPhone] userId=${userId}, account=${savedAccountId}, phone=${phoneNumber}`);

    // 1. Provision via Sigcore (reuse existing method)
    let allocationId: string;
    try {
      const result = await this.purchaseSigcorePhoneNumber(userId, savedAccountId, phoneNumber, friendlyName);
      allocationId = result.allocationId;
    } catch (err) {
      this.logger.error(`[purchaseTenantPhone] Sigcore provision failed: ${err.message}`);
      return { success: false, error: `Failed to provision number: ${err.message}` };
    }

    // 2. Get admin pricing config
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const stripePriceId = config?.stripePriceId;

    // 3. Add to Stripe subscription (if user has one and pricing is configured)
    let stripeSubItemId: string | null = null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { stripeSubscriptionId: true, stripeCustomerId: true, email: true },
    });

    if (stripePriceId && user?.stripeSubscriptionId) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(this.configService.get<string>('STRIPE_SECRET_KEY')!, {
          apiVersion: '2026-01-28.clover',
        });
        const subItem = await stripe.subscriptionItems.create({
          subscription: user.stripeSubscriptionId,
          price: stripePriceId,
          quantity: 1,
        });
        stripeSubItemId = subItem.id;
        this.logger.log(`[purchaseTenantPhone] Created Stripe sub item: ${stripeSubItemId}`);
      } catch (err) {
        this.logger.warn(`[purchaseTenantPhone] Stripe billing failed (number still provisioned): ${err.message}`);
      }
    }

    // 4. Extract area code from phone number
    const areaCode = phoneNumber.replace(/\D/g, '').slice(1, 4); // +1XXXYYYZZZZ → XXX

    // 5. Create TenantPhoneNumber record
    const tenantPhone = await this.prisma.tenantPhoneNumber.create({
      data: {
        userId,
        savedAccountId,
        phoneNumber,
        friendlyName: friendlyName || phoneNumber,
        areaCode,
        sigcoreAllocationId: allocationId,
        stripeSubItemId,
        status: 'ACTIVE',
      },
    });

    this.logger.log(`[purchaseTenantPhone] Created tenant phone: ${tenantPhone.id} — ${phoneNumber}`);
    return { success: true, tenantPhone };
  }

  async cancelTenantPhoneNumber(
    userId: string,
    tenantPhoneId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const tenantPhone = await this.prisma.tenantPhoneNumber.findUnique({
      where: { id: tenantPhoneId },
    });

    if (!tenantPhone || tenantPhone.userId !== userId) {
      return { success: false, error: 'Phone number not found' };
    }

    if (tenantPhone.status !== 'ACTIVE') {
      return { success: false, error: 'Phone number is not active' };
    }

    // Get grace period from admin config
    const config = await this.prisma.adminConfig.findUnique({ where: { id: 'global' } });
    const gracePeriodDays = config?.phoneGracePeriodDays ?? 30;
    const gracePeriodEndsAt = new Date();
    gracePeriodEndsAt.setDate(gracePeriodEndsAt.getDate() + gracePeriodDays);

    // Remove Stripe subscription item (stop billing immediately)
    if (tenantPhone.stripeSubItemId) {
      try {
        const Stripe = (await import('stripe')).default;
        const stripe = new Stripe(this.configService.get<string>('STRIPE_SECRET_KEY')!, {
          apiVersion: '2026-01-28.clover',
        });
        await stripe.subscriptionItems.del(tenantPhone.stripeSubItemId);
        this.logger.log(`[cancelTenantPhone] Removed Stripe sub item: ${tenantPhone.stripeSubItemId}`);
      } catch (err) {
        this.logger.warn(`[cancelTenantPhone] Failed to remove Stripe item: ${err.message}`);
      }
    }

    // Update status to grace period
    await this.prisma.tenantPhoneNumber.update({
      where: { id: tenantPhoneId },
      data: {
        status: 'GRACE_PERIOD',
        cancelledAt: new Date(),
        gracePeriodEndsAt,
      },
    });

    this.logger.log(`[cancelTenantPhone] ${tenantPhone.phoneNumber} → GRACE_PERIOD until ${gracePeriodEndsAt.toISOString()}`);
    return { success: true };
  }

  async releaseTenantPhoneNumber(tenantPhoneId: string): Promise<{ success: boolean; error?: string }> {
    const tenantPhone = await this.prisma.tenantPhoneNumber.findUnique({
      where: { id: tenantPhoneId },
    });

    if (!tenantPhone) {
      return { success: false, error: 'Phone number not found' };
    }

    // Release via Sigcore if we have an allocation ID
    if (tenantPhone.sigcoreAllocationId) {
      try {
        const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
        const platformKey = this.configService.get<string>('SIGCORE_API_KEY') || '';
        await fetch(`${sigcoreUrl}/tenants/${tenantPhone.sigcoreAllocationId}/phone-numbers/release`, {
          method: 'POST',
          headers: { 'x-api-key': platformKey, 'Content-Type': 'application/json' },
        });
        this.logger.log(`[releaseTenantPhone] Released via Sigcore: ${tenantPhone.phoneNumber}`);
      } catch (err) {
        this.logger.warn(`[releaseTenantPhone] Sigcore release failed: ${err.message}`);
      }
    }

    // Mark as released
    await this.prisma.tenantPhoneNumber.update({
      where: { id: tenantPhoneId },
      data: { status: 'RELEASED', releasedAt: new Date() },
    });

    // If this was the user's active fromPhone, clear it
    if (tenantPhone.savedAccountId) {
      const settings = await this.prisma.notificationSettings.findUnique({
        where: { savedAccountId: tenantPhone.savedAccountId },
      });
      if (settings?.sigcoreFromPhone === tenantPhone.phoneNumber) {
        await this.prisma.notificationSettings.update({
          where: { savedAccountId: tenantPhone.savedAccountId },
          data: { sigcoreFromPhone: null },
        });
      }
    }

    this.logger.log(`[releaseTenantPhone] ${tenantPhone.phoneNumber} → RELEASED`);
    return { success: true };
  }

  async processGracePeriodExpirations(): Promise<number> {
    const expired = await this.prisma.tenantPhoneNumber.findMany({
      where: {
        status: 'GRACE_PERIOD',
        gracePeriodEndsAt: { lt: new Date() },
      },
    });

    let released = 0;
    for (const phone of expired) {
      const result = await this.releaseTenantPhoneNumber(phone.id);
      if (result.success) released++;
    }

    if (released > 0) {
      this.logger.log(`[processGracePeriodExpirations] Released ${released} expired numbers`);
    }
    return released;
  }
}
