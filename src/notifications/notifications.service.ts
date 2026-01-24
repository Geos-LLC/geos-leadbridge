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

export interface CallioPhoneNumber {
  id: string;
  phoneNumber: string;
  provider: 'twilio' | 'openphone';
  friendlyName?: string;
  capabilities?: string[];
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

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return null;
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
        enabled: data.enabled ?? false,
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
   * Send notification for a new lead
   * Called by webhook handler when a new lead is created
   */
  async sendLeadNotification(context: SendNotificationContext): Promise<void> {
    const { userId, savedAccountId, leadId, lead } = context;

    this.logger.log(`Checking notification settings for account ${savedAccountId}`);

    // Get settings for this account
    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      this.logger.log(`No notification settings for account ${savedAccountId}`);
      return;
    }

    if (!settings.enabled) {
      this.logger.log(`Notifications disabled for account ${savedAccountId}`);
      return;
    }

    if (!settings.destinationPhone) {
      this.logger.warn(`No destination phone configured for account ${savedAccountId}`);
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

    // Render the message template
    const messageBody = this.renderTemplate(settings.template, lead);

    // Create notification log entry
    const logEntry = await this.prisma.notificationLog.create({
      data: {
        notificationSettingsId: settings.id,
        leadId,
        toPhone: settings.destinationPhone,
        fromPhone: settings.callioFromPhone,
        status: 'pending',
        messageBody,
        metadata: JSON.stringify({ userId, savedAccountId }),
      },
    });

    // Send via Callio
    try {
      const result = await this.sendViaCallio({
        to: settings.destinationPhone,
        body: messageBody,
        fromPhone: settings.callioFromPhone,
        apiKey: settings.callioApiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        callioWorkspaceId: settings.callioWorkspaceId,
        metadata: {
          tenantId: savedAccountId,
          leadId,
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

      this.logger.log(`Notification sent for lead ${leadId} to ${settings.destinationPhone}`);
    } catch (error: any) {
      // Update log with error
      await this.prisma.notificationLog.update({
        where: { id: logEntry.id },
        data: {
          status: 'failed',
          error: error.message || 'Unknown error',
        },
      });

      this.logger.error(`Failed to send notification for lead ${leadId}`, error);
    }
  }

  /**
   * Send test notification
   */
  async sendTestNotification(
    userId: string,
    savedAccountId: string,
  ): Promise<{ success: boolean; error?: string }> {
    // Get full settings from database (not masked response)
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId },
    });

    if (!account) {
      return { success: false, error: 'Saved account not found' };
    }

    const settings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
    });

    if (!settings) {
      return { success: false, error: 'Notification settings not configured' };
    }

    if (!settings.destinationPhone) {
      return { success: false, error: 'No destination phone configured' };
    }

    if (!settings.callioApiKey) {
      return { success: false, error: 'No Callio API key configured. Please connect to Callio first.' };
    }

    const testLead = {
      customerName: 'Test Customer',
      customerPhone: '+15551234567',
      category: 'House Cleaning',
      city: 'Tampa',
      state: 'FL',
    };

    const messageBody = this.renderTemplate(settings.template, testLead);

    // Create notification log entry
    const logEntry = await this.prisma.notificationLog.create({
      data: {
        notificationSettingsId: settings.id,
        toPhone: settings.destinationPhone,
        fromPhone: settings.callioFromPhone,
        status: 'pending',
        messageBody: `[TEST] ${messageBody}`,
        metadata: JSON.stringify({ test: true }),
      },
    });

    try {
      const result = await this.sendViaCallio({
        to: settings.destinationPhone,
        body: `[TEST] ${messageBody}`,
        fromPhone: settings.callioFromPhone,
        apiKey: settings.callioApiKey,
        senderMode: settings.senderMode as 'shared' | 'dedicated' | 'openphone',
        callioWorkspaceId: settings.callioWorkspaceId,
        metadata: {
          tenantId: savedAccountId,
          test: true,
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
    },
  ): string {
    let message = template;

    // Replace variables
    message = message.replace(/\{\{lead\.name\}\}/gi, lead.customerName || 'Unknown');
    message = message.replace(/\{\{lead\.phone\}\}/gi, lead.customerPhone || 'Not provided');
    message = message.replace(/\{\{lead\.service\}\}/gi, lead.category || 'Not specified');

    const location = [lead.city, lead.state].filter(Boolean).join(', ') || 'Not specified';
    message = message.replace(/\{\{lead\.location\}\}/gi, location);

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
      const response = await fetch(
        'https://callio-production-47ac.up.railway.app/v1/phone-numbers',
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${settings.callioApiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        this.logger.error(`Callio API error: ${response.status} - ${error}`);
        throw new Error(`Failed to fetch phone numbers: ${response.status}`);
      }

      const result = await response.json();
      this.logger.log(`Callio phone numbers response: ${JSON.stringify(result)}`);

      // Handle different response formats from Callio API
      const phones = result.data || result.phoneNumbers || result || [];
      this.logger.log(`Raw phones array (getPhoneNumbers): ${JSON.stringify(phones)}`);

      return phones
        .map((phone: any) => {
          const phoneNumber = phone.phoneNumber || phone.phone_number || phone.number || phone.e164;
          return {
            id: phone.id || phone._id || phoneNumber || String(Math.random()),
            phoneNumber: phoneNumber,
            provider: phone.provider || phone.carrier || phone.type || 'unknown',
            friendlyName: phone.friendlyName || phone.friendly_name || phone.name || phone.label || '',
            capabilities: phone.capabilities || [],
          };
        })
        .filter((p: any) => p.phoneNumber && p.phoneNumber.length > 5);
    } catch (error: any) {
      this.logger.error('Failed to fetch Callio phone numbers', error);
      throw new Error(error.message || 'Failed to connect to Callio');
    }
  }

  /**
   * Validate Callio API key by attempting to fetch phone numbers
   */
  async validateCallioApiKey(apiKey: string): Promise<{ valid: boolean; phoneNumbers: CallioPhoneNumber[] }> {
    try {
      const response = await fetch(
        'https://callio-production-47ac.up.railway.app/v1/phone-numbers',
        {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
        },
      );

      if (!response.ok) {
        return { valid: false, phoneNumbers: [] };
      }

      const result = await response.json();
      this.logger.log(`Callio validate response: ${JSON.stringify(result)}`);

      // Handle different response formats from Callio API
      const phones = result.data || result.phoneNumbers || result || [];
      this.logger.log(`Raw phones array: ${JSON.stringify(phones)}`);

      const phoneNumbers = phones
        .map((phone: any) => {
          const phoneNumber = phone.phoneNumber || phone.phone_number || phone.number || phone.e164;
          this.logger.log(`Mapping phone: ${JSON.stringify(phone)} -> phoneNumber: ${phoneNumber}`);
          return {
            id: phone.id || phone._id || phoneNumber || String(Math.random()),
            phoneNumber: phoneNumber,
            provider: phone.provider || phone.carrier || phone.type || 'unknown',
            friendlyName: phone.friendlyName || phone.friendly_name || phone.name || phone.label || '',
            capabilities: phone.capabilities || [],
          };
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

    this.logger.log(`Callio request body: ${JSON.stringify(requestBody)}`);


    try {
      const response = await fetch(
        'https://callio-production-47ac.up.railway.app/api/v1/messages/send',
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${params.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Callio API error: ${response.status} - ${errorText}`);
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
}
