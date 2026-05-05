/**
 * Automation Service
 * Manages automation rules and pending automated messages
 */

import { Injectable, NotFoundException, OnModuleInit, Inject, forwardRef, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { TemplatesService } from '../templates/templates.service';
import { LeadsService } from '../leads/leads.service';
import { LeadStatusService } from '../leads/lead-status.service';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { TrialService } from '../trial/trial.service';
import { buildPriceRangeInstruction } from '../ai/price-range';

/**
 * Customer-reply phrase sets used by both:
 *   - the AI Conversation skip checks below in handleCustomerReply
 *   - the canonical Lead.status transition (detectCustomerReplyTransition)
 *
 * Exported for unit testing.
 */
export const OPT_OUT_PHRASES: readonly string[] = [
  'stop',
  'unsubscribe',
  "don't contact",
  'do not contact',
  'leave me alone',
  'remove me',
];

export const HIRED_SOMEONE_PHRASES: readonly string[] = [
  'already hired',
  'booked another',
  'found someone',
  'went with someone',
  'already have someone',
  'no longer need',
  'not interested',
];

export const AGREED_PHRASES: readonly string[] = [
  'sounds good',
  "let's do it",
  "i'll take it",
  'book it',
  'schedule it',
  "let's go",
  'perfect, when',
  'great, when',
  'yes please',
  "i'm in",
];

export type CustomerReplyTransition =
  | { kind: 'opt_out' }
  | { kind: 'hired_someone' }
  | { kind: 'agreed' }
  | { kind: 'engaged' };

/**
 * Pure: classifies a customer reply for the canonical Lead.status transition.
 * Priority: opt_out > hired_someone > agreed > engaged (default).
 *
 * Always returns a transition (default 'engaged') so the call site can always
 * attempt writeStatus and rely on its no-downgrade / same-status / terminal
 * guards to silently skip when the lead is already past `contacted`.
 */
export function detectCustomerReplyTransition(message: string): CustomerReplyTransition {
  const m = (message || '').toLowerCase();
  if (OPT_OUT_PHRASES.some((p) => m.includes(p))) return { kind: 'opt_out' };
  if (HIRED_SOMEONE_PHRASES.some((p) => m.includes(p))) return { kind: 'hired_someone' };
  if (AGREED_PHRASES.some((p) => m.includes(p))) return { kind: 'agreed' };
  return { kind: 'engaged' };
}

const REENGAGE_DAYS_AFTER_HIRED_SOMEONE = 75;

export type ReplyMode = 'custom' | 'price' | 'auto';

export interface CreateAutomationRuleDto {
  savedAccountId: string;
  name: string;
  triggerType: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  promptTemplateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  replyMode?: ReplyMode;
  aiSystemPrompt?: string; // deprecated — use promptTemplateId
  // Follow-up fields
  isFollowUp?: boolean;
  activeHoursStart?: string; // e.g. "09:00"
  activeHoursEnd?: string;   // e.g. "21:00"
  activeHoursTimezone?: string;
  stopOnCustomerReply?: boolean;
}

export interface UpdateAutomationRuleDto {
  name?: string;
  triggerType?: 'new_lead' | 'customer_reply';
  replyTriggerMode?: 'first_only' | 'every_reply';
  templateId?: string;
  promptTemplateId?: string;
  delayMinutes?: number;
  enabled?: boolean;
  useAi?: boolean;
  replyMode?: ReplyMode;
  aiSystemPrompt?: string; // deprecated — use promptTemplateId
  // Follow-up fields
  isFollowUp?: boolean;
  activeHoursStart?: string;
  activeHoursEnd?: string;
  activeHoursTimezone?: string;
  stopOnCustomerReply?: boolean;
}

export interface AutomationTriggerContext {
  userId: string;
  businessId: string;
  negotiationId: string;
  leadId: string;
  customerName: string;
  customerMessage?: string;
  accountName?: string;
  savedAccountId?: string;
  category?: string;
  city?: string;
  state?: string;
  budget?: number;
}

export interface CustomerReplyContext extends AutomationTriggerContext {
  isFirstCustomerReply: boolean;
  isSecondCustomerMessage?: boolean; // True when this is the 2nd customer message (first actual reply)
  /**
   * Optional stable identifier for the inbound customer message. Used as
   * the sourceEventId for canonical-status transitions so retries dedupe.
   * Falls back to a content-derived hash when absent.
   */
  messageId?: string;
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
    private conversationContext: ConversationContextService,
    private trialService: TrialService,
    @Inject(forwardRef(() => LeadStatusService))
    private leadStatusService: LeadStatusService,
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
        promptTemplate: {
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
        promptTemplate: {
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
        replyMode: data.replyMode ?? (data.useAi ? 'auto' : 'custom'),
        promptTemplateId: data.useAi ? (data.promptTemplateId ?? null) : null,
        aiSystemPrompt: data.aiSystemPrompt ?? null,
        isFollowUp: data.isFollowUp ?? false,
        activeHoursStart: data.activeHoursStart ?? null,
        activeHoursEnd: data.activeHoursEnd ?? null,
        activeHoursTimezone: data.activeHoursTimezone ?? 'America/New_York',
        stopOnCustomerReply: data.stopOnCustomerReply ?? true,
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
        ...(data.replyMode !== undefined && { replyMode: data.replyMode }),
        ...(data.promptTemplateId !== undefined && { promptTemplateId: data.promptTemplateId || null }),
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

    // Trial paywall: new leads are blocked the moment trial ends. Existing
    // conversations get the 24h grace via canProcessLead(conversationId), but
    // a new lead has no prior conversation so we omit conversationId here.
    const allowed = await this.trialService.canProcessLead(context.userId);
    if (!allowed.allowed) {
      this.logger.log(`[AUTOMATION] ✗ BLOCKED handleNewLead — user ${context.userId} reason=${allowed.reason}`);
      return;
    }

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
        promptTemplate: true,
      },
    });

    this.logger.log(`Found ${rules.length} new_lead rules for account ${savedAccount.businessName}`);

    const enrichedContext = { ...context, savedAccountId: savedAccount.id, accountName: context.accountName || savedAccount.businessName };
    for (const rule of rules) {
      await this.scheduleAutomatedMessage(rule, enrichedContext);
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

    // Trial paywall: customer replies on existing conversations get 24h grace
    // after trial end. Look up the lead's thread so canProcessLead can check.
    const lead = await this.prisma.lead.findUnique({
      where: { id: context.leadId },
      select: { threadId: true },
    });
    const allowed = await this.trialService.canProcessLead(context.userId, lead?.threadId ?? undefined);
    if (!allowed.allowed) {
      this.logger.log(`[AUTOMATION] ✗ BLOCKED handleCustomerReply — user ${context.userId} reason=${allowed.reason}`);
      return;
    }

    // ── Canonical status transition ───────────────────────────────────────
    // Fires on every customer reply, independent of whether automation rules
    // or AI Conversation handle the response. The LeadStatusService guards
    // (no-downgrade / same-status / terminal / SF-protect / dedup) decide
    // whether the write actually applies.
    await this.applyCustomerReplyStatusTransition(context).catch((err) => {
      this.logger.warn(`[AUTOMATION] status transition failed for lead ${context.leadId}: ${err.message}`);
    });

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
        promptTemplate: true,
      },
    });

    this.logger.log(`[AUTOMATION] Found ${rules.length} customer_reply rule(s) for account ${savedAccount.businessName}`);

    const enrichedContext = { ...context, savedAccountId: savedAccount.id, accountName: context.accountName || savedAccount.businessName };
    for (const rule of rules) {
      // Check reply trigger mode - "first_only" means the first reply AFTER initial message (2nd message)
      if (rule.replyTriggerMode === 'first_only' && context.isSecondCustomerMessage !== true) {
        this.logger.log(`[AUTOMATION] ✗ SKIPPED rule "${rule.name}" (${rule.id}): mode=first_only but this is not the 2nd customer message`);
        continue;
      }

      this.logger.log(`[AUTOMATION] ✓ TRIGGERING rule "${rule.name}" (${rule.id}): mode=${rule.replyTriggerMode || 'every_reply'}`);
      await this.scheduleAutomatedMessage(rule, enrichedContext);
    }

    // AI Conversation: if no customer_reply rules but account has aiConversationEnabled,
    // auto-reply to customer messages using AI (ongoing conversation handling)
    if (rules.length === 0 && savedAccount.aiConversationEnabled) {
      this.logger.log(`[AUTOMATION] AI Conversation enabled for ${savedAccount.businessName} — generating AI reply to customer message`);

      // Load AI conversation rules from settings
      let aiRules: any = {};
      if (savedAccount.followUpSettingsJson) {
        try { aiRules = JSON.parse(savedAccount.followUpSettingsJson); } catch {}
      }

      // Check terminal lead status — don't reply to done/hired/archived leads
      const lead = context.leadId ? await this.prisma.lead.findUnique({
        where: { id: context.leadId },
        select: { status: true, thumbtackStatus: true, threadId: true },
      }) : null;
      if (lead) {
        const s = (lead.status || '').toLowerCase();
        const ts = (lead.thumbtackStatus || '').toLowerCase();
        const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'completed', 'archived', 'lost'];
        if (terminal.includes(s) || terminal.includes(ts)) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — lead status is "${s || ts}"`);
          return;
        }
      }

      // Check AI conversation rules
      // Rule: stop on opt-out keywords in customer message
      if (aiRules.aiStopOnOptOut !== false && context.customerMessage) {
        const optOutPhrases = ['stop', 'unsubscribe', 'don\'t contact', 'do not contact', 'leave me alone', 'not interested', 'remove me'];
        const msgLower = context.customerMessage.toLowerCase();
        if (optOutPhrases.some(p => msgLower.includes(p))) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — customer opted out`);
          return;
        }
      }

      // Rule: stop on booked/hired keywords
      if (aiRules.aiStopOnBooked !== false && context.customerMessage) {
        const bookedPhrases = ['already hired', 'booked another', 'found someone', 'went with someone', 'already have someone', 'no longer need'];
        const msgLower = context.customerMessage.toLowerCase();
        if (bookedPhrases.some(p => msgLower.includes(p))) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — customer booked elsewhere`);
          return;
        }
      }

      // Rule: stop on price agreed — hand off to manager
      if (aiRules.aiStopOnPriceAgreed && context.customerMessage) {
        const agreedPhrases = ['sounds good', 'let\'s do it', 'i\'ll take it', 'book it', 'schedule it', 'let\'s go', 'perfect, when', 'great, when', 'yes please', 'i\'m in'];
        const msgLower = context.customerMessage.toLowerCase();
        if (agreedPhrases.some(p => msgLower.includes(p))) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation paused — customer agreed on price, handing off to manager`);
          return;
        }
      }

      // Rule: max replies per conversation
      if (aiRules.aiMaxReplies && aiRules.aiMaxReplies > 0 && lead?.threadId) {
        const aiReplyCount = await this.prisma.message.count({
          where: { conversationId: lead.threadId, sender: 'pro', senderType: 'ai' },
        });
        if (aiReplyCount >= aiRules.aiMaxReplies) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation stopped — reached max ${aiRules.aiMaxReplies} replies (sent ${aiReplyCount})`);
          return;
        }
      }

      // Create a synthetic AI rule so we can reuse scheduleAutomatedMessage
      const syntheticRule = {
        id: `ai-conversation-${savedAccount.id}`,
        name: 'AI Conversation',
        triggerType: 'customer_reply' as const,
        useAi: true,
        templateId: null,
        template: null,
        promptTemplateId: null,
        promptTemplate: null,
        delayMinutes: 0,
        enabled: true,
        savedAccountId: savedAccount.id,
        activeHoursStart: savedAccount.followUpActiveHoursStart,
        activeHoursEnd: savedAccount.followUpActiveHoursEnd,
        activeHoursTimezone: savedAccount.followUpTimezone,
        stopOnCustomerReply: true,
      };

      await this.scheduleAutomatedMessage(syntheticRule, enrichedContext);
    }
  }

  /**
   * Run the canonical Lead.status transition triggered by a customer reply.
   * Returns the writeStatus result so callers (and tests) can inspect what
   * happened. Errors are surfaced — callers should wrap if they want best-effort
   * semantics.
   *
   * Decision table (handled by detectCustomerReplyTransition):
   *   opt-out phrase           -> lost   (lostReason='opt_out')
   *   hired-someone phrase     -> lost   (lostReason='hired_someone',
   *                                       reengageAt=now+75d)
   *   agreed phrase            -> booked
   *   anything else            -> engaged
   *                              (no-downgrade guard silently skips when the
   *                              lead is already past contacted)
   */
  private async applyCustomerReplyStatusTransition(context: CustomerReplyContext) {
    if (!context.leadId || !context.customerMessage) return;

    const transition = detectCustomerReplyTransition(context.customerMessage);
    const sourceEventId = context.messageId
      ? `reply_${context.messageId}_${transition.kind}`
      : `reply_${context.leadId}_${transition.kind}_${createHash('sha256')
          .update(context.customerMessage)
          .digest('hex')
          .slice(0, 16)}`;

    const base = {
      leadId: context.leadId,
      source: 'lb_automation' as const,
      sourceEventId,
      actorType: 'system' as const,
    };

    switch (transition.kind) {
      case 'opt_out':
        return this.leadStatusService.writeStatus({
          ...base,
          newStatus: 'lost',
          lostReason: 'opt_out',
          reason: 'opt_out',
        });

      case 'hired_someone': {
        const reengageAt = new Date(
          Date.now() + REENGAGE_DAYS_AFTER_HIRED_SOMEONE * 24 * 60 * 60 * 1000,
        );
        return this.leadStatusService.writeStatus({
          ...base,
          newStatus: 'lost',
          lostReason: 'hired_someone',
          reason: 'hired_someone',
          reengageAt,
        });
      }

      case 'agreed':
        return this.leadStatusService.writeStatus({
          ...base,
          newStatus: 'booked',
          reason: 'price_agreed',
        });

      case 'engaged':
        // No-downgrade guard handles the case where the lead is already past
        // contacted (engaged/quoted/booked/etc.) — writeStatus will silently skip.
        return this.leadStatusService.writeStatus({
          ...base,
          newStatus: 'engaged',
          reason: 'customer_replied',
        });
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
    // Synthetic AI Conversation rules (id `ai-conversation-<accountId>`) have no
    // matching AutomationRule row, so we can't create a PendingAutomatedMessage
    // (FK violation) or bump triggerCount. Execute in-memory with a synthetic
    // pendingId — executePendingMessage detects the prefix and skips DB writes.
    if (typeof rule.id === 'string' && rule.id.startsWith('ai-conversation-')) {
      const syntheticId = `synthetic-${rule.id}-${context.negotiationId}`;
      this.logger.log(`[AI Conversation] executing synthetic rule ${rule.id} for ${context.negotiationId}`);
      await this.executePendingMessage(syntheticId, rule, context);
      return;
    }

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
    rule: { id: string; useAi: boolean; replyMode?: string | null; aiSystemPrompt?: string | null; promptTemplate?: { id: string; content: string } | null; template?: { id: string; content: string } | null },
    context: AutomationTriggerContext,
  ): Promise<void> {
    this.logger.log(`Executing pending message: ${pendingId} (useAi=${rule.useAi})`);

    try {
      // Check active hours for follow-up rules
      const fullRule = await this.prisma.automationRule.findUnique({ where: { id: rule.id } });
      if (fullRule?.isFollowUp && fullRule.activeHoursStart && fullRule.activeHoursEnd) {
        if (!this.isInActiveHours(fullRule.activeHoursStart, fullRule.activeHoursEnd, fullRule.activeHoursTimezone || 'America/New_York')) {
          // Outside active hours — reschedule to check again in 15 min
          this.logger.log(`Follow-up ${pendingId} outside active hours (${fullRule.activeHoursStart}-${fullRule.activeHoursEnd}), rescheduling in 15 min`);
          this.scheduleTimer(pendingId, 15 * 60 * 1000, rule, context);
          return;
        }
      }

      // Check stopOnCustomerReply — cancel if customer replied after scheduling
      if (fullRule?.stopOnCustomerReply && fullRule.isFollowUp) {
        const pending = await this.prisma.pendingAutomatedMessage.findUnique({ where: { id: pendingId } });
        if (pending) {
          const customerReplySince = await this.prisma.message.findFirst({
            where: {
              conversationId: { not: undefined },
              userId: context.userId,
              sender: 'customer',
              sentAt: { gt: pending.createdAt },
            },
            orderBy: { sentAt: 'desc' },
            select: { id: true },
          });
          if (customerReplySince) {
            this.logger.log(`Follow-up ${pendingId} cancelled — customer replied since scheduling`);
            await this.prisma.pendingAutomatedMessage.update({
              where: { id: pendingId },
              data: { status: 'cancelled', failureReason: 'Customer replied' },
            });
            return;
          }
        }
      }

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
        // Try thread context first (summary + state + recent messages)
        // Falls back to raw transcript if no ThreadContext exists yet
        const threadCtx = lead.threadId
          ? await this.conversationContext.buildContext(lead.threadId).catch(() => null)
          : null;

        let conversationHistory: { role: 'customer' | 'pro'; content: string; sentAt?: Date }[];
        let customerMessage: string;
        let threadContextPrompt: string | undefined;

        if (threadCtx) {
          // Use enriched context — summary + state instead of full transcript
          conversationHistory = threadCtx.recentMessages;
          threadContextPrompt = threadCtx.systemContext;
          const firstCustomerMsg = conversationHistory.find(m => m.role === 'customer')?.content;
          customerMessage = firstCustomerMsg || context.customerMessage || lead.message || '';
          this.logger.log(`[AI] Using thread context for ${pendingId} (stage: ${threadCtx.threadState.stage}, msgs: ${conversationHistory.length})`);
        } else {
          // Fallback: load raw transcript (no ThreadContext yet)
          const existingMessages = lead.threadId ? await this.prisma.message.findMany({
            where: { conversationId: lead.threadId },
            orderBy: { createdAt: 'asc' },
          }) : [];
          conversationHistory = existingMessages
            .filter(m => m.content?.trim())
            .map(m => ({
              role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
              content: m.content!,
              sentAt: m.sentAt,
            }));
          const firstCustomerMsg = conversationHistory.find(m => m.role === 'customer')?.content;
          customerMessage = firstCustomerMsg || context.customerMessage || lead.message || '';
          this.logger.log(`[AI] Using raw transcript for ${pendingId} (no thread context, ${conversationHistory.length} msgs)`);
        }

        // Extract structured lead details from rawJson
        const leadDetails = this.extractLeadDetails(lead.rawJson);

        // Fetch user's global AI prompt + name (used for business context)
        const userRecord = await this.prisma.user.findUnique({
          where: { id: context.userId },
          select: { globalAiPrompt: true, name: true },
        });

        // PRIMARY INSTRUCTION — strategy prompt
        // - replyMode='price' → force price anchor strategy (ignore user prompt template)
        // - replyMode='auto'  → rule.promptTemplate/aiSystemPrompt → fallback hybrid
        // - user prompt templates dominate the strategy default and are passed
        //   through as-is. The reactive pricing policy in the GLOBAL prompt
        //   (templates.service.ts DEFAULT_GLOBAL_AI_PROMPT) prevents the AI
        //   from volunteering a price when the user's template is silent on it.
        const { STRATEGY_PROMPTS } = require('../ai/strategy-prompts');
        const ruleReplyMode = (rule as any).replyMode as 'custom' | 'price' | 'auto' | undefined;
        let strategyPrompt: string;
        if (ruleReplyMode === 'price') {
          strategyPrompt = STRATEGY_PROMPTS.price;
        } else {
          strategyPrompt = rule.promptTemplate?.content || rule.aiSystemPrompt || STRATEGY_PROMPTS.hybrid;
        }

        // Pricing context from account settings, with sibling-account fallback
        // when this account has none of its own.
        const account = context.businessId
          ? await this.prisma.savedAccount.findFirst({
              where: { userId: context.userId, businessId: context.businessId },
              select: {
                businessName: true,
                servicePricingJson: true,
                followUpSettingsJson: true,
                followUpActiveHoursStart: true,
                followUpActiveHoursEnd: true,
                followUpTimezone: true,
              },
            })
          : null;

        // REFERENCE: business profile (name, owner, turnaround, active hours,
        // scheduling rules). Without this the AI fabricates specific time slots
        // — see business-context.ts.
        const { buildBusinessContextBlock } = require('../ai/business-context');
        const businessBlock = buildBusinessContextBlock({
          businessName: account?.businessName ?? context.accountName ?? null,
          ownerName: userRecord?.name ?? null,
          city: context.city ?? null,
          state: context.state ?? null,
          followUpSettingsJson: account?.followUpSettingsJson ?? null,
          activeHoursStart: account?.followUpActiveHoursStart ?? null,
          activeHoursEnd: account?.followUpActiveHoursEnd ?? null,
          timezone: account?.followUpTimezone ?? null,
        });

        let pricingJson: string | null = account?.servicePricingJson ?? null;
        if (!pricingJson) {
          const sibling = await this.prisma.savedAccount.findFirst({
            where: { userId: context.userId, servicePricingJson: { not: null } },
            select: { servicePricingJson: true },
            orderBy: { createdAt: 'asc' },
          });
          pricingJson = sibling?.servicePricingJson ?? null;
        }

        // REFERENCE: pricing table — only consulted when the PRIMARY
        // INSTRUCTION says to quote, or when the customer asks about price.
        let pricingBlock: string | undefined;
        if (pricingJson) {
          try {
            const p = JSON.parse(pricingJson);
            const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
            if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
              const priceParts: string[] = [];
              for (const row of p.priceTable.slice(0, 10)) {
                const prices = enabledTypes.map((t: any) => `${t.label}: $${row[t.key] || '?'}`).join(', ');
                priceParts.push(`  ${row.bed}BR/${row.bath}BA — ${prices}`);
              }
              priceParts.push('');
              priceParts.push(buildPriceRangeInstruction(p.priceRange));
              pricingBlock = priceParts.join('\n');
            }
          } catch { /* invalid JSON */ }
        }

        // Generate reply via OpenAI. Pass current time + timezone so the model
        // knows whether previously offered slots have passed and how big the
        // gaps between messages are.
        messageToSend = await this.aiService.generateReply({
          customerName: context.customerName,
          customerMessage,
          category: context.category,
          city: context.city,
          state: context.state,
          budget: context.budget,
          accountName: context.accountName,
          globalPrompt: userRecord?.globalAiPrompt || undefined,
          strategyPrompt,
          threadContextBlock: threadContextPrompt,
          businessBlock,
          pricingBlock,
          conversationHistory,
          leadDetails,
          currentTime: new Date(),
          timezone: fullRule?.activeHoursTimezone || 'America/New_York',
        });
        this.logger.log(`[AI] Generated reply for pending message ${pendingId} (threadCtx: ${!!threadCtx}, history: ${conversationHistory.length} msgs)`);
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
      await this.leadsService.sendMessage(context.userId, context.leadId, messageToSend, rule.useAi ? 'ai' : 'user');

      // Record outbound message in thread context
      if (lead.threadId) {
        this.conversationContext.recordMessage({
          conversationId: lead.threadId,
          leadId: lead.id,
          platform: lead.platform,
          sender: 'pro',
          senderType: rule.useAi ? 'ai' : 'business',
          content: messageToSend,
          aiGenerated: rule.useAi,
          strategyUsed: (rule.promptTemplate as any)?.name || undefined,
          isAutoFollowUp: (rule as any).delayMinutes > 0,
        }).catch(err => this.logger.warn(`Failed to record outbound in context: ${err.message}`));
      }

      // Mark as sent (skip for synthetic AI Conversation rules — no DB row)
      if (!pendingId.startsWith('synthetic-')) {
        await this.prisma.pendingAutomatedMessage.update({
          where: { id: pendingId },
          data: { status: 'sent', sentAt: new Date() },
        });
      }

      // Record template usage if applicable
      if (!rule.useAi && rule.template) {
        await this.templatesService.recordUsage(context.userId, rule.template.id);
      }

      this.logger.log(`Successfully sent automated message: ${pendingId}`);
    } catch (error: any) {
      this.logger.error(`Failed to send automated message: ${pendingId} — ${error.message}`);

      if (!pendingId.startsWith('synthetic-')) {
        await this.prisma.pendingAutomatedMessage.update({
          where: { id: pendingId },
          data: { status: 'failed', failureReason: error.message },
        });
      }

      // Capture to monitoring for dashboard + email alert
      this.monitoring.captureError({
        category: 'automation',
        message: error.message || 'Failed to send automated message',
        userId: context.userId,
        accountId: context.savedAccountId,
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
    rule: { id: string; useAi: boolean; replyMode?: string | null; aiSystemPrompt?: string | null; promptTemplate?: { id: string; content: string } | null; template?: { id: string; content: string } | null },
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
   * Check if current time is within the active hours window.
   * Used by follow-up rules to only send during business hours.
   */
  private isInActiveHours(start: string, end: string, timezone: string): boolean {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const currentTime = formatter.format(new Date());
      const [currentHour, currentMin] = currentTime.split(':').map(Number);
      const [startHour, startMin] = start.split(':').map(Number);
      const [endHour, endMin] = end.split(':').map(Number);

      const currentMinutes = currentHour * 60 + currentMin;
      const startMinutes = startHour * 60 + startMin;
      const endMinutes = endHour * 60 + endMin;

      // Handle overnight active hours (e.g., 22:00 to 06:00)
      if (startMinutes > endMinutes) {
        return currentMinutes >= startMinutes || currentMinutes < endMinutes;
      }
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    } catch {
      return true; // On error, allow sending
    }
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
            promptTemplate: true,
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
      replyMode: (rule.replyMode as 'custom' | 'price' | 'auto') || (rule.useAi ? 'auto' : 'custom'),
      promptTemplateId: rule.promptTemplateId || null,
      aiSystemPrompt: rule.aiSystemPrompt || null,
      isFollowUp: rule.isFollowUp || false,
      activeHoursStart: rule.activeHoursStart || null,
      activeHoursEnd: rule.activeHoursEnd || null,
      activeHoursTimezone: rule.activeHoursTimezone || null,
      stopOnCustomerReply: rule.stopOnCustomerReply ?? true,
      triggerCount: rule.triggerCount,
      lastTriggeredAt: rule.lastTriggeredAt?.toISOString() || null,
      createdAt: rule.createdAt.toISOString(),
      savedAccount: rule.savedAccount,
      template: rule.template,
      promptTemplate: (rule as any).promptTemplate || null,
    };
  }
}
