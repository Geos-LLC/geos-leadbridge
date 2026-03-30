import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface ConversationMessage {
  role: 'customer' | 'pro';
  content: string;
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

    const userPrompt = this.buildUserPrompt(ctx);

    this.logger.log(`[AI] Generating reply for customer "${ctx.customerName}" — category: ${ctx.category || 'unknown'}`);

    // Build the message thread:
    // system (instructions + lead context) → history turns → final customer message
    const openAiMessages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
      { role: 'system', content: systemPrompt + '\n\n' + userPrompt },
    ];

    // Inject conversation history as alternating user/assistant turns
    if (ctx.conversationHistory && ctx.conversationHistory.length > 0) {
      for (const m of ctx.conversationHistory) {
        openAiMessages.push({
          role: m.role === 'customer' ? 'user' : 'assistant',
          content: m.content,
        });
      }
    }

    // Final customer message to reply to
    openAiMessages.push({ role: 'user', content: ctx.customerMessage });

    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: openAiMessages,
      max_tokens: 200,
      temperature: 0.7,
    });

    const reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) {
      throw new Error('OpenAI returned empty response');
    }

    this.logger.log(`[AI] Reply generated (${reply.length} chars)`);
    return reply;
  }

  private buildUserPrompt(ctx: AiReplyContext): string {
    const parts: string[] = ['--- Lead Context ---'];

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
    parts.push('Use the context above to craft a personalized reply. Reference specific details (service type, frequency, add-ons, location, etc.) naturally — don\'t list them all back, but show you understand the request. If the customer wrote a detailed message, respond to what THEY said, not just the form data.');

    return parts.join('\n');
  }
}
