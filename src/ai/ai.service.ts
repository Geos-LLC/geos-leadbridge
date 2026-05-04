import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import {
  buildTimeAwarenessBlock,
  prefixWithTimestamp,
  resolveTimezone,
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
  globalPrompt?: string;   // Global AI prompt (from user settings)
  systemPrompt?: string;   // Strategy prompt (from prompt template)
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

    // Global prompt: user's custom global prompt → default global prompt
    const globalPrompt = ctx.globalPrompt?.trim() || TemplatesService.DEFAULT_GLOBAL_AI_PROMPT;

    // Strategy prompt: selected strategy template (e.g., Hybrid, Price-Anchor)
    const strategyPrompt = ctx.systemPrompt?.trim() || '';

    // Combine: global prompt + strategy add-on
    const systemPrompt = strategyPrompt
      ? `${globalPrompt}\n\n${strategyPrompt}`
      : globalPrompt;

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

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error('OpenAI returned empty response');
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
