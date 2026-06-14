import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  buildTimeAwarenessBlock,
  prefixWithTimestamp,
  resolveTimezone,
  stripLeadingTimestampPrefix,
} from './time-context';

export interface ConversationMessage {
  role: 'customer' | 'pro';
  content: string;
  /** When this message was actually sent. Used to prefix the model's view of history. */
  sentAt?: Date | string;
}

export interface AiReplyContext {
  customerName: string;
  customerMessage: string;
  category?: string;
  city?: string;
  state?: string;
  budget?: number;
  accountName?: string;
  /**
   * GLOBAL prompt — guardrails layer. Tone, opt-out behavior, scheduling
   * rules, and the REACTIVE pricing policy live here. Falls back to the
   * built-in DEFAULT_GLOBAL_AI_PROMPT when not provided.
   */
  globalPrompt?: string;
  /**
   * PRIMARY INSTRUCTION — the strategy or user-edited template that
   * decides what the AI should DO right now (qualify, convert, etc.).
   * This layer overrides the GLOBAL when they conflict. If the user has
   * a custom prompt template, pass its content here.
   */
  strategyPrompt?: string;
  /**
   * @deprecated — kept for backward compatibility with callers that still
   * pass the older `systemPrompt` field. New callers should use the
   * separate strategyPrompt + reference blocks for proper section labeling.
   */
  systemPrompt?: string;
  /** REFERENCE — thread context (summary + state). Optional. */
  threadContextBlock?: string;
  /** REFERENCE — business profile (name, owner, hours, scheduling rules). Optional. */
  businessBlock?: string;
  /** REFERENCE — pricing table + range instruction. Optional. */
  pricingBlock?: string;
  /**
   * REFERENCE — deterministic calculated quote produced by the pricing
   * engine (src/pricing/pricing-engine.ts:buildQuoteBlock). When present,
   * the BASE HARD RULES require the LLM to use the numbers in this block
   * verbatim — no recompute, no rounding, no estimation. When the block
   * says "Pricing has NOT been calculated", the LLM must ask one
   * clarifying question instead of quoting. Optional.
   */
  quoteBlock?: string;
  /**
   * RUNTIME GUARD — PRICE INTENT ENFORCEMENT. Built by
   * src/pricing/price-intent.ts:buildPriceIntentBlock when the latest
   * customer message contains a price-seeking token AND the engine
   * produced a meaningful calculation. Renders ABOVE PRIMARY INSTRUCTION
   * with an explicit "this overrides PRIMARY and PLAYBOOK for this
   * single reply" header — closes the Peter Pidochev 2026-06-10 class
   * of bug where a softer "give a price range if you have enough info"
   * template instruction beat the strict PRICE strategy. Optional.
   */
  priceIntentBlock?: string;
  /** REFERENCE — per-account FAQ (insurance, supplies, pets, payment, scope, etc.). Optional. */
  faqBlock?: string;
  /** REFERENCE — urgency context (customer urgency × business capability). Optional. */
  urgencyBlock?: string;
  /**
   * PLAYBOOK — situational behavior summary (generated from settings) +
   * user-editable instructions per category. Pre-formatted block already
   * including the `=== PLAYBOOK ===` header. Optional. Built by
   * src/ai/playbook-renderer.ts:renderPlaybookBlock. Empty string when the
   * user has no instructions AND no toggles produce bullets.
   */
  playbookBlock?: string;
  /**
   * REFERENCE — Qualification required fields (Price/Qualify goals only).
   * Pre-formatted block listing the snake_case field keys the tenant has
   * marked as required for qualification. Built by the caller from
   * `followUpSettingsJson.qualificationV2.requiredFields` — only set when
   * strategy is 'price' or 'qualify' AND the array is non-empty.
   * Existing accounts without saved fields leave this undefined and AI
   * keeps the legacy hardcoded priority order from STRATEGY_PROMPTS.
   */
  qualificationBlock?: string;
  conversationHistory?: ConversationMessage[];
  leadDetails?: Record<string, string>;
  /** "Now" — defaults to new Date() at generation time. */
  currentTime?: Date;
  /** IANA tz, e.g. "America/New_York". Defaults inside time-context helpers. */
  timezone?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private _client: OpenAI | null = null;

  constructor(private readonly configService: ConfigService) {}

