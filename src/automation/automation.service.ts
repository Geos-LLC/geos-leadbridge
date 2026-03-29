/**
 * Automation Service
 * Manages automation rules and pending automated messages
 */

import { Injectable, NotFoundException, OnModuleInit, Inject, forwardRef, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { TemplatesService } from '../templates/templates.service';
import { LeadsService } from '../leads/leads.service';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { MonitoringService } from '../monitoring/monitoring.service';

export interface CreateAutomationRuleDto {
  savedAccountId: string;
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  aiSystemPrompt?: string;
}

export interface UpdateAutomationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  aiSystemPrompt?: string;
}

export interface AutomationTriggerContext {
  userId: string;
  businessId: string;
  negotiationId: string;
  leadId: string;
  customerName: string;
  customerMessage?: string;
  accountName?: string;
  category?: string;
  city?: string;
  state?: string;
  budget?: number;
}

export interface CustomerReplyContext extends AutomationTriggerContext {
  isFirstCustomerReply: boolean;
  isSecondCustomerMessage?: boolean; // True when this is the 2nd customer message (first actual reply)
}

@Injectable()
export class AutomationService implements OnModuleInit {
  private readonly logger = new Logger(AutomationService.name);
  private pendingTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private prisma: PrismaService,
    private templatesService: TemplatesService,
    @Inject(forwardRef(() => LeadsService))
    private leadsService: LeadsService,
    private configService: ConfigService,
    private aiService: AiService,
    private monitoring: MonitoringService,
  ) {}

  /**
   * On startup, restore pending messages and reschedule them
   */
  async onModuleInit(): Promise<void> {
    await this.restorePendingMessages();
  }

  // ==========================================
  // CRUD Operations
  // ==========================================

  /**
   * Get all automation rules for a user
   */
  async getRules(userId: string): Promise<any[]> {
    const rules = await this.prisma.automationRule.findMany({
      where: { userId },
      include: {
        savedAccount: {
          select: { id: true, businessId: true, businessName: true },
        },
        template: {
          select: { id: true, name: true, content: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rules.map(this.formatRule);
  }

  /**
   * Get automation rules for a specific saved account
   */
  async getRulesForAccount(userId: string, savedAccountId: string): Promise<any[]> {
    const rules = await this.prisma.automationRule.findMany({
      where: { userId, savedAccountId },
      include: {
        savedAccount: {
          select: { id: true, businessId: true, businessName: true },
        },
        template: {
          select: { id: true, name: true, content: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return rules.map(this.formatRule);
  }

  /**
   * Get a single rule by ID
   */
  async getRule(userId: string, ruleId: string): Promise<any> {
    const rule = await this.prisma.automationRule.findFirst({
      where: { id: ruleId, userId },
      include: {
        savedAccount: {
          select: { id: true, businessId: true, businessName: true },
        },
        template: {
          select: { id: true, name: true, content: true },
        },
      },
    });

    if (!rule) {
      throw new NotFoundException('Automation rule not found');
    }

    return this.formatRule(rule);
  }

  /**
   * Create a new automation rule
   */
  async createRule(userId: string, data: CreateAutomationRuleDto): Promise<any> {
    // Verify saved account belongs to user
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: { id: data.savedAccountId, userId },
    });

    if (!savedAccount) {
      throw new NotFoundException('Saved account not found');
    }

    // Verify template belongs to user (only required when not using AI)
    if (!data.useAi) {
      if (!data.templateId) {
        throw new NotFoundException('Template is required when not using AI');
      }
      const template = await this.prisma.messageTemplate.findFirst({
        where: { id: data.templateId, userId },
      });
      if (!template) {
        throw new NotFoundException('Template not found');
      }
    }

    const rule = await this.prisma.automationRule.create({
      data: {
        userId,
        savedAccountId: data.savedAccountId,
        name: data.name,
        triggerType: data.triggerType,
        replyTriggerMode: data.replyTriggerMode,
        templateId: data.useAi ? null : data.templateId,
        delayMinutes: data.delayMinutes ?? 0,
        enabled: data.enabled ?? true,
        useAi: data.useAi ?? false,
        aiSystemPrompt: data.aiSystemPrompt ?? null,
      },
      include: {
        savedAccount: {
          select: { id: true, businessId: true, businessName: true },
        },
        template: {
          select: { id: true, name: true, content: true },
        },
      },
    });

    this.logger.log(`Created automation rule: ${rule.id} - ${rule.name}`);
    return this.formatRule(rule);
  }

  /**
   * Update an existing automation rule
   */
  async updateRule(userId: string, ruleId: string, data: UpdateAutomationRuleDto): Promise<any> {
    const existing = await this.prisma.automationRule.findFirst({
      where: { id: ruleId, userId },
    });

    if (!existing) {
      throw new NotFoundException('Automation rule not found');
    }

    // If changing template, verify it belongs to user
    if (data.templateId) {
      const template = await this.prisma.messageTemplate.findFirst({
        where: { id: data.templateId, userId },
      });

      if (!template) {
        throw new NotFoundException('Template not found');
      }
    }

    const rule = await this.prisma.automationRule.update({
      where: { id: ruleId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.triggerType !== undefined && { triggerType: data.triggerType }),
        ...(data.replyTriggerMode !== undefined && { replyTriggerMode: data.replyTriggerMode }),
        ...(data.templateId !== undefined && { templateId: data.useAi ? null : data.templateId }),
        ...(data.delayMinutes !== undefined && { delayMinutes: data.delayMinutes }),
        ...(data.enabled !== undefined && { enabled: data.enabled }),
        ...(data.useAi !== undefined && { useAi: data.useAi }),
        ...(data.aiSystemPrompt !== undefined && { aiSystemPrompt: data.aiSystemPrompt }),
      },
      include: {
        savedAccount: {
          select: { id: true, businessId: true, businessName: true },
        },
        template: {
          select: { id: true, name: true, content: true },
        },
      },
    });

    this.logger.log(`Updated automation rule: ${rule.id}`);
    return this.formatRule(rule);
  }

  /**
   * Delete an automation rule
   * Cancels any pending messages and clears timers
   */
  async deleteRule(userId: string, ruleId: string): Promise<void> {
    const existing = await this.prisma.automationRule.findFirst({
      where: { id: ruleId, userId },
    });

    if (!existing) {
      throw new NotFoundException('Automation rule not found');
    }

    // Get all pending messages for this rule and cancel their timers
    const pendingMessages = await this.prisma.pendingAutomatedMessage.findMany({
      where: { automationRuleId: ruleId, status: 'pending' },
    });

    for (const pending of pendingMessages) {
      this.cancelTimer(pending.id);
    }

    // Delete rule (cascades to pending messages)
    await this.prisma.automationRule.delete({
      where: { id: ruleId },
    });

    this.logger.log(`Deleted automation rule: ${ruleId}`);
  }

  /**
   * Get pending messages for a rule
   */
  async getPendingMessages(userId: string, ruleId: string): Promise<any[]> {
    const rule = await this.prisma.automationRule.findFirst({
      where: { id: ruleId, userId },
    });

    if (!rule) {
      throw new NotFoundException('Automation rule not found');
    }

    const pending = await this.prisma.pendingAutomatedMessage.findMany({
      where: { automationRuleId: ruleId },
      include: {
        lead: {
          select: { customerName: true, category: true },
        },
      },
      orderBy: { scheduledFor: 'asc' },
    });

    return pending.map((p) => ({
      id: p.id,
      scheduledFor: p.scheduledFor.toISOString(),
      status: p.status,
      failureReason: p.failureReason,
      sentAt: p.sentAt?.toISOString() || null,
      lead: p.lead ? {
        customerName: p.lead.customerName,
        category: p.lead.category,
      } : null,
    }));
  }

  /**
   * Cancel a pending automated message
   */
  async cancelPendingMessage(userId: string, pendingId: string): Promise<void> {
    const pending = await this.prisma.pendingAutomatedMessage.findFirst({
      where: { id: pendingId },
      include: {
        automationRule: true,
      },
    });

    if (!pending || pending.automationRule.userId !== userId) {
      throw new NotFoundException('Pending message not found');
    }

    if (pending.status !== 'pending') {
      throw new NotFoundException('Message is not pending');
    }

    // Cancel timer
    this.cancelTimer(pendingId);

    // Update status
    await this.prisma.pendingAutomatedMessage.update({
      where: { id: pendingId },
      data: { status: 'cancelled' },
    });

    this.logger.log(`Cancelled pending message: ${pendingId}`);
  }

  // ==========================================
  // Trigger Handlers
  // ==========================================

  /**
   * Handle new lead event - triggers "new_lead" automation rules
   */
  async handleNewLead(context: AutomationTriggerContext): Promise<void> {
    this.logger.log(`Handling new lead automation: ${context.negotiationId} for business ${context.businessId}`);

    // Find saved account by businessId (any platform — Thumbtack, Yelp, etc.)
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: {
        userId: context.userId,
        businessId: context.businessId,
      },
    });

    if (!savedAccount) {
      this.logger.warn(`No saved account found for businessId: ${context.businessId}`);
      return;
    }

    // Find enabled new_lead rules for this account
    const rules = await this.prisma.automationRule.findMany({
      where: {
        savedAccountId: savedAccount.id,
        triggerType: 'new_lead',
        enabled: true,
      },
      include: {
        template: true,
      },
    });

    this.logger.log(`Found ${rules.length} new_lead rules for account ${savedAccount.businessName}`);

    for (const rule of rules) {
      await this.scheduleAutomatedMessage(rule, context);
    }
  }

  /**
   * Handle customer reply event - triggers "customer_reply" automation rules
   * Note: The first customer message is excluded from triggering automations.
   * This only triggers on the 2nd and subsequent customer messages.
   */
  async handleCustomerReply(context: CustomerReplyContext): Promise<void> {
    this.logger.log(`[AUTOMATION] Handling customer reply: negotiation=${context.negotiationId}, business=${context.businessId}`);
    this.logger.log(`[AUTOMATION] Message position: isFirstCustomerReply=${context.isFirstCustomerReply}, isSecondCustomerMessage=${context.isSecondCustomerMessage}`);

    // Skip the first customer message - only trigger on actual replies (2nd+ messages)
    if (context.isFirstCustomerReply) {
      this.logger.log(`[AUTOMATION] ✗ SKIPPED: First customer message - automations only trigger on replies (2nd+ messages)`);
      return;
    }

    this.logger.log(`[AUTOMATION] ✓ ELIGIBLE: This is a customer reply (not the first message)`);

    // Find saved account by businessId (any platform — Thumbtack, Yelp, etc.)
    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: {
        userId: context.userId,
        businessId: context.businessId,
      },
    });

    if (!savedAccount) {
      this.logger.warn(`[AUTOMATION] ✗ No saved account found for businessId: ${context.businessId}`);
      return;
    }

    // Find enabled customer_reply rules for this account
    const rules = await this.prisma.automationRule.findMany({
      where: {
        savedAccountId: savedAccount.id,
        triggerType: 'customer_reply',
        enabled: true,
      },
      include: {
        template: true,
      },
    });

    this.logger.log(`[AUTOMATION] Found ${rules.length} customer_reply rule(s) for account ${savedAccount.businessName}`);

    for (const rule of rules) {
      // Check reply trigger mode - "first_only" means the first reply AFTER initial message (2nd message)
      if (rule.replyTriggerMode === 'first_only' && context.isSecondCustomerMessage !== true) {
        this.logger.log(`[AUTOMATION] ✗ SKIPPED rule "${rule.name}" (${rule.id}): mode=first_only but this is not the 2nd customer message`);
        continue;
      }

      this.logger.log(`[AUTOMATION] ✓ TRIGGERING rule "${rule.name}" (${rule.id}): mode=${rule.replyTriggerMode || 'every_reply'}`);
      await this.scheduleAutomatedMessage(rule, context);
    }
  }

  // ==========================================
  // Scheduling
  // ==========================================

  /**
   * Schedule an automated message based on rule delay
   */
  private async scheduleAutomatedMessage(
    rule: any,
    context: AutomationTriggerContext,
  ): Promise<void> {
    // Check for duplicate (same rule + negotiation)
    const existing = await this.prisma.pendingAutomatedMessage.findFirst({
      where: {
        automationRuleId: rule.id,
        negotiationId: context.negotiationId,
      },
    });

    if (existing) {
      if (existing.status === 'pending') {
        // Message is still queued — don't schedule another
        this.logger.log(`Skipping duplicate: rule ${rule.id} already has pending message for ${context.negotiationId}`);
        return;
      }
      // For every_reply rules: previous message was already sent/failed/cancelled — allow a new one
      if (rule.replyTriggerMode === 'every_reply') {
        await this.prisma.pendingAutomatedMessage.delete({ where: { id: existing.id } });
      } else {
        // For new_lead / first_only rules: only send once per lead, even if the record is sent
        this.logger.log(`Skipping re-send: rule ${rule.id} (${rule.triggerType}/${rule.replyTriggerMode}) already triggered for ${context.negotiationId}`);
        return;
      }
    }

    const scheduledFor = new Date(Date.now() + rule.delayMinutes * 60 * 1000);

    // Create pending message record
    const pending = await this.prisma.pendingAutomatedMessage.create({
      data: {
        automationRuleId: rule.id,
        leadId: context.leadId,
        negotiationId: context.negotiationId,
        scheduledFor,
        status: 'pending',
      },
    });

    this.logger.log(`Created pending message: ${pending.id}, scheduled for ${scheduledFor.toISOString()}`);

    // Update rule stats
    await this.prisma.automationRule.update({
      where: { id: rule.id },
      data: {
        triggerCount: { increment: 1 },
        lastTriggeredAt: new Date(),
      },
    });

    // Schedule execution
    const delayMs = rule.delayMinutes * 60 * 1000;
    if (delayMs === 0) {
      // Execute immediately
      await this.executePendingMessage(pending.id, rule, context);
    } else {
      // Schedule for later
      this.scheduleTimer(pending.id, delayMs, rule, context);
    }
  }

  /**
   * Execute a pending automated message (send it)
   * Supports both static templates and AI-generated replies.
   */
  private async executePendingMessage(
    pendingId: string,
    rule: { id: string; useAi: boolean; aiSystemPrompt?: string | null; template?: { id: string; content: string } | null },
    context: AutomationTriggerContext,
  ): Promise<void> {
    this.logger.log(`Executing pending message: ${pendingId} (useAi=${rule.useAi})`);

    try {
      // Verify lead still has a thread
      const lead = await this.prisma.lead.findUnique({
        where: { id: context.leadId },
      });

      if (!lead) {
        throw new Error('Lead not found');
      }

      if (!lead.threadId) {
        // Conversation may not exist yet (race with webhook handler) — create it now
        this.logger.warn(`Lead ${context.leadId} has no threadId — creating conversation for negotiation ${context.negotiationId}`);
        const conversation = await this.prisma.conversation.upsert({
          where: {
            platform_externalThreadId: {
              platform: lead.platform,
              externalThreadId: lead.externalRequestId,
            },
          },
          create: {
            userId: context.userId,
            platform: lead.platform,
            externalThreadId: lead.externalRequestId,
            customerName: context.customerName,
            lastMessageAt: new Date(),
            status: 'active',
          },
          update: {},
        });
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { threadId: conversation.id },
        });
        lead.threadId = conversation.id;
      }

      let messageToSend: string;

      if (rule.useAi) {
        // Fetch conversation history for context (via lead's threadId)
        const existingMessages = lead.threadId ? await this.prisma.message.findMany({
          where: { conversationId: lead.threadId },
          orderBy: { createdAt: 'asc' },
        }) : [];
        const conversationHistory = existingMessages
          .filter(m => m.content?.trim())
          .map(m => ({
            role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
            content: m.content!,
          }));

        // Extract structured lead details from rawJson
        const leadDetails = this.extractLeadDetails(lead.rawJson);

        // Use the customer's actual first message (from conversation) if available,
        // fall back to request.description (form data only).
        // The first customer message often contains the real intent/details.
        const firstCustomerMsg = conversationHistory.find(m => m.role === 'customer')?.content;
        const customerMessage = firstCustomerMsg || context.customerMessage || lead.message || '';

        // Generate reply via OpenAI
        messageToSend = await this.aiService.generateReply({
          customerName: context.customerName,
          customerMessage,
          category: context.category,
          city: context.city,
          state: context.state,
          budget: context.budget,
          accountName: context.accountName,
          systemPrompt: rule.aiSystemPrompt ?? undefined,
          conversationHistory,
          leadDetails,
        });
        this.logger.log(`[AI] Generated reply for pending message ${pendingId} (history: ${conversationHistory.length} msgs, customerMsg: ${firstCustomerMsg ? 'from-thread' : 'from-request'})`);
      } else {
        // Use static template
        if (!rule.template) {
          throw new Error('No template configured for this automation rule');
        }
        messageToSend = this.templatesService.personalizeMessage(rule.template.content, {
          customerName: context.customerName,
          accountName: context.accountName,
          category: context.category,
          city: context.city,
          state: context.state,
        });
      }

      // Send the message
      await this.leadsService.sendMessage(context.userId, context.leadId, messageToSend);

      // Mark as sent
      await this.prisma.pendingAutomatedMessage.update({
        where: { id: pendingId },
        data: { status: 'sent', sentAt: new Date() },
      });

      // Record template usage if applicable
      if (!rule.useAi && rule.template) {
        await this.templatesService.recordUsage(context.userId, rule.template.id);
      }

      this.logger.log(`Successfully sent automated message: ${pendingId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send automated message: ${pendingId} — ${error.message}`);

      await this.prisma.pendingAutomatedMessage.update({
        where: { id: pendingId },
        data: { status: 'failed', failureReason: error.message },
      });

      // Capture to monitoring for dashboard + email alert
      this.monitoring.captureError({
        category: 'automation',
        message: error.message || 'Failed to send automated message',
        userId: context.userId,
        accountName: context.accountName,
        context: { pendingId, leadId: context.leadId, negotiationId: context.negotiationId },
      });
    }
  }

  /**
   * Schedule a timer to execute a pending message
   */
  private scheduleTimer(
    pendingId: string,
    delayMs: number,
    rule: { id: string; useAi: boolean; aiSystemPrompt?: string | null; template?: { id: string; content: string } | null },
    context: AutomationTriggerContext,
  ): void {
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(pendingId);
      await this.executePendingMessage(pendingId, rule, context);
    }, delayMs);

    this.pendingTimers.set(pendingId, timer);
    this.logger.log(`Scheduled timer for ${pendingId}, delay: ${delayMs}ms`);
  }

  /**
   * Cancel a timer for a pending message
   */
  private cancelTimer(pendingId: string): void {
    const timer = this.pendingTimers.get(pendingId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimers.delete(pendingId);
      this.logger.log(`Cancelled timer for ${pendingId}`);
    }
  }

  /**
   * Restore pending messages on startup
   * Reschedules any messages that were pending when server stopped
   */
  private async restorePendingMessages(): Promise<void> {
    this.logger.log('Restoring pending automated messages...');

    const pendingMessages = await this.prisma.pendingAutomatedMessage.findMany({
      where: { status: 'pending' },
      include: {
        automationRule: {
          include: {
            template: true,
          },
        },
        lead: true,
      },
    });

    this.logger.log(`Found ${pendingMessages.length} pending messages to restore`);

    const now = Date.now();

    for (const pending of pendingMessages) {
      const scheduledTime = pending.scheduledFor.getTime();
      const delayMs = Math.max(0, scheduledTime - now);

      const savedAccount = pending.lead.businessId
        ? await this.prisma.savedAccount.findFirst({
            where: { businessId: pending.lead.businessId },
            select: { businessName: true },
          })
        : null;

      const context: AutomationTriggerContext = {
        userId: pending.automationRule.userId,
        businessId: pending.lead.businessId || '',
        negotiationId: pending.negotiationId,
        leadId: pending.leadId,
        customerName: pending.lead.customerName,
        customerMessage: pending.lead.message || undefined,
        accountName: savedAccount?.businessName || undefined,
        category: pending.lead.category || undefined,
        city: pending.lead.city || undefined,
        state: pending.lead.state || undefined,
      };

      if (delayMs === 0) {
        // Should have already been sent - execute now
        this.logger.log(`Executing overdue message: ${pending.id}`);
        await this.executePendingMessage(pending.id, pending.automationRule, context);
      } else {
        // Reschedule for remaining time
        this.scheduleTimer(pending.id, delayMs, pending.automationRule, context);
      }
    }
  }

  /**
   * Format rule for API response
   */
  private extractLeadDetails(rawJson: string): Record<string, string> {
    try {
      const raw = JSON.parse(rawJson);
      const details: any[] = raw.request?.details || raw.details || [];
      const result: Record<string, string> = {};
      for (const item of details) {
        if (item.question && item.answer) {
          result[String(item.question)] = String(item.answer);
        }
      }
      if (raw.request?.description) result['Description'] = raw.request.description;
      if (raw.description) result['Description'] = raw.description;
      return result;
    } catch {
      return {};
    }
  }

  private formatRule(rule: any): any {
    return {
      id: rule.id,
      savedAccountId: rule.savedAccountId,
      name: rule.name,
      triggerType: rule.triggerType,
      replyTriggerMode: rule.replyTriggerMode,
      templateId: rule.templateId,
      delayMinutes: rule.delayMinutes,
      enabled: rule.enabled,
      useAi: rule.useAi,
      aiSystemPrompt: rule.aiSystemPrompt || null,
      triggerCount: rule.triggerCount,
      lastTriggeredAt: rule.lastTriggeredAt?.toISOString() || null,
      createdAt: rule.createdAt.toISOString(),
      savedAccount: rule.savedAccount,
      template: rule.template,
    };
  }
}
