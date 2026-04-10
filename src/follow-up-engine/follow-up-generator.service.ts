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

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { STRATEGY_PROMPTS, OBJECTIVE_FLAVORS } from '../ai/strategy-prompts';
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
      this.logger.warn('OpenAI not configured — using fallback template');
      return this.generateFromTemplate(step);
    }

    // Step 1: Load thread context
    const context = await this.conversationContext.buildContext(conversationId, { recentMessageLimit: 5 });
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
        // Filter by enabled strategies in account settings
        const enabledStrategies = await this.getEnabledStrategies(conversationId);
        if (enabledStrategies && enabledStrategies.includes(suggestion.suggested)) {
          strategyKey = suggestion.suggested;
          strategyReason = suggestion.reason;
        } else if (enabledStrategies) {
          // Suggested strategy is disabled — pick the highest-scoring enabled one
          const bestEnabled = Object.entries(suggestion.scores)
            .filter(([key]) => enabledStrategies.includes(key))
            .sort(([, a], [, b]) => b - a)[0];
          if (bestEnabled) {
            strategyKey = bestEnabled[0];
            strategyReason = `fallback (${suggestion.suggested} disabled)`;
          }
        } else {
          strategyKey = suggestion.suggested;
          strategyReason = suggestion.reason;
        }
      }
    }

    const strategyPrompt = customStrategyPrompt || STRATEGY_PROMPTS[strategyKey] || STRATEGY_PROMPTS.hybrid;
    const objectiveFlavor = OBJECTIVE_FLAVORS[step.objective] || '';

    this.logger.log(`[FollowUpGenerator] Strategy: ${strategyKey} (${strategyReason}), objective: ${step.objective}`);

    // Step 3: Load pricing context and lead details
    let pricingContext = '';
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

    if (lead?.businessId) {
      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { servicePricingJson: true },
      });
      if (account?.servicePricingJson) {
        try {
          const p = JSON.parse(account.servicePricingJson);
          const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
          if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
            const priceParts = [
              '--- PRICING TABLE (reference for accurate quoting) ---',
            ];
            for (const row of p.priceTable.slice(0, 10)) {
              const prices = enabledTypes.map((t: any) => `${t.label}: $${row[t.key] || '?'}`).join(', ');
              priceParts.push(`  ${row.bed}BR/${row.bath}BA — ${prices}`);
            }
            priceParts.push('--- END PRICING ---');
            priceParts.push('Use these prices as your reference. Match the customer\'s bedrooms/bathrooms to the correct row. You may quote a range around the table price but it MUST be based on the actual table values — do NOT invent prices unrelated to the table.');
            pricingContext = priceParts.join('\n');
          }
        } catch { /* invalid JSON */ }
      }
    }

    // Step 3b: Load urgency context
    let urgencyContext = '';
    if (lead?.businessId) {
      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
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

    // Step 6: Build the final prompt
    const systemParts = [
      globalPrompt,
      '',
      '--- FOLLOW-UP CONTEXT ---',
      'The customer has NOT replied. You are writing a follow-up message.',
      'Write as the business owner, not as an AI. Be natural, brief, and professional.',
      'Do NOT use subject lines, greetings like "Dear", or sign-offs. Just the message body.',
      'Keep it under 3 sentences unless the objective requires more detail.',
      '',
      strategyPrompt,
    ];

    if (objectiveFlavor) {
      systemParts.push('', `STEP FLAVOR: ${objectiveFlavor}`);
    }

    if (customPrompt) {
      systemParts.push('', 'CUSTOM INSTRUCTIONS:', customPrompt);
    }

    if (pricingContext) {
      systemParts.push('', pricingContext);
    }

    if (urgencyContext) {
      systemParts.push('', urgencyContext);
    }

    if (context?.systemContext) {
      systemParts.push('', context.systemContext);
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
          content: msg.content,
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

      const reply = completion.choices[0]?.message?.content?.trim();
      if (!reply) throw new Error('Empty AI response');

      this.logger.log(`[FollowUpGenerator] Generated ${reply.length} chars — strategy=${strategyKey}, objective=${step.objective}`);

      return {
        message: reply,
        objective: step.objective,
        strategyUsed: strategyKey,
      };
    } catch (err: any) {
      this.logger.error(`[FollowUpGenerator] AI generation failed: ${err.message}`);
      return this.generateFromTemplate(step);
    }
  }

  /**
   * Get enabled strategies from account follow-up settings.
   * Returns null if no restrictions (all enabled).
   */
  private async getEnabledStrategies(conversationId: string): Promise<string[] | null> {
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
      // Auto mode = all strategies enabled (no filtering)
      if (settings.followUpStrategyMode === 'auto') return null;
      const scenarios = settings.followUpScenarios;
      if (!scenarios) return null;

      return Object.entries(scenarios)
        .filter(([, enabled]) => enabled)
        .map(([key]) => key);
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
