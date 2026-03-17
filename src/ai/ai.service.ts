import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface AiReplyContext {
  customerName: string;
  customerMessage: string;
  category?: string;
  city?: string;
  state?: string;
  budget?: number;
  accountName?: string;
  systemPrompt?: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly client: OpenAI;

  constructor(private readonly configService: ConfigService) {
    this.client = new OpenAI({
      apiKey: this.configService.get<string>('OPENAI_API_KEY'),
    });
  }

  async generateReply(ctx: AiReplyContext): Promise<string> {
    const defaultSystemPrompt = `You are a friendly, professional assistant for a home service business.
Your job is to respond to new customer inquiries quickly and warmly to win the job.
Keep responses short (2-4 sentences), conversational, and focused on moving toward booking.
Ask one clarifying question if needed. Never mention AI or automation.`;

    const systemPrompt = ctx.systemPrompt?.trim()
      ? ctx.systemPrompt.trim()
      : defaultSystemPrompt;

    const userPrompt = this.buildUserPrompt(ctx);

    this.logger.log(`[AI] Generating reply for customer "${ctx.customerName}" — category: ${ctx.category || 'unknown'}`);

    const completion = await this.client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
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
    const parts: string[] = [];

    if (ctx.accountName) parts.push(`Business: ${ctx.accountName}`);
    if (ctx.category) parts.push(`Service: ${ctx.category}`);
    if (ctx.city || ctx.state) parts.push(`Location: ${[ctx.city, ctx.state].filter(Boolean).join(', ')}`);
    if (ctx.budget) parts.push(`Customer budget: $${ctx.budget}`);

    parts.push(`Customer name: ${ctx.customerName}`);
    parts.push(`Customer message: "${ctx.customerMessage}"`);
    parts.push(`\nWrite a reply to this customer inquiry:`);

    return parts.join('\n');
  }
}