  private get client(): OpenAI {
    if (!this._client) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
      this._client = new OpenAI({ apiKey });
    }
    return this._client;
  }

  async generateReply(ctx: AiReplyContext): Promise<string> {
    const { TemplatesService } = require('../templates/templates.service');

    // GLOBAL — guardrails. User's custom global prompt → default global.
    const globalPrompt = ctx.globalPrompt?.trim() || TemplatesService.DEFAULT_GLOBAL_AI_PROMPT;

    // PRIMARY INSTRUCTION — strategy / user prompt template. Wins over GLOBAL
    // when they conflict. The legacy `systemPrompt` field is accepted as a
    // fallback for any caller that hasn't migrated to `strategyPrompt` yet.
    const strategyPrompt = (ctx.strategyPrompt ?? ctx.systemPrompt)?.trim() || '';

    // REFERENCE blocks — factual context the model may consult, never the
    // primary goal. Order: thread context (what we know about this convo),
    // business profile (who we are / scheduling), pricing table (only if
    // quoting), urgency.
    const referenceBlocks: string[] = [];
    if (ctx.threadContextBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: THREAD CONTEXT ===\n${ctx.threadContextBlock.trim()}`);
    }
    if (ctx.businessBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: BUSINESS PROFILE ===\n${ctx.businessBlock.trim()}`);
    }
    if (ctx.pricingBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: PRICING TABLE (use only when quoting — see GLOBAL pricing behavior) ===\n${ctx.pricingBlock.trim()}`);
    }
    // CALCULATED QUOTE — deterministic, authoritative. Renders after the
    // raw PRICING TABLE so the LLM sees "here is the table; here is the
    // already-computed quote for THIS lead — use the quote." BASE HARD
    // RULES forbid recomputing this block.
    if (ctx.quoteBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: CALCULATED QUOTE (deterministic — these numbers are authoritative; see BASE HARD RULES) ===\n${ctx.quoteBlock.trim()}`);
    }
    if (ctx.faqBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: ACCOUNT FAQ (verified answers — use verbatim when relevant) ===\n${ctx.faqBlock.trim()}`);
    }
    if (ctx.urgencyBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: URGENCY ===\n${ctx.urgencyBlock.trim()}`);
    }
    if (ctx.qualificationBlock?.trim()) {
      referenceBlocks.push(`=== REFERENCE: QUALIFICATION REQUIRED FIELDS (Price / Qualify goals) ===\n${ctx.qualificationBlock.trim()}`);
    }

    // Assemble the system prompt with explicit section labels so the model
    // can tell guardrails from goal from reference. PRIMARY INSTRUCTION sits
    // last among the directive sections — LLMs weight late + explicitly
    // labeled instructions heavier, which makes the user template / strategy
    // dominate when the GLOBAL and PRIMARY conflict.
    const sections: string[] = [];
    sections.push(`=== GLOBAL (guardrails — apply to every reply) ===\n${globalPrompt}`);
    if (strategyPrompt) {
      sections.push(`=== PRIMARY INSTRUCTION (this overrides GLOBAL when they conflict) ===\n${strategyPrompt}`);
    }
    // PLAYBOOK — situational behavior summary + user instructions. Sits
    // between PRIMARY (goal) and REFERENCE (lookup material): closer to the
    // goal because Playbook rules are conditional on situation, but separate
    // because it's user-authored content. The block already includes its
    // `=== PLAYBOOK ===` header — see playbook-renderer.ts.
    if (ctx.playbookBlock?.trim()) {
      sections.push(ctx.playbookBlock.trim());
    }
    // PRICE INTENT ENFORCEMENT — runtime guard. Renders LAST among the
    // directive sections so it is the most recently-stated, most
    // specific instruction the model sees before the REFERENCE blocks.
    // Combined with the BASE HARD RULES clause that calls this header
    // out as authoritative, it overrides any softer template / strategy
    // language. See src/pricing/price-intent.ts.
    if (ctx.priceIntentBlock?.trim()) {
      sections.push(`=== PRICE INTENT ENFORCEMENT (runtime guard — overrides PRIMARY INSTRUCTION and PLAYBOOK for THIS reply) ===\n${ctx.priceIntentBlock.trim()}`);
    }
    if (referenceBlocks.length > 0) {
      sections.push(referenceBlocks.join('\n\n'));
    }
    const systemPrompt = sections.join('\n\n');

    const now = ctx.currentTime ?? new Date();
    const timezone = resolveTimezone(ctx.timezone);
    const userPrompt = this.buildUserPrompt(ctx, now, timezone);

    this.logger.log(`[AI] Generating reply for customer "${ctx.customerName}" — category: ${ctx.category || 'unknown'} — tz: ${timezone}`);

    // Build the message thread:
    // system (instructions + lead context + current time) → history turns → final customer message
    const openAiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt + '\n\n' + userPrompt },
    ];

    // Inject conversation history as alternating user/assistant turns,
    // each prefixed with its [absolute time, relative delta] stamp so the
    // model can reason about gaps and stale offers.
    if (ctx.conversationHistory && ctx.conversationHistory.length > 0) {
      for (const m of ctx.conversationHistory) {
        openAiMessages.push({
          role: m.role === 'customer' ? 'user' : 'assistant',
          content: prefixWithTimestamp(m.content, m.sentAt, now, timezone),
        });
      }
    }

    // Final customer message — implicitly "just now" per the time-awareness block,
    // but stamp it explicitly too so the model can't miss it.
    openAiMessages.push({
      role: 'user',
      content: prefixWithTimestamp(ctx.customerMessage, now, now, timezone),
    });

    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: openAiMessages,
      max_tokens: 250,
      temperature: 0.4,
    });

    const rawReply = completion.choices[0]?.message?.content?.trim();
    if (!rawReply) {
      throw new Error('OpenAI returned empty response');
    }

    // Strip any leading [Today …, just now] prefix the model may have echoed
    // from the time-stamped history. The system prompt forbids it, but the
    // strip is a hard backstop so a slip never reaches the customer.
    const reply = stripLeadingTimestampPrefix(rawReply);
    if (reply !== rawReply) {
      this.logger.warn(`[AI] Stripped echoed timestamp prefix from reply`);
    }

    this.logger.log(`[AI] Reply generated (${reply.length} chars)`);
    return reply;
  }

  private buildUserPrompt(ctx: AiReplyContext, now: Date, timezone: string): string {
    const parts: string[] = [];

    // Time awareness goes first — current local time + rules for handling
    // stale offers and conversation gaps. The history that follows uses the
    // same clock, so the model can compute "has 2:30 PM passed yet?" itself.
    parts.push(buildTimeAwarenessBlock(now, timezone));
    parts.push('');

    // CONTINUATION guardrail — when there's any prior assistant turn in the
    // history, this is a continuation, not a first contact. The lead context
    // block below still surfaces sensitive details (death, divorce, hardship)
    // that anchor the model into re-opening with condolences and re-quoting
    // pricing every turn (Donna case). This block makes the continuation
    // status explicit and forbids the most common drift patterns.
    const hasPriorAssistantTurn =
      Array.isArray(ctx.conversationHistory) &&
      ctx.conversationHistory.some((m) => m.role === 'pro' && (m.content || '').trim().length > 0);
    if (hasPriorAssistantTurn) {
      parts.push('--- CONTINUATION ---');
      parts.push('This is a CONTINUATION of an existing conversation. The customer has heard from you before — they know who you are and what you offer.');
      parts.push('- Do NOT open with greetings ("Hi <name>,"), self-introductions, condolences, or expressions of sympathy. Those belong in the FIRST reply only.');
      parts.push('- Do NOT re-quote pricing, re-summarize the job (bedrooms / bathrooms / services), or re-offer scheduling unless the customer JUST asked for it again.');
      parts.push('- Respond ONLY to what the customer most recently said. If they said "thanks" / "all done" / "got it" / "the house has been cleaned" / similar wrap-up, do not pitch — match their energy with a brief acknowledgment, or stay silent if there is nothing useful to add.');
      parts.push('- The Lead Context below (sensitive details, original survey answers) is REFERENCE for your awareness, not a prompt to re-perform. Treat it as background you already used.');
      parts.push('--- END CONTINUATION ---');
      parts.push('');
    }

    parts.push('--- Lead Context ---');

    if (ctx.accountName) parts.push(`Business: ${ctx.accountName}`);
    if (ctx.category) parts.push(`Service requested: ${ctx.category}`);
    if (ctx.city || ctx.state) parts.push(`Location: ${[ctx.city, ctx.state].filter(Boolean).join(', ')}`);
    if (ctx.budget) parts.push(`Customer budget: $${ctx.budget}`);
    parts.push(`Customer name: ${ctx.customerName}`);

    // Include structured lead details (bedrooms, bathrooms, pets, frequency, etc.)
    if (ctx.leadDetails && Object.keys(ctx.leadDetails).length > 0) {
      parts.push('Job details:');
      for (const [question, answer] of Object.entries(ctx.leadDetails)) {
        parts.push(`  - ${question}: ${answer}`);
      }
    }

    parts.push('--- End Context ---');
    parts.push('IMPORTANT: The Job details above are FACTS from the customer\'s original request. Do NOT ask about information already provided (e.g., if they said "Regular cleaning", do not ask if they want deep vs regular). Use these details as established facts and build your response on top of them. Reference specific details naturally. If the customer wrote a message, respond to what THEY said.');

    return parts.join('\n');
  }
}
