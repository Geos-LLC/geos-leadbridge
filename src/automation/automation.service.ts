/**
 * Automation Service
 * Manages automation rules and pending automated messages
 */

import { Injectable, NotFoundException, OnModuleInit, Inject, forwardRef, Logger, Optional } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { parseDuration } from '../common/utils/parse-duration';
import { BusinessHoursService } from '../common/utils/business-hours.service';
import { resolveTimezone } from '../common/utils/account-timezone';
import { TemplatesService } from '../templates/templates.service';
import { LeadsService } from '../leads/leads.service';
import { LeadStatusService } from '../leads/lead-status.service';
import { extractLeadDetails } from '../leads/extract-lead-details';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { IntentClassifierService, IntentClassification, HandoffReason } from '../ai/intent-classifier.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { ConversationRuntimeService } from '../conversation-context/conversation-runtime.service';
import { BookingOrchestratorService } from '../booking-orchestrator/booking-orchestrator.service';
import {
  AI_STATUS_REASONS,
  CONVERSATION_STATE_REASONS,
} from '../conversation-context/conversation-runtime';
import { TrialService } from '../trial/trial.service';
import { buildPriceRangeInstruction } from '../ai/price-range';
import { buildPricingGuardRules } from '../ai/pricing-guards';
import { hydratePricing } from '../users/pricing-hydrate';
import { computeQuoteAndIntent } from '../pricing/pricing-engine';
import { FollowUpEngineService } from '../follow-up-engine/follow-up-engine.service';
import { ensureCustomerReplyPresets } from '../follow-up-engine/follow-up-seed';
import { NotificationsService } from '../notifications/notifications.service';
import { ServiceProfileService } from '../service-profile/service-profile.service';
import { buildPlaybookSettingsForRenderer } from '../service-profile/service-profile.types';
import { isAutomationOwner, logSkippedAutomation } from '../common/automation-owner';

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
  // Cancellation phrases — Lewam case: customer said "It's ok we can cancel" /
  // "No it is canceled" / "That was canceled" multiple times. Without these
  // the lead stayed status=new, AI kept auto-replying, and a fresh follow-up
  // enrollment fired 24h later asking "are you still interested?". Treating
  // these as opt-out marks the lead lost, blocks future enrollments, and
  // stops AI Conversation immediately.
  'is canceled',
  'is cancelled',
  'was canceled',
  'was cancelled',
  'cancel it',
  'cancel that',
  'cancel the',
  'cancel my',
  'cancel this',
  'we cancel',
  'we can cancel',
  'we will cancel',
  'please cancel',
  'i cancel',
  'i need to cancel',
  'i want to cancel',
  'i have to cancel',
  'going to cancel',
  'gonna cancel',
];

