/**
 * Follow-Up Generator Service
 *
 * Generation flow:
 *   thread context → suggestStrategy() → strategy prompt → step objective flavor → final message
 *
 * Uses the same strategy prompts as Lead Activity preview buttons.
 * Step objectives (quick_check_in, value_add, etc.) act as flavor modifiers
 * on top of the selected strategy, not as a separate prompt system.
 *
 * Respects:
 *   - Manual strategy override (activeStrategy on ThreadContext wins over suggestion)
 *   - Enabled strategies from account settings (fuScenarios)
 *   - Platform-agnostic (Yelp, Thumbtack, future platforms)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { MonitoringService } from '../monitoring/monitoring.service';
import { STRATEGY_PROMPTS, OBJECTIVE_FLAVORS } from '../ai/strategy-prompts';
import { buildTimeAwarenessBlock, prefixWithTimestamp, resolveTimezone, stripLeadingTimestampPrefix } from '../ai/time-context';
import { buildBusinessContextBlock } from '../ai/business-context';
import { buildFaqBlock, parseAccountFaq } from '../ai/faq-context';
import { buildPriceRangeInstruction } from '../ai/price-range';
import { buildPricingGuardRules } from '../ai/pricing-guards';
import { renderPlaybookBlock } from '../ai/playbook-renderer';
import { buildQualificationBlockForStrategy } from '../ai/qualification-context';
import OpenAI from 'openai';

export interface SequenceStep {
  stepOrder: number;
  delayMinutes: number;
  objective: string;
  messageTemplate?: string | null;
}

export interface GeneratedFollowUp {
  message: string;
  objective: string;
  strategyUsed: string | null;
}

@Injectable()
export class FollowUpGeneratorService {
  private readonly logger = new Logger(FollowUpGeneratorService.name);
  private _openai: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly conversationContext: ConversationContextService,
    // Optional so unit tests that direct-instantiate the service don't need to
    // wire monitoring. Production DI always populates it via the global module.
    @Optional() private readonly monitoring: MonitoringService | null = null,
  ) {}

  private get openai(): OpenAI | null {
    if (!this._openai) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) return null;
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

  /**
   * Generate a follow-up message for a step.
   *
   * Flow: thread context → suggestStrategy() → strategy prompt → objective flavor → message
   */
  async generateMessage(
    step: SequenceStep,
    conversationId: string,
    generationMode: string,
    promptTemplateId?: string | null,
  ): Promise<GeneratedFollowUp> {
    // If step has a user-assigned template message, always use it (regardless of mode)
    if (step.messageTemplate) {
      return this.generateFromTemplate(step, conversationId);
    }

    // AI mode: generate contextual message
    return this.generateFromAI(step, conversationId, promptTemplateId);
  }

  private async generateFromTemplate(step: SequenceStep, conversationId?: string): Promise<GeneratedFollowUp> {
    let message = step.messageTemplate || 'Following up on your request.';

    // Variable substitution
    if (conversationId && message.includes('{{')) {
      try {
        const lead = await this.prisma.lead.findFirst({
          where: { threadId: conversationId },
          select: { customerName: true, category: true, city: true, state: true },
        });
        if (lead) {
          message = message
            .replace(/\{\{lead\.name\}\}/g, lead.customerName || 'there')
            .replace(/\{\{lead\.category\}\}/g, lead.category || 'your service request')
            .replace(/\{\{lead\.city\}\}/g, lead.city || '')
            .replace(/\{\{lead\.state\}\}/g, lead.state || '');
        }
      } catch { /* non-critical */ }
    }

    return { message, objective: step.objective, strategyUsed: 'template' };
  }

  private async generateFromAI(
    step: SequenceStep,
    conversationId: string,
    promptTemplateId?: string | null,
  ): Promise<GeneratedFollowUp> {
    if (!this.openai) {
      this.logger.warn('OpenAI not configured — checking for user template fallback');
      const userTemplate = await this.lookupUserStepTemplate(conversationId, step.stepOrder);
      if (userTemplate) {
        return this.generateFromTemplate(
          { ...step, messageTemplate: userTemplate },
          conversationId,
        );
      }
      throw new Error(`OPENAI_API_KEY not configured and no user template for step ${step.stepOrder}`);
    }

    // Step 1: Load thread context. We pass 100 as the limit — large enough to
    // cover effectively any real lead thread (typical max is 30-50 messages
    // before a status transition closes it). Earlier versions used 5 then 20,
    // both small enough that the prior scheduling discussion fell off and the
    // AI regressed to qualifying questions. 100 is the practical "full thread".
    const context = await this.conversationContext.buildContext(conversationId, { recentMessageLimit: 100 });
    const threadState = await this.conversationContext.getThreadState(conversationId);

    // Step 2: Determine strategy
    //   Priority: thread override > account default > suggestStrategy() > fallback 'hybrid'
    let strategyKey = 'hybrid';
    let strategyReason = '';
    let customStrategyPrompt: string | null = null;

    // Check account-level strategy setting (user configured in follow-up settings)
    const accountSettings = await this.getAccountFollowUpSettings(conversationId);
    if (accountSettings?.followUpStrategy && accountSettings.followUpStrategy !== 'auto') {
      strategyKey = accountSettings.followUpStrategy;
      strategyReason = 'account default';
      if (accountSettings.followUpStrategyPrompt) {
        customStrategyPrompt = accountSettings.followUpStrategyPrompt;
      }
    } else if (threadState?.activeStrategy && STRATEGY_PROMPTS[threadState.activeStrategy]) {
      // Manual override from thread — respect it
      strategyKey = threadState.activeStrategy;
      strategyReason = 'manual override';
    } else {
      // Use suggestStrategy() to pick the best strategy from thread context
      const suggestion = await this.conversationContext.suggestStrategy(conversationId);
      if (suggestion) {
        strategyKey = suggestion.suggested;
        strategyReason = suggestion.reason;
      }
    }

    const strategyPrompt = customStrategyPrompt || STRATEGY_PROMPTS[strategyKey] || STRATEGY_PROMPTS.hybrid;
    const objectiveFlavor = OBJECTIVE_FLAVORS[step.objective] || '';

    this.logger.log(`[FollowUpGenerator] Strategy: ${strategyKey} (${strategyReason}), objective: ${step.objective}`);

    // Step 3: Load pricing context and lead details
    let pricingContext = '';
    let faqContext = '';
    const lead = await this.prisma.lead.findFirst({
      where: { threadId: conversationId },
      select: { customerName: true, category: true, city: true, state: true, businessId: true, userId: true, message: true, rawJson: true },
    });

    // Extract request details (bedrooms, bathrooms, service type) from lead
    let requestDetails = '';
    if (lead?.rawJson) {
      try {
        const raw = JSON.parse(lead.rawJson);
        const details: string[] = [];
        if (raw.bedrooms) details.push(`${raw.bedrooms} bedrooms`);
        if (raw.bathrooms) details.push(`${raw.bathrooms} bathrooms`);
        if (raw.squareFeet || raw.square_feet) details.push(`${raw.squareFeet || raw.square_feet} sq ft`);
        if (raw.frequency) details.push(`frequency: ${raw.frequency}`);
        if (raw.serviceType || raw.service_type) details.push(`service: ${raw.serviceType || raw.service_type}`);
        if (details.length > 0) requestDetails = `Customer request details: ${details.join(', ')}`;
      } catch {}
    }
    if (!requestDetails && lead?.message) {
      requestDetails = `Customer request: ${lead.message.substring(0, 200)}`;
    }

    // Load all account fields once — used for pricing, business profile, urgency, and Playbook.
    let timezone: string = 'America/New_York';
    let businessContext = '';
    let urgencyContext = '';
    let playbookBlock = '';
    // Qualification REFERENCE block. Only emitted when the resolved strategy
    // is 'price' or 'qualify' AND the tenant has saved a non-empty
    // `qualificationV2.requiredFields` array. Existing accounts without
    // that key keep the legacy hardcoded priority order from STRATEGY_PROMPTS.qualify.
    const qualificationBlockBody: string = buildQualificationBlockForStrategy(
      strategyKey,
      accountSettings?.qualificationV2?.requiredFields,
    );
    if (lead?.businessId) {
      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: {
          businessName: true,
          servicePricingJson: true,
          faqJson: true,
          followUpTimezone: true,
          followUpSettingsJson: true,
          followUpActiveHoursStart: true,
          followUpActiveHoursEnd: true,
          aiConversationMode: true,
        },
      });
      const owner = await this.prisma.user.findUnique({
        where: { id: lead.userId },
        select: { name: true },
      });
      timezone = resolveTimezone(account?.followUpTimezone);
      // Qualify never quotes — suppress the pricing REFERENCE so the model
      // isn't tempted to volunteer a number after the customer answers a
      // qualifying question.
      const suppressPricingForQualify = strategyKey === 'qualify';
      if (account?.servicePricingJson && !suppressPricingForQualify) {
        try {
          const p = JSON.parse(account.servicePricingJson);
          const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
          if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
            // Same range/exact toggle as automation.service / ai.controller.
            let priceQuoteMode: 'range' | 'exact' | undefined;
            if (account?.followUpSettingsJson) {
              try {
                const s = JSON.parse(account.followUpSettingsJson);
                if (s?.priceQuoteMode === 'range' || s?.priceQuoteMode === 'exact') priceQuoteMode = s.priceQuoteMode;
              } catch { /* fall back to legacy inference */ }
            }
            const sqftAdjustEnabled = p?.sqftAdjustEnabled !== false;
            const priceParts = [
              '=== REFERENCE: PRICING TABLE (use only when quoting — see GLOBAL pricing behavior) ===',
            ];
            for (const row of p.priceTable.slice(0, 10)) {
              // Back-compat: rows saved before the min/max split carry a single `sqft` field.
              const legacy = Number(row.sqft) || 0;
              const sqftMin = Number(row.sqftMin) || legacy;
              const sqftMax = Number(row.sqftMax) || legacy;
              const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
              const prices = enabledTypes.map((t: any) => {
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
            // Hard guards (see pricing-guards.ts). Closes the FargiPro follow-up
            // "$130 for 1BR/1BA" bug — AI must NOT quote when bed/bath unknown
            // or when the requested service type is disabled on this account.
            priceParts.push(buildPricingGuardRules(p));
            pricingContext = priceParts.join('\n');
          }
        } catch { /* invalid JSON */ }
      }

      const faq = buildFaqBlock(parseAccountFaq(account?.faqJson));
      if (faq) {
        faqContext = `=== REFERENCE: ACCOUNT FAQ (verified answers — use verbatim when relevant) ===\n${faq}`;
      }

      // Business profile (turnaround capability, active hours, scheduling rules)
      businessContext = buildBusinessContextBlock({
        businessName: account?.businessName ?? null,
        ownerName: owner?.name ?? null,
        city: lead.city ?? null,
        state: lead.state ?? null,
        followUpSettingsJson: account?.followUpSettingsJson ?? null,
        activeHoursStart: account?.followUpActiveHoursStart ?? null,
        activeHoursEnd: account?.followUpActiveHoursEnd ?? null,
        timezone: account?.followUpTimezone ?? null,
      });

      // Extra urgency emphasis when customer flagged urgent (base capability
      // already in the business profile above)
      const threadCtx = context?.threadState;
      const customerUrgency = threadCtx?.customerUrgency || 'low';
      let urgentCapability = 'same_day';
      if (account?.followUpSettingsJson) {
        try {
          const s = JSON.parse(account.followUpSettingsJson);
          if (s.followUpUrgentCapability) urgentCapability = s.followUpUrgentCapability;
        } catch {}
      }
      if (customerUrgency === 'high') {
        urgencyContext = `Customer urgency: HIGH. Business capability: ${urgentCapability}.`;
        if (urgentCapability === 'same_day') urgencyContext += ' You CAN offer same-day.';
        else if (urgentCapability === '24h') urgencyContext += ' Shift to tomorrow, NOT same-day.';
        else if (urgentCapability === '48h') urgencyContext += ' Offer 1-2 days out, NOT same-day.';
        else urgencyContext += ' Do NOT imply urgent availability. Offer next available slot.';
      }

      // PLAYBOOK V2 — BASE HARD RULES + 8 HOW sections (default + custom).
      // No automation-derived behavior bullets in V2; Playbook is HOW only.
      playbookBlock = renderPlaybookBlock({
        followUpSettingsJson: account?.followUpSettingsJson ?? null,
      });
    }

    // Step 4: Load custom prompt template if specified
    let customPrompt = '';
    if (promptTemplateId) {
      const template = await this.prisma.messageTemplate.findUnique({ where: { id: promptTemplateId } });
      if (template?.content) customPrompt = template.content;
    }

    // Step 5: Load global AI prompt
    let globalPrompt = '';
    if (lead?.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: lead.userId }, select: { globalAiPrompt: true } });
      if (user?.globalAiPrompt) globalPrompt = user.globalAiPrompt;
    }
    if (!globalPrompt) {
      const { TemplatesService } = require('../templates/templates.service');
      globalPrompt = TemplatesService.DEFAULT_GLOBAL_AI_PROMPT;
    }

    // Step 6: Build the final prompt with labeled sections so the model can
    // distinguish guardrails (GLOBAL) from goal (PRIMARY INSTRUCTION) from
    // reference material. Mirrors ai.service.ts assembly.
    const now = new Date();
    const systemParts = [
      '=== GLOBAL (guardrails — apply to every reply) ===',
      globalPrompt,
      '',
      buildTimeAwarenessBlock(now, timezone),
      '',
      '=== PRIMARY INSTRUCTION (this overrides GLOBAL when they conflict) ===',
      'FOLLOW-UP CONTEXT: The customer has NOT replied. You are writing a follow-up message.',
      'Write as the business owner, not as an AI. Be natural, brief, and professional.',
      'Do NOT use subject lines, greetings like "Dear", or sign-offs. Just the message body.',
      'Keep it under 3 sentences unless the objective requires more detail.',
      '',
      // Conversation-stage guardrail: if scheduling / booking has already been
      // discussed in the prior thread, do NOT regress to qualifying questions
      // (bedrooms, bathrooms, square footage). Carol case: AI asked for room
      // count after the customer had already moved on to picking a day.
      'IMPORTANT — read the conversation history below before writing:',
      '- If the customer has already discussed scheduling, picked an availability, asked about timing, or said "afternoons/mornings work", DO NOT ask qualifying questions about home size, bedrooms, bathrooms, or square footage. Stay in scheduling mode.',
      '- If the customer is paused waiting on someone else (spouse, partner, family), DO NOT pressure them with new questions. A brief, low-pressure check-in is fine — but no new asks.',
      '- If the customer has already given home details in their message (rooms, size, condition, special requests), DO NOT ask them again.',
      '- The strategy below is a default direction; the conversation history overrides it when the lead has progressed past that stage.',
      '',
      strategyPrompt,
    ];

    if (objectiveFlavor) {
      systemParts.push('', `STEP FLAVOR: ${objectiveFlavor}`);
    }

    // PLAYBOOK — situational behavior summary + user instructions. Sits AFTER
    // strategy + STEP FLAVOR (modifiers) and BEFORE customPrompt (per-step
    // user override) so the Playbook is foundational guidance; per-step
    // overrides still win when explicitly set. Block already includes its
    // own `=== PLAYBOOK ===` header.
    if (playbookBlock) {
      systemParts.push('', playbookBlock);
    }

    if (customPrompt) {
      systemParts.push('', 'CUSTOM INSTRUCTIONS (user-supplied — these override the strategy default above):', customPrompt);
    }

    if (businessContext) {
      systemParts.push('', '=== REFERENCE: BUSINESS PROFILE ===', businessContext);
    }

    if (pricingContext) {
      systemParts.push('', pricingContext);
    }

    if (faqContext) {
      systemParts.push('', faqContext);
    }

    if (urgencyContext) {
      systemParts.push('', '=== REFERENCE: URGENCY ===', urgencyContext);
    }

    if (qualificationBlockBody) {
      systemParts.push(
        '',
        '=== REFERENCE: QUALIFICATION REQUIRED FIELDS (Price / Qualify goals) ===',
        qualificationBlockBody,
      );
    }

    if (context?.systemContext) {
      systemParts.push('', '=== REFERENCE: THREAD CONTEXT ===', context.systemContext);
    }

    if (lead) {
      systemParts.push('', '--- Lead ---');
      if (lead.customerName) systemParts.push(`Customer: ${lead.customerName}`);
      if (lead.category) systemParts.push(`Service: ${lead.category}`);
      if (lead.city || lead.state) systemParts.push(`Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}`);
      if (requestDetails) systemParts.push(requestDetails);
    }

    // Load ALL previous follow-up messages across ALL enrollments for this conversation
    // so AI doesn't repeat itself even when re-enrolled
    const previousFollowUps = await this.prisma.followUpStepExecution.findMany({
      where: {
        enrollment: { conversationId },
        status: 'sent',
        generatedMessage: { not: null },
      },
      orderBy: { scheduledAt: 'asc' },
      select: { generatedMessage: true, stepIndex: true },
    });
    // Deduplicate by message content
    const seenMessages = new Set<string>();
    const uniqueFollowUps = previousFollowUps.filter(p => {
      if (seenMessages.has(p.generatedMessage!)) return false;
      seenMessages.add(p.generatedMessage!);
      return true;
    });
    // Also load ALL pro messages sent to this conversation (manual + auto)
    const allProMessages = await this.prisma.message.findMany({
      where: { conversationId, sender: 'pro' },
      orderBy: { sentAt: 'asc' },
      select: { content: true },
    });
    const allSentContent = allProMessages.map(m => m.content).filter(Boolean);
    for (const content of allSentContent) {
      seenMessages.add(content);
    }

    if (uniqueFollowUps.length > 0 || allSentContent.length > 0) {
      systemParts.push('', '--- ALL MESSAGES ALREADY SENT TO THIS CUSTOMER (do NOT repeat ANY of these) ---');
      for (const content of seenMessages) {
        systemParts.push(`"${content}"`);
      }

      // Extract opening phrases (first 5-6 words) as explicit banned openers
      const bannedOpeners: string[] = [];
      for (const content of seenMessages) {
        const words = content.split(/\s+/).slice(0, 5).join(' ');
        if (words.length > 5) bannedOpeners.push(words);
      }
      if (bannedOpeners.length > 0) {
        systemParts.push('', '--- BANNED OPENING PHRASES (do NOT start your message with any variation of these) ---');
        for (const opener of bannedOpeners) {
          systemParts.push(`- "${opener}..."`);
        }
      }

      systemParts.push('', 'CRITICAL: You MUST write a COMPLETELY DIFFERENT message. Rules:');
      systemParts.push('1. Do NOT start with any of the banned opening phrases above or similar variations.');
      systemParts.push('2. Do NOT reuse the same angle, structure, or wording from any previous message.');
      systemParts.push('3. Try a completely new approach — different opening, different value proposition, different tone.');
      systemParts.push(`4. You have sent ${seenMessages.size} messages already. Be creative and vary your style.`);
    }

    // Build messages with conversation history
    const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemParts.join('\n') },
    ];

    if (context?.recentMessages) {
      for (const msg of context.recentMessages) {
        messages.push({
          role: msg.role === 'customer' ? 'user' : 'assistant',
          content: prefixWithTimestamp(msg.content, msg.sentAt, now, timezone),
        });
      }
    }

    messages.push({
      role: 'user',
      content: `Write the follow-up message now. The customer has not replied. Strategy: ${strategyKey}. Step: ${step.objective}.`,
    });

    try {
      // Vary temperature by step order and number of previous messages:
      // Early steps (0-1): 0.4 (consistent), Mid steps (2-4): 0.6, Late steps (5+): 0.8 (creative)
      // More previous messages = more temperature to force divergence
      const baseTemp = step.stepOrder <= 1 ? 0.4 : step.stepOrder <= 4 ? 0.6 : 0.8;
      const prevMsgBoost = Math.min(0.2, seenMessages.size * 0.05);
      const temperature = Math.min(1.0, baseTemp + prevMsgBoost);

      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 200,
        temperature,
      });

      const rawReply = completion.choices[0]?.message?.content?.trim();
      if (!rawReply) throw new Error('Empty AI response');

      const reply = stripLeadingTimestampPrefix(rawReply);
      if (reply !== rawReply) {
        this.logger.warn(`[FollowUpGenerator] Stripped echoed timestamp prefix from reply`);
      }

      this.logger.log(`[FollowUpGenerator] Generated ${reply.length} chars — strategy=${strategyKey}, objective=${step.objective}`);

      return {
        message: reply,
        objective: step.objective,
        strategyUsed: strategyKey,
      };
    } catch (err: any) {
      const errMessage = err?.message ?? String(err);
      this.logger.error(`[FollowUpGenerator] AI generation failed: ${errMessage}`);

      // Report to MonitoringService. captureError dedups via SystemErrorLog and
      // auto-detects platform-wide OpenAI failures (auth + quota) — those fire
      // a single dev-alert email per 24h to DEV_ALERT_EMAIL, not per-account
      // spam to the customer.
      if (this.monitoring) {
        this.monitoring.captureError({
          category: 'automation',
          code: 'ai_followup_generation_failed',
          severity: 'error',
          message: errMessage,
          userId: lead?.userId,
          accountId: undefined, // SavedAccount.id not in scope; userId is enough for dedup
          context: {
            conversationId,
            strategy: strategyKey,
            objective: step.objective,
            stepOrder: step.stepOrder,
          },
        }).catch(e => this.logger.warn(`[FollowUpGenerator] captureError failed: ${e?.message}`));
      }

      // Fallback policy when AI is unavailable:
      //   1. Try the user's saved template text for this step (kept in
      //      followUpSettingsJson.followUpSteps even when the sequence is in
      //      AI mode — scheduler strips it for the generator, but for failure
      //      fallback we want the real saved text, not "Following up on your
      //      request.").
      //   2. If the user never wrote step text, throw so the scheduler can
      //      mark the execution as failed and retry. We deliberately do NOT
      //      send the generic hardcoded placeholder — it's spammy and erodes
      //      trust when AI is broken account-wide.
      const userTemplate = await this.lookupUserStepTemplate(conversationId, step.stepOrder);
      if (userTemplate) {
        this.logger.warn(`[FollowUpGenerator] Falling back to user template for step ${step.stepOrder}`);
        return this.generateFromTemplate(
          { ...step, messageTemplate: userTemplate },
          conversationId,
        );
      }

      // No user template configured — refuse to send a generic fallback.
      // The scheduler catches this and treats it as a transient send failure
      // (15-minute retry), keeping the customer experience clean while OpenAI
      // is down.
      throw new Error(`AI generation failed and no user template configured for step ${step.stepOrder}: ${errMessage}`);
    }
  }

  /**
   * Read the user's saved follow-up step message text from SavedAccount
   * settings — even when the sequence is in AI mode. Used as the
   * "OpenAI is down" fallback so we send the user's words instead of the
   * generic "Following up on your request." placeholder.
   *
   * Returns null when no template text exists for this step index.
   */
  private async lookupUserStepTemplate(
    conversationId: string,
    stepOrder: number,
  ): Promise<string | null> {
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { threadId: conversationId },
        select: { businessId: true, userId: true },
      });
      if (!lead?.businessId) return null;

      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (!account?.followUpSettingsJson) return null;

      const settings = JSON.parse(account.followUpSettingsJson);
      const uiSteps = settings.followUpSteps || settings.followUpSmartSteps || settings.followUpCustomSteps;
      if (!Array.isArray(uiSteps)) return null;

      const entry = uiSteps[stepOrder];
      const text = entry?.message;
      return typeof text === 'string' && text.trim().length > 0 ? text : null;
    } catch {
      return null;
    }
  }

  /**
   * Load account follow-up settings (strategy, custom prompt, etc.).
   */
  private async getAccountFollowUpSettings(conversationId: string): Promise<any | null> {
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { threadId: conversationId },
        select: { businessId: true, userId: true },
      });
      if (!lead?.businessId) return null;

      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (!account?.followUpSettingsJson) return null;

      return JSON.parse(account.followUpSettingsJson);
    } catch {
      return null;
    }
  }
}