export const HIRED_SOMEONE_PHRASES: readonly string[] = [
  'already hired',
  'booked another',
  'found someone',
  'went with someone',
  'already have someone',
  'no longer need',
  'not interested',
  // Donna case: customer said "It's already done, thanks" / "It's already done,
  // thank you" twice. Lead stayed status=new, AI kept auto-replying with a
  // hallucinated condolence + repeat price quote. Treating these as
  // hired-someone flips the lead to lost (lostReason='hired_someone',
  // reengage in 21d) and stops AI Conversation immediately.
  'already done',
  'all done',
  'all set',
  'taken care of',
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

// 21 days — aligned with the customer_hired_competitor FollowUpEnrollment so
// there is one canonical re-engagement clock. Previously 75 days; superseded
// when the FollowUpEnrollment took over as the active re-engagement mechanism.
const REENGAGE_DAYS_AFTER_HIRED_SOMEONE = 21;

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
    private intentClassifier: IntentClassifierService,
    private monitoring: MonitoringService,
    private conversationContext: ConversationContextService,
    private trialService: TrialService,
    @Inject(forwardRef(() => LeadStatusService))
    private leadStatusService: LeadStatusService,
    @Inject(forwardRef(() => FollowUpEngineService))
    private followUpEngine: FollowUpEngineService,
    private notifications: NotificationsService,
    private businessHours: BusinessHoursService,
    // Phase 1 — durable conversation runtime state. Parallel-write only;
    // no read paths in Phase 1.
    private conversationRuntime: ConversationRuntimeService,
    // Phase 2B — booking orchestrator. Flag-gated, additive. No-ops on
    // every tenant not in BOOKING_ORCHESTRATION_ENABLED_USER_IDS.
    @Inject(forwardRef(() => BookingOrchestratorService))
    private bookingOrchestrator: BookingOrchestratorService,
    // ServiceProfile resolver (Phase 1b adoption). @Inject + @Optional
    // ensures Nest finds the provider when wired AND falls back to null
    // when not (legacy unit tests direct-instantiating without DI). Bare
    // @Optional alone was observed to resolve to null in prod despite
    // the import being correct — explicit token closes that.
    @Optional()
    @Inject(ServiceProfileService)
    private serviceProfile: ServiceProfileService | null = null,
  ) {}

  /**
   * Enroll a conversation in a customer-reply trigger sequence (deferred /
   * hired-competitor). Lazy-seeds the template if this account pre-dates
   * the feature. Single-step sequences with literal-message generation.
   * Idempotent — enrollInSequence already returns the existing enrollment
   * if one is active on the conversation.
   */
  private async enrollInCustomerReplySequence(
    triggerState: 'customer_deferred' | 'customer_hired_competitor',
    leadId: string,
    threadId: string | null | undefined,
    userId: string,
    platform: string,
    savedAccountId: string | null,
    activeHoursStart: string | null | undefined,
    activeHoursEnd: string | null | undefined,
    activeHoursTimezone: string | null | undefined,
    /**
     * Number of days the customer explicitly named as the return window
     * ("back in 2 weeks" → 14). Overrides the first-step delay on the
     * sequence so the next re-engagement fires at the customer's stated
     * timing instead of the configured default cadence. Pass undefined when
     * no explicit duration was extracted.
     */
    suggestedReengageInDays?: number,
  ): Promise<void> {
    if (!threadId) return;
    try {
      // Lazy-seed the customer-reply trigger templates if this account
      // hasn't been seeded yet (e.g. pre-dates the feature).
      if (savedAccountId) {
        await ensureCustomerReplyPresets(
          this.prisma,
          userId,
          platform,
          savedAccountId,
          activeHoursStart || '09:00',
          activeHoursEnd || '21:00',
          activeHoursTimezone || 'America/New_York',
        );
      }

      const template = await this.prisma.followUpSequenceTemplate.findFirst({
        where: {
          ...(savedAccountId ? { savedAccountId } : { userId, savedAccountId: null }),
          platform,
          triggerState,
          enabled: true,
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      });
      if (!template) {
        this.logger.log(`[AUTOMATION] No ${triggerState} template found for account ${savedAccountId || userId} on ${platform} — skipping enrollment`);
        return;
      }

      const overrideMinutes = typeof suggestedReengageInDays === 'number' && suggestedReengageInDays > 0
        ? suggestedReengageInDays * 24 * 60
        : undefined;
      await this.followUpEngine.enrollInSequence(threadId, template.id, platform, leadId, overrideMinutes);
      const overrideBit = overrideMinutes ? ` first-step=${suggestedReengageInDays}d (customer-stated)` : '';
      this.logger.log(`[AUTOMATION] ✓ Enrolled conversation ${threadId} in ${triggerState} (template ${template.id})${overrideBit}`);
    } catch (err: any) {
      this.logger.error(`[AUTOMATION] ${triggerState} enrollment failed for ${threadId}: ${err.message}`);
    }
  }

  /**
   * Manager-handoff SMS alert, classifier-driven. Fires once per inbound
   * customer message when the LLM intent classifier returns a high-intent
   * signal:
   *   - intent='agreed'             → "ready to book" (yes please / let's do it / book it)
   *   - intent='wants_live_contact' → "wants a live call/meeting/Zoom"
   * Only fires when confidence ≥ CLASSIFIER_CONFIDENCE_THRESHOLD (0.7) and
   * fromLlm=true — phrase-list fallbacks don't trigger handoff because the
   * false-positive cost (paging the owner for nothing) is higher than for
   * status transitions.
   *
   * Single-toggle UX: there's ONE user-facing alerts switch (the existing
   * `reEngagementAlertEnabled`, surfaced in the UI as "Re-engagement
   * Alerts"). Handoff is auto-gated on `aiConversationEnabled`:
   *   - AI on  + alerts on → Handoff fires on high-intent
   *   - AI off + alerts on → Handoff doesn't fire (Re-engagement covers
   *                          customer replies via the follow-up path)
   *   - Alerts off         → neither fires
   * The split between Re-engagement and Handoff is internal architecture,
   * not a user choice.
   *
   * Distinct from Re-engagement Alert: re-engagement fires when a previously
   * silent lead replies after follow-ups went out (requires an active
   * FollowUpEnrollment). Handoff fires the moment the customer signals
   * "I want a human now" inside an active AI Conversation. The two are
   * complementary; both can fire on the same reply when both conditions hit.
   */
  private async maybeFireHandoffAlert(
    classification: IntentClassification | undefined,
    context: CustomerReplyContext,
    savedAccount: { id: string; followUpSettingsJson: string | null; businessName?: string | null },
    aiConversationEnabled: boolean,
  ): Promise<void> {
    if (!classification || !classification.fromLlm) return;
    if (classification.confidence < AutomationService.CLASSIFIER_CONFIDENCE_THRESHOLD) return;

    // Auto-gate: handoff only makes sense when AI is actively conversing.
    // aiConversationEnabled is user-scope as of 2026-05-23 (single source
    // of truth, no more per-account fanout). Caller passes it through.
    if (!aiConversationEnabled) {
      this.logger.log(`[Handoff] skipped — AI Conversation off (user-level)`);
      return;
    }

    // Resolve handoff reason. Prefer the explicit handoff signal from the
    // classifier; fall back to intent-based detection so existing 'agreed' /
    // 'wants_live_contact' classifications keep firing during the rollout
    // window even if the LLM doesn't populate the new `handoff` field.
    let reason: HandoffReason | null = null;
    if (classification.handoff?.shouldHandoff && classification.handoff.reason) {
      reason = classification.handoff.reason;
    } else if (classification.intent === 'agreed' || classification.intent === 'wants_live_contact') {
      reason = classification.intent;
    }
    if (!reason) return;

    // Parse per-account settings — single source of truth for trigger toggles,
    // strategy, price quote mode, master alerts toggle, and template body.
    let alertsEnabled = true;
    let template = 'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"';
    let strategy: string = 'hybrid';
    let priceQuoteMode: string = 'range';
    const triggerDefault = true;
    const triggers: Record<HandoffReason, boolean> = {
      agreed: triggerDefault,
      wants_live_contact: triggerDefault,
      provided_phone_number: triggerDefault,
      provided_square_footage: triggerDefault,
      qualification_complete: triggerDefault,
    };
    if (savedAccount.followUpSettingsJson) {
      try {
        const s = JSON.parse(savedAccount.followUpSettingsJson);
        if (s.reEngagementAlertEnabled === false) alertsEnabled = false;
        if (typeof s.handoffAlertTemplate === 'string' && s.handoffAlertTemplate.trim()) {
          template = s.handoffAlertTemplate;
        }
        if (typeof s.followUpStrategy === 'string') strategy = s.followUpStrategy;
        if (typeof s.priceQuoteMode === 'string') priceQuoteMode = s.priceQuoteMode;
        // Per-reason toggles — undefined means "default ON" so back-compat is
        // preserved for accounts that have never seen the new UI.
        if (s.handoffTriggerAgreed === false) triggers.agreed = false;
        if (s.handoffTriggerWantsLiveContact === false) triggers.wants_live_contact = false;
        if (s.handoffTriggerProvidedPhone === false) triggers.provided_phone_number = false;
        if (s.handoffTriggerProvidedSquareFootage === false) triggers.provided_square_footage = false;
        if (s.handoffTriggerQualificationComplete === false) triggers.qualification_complete = false;
      } catch { /* invalid JSON — fall through to defaults */ }
    }
    if (!alertsEnabled) {
      this.logger.log(`[Handoff] skipped — alerts toggle off (reason=${reason})`);
      return;
    }
    if (!triggers[reason]) {
      this.logger.log(`[Handoff] skipped — trigger '${reason}' disabled per-account`);
      return;
    }

    // Strategy-aware gates:
    // - provided_phone_number fires only when strategy=phone OR the lead has
    //   no usable phone yet (the dispatcher actually needs a callback number).
    // - provided_square_footage fires only when strategy=qualify OR the price
    //   quote mode is 'exact' (the dispatcher needs sqft to quote precisely).
    if (reason === 'provided_phone_number' && strategy !== 'phone') {
      try {
        const lead = await this.prisma.lead.findUnique({
          where: { id: context.leadId },
          select: { customerPhone: true },
        });
        const usable = !!lead?.customerPhone && lead.customerPhone.replace(/\D/g, '').length >= 7;
        if (usable) {
          this.logger.log(`[Handoff] skipped — provided_phone_number not actionable (strategy=${strategy} and lead already has phone)`);
          return;
        }
      } catch (err: any) {
        // Lookup failure isn't fatal — fall through (better to alert than miss).
        this.logger.warn(`[Handoff] lead lookup failed for phone gate (${err?.message}); firing anyway`);
      }
    }
    if (reason === 'provided_square_footage' && strategy !== 'qualify' && priceQuoteMode !== 'exact') {
      this.logger.log(`[Handoff] skipped — provided_square_footage not actionable (strategy=${strategy} priceQuoteMode=${priceQuoteMode})`);
      return;
    }

    const FRIENDLY: Record<HandoffReason, string> = {
      agreed: 'ready to book',
      wants_live_contact: 'wants live contact',
      provided_phone_number: 'provided phone number',
      provided_square_footage: 'provided square footage',
      qualification_complete: 'qualification complete',
    };
    const intentLabel = FRIENDLY[reason];
    const message = (context.customerMessage || '').substring(0, 200);
    const rendered = template
      .replace(/\{\{lead\.name\}\}/g, context.customerName || 'Unknown')
      .replace(/\{\{message\}\}/g, message)
      .replace(/\{\{intent\}\}/g, intentLabel);

    await this.notifications.sendHandoffAlert(context.userId, savedAccount.id, rendered);
    this.logger.log(`[Handoff] fired for ${context.customerName} — reason=${reason} conf=${classification.confidence.toFixed(2)}`);

    // Phase 1: durable handoff state. Lets the UI show "Human takeover
    // requested 5 min ago" without re-running the classifier. Resolved
    // when a manual reply lands (see manual-recency-pause branch).
    if (context.leadId) {
      try {
        const lead = await this.prisma.lead.findUnique({
          where: { id: context.leadId },
          select: { threadId: true },
        });
        if (lead?.threadId) {
          await this.conversationRuntime.setHandoffRequested(lead.threadId, reason);
        }
      } catch (err: any) {
        // never block on the runtime mirror
        this.logger.warn(`[Handoff] runtime state write failed: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * On startup, restore pending messages and reschedule them.
   *
   * AUTOMATION_OWNER guard: staging shares the production DB, so when
   * staging boots it would otherwise read prod's pending rows and create
   * its own setTimeout for each — leading to a double-send when both
   * timers fire. Non-owners skip rehydration entirely. See
   * src/common/automation-owner.ts.
   */
  async onModuleInit(): Promise<void> {
    if (!isAutomationOwner()) {
      logSkippedAutomation(this.logger, 'restorePendingMessages on boot');
      return;
    }
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
        automationRule: { select: { userId: true } },
        savedAccount: { select: { userId: true } },
      },
    });

    const ownerUserId = pending?.automationRule?.userId ?? pending?.savedAccount?.userId;
    if (!pending || ownerUserId !== userId) {
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
    // after trial end. Look up the lead's thread + status (status feeds the
    // intent classifier — "it's done" means different things at engaged vs
    // booked).
    const lead = await this.prisma.lead.findUnique({
      where: { id: context.leadId },
      select: { threadId: true, status: true, thumbtackStatus: true, category: true },
    });
    const allowed = await this.trialService.canProcessLead(context.userId, lead?.threadId ?? undefined);
    if (!allowed.allowed) {
      this.logger.log(`[AUTOMATION] ✗ BLOCKED handleCustomerReply — user ${context.userId} reason=${allowed.reason}`);
      return;
    }

    // ── LLM intent classification ────────────────────────────────────────
    // One classification per inbound customer message. Shared by the status
    // transition path AND the AI Conversation skip checks below — never
    // double-classify. Phrase lists serve as the safety net when confidence
    // is low or the LLM is unavailable.
    const classification = context.customerMessage
      ? await this.classifyCustomerReply({
          message: context.customerMessage,
          threadId: lead?.threadId,
          leadStatus: lead?.status ?? undefined,
          leadCategory: lead?.category ?? context.category,
        })
      : undefined;

    // Phase 1: persist the classifier output so the UI can surface
    // "customer asked for human 10 min ago" without re-classifying.
    // Best-effort; never blocks the decision path.
    if (lead?.threadId && classification?.intent) {
      await this.conversationRuntime.recordClassifierIntent(lead.threadId, {
        intent: classification.intent,
        confidence: classification.confidence ?? null,
      });
    }

    // ── Canonical status transition ───────────────────────────────────────
    // Fires on every customer reply, independent of whether automation rules
    // or AI Conversation handle the response. The LeadStatusService guards
    // (no-downgrade / same-status / terminal / SF-protect / dedup) decide
    // whether the write actually applies.
    await this.applyCustomerReplyStatusTransition(context, classification).catch((err) => {
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

    // Resolve the user-level AI Conversation master switch ONCE per
    // customer-reply handling. Used by both maybeFireHandoffAlert (gate)
    // and the main AI Conversation block below. Promoted from per-account
    // to per-user on 2026-05-23 — see User.aiConversationEnabled in schema.
    const userAi = await this.prisma.user.findUnique({
      where: { id: context.userId },
      select: { aiConversationEnabled: true, sigcoreBusinessId: true },
    });
    const aiConversationEnabled = userAi?.aiConversationEnabled === true;

    // Phase 1: durable mirror of the master switch. Writes 'disabled' when
    // the user toggled AI off; downstream skips will overwrite with more
    // specific status if applicable.
    if (lead?.threadId && !aiConversationEnabled) {
      await this.conversationRuntime.setAiStatus(lead.threadId, {
        status: 'disabled',
        reason: AI_STATUS_REASONS.USER_DISABLED,
      });
    }

    // ── Handoff Alert ────────────────────────────────────────────────────
    // Classifier-driven manager notification. Fires when the customer
    // signals high intent — ready to book ('agreed') OR wants a live
    // call/meeting ('wants_live_contact'). Sits between the new-lead alert
    // and the re-engagement alert: it fires DURING an active AI
    // conversation, the moment the customer says "I want a human now."
    // Re-engagement covers the AI-off / follow-up-running case; handoff
    // covers the AI-conversation-in-progress case.
    await this.maybeFireHandoffAlert(classification, context, savedAccount, aiConversationEnabled).catch(err => {
      this.logger.warn(`[Handoff] alert failed: ${err.message}`);
    });

    // ── Booking orchestrator entry (Phase 2B) ─────────────────────────
    // Flag-gated inside the service — for non-canary tenants this call
    // returns { decision: 'flag_disabled' } as a no-op without touching
    // any state. Runs AFTER maybeFireHandoffAlert so the existing
    // handoff path remains the safety net regardless of flag state:
    // even if the booking orchestrator does nothing, the LLM's
    // handoff.shouldHandoff=true signal on wants_to_schedule still
    // pages the dispatcher.
    //
    // The orchestrator returns an OrchestratorOutcome with an optional
    // outboundMessage; PR-B2 deliberately does NOT wire that into the
    // SMS send path. The PR ships dark — flag OFF, no callers act on
    // the message. Tenant-2 enablement is a separate step that may
    // additionally wire outboundMessage into notifications.sendAdHocSms.
    if (
      classification?.intent === 'wants_to_schedule' &&
      lead?.threadId &&
      context.customerMessage
    ) {
      await this.bookingOrchestrator
        .handleClassifiedIntent({
          userId: context.userId,
          leadId: context.leadId,
          conversationId: lead.threadId,
          customerMessage: context.customerMessage,
          intent: 'wants_to_schedule',
          sigcoreBusinessId: userAi?.sigcoreBusinessId ?? null,
          serviceType: lead.category ?? context.category ?? null,
          accountName: savedAccount.businessName ?? null,
        })
        .catch((err) => {
          this.logger.warn(`[BookingOrchestrator] entry failed: ${err.message}`);
        });
    }

    // ── Manual-pro-recency pause ────────────────────────────────────────
    // When a real human (manager) or 3rd-party bridge (Telegram → TT)
    // typed into this thread recently, AI shouldn't talk over them.
    // Pause ALL automated reply paths — rule-driven customer_reply
    // AutomationRules + AI Conversation — for the user's configured
    // "Resume follow-ups after conversation" window. Handoff alert
    // above still fires so dispatchers see high-intent customer messages
    // even during the pause.
    //
    // We deliberately reuse the existing `fuReEnrollDelay` setting (UI:
    // "Resume follow-ups after conversation · Wait before resuming")
    // rather than introducing a new knob — semantically it's the same
    // question: "after a conversation has happened, how long do we wait
    // before automation resumes?". The string format matches the
    // existing inline parser at follow-up-engine.service.ts:337-339
    // ("24h", "1d", "1w", or bare minutes).
    //
    // The 'manual' senderType is stamped by the inbound webhook handler
    // when sender='pro' AND the row wasn't pre-written by our send path
    // (sendMessage stamps 'ai'/'user'). The 'user' senderType is what
    // we set when an LB user types a manual reply through the LB UI —
    // same intent for this gate: a human is handling this thread.
    if (lead?.threadId) {
      // Shared parseDuration handles compact ("24h", "1w") + long form
      // ("1 hour", "3 days") + bare numbers — all the shapes the saved
      // JSON can carry. Default fallback 60 min ("1 hour") matches the UI
      // placeholder for "Resume follow-ups after conversation".
      let pauseMinutes = 60;
      if (savedAccount.followUpSettingsJson) {
        try {
          const s = JSON.parse(savedAccount.followUpSettingsJson);
          if (typeof s.fuReEnrollDelay === 'string' && s.fuReEnrollDelay) {
            pauseMinutes = parseDuration(s.fuReEnrollDelay, 60);
          }
        } catch { /* invalid JSON — keep the 60-min default */ }
      }
      if (pauseMinutes > 0) {
        const cutoff = new Date(Date.now() - pauseMinutes * 60 * 1000);
        const manualReply = await this.prisma.message.findFirst({
          where: {
            conversationId: lead.threadId,
            sender: 'pro',
            senderType: { in: ['manual', 'user'] },
            sentAt: { gte: cutoff },
          },
          orderBy: { sentAt: 'desc' },
          select: { id: true, senderType: true, sentAt: true },
        });
        if (manualReply) {
          this.logger.log(
            `[AUTOMATION] ✗ Auto-reply paused — ${manualReply.senderType} pro message within ${pauseMinutes}min via fuReEnrollDelay (msg=${manualReply.id} at=${manualReply.sentAt.toISOString()})`,
          );
          // Phase 1: durable mirror of the recency-window pause. The human
          // has ALREADY REPLIED inside the pause window — we are now
          // waiting for the customer, not for the human. Hence
          // awaiting_customer (NOT human_handling, which is reserved for
          // "customer wants live contact, no human reply yet").
          await this.conversationRuntime.setState(lead.threadId, {
            aiStatus: 'paused_human',
            aiStatusReason: AI_STATUS_REASONS.MANUAL_REPLY_WINDOW,
            conversationState: 'awaiting_customer',
            conversationStateReason: CONVERSATION_STATE_REASONS.MANUAL_REPLY,
          });
          await this.conversationRuntime.resolveHandoff(lead.threadId);
          return;
        }
      }
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

    // AI Conversation: if no customer_reply rules and the user has the
    // master switch on, auto-reply to customer messages using AI (ongoing
    // conversation handling). aiConversationEnabled is user-scope as of
    // 2026-05-23 — single source of truth, no per-account fanout. Read
    // above into `aiConversationEnabled`.
    if (rules.length === 0 && aiConversationEnabled) {
      this.logger.log(`[AUTOMATION] AI Conversation enabled (user-level) — generating AI reply for ${savedAccount.businessName}`);

      // Load AI conversation rules from settings
      let aiRules: any = {};
      if (savedAccount.followUpSettingsJson) {
        try { aiRules = JSON.parse(savedAccount.followUpSettingsJson); } catch {}
      }

      // AI Conversation availability — two-state on `savedAccount.aiConversationMode`:
      //   "always"                      — reply 24/7
      //   "when_dispatcher_unavailable" — reply ONLY outside business hours
      //                                   (human handles during business hours)
      // Falls back to the legacy `followUpAvailability` / `followUpActiveHours*`
      // settings if `aiConversationMode` is null (pre-migration accounts).
      // Deferral target — when set, the synthetic rule below carries this
      // through to scheduleAutomatedMessage, which writes a kind='ai_conversation'
      // PendingAutomatedMessage row + scheduleTimer instead of sending now.
      // The deferred fire path re-loads the full thread so the AI replies to
      // whatever the customer has said by then, and cancels if the dispatcher
      // (business/manual) has replied in the meantime.
      let aiDeferredSendAt: Date | null = null;

      const aiMode = (savedAccount as any).aiConversationMode as string | null | undefined;
      if (aiMode === 'when_dispatcher_unavailable') {
        const inHours = await this.businessHours.isInBusinessHours(context.userId, savedAccount.id);
        if (inHours) {
          aiDeferredSendAt = await this.businessHours.nextDeferredAiSendAt(context.userId, savedAccount.id);
          this.logger.log(`[AUTOMATION] AI Conversation deferred — dispatcher available; queued for ${aiDeferredSendAt.toISOString()}`);
        }
      } else if (aiMode == null) {
        // Legacy path — preserve until UI migrates everyone to aiConversationMode.
        const aiAvailability = aiRules.followUpAvailability ?? aiRules.availability;
        const ahStart = savedAccount.followUpActiveHoursStart;
        const ahEnd = savedAccount.followUpActiveHoursEnd;
        // Canonical TZ resolution chain (matches enrollInSequence + scheduler):
        // SavedAccount.followUpTimezone → User.businessHoursTimezone → DEFAULT.
        // The old literal fallback caused this gate to interpret active-hours
        // in NY for any account where followUpTimezone was null even though
        // the user had a non-NY master timezone set.
        const userForTz = await this.prisma.user.findUnique({
          where: { id: context.userId },
          select: { businessHoursTimezone: true },
        }).catch(() => null);
        const ahTz = resolveTimezone(savedAccount, userForTz);
        if (aiAvailability === 'active_hours' && ahStart && ahEnd) {
          if (!this.isInActiveHours(ahStart, ahEnd, ahTz)) {
            this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — outside active hours (${ahStart}-${ahEnd} ${ahTz}) [legacy mode]`);
            if (lead?.threadId) {
              await this.conversationRuntime.setAiStatus(lead.threadId, {
                status: 'unavailable',
                reason: AI_STATUS_REASONS.OUTSIDE_BUSINESS_HOURS,
              });
            }
            return;
          }
        }
      }
      // aiMode === 'always' falls through — no gate.

      // Check terminal lead status — don't reply to done/hired/archived leads.
      // Reuses the outer-scope `lead` (already loaded with status + threadId).
      if (lead) {
        const s = (lead.status || '').toLowerCase();
        const ts = (lead.thumbtackStatus || '').toLowerCase();
        const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'completed', 'archived', 'lost'];
        if (terminal.includes(s) || terminal.includes(ts)) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — lead status is "${s || ts}"`);
          if (lead.threadId) {
            // Phase 1: reason tag explicitly flags this as a CRM-pipeline
            // check; Phase 3 will replace this branch with a conversation-
            // state check (opted_out / hired_elsewhere / booked_in_lb / ...).
            await this.conversationRuntime.setAiStatus(lead.threadId, {
              status: 'stopped_terminal',
              reason: AI_STATUS_REASONS.CRM_TERMINAL_LEGACY,
            });
          }
          return;
        }
      }

      // ── Classifier-driven short-circuit ────────────────────────────────
      // When the LLM is confident (≥0.7) about a terminal/pause intent, act
      // on it directly. This catches the cases the phrase lists miss
      // (Lynn: "please lose my information", Donna: "it's already done",
      // free-form cancellations, polite winding-down). The inline phrase
      // checks below remain as the fallback for low-confidence/LLM-failure
      // cases — never delete them, they're the safety net.
      if (classification && classification.fromLlm
          && classification.confidence >= AutomationService.CLASSIFIER_CONFIDENCE_THRESHOLD) {
        const intent = classification.intent;
        if (intent === 'opt_out' && aiRules.aiStopOnOptOut !== false) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — classifier=opt_out conf=${classification.confidence.toFixed(2)} reason="${classification.reason}"`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_terminal',
              aiStatusReason: AI_STATUS_REASONS.CLASSIFIER_OPT_OUT,
              conversationState: 'opted_out',
              conversationStateReason: CONVERSATION_STATE_REASONS.CLASSIFIER_OPT_OUT,
            });
          }
          return;
        }
        if ((intent === 'hired_elsewhere' || intent === 'completed') && aiRules.aiStopOnBooked !== false) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — classifier=${intent} conf=${classification.confidence.toFixed(2)} reason="${classification.reason}"`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_terminal',
              aiStatusReason: AI_STATUS_REASONS.CLASSIFIER_HIRED_ELSEWHERE,
              conversationState: 'hired_elsewhere',
              conversationStateReason: CONVERSATION_STATE_REASONS.CLASSIFIER_HIRED_ELSEWHERE,
            });
          }
          if (aiRules.aiHiredCompetitorReengage !== false && context.leadId && lead?.threadId) {
            await this.enrollInCustomerReplySequence(
              'customer_hired_competitor',
              context.leadId,
              lead.threadId,
              context.userId,
              savedAccount.platform,
              savedAccount.id,
              savedAccount.followUpActiveHoursStart,
              savedAccount.followUpActiveHoursEnd,
              savedAccount.followUpTimezone,
              classification.suggestedReengageInDays,
            );
          }
          return;
        }
        // SYSTEM EVENT — customer explicitly requested live contact.
        // Always stops the AI + always notifies (handoff alert SMS already
        // fired via maybeFireHandoffAlert above). NOT gated by any
        // per-goal Continue/Stop toggle — the customer asked for a human
        // and muting that signal would be hostile.
        //
        // Split from the `agreed` path in V2 (2026-06-12). Previously
        // these two intents shared the `aiStopOnPriceAgreed !== false`
        // gate, which meant Price="Continue AI + Notify Team" silently
        // disabled the wants_live_contact stop too. That coupling
        // contradicted the V2 spec where wants_live_contact is a
        // non-configurable system event.
        if (intent === 'wants_live_contact') {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation stopped — system event: wants_live_contact (conf=${classification.confidence.toFixed(2)})`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_booked',
              aiStatusReason: AI_STATUS_REASONS.CLASSIFIER_WANTS_LIVE_CONTACT,
              conversationState: 'human_handling',
              conversationStateReason: CONVERSATION_STATE_REASONS.CLASSIFIER_WANTS_LIVE_CONTACT,
            });
          }
          return;
        }

        // PRICE GOAL COMPLETION — customer agrees on price. Stop is
        // gated by `aiStopOnPriceAgreed` (the Price goal's Continue/Stop
        // radio in V2). Default true preserves the Savanna 2026-05-13
        // regression fix: customer said "Yes, I already confirmed the
        // cleaning for 5/21 at 10am" and the AI followed up with
        // "Thanks for confirming, all set!" because the field defaulted
        // falsy. `!== false` matches every other terminal-intent stop.
        if (intent === 'agreed' && aiRules.aiStopOnPriceAgreed !== false) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation handed off — Price goal complete (agreed) conf=${classification.confidence.toFixed(2)}`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_booked',
              aiStatusReason: AI_STATUS_REASONS.CLASSIFIER_AGREED,
              conversationState: 'booked_in_lb',
              conversationStateReason: CONVERSATION_STATE_REASONS.CLASSIFIER_AGREED,
            });
          }
          return;
        }
        // V2 goal completion stops (2026-06-12).
        //
        // The Conversation Goals V2 model gives each per-goal completion
        // its own "Continue AI + Notify Team" vs "Stop AI + Notify Team"
        // choice. Price already had this via `aiStopOnPriceAgreed` above.
        // Qualify and Phone get the same shape via two new JSON keys:
        //
        //   goalQualifyStopOnComplete  — stop after handoff.reason='qualification_complete'
        //   goalPhoneStopOnComplete    — stop after handoff.reason='provided_phone_number'
        //
        // Both default to undefined/false — existing tenants whose
        // followUpSettingsJson doesn't carry the keys see no behavior
        // change. The handoff alert SMS fires independently via
        // maybeFireHandoffAlert earlier; these gates only decide whether
        // the AI ALSO falls silent after that event.
        const isQualifyComplete = classification.handoff?.shouldHandoff
          && classification.handoff.reason === 'qualification_complete'
          && (aiRules as any).goalQualifyStopOnComplete === true;
        if (isQualifyComplete) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation stopped — Qualify goal complete + Stop selected (conf=${classification.confidence.toFixed(2)})`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_booked',
              aiStatusReason: AI_STATUS_REASONS.GOAL_QUALIFY_COMPLETE,
              conversationState: 'human_handling',
              conversationStateReason: CONVERSATION_STATE_REASONS.GOAL_QUALIFY_COMPLETE,
            });
          }
          return;
        }
        const isPhoneComplete = classification.handoff?.shouldHandoff
          && classification.handoff.reason === 'provided_phone_number'
          && (aiRules as any).goalPhoneStopOnComplete === true;
        if (isPhoneComplete) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation stopped — Phone goal complete + Stop selected (conf=${classification.confidence.toFixed(2)})`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'stopped_booked',
              aiStatusReason: AI_STATUS_REASONS.GOAL_PHONE_COMPLETE,
              conversationState: 'human_handling',
              conversationStateReason: CONVERSATION_STATE_REASONS.GOAL_PHONE_COMPLETE,
            });
          }
          return;
        }
        // "Check in after customer deferral" — single UI toggle
        // (aiDeferralCheckIn) gates the whole flow: silencing the AI here
        // AND scheduling the nudge below. Toggle off in the UI = AI keeps
        // talking + no nudge. Replaces the old split between aiStopOnDeferral
        // (hidden, default-ON) and aiDeferralCheckIn (UI). The matching UI
        // copy already says "silence the AI and schedule one nudge later"
        // — this aligns runtime with the copy.
        if (intent === 'deferring' && aiRules.aiDeferralCheckIn !== false) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — classifier=deferring conf=${classification.confidence.toFixed(2)} reason="${classification.reason}"`);
          if (lead?.threadId) {
            await this.conversationRuntime.setState(lead.threadId, {
              aiStatus: 'paused_deferral',
              aiStatusReason: AI_STATUS_REASONS.CLASSIFIER_DEFERRING,
              conversationState: 'deferred',
              conversationStateReason: CONVERSATION_STATE_REASONS.CLASSIFIER_DEFERRING,
            });
          }
          if (context.leadId && lead?.threadId) {
            await this.enrollInCustomerReplySequence(
              'customer_deferred',
              context.leadId,
              lead.threadId,
              context.userId,
              savedAccount.platform,
              savedAccount.id,
              savedAccount.followUpActiveHoursStart,
              savedAccount.followUpActiveHoursEnd,
              savedAccount.followUpTimezone,
              classification.suggestedReengageInDays,
            );
          }
          return;
        }
        // intent='asking' or 'engaged' — fall through to AI reply generation.
      }

      // ── Phrase-list fallback ───────────────────────────────────────────
      // Runs when classifier was unavailable, low-confidence, or returned a
      // non-terminal intent. These checks predate the classifier and remain
      // as a safety net — never delete without a separate cleanup PR.
      // Rule: stop on opt-out keywords in customer message.
      if (aiRules.aiStopOnOptOut !== false && context.customerMessage) {
        const inlineExtras = ['stop', 'not interested'];
        const allOptOut = [...OPT_OUT_PHRASES, ...inlineExtras];
        const msgLower = context.customerMessage.toLowerCase();
        const matched = allOptOut.find(p => msgLower.includes(p));
        if (matched) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — customer opted out / canceled ("${matched}")`);
          return;
        }
      }

      // Rule: stop on booked/hired keywords. Then schedule a longer
      // re-engagement follow-up (default 21 days) — the customer's current
      // job may not work out, and a polite check-in then captures the
      // dissatisfied ones. Sources HIRED_SOMEONE_PHRASES (canonical — also
      // drives lead.status -> lost transition) so the two paths can't drift.
      if (aiRules.aiStopOnBooked !== false && context.customerMessage) {
        const msgLower = context.customerMessage.toLowerCase();
        const matched = HIRED_SOMEONE_PHRASES.find(p => msgLower.includes(p));
        if (matched) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — customer booked elsewhere ("${matched}")`);
          if (aiRules.aiHiredCompetitorReengage !== false && context.leadId && lead?.threadId) {
            await this.enrollInCustomerReplySequence(
              'customer_hired_competitor',
              context.leadId,
              lead.threadId,
              context.userId,
              savedAccount.platform,
              savedAccount.id,
              savedAccount.followUpActiveHoursStart,
              savedAccount.followUpActiveHoursEnd,
              savedAccount.followUpTimezone,
            );
          }
          return;
        }
      }

      // Rule: stop on price agreed — hand off to manager. Default ON to
      // mirror the classifier-driven short-circuit above (Savanna 2026-05-13).
      if (aiRules.aiStopOnPriceAgreed !== false && context.customerMessage) {
        const agreedPhrases = ['sounds good', 'let\'s do it', 'i\'ll take it', 'book it', 'schedule it', 'let\'s go', 'perfect, when', 'great, when', 'yes please', 'i\'m in', 'i already confirmed', 'already confirmed'];
        const msgLower = context.customerMessage.toLowerCase();
        if (agreedPhrases.some(p => msgLower.includes(p))) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation paused — customer agreed on price, handing off to manager`);
          return;
        }
      }

      // Rule: stop on customer deferral — phrases that explicitly signal "I'm
      // pausing the conversation" (e.g. "I'll get back to you", "let me think").
      // Replying after these reads as pestering and is a top complaint source.
      // Gated by the same "Check in after customer deferral" toggle the UI
      // exposes (aiDeferralCheckIn). Defaults ON.
      if (aiRules.aiDeferralCheckIn !== false && context.customerMessage) {
        const deferralPhrases = [
          'get back to you', 'get back to u',
          'let me think', 'let me check', 'let me look',
          'i\'ll think', 'ill think', 'i will think',
          'i\'ll let you know', 'ill let you know', 'i will let you know',
          'i\'ll be in touch', 'ill be in touch', 'we\'ll be in touch', 'we will be in touch',
          'need to think', 'need to discuss', 'need to talk',
          'have to think', 'have to discuss', 'have to talk',
          'thinking about it', 'thinking it over',
          'talk it over', 'discuss it with',
          'shopping around', 'comparing quotes', 'comparing prices',
          'give me a minute', 'give me some time', 'give me a bit',
          // "check with my husband/wife/partner/spouse/boss" etc — Carol case
          'check with my husband', 'check with my wife', 'check with my partner', 'check with my spouse',
          'check with the husband', 'check with the wife', 'check with my hubby',
          'ask my husband', 'ask my wife', 'ask my partner', 'ask my spouse',
          'talk to my husband', 'talk to my wife', 'talk to my partner', 'talk to my spouse',
          'run it by', 'run this by', 'run it past', 'run this past',
          'check with the boss', 'ask the boss', 'check with my family',
          'need to check', 'need to ask', 'will need to check', 'will need to ask',
        ];
        const msgLower = context.customerMessage.toLowerCase();
        const matched = deferralPhrases.find(p => msgLower.includes(p));
        if (matched) {
          this.logger.log(`[AUTOMATION] ✗ AI Conversation skipped — customer signaled deferral ("${matched}")`);
          // Outer gate above already confirmed aiDeferralCheckIn is on,
          // so unconditionally schedule the check-in nudge here.
          if (context.leadId && lead?.threadId) {
            await this.enrollInCustomerReplySequence(
              'customer_deferred',
              context.leadId,
              lead.threadId,
              context.userId,
              savedAccount.platform,
              savedAccount.id,
              savedAccount.followUpActiveHoursStart,
              savedAccount.followUpActiveHoursEnd,
              savedAccount.followUpTimezone,
            );
          }
          return;
        }
      }

      // aiMaxReplies removed 2026-05-23 — runaway AI conversations are
      // already prevented by: (a) classifier-driven hand-off intents
      // (agreed / wants_live_contact / opt_out / hired_elsewhere / deferring),
      // (b) the per-account "Customer Reply Alerts" handoff SMS that pages
      // the manager on high intent, (c) terminal lead.status gates, and
      // (d) per-account follow-up step limits in the Automation settings.
      // A separate reply-count cap was unused (no UI), redundant, and
      // surfaced no clear use case the existing stop paths don't cover.

      // V2 Review Mode (2026-06-12): per-account
      // followUpSettingsJson.aiConversationDeliveryMode. 'suggest' parks
      // the generated reply as a pending AI suggestion on
      // ThreadContext.stateJson instead of dispatching. Missing key or
      // any other value → 'auto_send' (existing behavior).
      const aiConversationDeliveryMode: 'suggest' | 'auto_send' =
        (aiRules as any).aiConversationDeliveryMode === 'suggest' ? 'suggest' : 'auto_send';

      // Dedup gate: skip generation entirely when a pending AI
      // suggestion already exists for this conversation. The operator
      // must approve (sends + clears) or discard (just clears) before
      // AI generates again. Without this, every burst of customer
      // follow-up messages would queue duplicate suggestions.
      if (aiConversationDeliveryMode === 'suggest' && lead?.threadId) {
        const existing = await this.conversationRuntime.getAiSuggestion(lead.threadId);
        if (existing) {
          this.logger.log(
            `[AI_SUGGEST] dedup — suggestion ${existing.id} already pending for thread ${lead.threadId}`,
          );
          return;
        }
      }

      // Create a synthetic AI rule so we can reuse scheduleAutomatedMessage.
      // When `aiDeferredSendAt` was set by the OBH gate above, translate it
      // to `delayMinutes` so scheduleAutomatedMessage writes a persistent
      // kind='ai_conversation' row + timer instead of firing immediately.
      // every_reply semantics so a new inbound from the customer naturally
      // supersedes an older deferred enqueue via the existing dedup path.
      const aiDelayMinutes = aiDeferredSendAt
        ? Math.max(0, Math.ceil((aiDeferredSendAt.getTime() - Date.now()) / 60_000))
        : 0;
      const syntheticRule = {
        id: `ai-conversation-${savedAccount.id}`,
        name: 'AI Conversation',
        triggerType: 'customer_reply' as const,
        useAi: true,
        templateId: null,
        template: null,
        promptTemplateId: null,
        promptTemplate: null,
        delayMinutes: aiDelayMinutes,
        enabled: true,
        savedAccountId: savedAccount.id,
        activeHoursStart: savedAccount.followUpActiveHoursStart,
        activeHoursEnd: savedAccount.followUpActiveHoursEnd,
        activeHoursTimezone: savedAccount.followUpTimezone,
        stopOnCustomerReply: true,
        replyTriggerMode: 'every_reply' as const,
        // Propagated to executePendingMessage — see the suggest-mode
        // fork right before leadsService.sendMessage().
        deliveryMode: aiConversationDeliveryMode,
      };

      await this.scheduleAutomatedMessage(syntheticRule, enrichedContext);
    }
  }

  /**
   * Run the LLM intent classifier on a customer message. Pulls recent
   * conversation history (last 5 turns) for context and passes the current
   * lead status — both materially change the right answer ("it's done" at
   * status=booked vs status=engaged means different things). Returns a
   * structured intent + confidence, or a fromLlm=false fallback if the
   * classifier is unavailable.
   */
  private async classifyCustomerReply(opts: {
    message: string;
    threadId?: string | null;
    leadStatus?: string;
    leadCategory?: string;
  }): Promise<IntentClassification> {
    let recentHistory: { role: 'customer' | 'pro'; content: string }[] = [];
    if (opts.threadId) {
      try {
        const recent = await this.prisma.message.findMany({
          where: { conversationId: opts.threadId },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { sender: true, content: true },
        });
        recentHistory = recent.reverse().map((m: any) => ({
          role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
          content: m.content || '',
        }));
      } catch {
        // history is best-effort context; classifier still works without it
      }
    }
    return this.intentClassifier.classify({
      message: opts.message,
      recentHistory,
      leadStatus: opts.leadStatus,
      leadCategory: opts.leadCategory,
    });
  }

  /**
   * Confidence threshold below which we treat the LLM result as unreliable
   * and fall back to phrase-list classification. Tuned conservatively —
   * false-positive on a terminal intent prematurely loses the lead, so we
   * only act on the LLM when it's clearly confident. Below this threshold
   * we either fall through to phrase lists (status transition) or just let
   * the AI reply normally (skip checks).
   */
  private static readonly CLASSIFIER_CONFIDENCE_THRESHOLD = 0.7;

  /**
   * Map a high-confidence LLM intent to the legacy CustomerReplyTransition
   * kind. Returns null when the classifier isn't trustworthy here — caller
   * should fall back to the phrase-list `detectCustomerReplyTransition`.
   *
   * - opt_out                       -> opt_out
   * - hired_elsewhere | completed   -> hired_someone (same status + 21d reengage)
   * - agreed                        -> agreed
   * - deferring | asking | engaged  -> engaged (no terminal write; no-downgrade guarded)
   */
  private intentToTransitionKind(c: IntentClassification): CustomerReplyTransition['kind'] | null {
    if (!c.fromLlm || c.confidence < AutomationService.CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return null;
    }
    switch (c.intent) {
      case 'opt_out': return 'opt_out';
      case 'hired_elsewhere':
      case 'completed': return 'hired_someone';
      case 'agreed': return 'agreed';
      case 'deferring':
      case 'asking':
      case 'engaged':
      default: return 'engaged';
    }
  }

  /**
   * Run the canonical Lead.status transition triggered by a customer reply.
   * Returns the writeStatus result so callers (and tests) can inspect what
   * happened. Errors are surfaced — callers should wrap if they want best-effort
   * semantics.
   *
   * Decision priority:
   *   1. Pre-computed LLM classification (if confidence >= threshold)
   *   2. Phrase-list `detectCustomerReplyTransition` (fallback / safety net)
   *
   * Decision table:
   *   opt-out                  -> lost   (lostReason='opt_out')
   *   hired_someone/completed  -> lost   (lostReason='hired_someone',
   *                                       reengageAt=now+21d, plus a
   *                                       customer_hired_competitor
   *                                       FollowUpEnrollment via the
   *                                       handleCustomerReply caller)
   *   agreed                   -> booked
   *   anything else            -> engaged
   *                              (no-downgrade guard silently skips when the
   *                              lead is already past contacted)
   */
  private async applyCustomerReplyStatusTransition(
    context: CustomerReplyContext,
    classification?: IntentClassification,
  ) {
    if (!context.leadId || !context.customerMessage) return;

    // Prefer high-confidence LLM classification; fall back to phrase lists.
    const llmKind = classification ? this.intentToTransitionKind(classification) : null;

    // Guard: classifier intents `completed` and `hired_elsewhere` both map
    // to `hired_someone` → writes Lead.status='lost'. That's the right
    // call when the customer was still negotiating, but it's wrong when
    // they already booked — a "Thanks again!" or "Sounds good!" from a
    // booked customer is a positive wrap-up, not a competitor-hire signal.
    //
    // Feryal Berjawi 2026-06-14 incident: classified `completed` @ 0.90
    // ("Customer acknowledges and concludes the conversation"), gate wrote
    // `lost` over `booked` → owner saw "Lost" while SF correctly held
    // "Scheduled". Suppressing here keeps the booked terminal intact;
    // owners can manually flip a lead to lost if the customer actually
    // backed out.
    //
    // The pipeline_downgrade guard inside LeadStatusService doesn't catch
    // this because `lost` is a valid terminal from any prior state — that
    // guard only blocks `engaged` over later states. So the gate has to
    // live here, on the source of the transition kind.
    if (
      llmKind === 'hired_someone' &&
      classification &&
      (classification.intent === 'completed' || classification.intent === 'hired_elsewhere')
    ) {
      const cur = await this.prisma.lead.findUnique({
        where: { id: context.leadId },
        select: { status: true },
      });
      if (cur?.status === 'booked' || cur?.status === 'completed') {
        this.logger.log(
          `[classifier] suppressed ${classification.intent}→hired_someone on ${cur.status} lead ${context.leadId} ` +
          `— positive wrap-up after booking, not a competitor hire`,
        );
        return;
      }
    }

    const transition: CustomerReplyTransition = llmKind
      ? ({ kind: llmKind } as CustomerReplyTransition)
      : detectCustomerReplyTransition(context.customerMessage);
    if (llmKind) {
      this.logger.log(`[classifier] status transition kind=${llmKind} (intent=${classification!.intent} conf=${classification!.confidence.toFixed(2)})`);
    }
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
    // AUTOMATION_OWNER guard: never enqueue or fire a send on a non-owner
    // instance. Staging has no business sending on behalf of a tenant,
    // even when an API call happens to land here. We log the skip so an
    // operator looking at Loki can tell why nothing happened.
    if (!isAutomationOwner()) {
      logSkippedAutomation(this.logger, 'scheduleAutomatedMessage', {
        ruleId: rule?.id, negotiationId: context.negotiationId,
      });
      return;
    }

    // Synthetic AI Conversation rules (id `ai-conversation-<accountId>`) have no
    // matching AutomationRule row, so the persisted row keys on `savedAccountId`
    // + kind='ai_conversation' instead. Two paths:
    //   - delayMinutes === 0 → fire in-memory with a synthetic pendingId
    //     (legacy fast path; no DB row needed for immediate sends).
    //   - delayMinutes > 0   → write a real row so the deferred timer survives
    //     restarts (restorePendingMessages) and dedups against newer customer
    //     replies on the same negotiation.
    if (typeof rule.id === 'string' && rule.id.startsWith('ai-conversation-')) {
      const savedAccountId = (rule as any).savedAccountId as string | undefined;
      if (!rule.delayMinutes || rule.delayMinutes === 0) {
        const syntheticId = `synthetic-${rule.id}-${context.negotiationId}`;
        this.logger.log(`[AI Conversation] executing synthetic rule ${rule.id} for ${context.negotiationId}`);
        await this.executePendingMessage(syntheticId, rule, context);
        return;
      }

      if (!savedAccountId) {
        this.logger.warn(`[AI Conversation] synthetic rule ${rule.id} missing savedAccountId — cannot persist deferred row, falling back to immediate execute`);
        const syntheticId = `synthetic-${rule.id}-${context.negotiationId}`;
        await this.executePendingMessage(syntheticId, rule, context);
        return;
      }

      // Dedup against existing pending row for this account+negotiation.
      // every_reply semantics: drop the stale pending and re-enqueue with
      // a fresh scheduledFor so the deferral always reflects the latest
      // inbound customer activity.
      const existing = await this.prisma.pendingAutomatedMessage.findFirst({
        where: { savedAccountId, negotiationId: context.negotiationId, kind: 'ai_conversation' },
      });
      if (existing) {
        if (existing.status === 'pending') {
          this.logger.log(`[AI Conversation] dropping superseded pending row ${existing.id} for ${context.negotiationId}`);
          await this.prisma.pendingAutomatedMessage.delete({ where: { id: existing.id } }).catch(() => undefined);
          const t = this.pendingTimers.get(existing.id);
          if (t) { clearTimeout(t); this.pendingTimers.delete(existing.id); }
        } else if (existing.status === 'sent' || existing.status === 'cancelled' || existing.status === 'failed') {
          // Free up the slot — a new customer reply earns a new deferral.
          await this.prisma.pendingAutomatedMessage.delete({ where: { id: existing.id } }).catch(() => undefined);
        }
      }

      const scheduledFor = new Date(Date.now() + rule.delayMinutes * 60 * 1000);
      const pending = await this.prisma.pendingAutomatedMessage.create({
        data: {
          automationRuleId: null,
          kind: 'ai_conversation',
          savedAccountId,
          leadId: context.leadId,
          negotiationId: context.negotiationId,
          scheduledFor,
          status: 'pending',
        },
      });
      this.logger.log(`[AI Conversation] queued deferred row ${pending.id} for ${context.negotiationId} (scheduledFor=${scheduledFor.toISOString()})`);
      this.scheduleTimer(pending.id, rule.delayMinutes * 60 * 1000, rule, context);
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
      // Trial paywall re-check: a follow-up scheduled BEFORE trial end can fire
      // hours/days later. Re-evaluate at execute-time so post-trial firings are
      // blocked. Look up the lead's conversation for grace eligibility.
      const leadForGate = await this.prisma.lead.findUnique({
        where: { id: context.leadId },
        select: { threadId: true },
      });
      const access = await this.trialService.canProcessLead(context.userId, leadForGate?.threadId ?? undefined);
      if (!access.allowed) {
        this.logger.log(`[executePendingMessage] ✗ BLOCKED user=${context.userId} pending=${pendingId} reason=${access.reason}`);
        if (!pendingId.startsWith('synthetic-')) {
          await this.prisma.pendingAutomatedMessage.update({
            where: { id: pendingId },
            data: { status: 'cancelled', failureReason: `trial_${access.reason}` },
          }).catch(() => undefined);
        }
        return;
      }

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

      // AI Conversation deferred-send: back off if the dispatcher (business
      // owner / manual operator) replied on this thread after the row was
      // queued. The whole reason the row exists is "when_dispatcher_unavailable"
      // mode — if the human did jump in, the AI must not pile on at close.
      if (!pendingId.startsWith('synthetic-')) {
        const pendingRow = await this.prisma.pendingAutomatedMessage.findUnique({
          where: { id: pendingId },
          select: { kind: true, createdAt: true, leadId: true },
        });
        if (pendingRow?.kind === 'ai_conversation') {
          const leadForThread = await this.prisma.lead.findUnique({
            where: { id: pendingRow.leadId },
            select: { threadId: true },
          });
          if (leadForThread?.threadId) {
            // Dispatcher = any pro-side message that isn't AI. senderType
            // can be 'user' | 'manual' | 'business' | null for human sends
            // (see webhooks.service, leads.service, automation.service
            // recordMessage calls). We treat the complement of 'ai' as the
            // human-handled signal.
            const dispatcherReplySince = await this.prisma.message.findFirst({
              where: {
                conversationId: leadForThread.threadId,
                sender: 'pro',
                NOT: { senderType: 'ai' },
                sentAt: { gt: pendingRow.createdAt },
              },
              orderBy: { sentAt: 'desc' },
              select: { id: true },
            });
            if (dispatcherReplySince) {
              this.logger.log(`[AI Conversation] cancelled ${pendingId} — dispatcher replied since queue`);
              await this.prisma.pendingAutomatedMessage.update({
                where: { id: pendingId },
                data: { status: 'cancelled', failureReason: 'Dispatcher replied' },
              });
              return;
            }
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
      // Hoisted so the V2 Review-Mode suggest fork (below) can tag the
      // parked suggestion with the goal that was actually used. Only the
      // AI branch assigns it; template branch leaves it undefined.
      let effectiveStrategyKeyOuter: string | undefined;

      if (rule.useAi) {
        // Try thread context first (summary + state + recent messages).
        // Pass 100 as recentMessageLimit so the AI sees effectively the full
        // thread, not just the default 10. Without this the AI can lose
        // earlier context (e.g. scheduling discussion) and regress to
        // qualifying questions on a long conversation.
        const threadCtx = lead.threadId
          ? await this.conversationContext.buildContext(lead.threadId, { recentMessageLimit: 100 }).catch(() => null)
          : null;

        let conversationHistory: { role: 'customer' | 'pro'; content: string; sentAt?: Date }[];
        let customerMessage: string;
        let threadContextPrompt: string | undefined;

        if (threadCtx) {
          // Use enriched context — summary + state instead of full transcript
          conversationHistory = threadCtx.recentMessages;
          threadContextPrompt = threadCtx.systemContext;
          // Prefer the live trigger message (the customer reply that fired this
          // auto-reply) over the first message in history. Donna case: anchoring
          // on firstCustomerMsg meant every reply re-responded to the original
          // lead pitch ("My Mother passed…") instead of the latest "It's already
          // done." Falls back to firstCustomerMsg / lead.message for follow-ups
          // where there's no live customer trigger.
          const firstCustomerMsg = conversationHistory.find(m => m.role === 'customer')?.content;
          customerMessage = context.customerMessage || firstCustomerMsg || lead.message || '';
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
          customerMessage = context.customerMessage || firstCustomerMsg || lead.message || '';
          this.logger.log(`[AI] Using raw transcript for ${pendingId} (no thread context, ${conversationHistory.length} msgs)`);
        }

        // Extract structured lead details from rawJson (TT survey + Yelp survey_answers).
        const leadDetails = extractLeadDetails(lead.rawJson);

        // Fetch user's global AI prompt + name (used for business context)
        const userRecord = await this.prisma.user.findUnique({
          where: { id: context.userId },
          select: { globalAiPrompt: true, name: true },
        });

        // Load account first so we can read the central followUpStrategy
        // when resolving the PRIMARY INSTRUCTION below.
        // ServiceProfile adoption (Phase 1b): added `id` and
        // `serviceOverridesJson` to the SELECT so the resolver can apply
        // per-location overrides on top of the profile base.
        const account = context.businessId
          ? await this.prisma.savedAccount.findFirst({
              where: { userId: context.userId, businessId: context.businessId },
              select: {
                id: true,
                businessName: true,
                servicePricingJson: true,
                faqJson: true,
                serviceOverridesJson: true,
                followUpSettingsJson: true,
                followUpActiveHoursStart: true,
                followUpActiveHoursEnd: true,
                followUpTimezone: true,
                aiConversationMode: true,
              },
            })
          : null;

        // ─── ServiceProfile resolver ────────────────────────────────────
        // Phase 1b adoption: route pricing/FAQ/aiInstructions through the
        // resolver so per-field fallback applies and aiPaused (draft
        // profile) short-circuits the reply path entirely.
        //
        // The Spotless null-FAQ class of bugs is prevented at runtime here:
        // even when the profile carries a null faqJson, the resolver
        // returns the SavedAccount's faqJson via per-field fallback rather
        // than wiping the prompt context.
        //
        // Optional dep — legacy unit tests direct-instantiate this service
        // without DI. When the resolver isn't wired we fall through to
        // direct account reads below (same behavior as pre-Phase-1b).
        const profileInputs = this.serviceProfile
          ? await this.serviceProfile.resolveEffectivePromptInputs(
              { id: lead.id, userId: lead.userId, category: lead.category ?? null, categoryId: (lead as any).categoryId ?? null },
              account
                ? {
                    id: account.id,
                    servicePricingJson: account.servicePricingJson,
                    faqJson: account.faqJson,
                    serviceOverridesJson: account.serviceOverridesJson,
                    followUpSettingsJson: account.followUpSettingsJson,
                  }
                : null,
            )
          : null;

        // Draft profile short-circuit: do NOT generate an AI reply.
        // The lead/message remain tracked elsewhere — this only skips
        // the AI generate+send. Structured log line so monitoring can
        // alert when this fires in volume (signal: an operator hasn't
        // promoted a draft profile to active yet).
        //
        // Cancellation pattern matches the trial-paywall / stopOnReply
        // branches above (status='cancelled', specific failureReason),
        // so the row exits 'pending' and won't be re-attempted on the
        // next cron cycle. Synthetic rows have no DB representation —
        // structured log only.
        if (profileInputs?.aiPaused) {
          this.logger.log(
            `[service-profile] AI paused — skipping reply path=automation pendingId=${pendingId} ` +
            `userId=${context.userId} leadId=${lead.id} profileId=${profileInputs.profileId} ` +
            `reason=service_profile_ai_paused`,
          );
          if (!pendingId.startsWith('synthetic-')) {
            await this.prisma.pendingAutomatedMessage.update({
              where: { id: pendingId },
              data: { status: 'cancelled', failureReason: 'service_profile_ai_paused' },
            }).catch(() => undefined);
          }
          return;
        }

        // Parse central AI Strategy from followUpSettingsJson. Same setting
        // is used by Follow-ups (follow-up-generator.service.ts:124) and by
        // the AI Strategy panel in the Services page UI.
        let accountFollowUpStrategy: string | undefined;
        let accountFollowUpStrategyPrompt: string | undefined;
        if (account?.followUpSettingsJson) {
          try {
            const s = JSON.parse(account.followUpSettingsJson);
            if (typeof s.followUpStrategy === 'string') accountFollowUpStrategy = s.followUpStrategy;
            if (typeof s.followUpStrategyPrompt === 'string') accountFollowUpStrategyPrompt = s.followUpStrategyPrompt;
          } catch { /* invalid JSON */ }
        }

        // PRIMARY INSTRUCTION — delegated to the shared goal resolver so
        // Lead Arrives + AI Conversation share one priority chain with the
        // follow-up generator. The resolver also auto-routes when the
        // account goal is `auto` (calls suggestStrategy on the thread).
        const { resolveActiveGoal } = require('../ai/goal-resolver');
        const ruleReplyMode = (rule as any).replyMode as 'custom' | 'price' | 'auto' | undefined;
        const resolvedGoal = await resolveActiveGoal(
          {
            ruleForcePrice: ruleReplyMode === 'price',
            rulePromptOverride: rule.promptTemplate?.content ?? null,
            ruleLegacyPrompt: rule.aiSystemPrompt ?? null,
            threadActiveStrategy: threadCtx?.threadState?.activeStrategy ?? null,
            accountFollowUpStrategy,
            accountFollowUpStrategyPrompt,
            conversationId: lead.threadId ?? null,
          },
          {
            suggestStrategy: (id: string) =>
              this.conversationContext.suggestStrategy(id),
          },
        );
        const strategyPrompt: string = resolvedGoal.strategyPrompt;
        const effectiveStrategyKey: string | undefined =
          resolvedGoal.goalKey ?? undefined;
        effectiveStrategyKeyOuter = effectiveStrategyKey;
        this.logger.log(
          `[AI] Goal resolved for ${pendingId}: ${effectiveStrategyKey ?? '(rule prompt)'} ` +
          `via ${resolvedGoal.source} — ${resolvedGoal.reason}`,
        );
        // Qualify never quotes — suppress the pricing REFERENCE so the model
        // isn't tempted to volunteer a number after the customer answers a
        // qualifying question.
        const suppressPricingForQualify = effectiveStrategyKey === 'qualify';

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

        // Pricing: prefer the resolver's effective value. Resolver already
        // handles per-field fallback to account.servicePricingJson, so the
        // cross-tenant sibling fallback below only fires when BOTH the
        // profile AND the current account have no pricing — defense in
        // depth for tenants with a barely-configured primary account.
        let pricingJson: string | null = profileInputs?.pricingJson ?? account?.servicePricingJson ?? null;
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
        if (pricingJson && !suppressPricingForQualify) {
          try {
            // Hydrate: legacy JSON missing cleaningTypes still emits all
            // service columns; explicit 0 prices are preserved (and the
            // pricing-guards layer flips them into a defer-to-team rule).
            const p = hydratePricing(JSON.parse(pricingJson));
            const allTypes = p.cleaningTypes;
            if (p.priceTable.length > 0 && allTypes.length > 0) {
              // Resolve the per-account range/exact toggle stored in followUpSettingsJson.
              let priceQuoteMode: 'range' | 'exact' | undefined;
              if (account?.followUpSettingsJson) {
                try {
                  const s = JSON.parse(account.followUpSettingsJson);
                  if (s?.priceQuoteMode === 'range' || s?.priceQuoteMode === 'exact') priceQuoteMode = s.priceQuoteMode;
                } catch { /* fall back to legacy inference in buildPriceRangeInstruction */ }
              }
              const sqftAdjustEnabled = p.sqftAdjustEnabled !== false; // default ON
              const priceParts: string[] = [];
              for (const row of p.priceTable.slice(0, 10)) {
                // Back-compat: rows saved before the min/max split carry a single `sqft` field.
                const legacy = Number(row.sqft) || 0;
                const sqftMin = Number(row.sqftMin) || legacy;
                const sqftMax = Number(row.sqftMax) || legacy;
                const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
                const prices = allTypes.map((t) => {
                  const price = Number(row[t.key]) || 0;
                  const perSqft = midpoint > 0 ? (price / midpoint).toFixed(3) : null;
                  return perSqft && sqftAdjustEnabled
                    ? `${t.label}: $${price} ($${perSqft}/sqft)`
                    : `${t.label}: $${price}`;
                }).join(', ');
                let sizeLabel = `${row.bed}BR/${row.bath}BA`;
                if (sqftMin && sqftMax && sqftMin !== sqftMax) sizeLabel += ` @ ${sqftMin}-${sqftMax} sqft`;
                else if (midpoint > 0) sizeLabel += ` @ ${midpoint} sqft`;
                priceParts.push(`  ${sizeLabel} — ${prices}`);
              }
              priceParts.push('');
              priceParts.push(buildPriceRangeInstruction(p.priceRange, { priceQuoteMode, sqftAdjustEnabled }));
              // Hard guards (see pricing-guards.ts). AI must NOT quote
              // when bed/bath unknown or when the customer asks for a
              // service the account marks not-offered (all-zero column).
              priceParts.push(buildPricingGuardRules(p));
              pricingBlock = priceParts.join('\n');
            }
          } catch { /* invalid JSON */ }
        }

        // Deterministic quote block — pricing engine. BASE HARD RULES
        // make this authoritative: when present, the LLM quotes these
        // numbers verbatim instead of inferring from the PRICING TABLE.
        // Built from the same hydrated pricing used for pricingBlock so
        // the two never disagree. Skipped under qualify (no quoting).
        let quoteBlock: string | undefined;
        let priceIntentBlock: string | undefined;
        if (pricingJson && !suppressPricingForQualify) {
          try {
            const p = hydratePricing(JSON.parse(pricingJson));
            const additionalInfo = leadDetails['Additional details'] ?? null;
            const built = computeQuoteAndIntent({
              pricing: p,
              leadDetails,
              customerMessage,
              conversationHistory,
              additionalInfo,
            });
            if (built.quoteBlock) quoteBlock = built.quoteBlock;
            if (built.priceIntentBlock) priceIntentBlock = built.priceIntentBlock;
          } catch (err: any) {
            this.logger.warn(`[AI quote] engine threw for ${pendingId}: ${err?.message}`);
          }
        }

        // REFERENCE: account FAQ — verified per-tenant answers to the most
        // common customer questions. Empty fields fall through to the GLOBAL
        // defer-when-empty rule.
        // Resolver-supplied: profile faqJson when populated, else
        // account.faqJson via per-field fallback. The Spotless null-FAQ
        // class of incidents can't recur here even if the profile column
        // was backfilled empty.
        const { buildFaqBlock, parseAccountFaq } = require('../ai/faq-context');
        const effectiveFaqJson = profileInputs?.faqJson ?? account?.faqJson ?? null;
        const faqBlock = buildFaqBlock(parseAccountFaq(effectiveFaqJson)) || undefined;

        // PLAYBOOK — behavior summary (generated from settings) + user
        // instructions (followUpSettingsJson.aiPlaybookInstructions). Pure
        // PLAYBOOK V2 — BASE HARD RULES + 8 HOW sections (default + custom).
        // No automation-derived "current behavior" bullets in V2; Playbook is
        // HOW only. See src/ai/playbook-renderer.ts.
        //
        // The playbook helper still reads from a `followUpSettingsJson`
        // blob shape. buildPlaybookSettingsForRenderer splices the
        // resolver-supplied aiInstructionsJson (when present) as the
        // `aiPlaybookV2` key on top of the legacy blob — keeping all
        // sibling keys (priceQuoteMode, qualificationV2, …) intact.
        const { renderPlaybookBlock } = require('../ai/playbook-renderer');
        const playbookSettingsForRenderer = buildPlaybookSettingsForRenderer(
          profileInputs?.aiInstructionsJson ?? null,
          account?.followUpSettingsJson ?? null,
        );
        const playbookBlock: string = account
          ? renderPlaybookBlock({
              followUpSettingsJson: playbookSettingsForRenderer,
            })
          : '';

        // REFERENCE: Qualification required fields (Price / Qualify only).
        // Read from followUpSettingsJson.qualificationV2.requiredFields. The
        // helper returns '' when the strategy doesn't warrant it OR when the
        // tenant has no saved fields — both cases preserve legacy behavior
        // (the qualify-strategy prompt's hardcoded priority continues to drive
        // the conversation). See src/ai/qualification-context.ts.
        const { buildQualificationBlockForStrategy } = require('../ai/qualification-context');
        let qualificationRequiredFields: unknown = undefined;
        let qualificationCustomFields: unknown = undefined;
        if (account?.followUpSettingsJson) {
          try {
            const s = JSON.parse(account.followUpSettingsJson);
            qualificationRequiredFields = s?.qualificationV2?.requiredFields;
            qualificationCustomFields = s?.qualificationV2?.customFields;
          } catch { /* invalid JSON */ }
        }
        const qualificationBlock: string = buildQualificationBlockForStrategy(
          effectiveStrategyKey,
          qualificationRequiredFields,
          qualificationCustomFields,
        );

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
          quoteBlock,
          priceIntentBlock,
          faqBlock,
          playbookBlock: playbookBlock || undefined,
          qualificationBlock: qualificationBlock || undefined,
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

      // Atomic claim — placed here (not at the top of the method) so the
      // gating checks above (trial paywall, active hours, stopOnCustomerReply)
      // can still reschedule or cancel the row without the claim leaving it
      // stuck in a transient state. By the time we reach this line we've
      // decided we're actually going to send; if a sibling runner beat us
      // here we bail before touching the platform API. Synthetic
      // ai-conversation rows have no DB row, so skip the claim for them.
      if (!pendingId.startsWith('synthetic-')) {
        const claim = await this.prisma.pendingAutomatedMessage.updateMany({
          where: { id: pendingId, status: 'pending' },
          data: { status: 'sending' },
        });
        if (claim.count === 0) {
          this.logger.log(`[executePendingMessage] skip — pending=${pendingId} already claimed (status != 'pending')`);
          return;
        }
      }

      // V2 Review Mode (2026-06-12): when the synthetic AI rule carries
      // `deliveryMode='suggest'` (set in handleCustomerReply when the
      // account opted into Review mode), park the body as a pending
      // suggestion on ThreadContext.stateJson instead of dispatching.
      // Operator approves via /v1/leads/:id/ai-suggestion/{send,discard} —
      // the send endpoint calls leadsService.sendMessage with the same
      // body, so the outbound write path is byte-identical to auto-send.
      //
      // Dedup: handleCustomerReply already checked for an existing
      // pending suggestion + skipped scheduling if one existed. We
      // re-check here defensively to handle the race where a sibling
      // runner arrived between the handleCustomerReply check and this
      // point.
      if ((rule as any).deliveryMode === 'suggest' && lead.threadId) {
        const existingSuggestion = await this.conversationRuntime.getAiSuggestion(lead.threadId);
        if (existingSuggestion) {
          this.logger.log(
            `[AI_SUGGEST] race-skip — pending suggestion ${existingSuggestion.id} already exists for thread ${lead.threadId}`,
          );
          return;
        }
        const { randomUUID } = require('crypto');
        const suggestionId = randomUUID();
        // Resolve the latest customer message id for dedup-by-source.
        let sourceMessageId: string | null = null;
        try {
          const latest = await this.prisma.message.findFirst({
            where: { conversationId: lead.threadId, sender: 'customer' },
            orderBy: { sentAt: 'desc' },
            select: { id: true },
          });
          sourceMessageId = latest?.id ?? null;
        } catch { /* best-effort — dedup falls through */ }
        await this.conversationRuntime.setAiSuggestion(lead.threadId, {
          id: suggestionId,
          message: messageToSend,
          goal: effectiveStrategyKeyOuter ?? null,
          reason: 'customer_reply',
          sourceMessageId,
        });
        this.logger.log(
          `[AI_SUGGEST] parked suggestion ${suggestionId} for thread ${lead.threadId} ` +
          `(${messageToSend.length} chars, sourceMessageId=${sourceMessageId ?? 'null'})`,
        );
        return;
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

      // Proactively evaluate follow-up enrollment after we send a pro/AI
      // message. The webhook handler in webhooks.service.ts also calls
      // evaluateThread on inbound `sender='pro'` echoes — but TT/Yelp don't
      // always echo our own outbound messages back promptly (TT batches
      // them; for Padma's lead the AI Instant Reply at 19:10:28 wasn't
      // echoed back as MessageCreatedV4 until her customer reply arrived
      // 80 min later, and only via lazy backfill). That delay meant the
      // FollowUpEnrollment wasn't active when the customer replied →
      // re-engagement returned null → owner never got the SMS.
      //
      // Calling evaluateThread directly from the outbound path arms the
      // enrollment immediately so re-engagement can fire on the next
      // customer reply. evaluateThread is idempotent — running both here
      // and on the eventual webhook echo is safe.
      if (lead.threadId) {
        this.followUpEngine.evaluateThread(lead.threadId, lead.platform).catch(err =>
          this.logger.warn(`[evaluateThread] outbound-send hook failed for ${lead.threadId}: ${err.message}`),
        );
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
        savedAccount: {
          select: {
            id: true,
            userId: true,
            businessId: true,
            businessName: true,
            followUpActiveHoursStart: true,
            followUpActiveHoursEnd: true,
            followUpTimezone: true,
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

      // kind='ai_conversation' rows have no AutomationRule — synthesize the
      // rule object from savedAccount instead so executePendingMessage can
      // drive the AI generator unchanged.
      let rule: any;
      let userId: string;
      if (pending.kind === 'ai_conversation') {
        if (!pending.savedAccount) {
          this.logger.warn(`[restorePendingMessages] AI Conversation row ${pending.id} missing savedAccount — cancelling`);
          await this.prisma.pendingAutomatedMessage.update({
            where: { id: pending.id },
            data: { status: 'cancelled', failureReason: 'savedAccount missing on restore' },
          }).catch(() => undefined);
          continue;
        }
        rule = {
          id: `ai-conversation-${pending.savedAccount.id}`,
          name: 'AI Conversation',
          triggerType: 'customer_reply',
          useAi: true,
          templateId: null,
          template: null,
          promptTemplateId: null,
          promptTemplate: null,
          delayMinutes: 0,
          enabled: true,
          savedAccountId: pending.savedAccount.id,
          activeHoursStart: pending.savedAccount.followUpActiveHoursStart,
          activeHoursEnd: pending.savedAccount.followUpActiveHoursEnd,
          activeHoursTimezone: pending.savedAccount.followUpTimezone,
          stopOnCustomerReply: true,
          replyTriggerMode: 'every_reply',
        };
        userId = pending.savedAccount.userId;
      } else {
        if (!pending.automationRule) {
          this.logger.warn(`[restorePendingMessages] rule-kind row ${pending.id} missing automationRule — cancelling`);
          await this.prisma.pendingAutomatedMessage.update({
            where: { id: pending.id },
            data: { status: 'cancelled', failureReason: 'automationRule missing on restore' },
          }).catch(() => undefined);
          continue;
        }
        rule = pending.automationRule;
        userId = pending.automationRule.userId;
      }

      const accountName = pending.savedAccount?.businessName
        ?? (pending.lead.businessId
          ? (await this.prisma.savedAccount.findFirst({
              where: { businessId: pending.lead.businessId },
              select: { businessName: true },
            }))?.businessName
          : undefined)
        ?? undefined;

      const context: AutomationTriggerContext = {
        userId,
        businessId: pending.lead.businessId || '',
        negotiationId: pending.negotiationId,
        leadId: pending.leadId,
        customerName: pending.lead.customerName,
        customerMessage: pending.lead.message || undefined,
        accountName,
        category: pending.lead.category || undefined,
        city: pending.lead.city || undefined,
        state: pending.lead.state || undefined,
        savedAccountId: pending.savedAccountId ?? undefined,
      };

      if (delayMs === 0) {
        // Should have already been sent - execute now
        this.logger.log(`Executing overdue message: ${pending.id} (kind=${pending.kind})`);
        await this.executePendingMessage(pending.id, rule, context);
      } else {
        // Reschedule for remaining time
        this.scheduleTimer(pending.id, delayMs, rule, context);
      }
    }
  }

  /**
   * Format rule for API response
   */
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
