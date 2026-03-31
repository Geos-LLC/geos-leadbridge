/**
 * Follow-Up Generator Service
 *
 * Generates follow-up message content from step objective + ThreadContext.
 * AI mode: builds prompt from objective + conversation summary + state.
 * Template mode: uses step.messageTemplate with variable personalization.
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
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

/** Maps step objectives to AI generation instructions */
const OBJECTIVE_PROMPTS: Record<string, string> = {
  quick_check_in: 'Send a brief, friendly check-in. Ask if they had a chance to review your message. Keep it under 2 sentences.',
  value_add: 'Share something helpful — a tip, availability update, or relevant detail about the service they requested. Show expertise without being pushy.',
  soft_nudge: 'Gently remind them you are available. Reference the original request. Ask an easy question to re-engage.',
  re_engagement: 'Re-engage after a longer silence. Mention you are still interested in helping. Offer flexibility on scheduling.',
  last_chance: 'Final friendly reach-out. Let them know you will not follow up again unless they respond. Keep the door open.',
  soft_close: 'Wrap up warmly. Mention you are available if they change their mind. No pressure.',
  clarification_reminder: 'Gently remind about the unanswered question. Rephrase it simply if possible.',
  simplified_question: 'Ask a simpler version of the original question. Make it easy to answer (yes/no or pick from options).',
  price_follow_up: 'Follow up on the price/quote shared. Ask if it works for their budget or if they have questions.',
  value_justification: 'Explain what is included in the price. Highlight quality, reliability, or unique value.',
  flexibility_offer: 'Offer flexibility — payment plans, different service tiers, or adjusted scope.',
  booking_reminder: 'Remind them about the booking/scheduling step. Make it easy to confirm.',
  urgency_nudge: 'Add gentle urgency — mention limited availability or upcoming schedule changes.',
  availability_check: 'Check if their timeline has changed. Offer alternative dates or times.',
  monthly_check: 'Casual monthly check-in. Ask if they still need the service or if anything has changed.',
  final_attempt: 'Last message in the sequence. Friendly, brief, leave the door open.',
  follow_up: 'General follow-up. Reference original request and ask if they are still interested.',
};

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
   */
  async generateMessage(
    step: SequenceStep,
    conversationId: string,
    generationMode: string,
    promptTemplateId?: string | null,
  ): Promise<GeneratedFollowUp> {
    if (generationMode === 'template' && step.messageTemplate) {
      return this.generateFromTemplate(step);
    }

    return this.generateFromAI(step, conversationId, promptTemplateId);
  }

  private async generateFromTemplate(step: SequenceStep): Promise<GeneratedFollowUp> {
    // Personalize template with lead data
    const message = step.messageTemplate || `Following up on your request. ${step.objective}`;
    return {
      message,
      objective: step.objective,
      strategyUsed: null,
    };
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

    // Load thread context for AI
    const context = await this.conversationContext.buildContext(conversationId, { recentMessageLimit: 5 });
    const threadState = await this.conversationContext.getThreadState(conversationId);

    // Load custom prompt template if specified
    let customPrompt = '';
    if (promptTemplateId) {
      const template = await this.prisma.messageTemplate.findUnique({ where: { id: promptTemplateId } });
      if (template?.content) customPrompt = template.content;
    }

    // Load lead details for personalization
    const lead = await this.prisma.lead.findFirst({
      where: { threadId: conversationId },
      select: { customerName: true, category: true, city: true, state: true },
    });

    // Build the objective instruction
    const objectiveInstruction = OBJECTIVE_PROMPTS[step.objective] || `Follow up with objective: ${step.objective}`;

    // Build system prompt
    const systemParts = [
      'You are a business assistant writing a follow-up message to a customer who has not replied.',
      'Write as the business owner, not as an AI. Be natural, brief, and professional.',
      'Do NOT use subject lines, greetings like "Dear", or sign-offs. Just the message body.',
      'Keep it under 3 sentences unless the objective requires more detail.',
      '',
      `OBJECTIVE: ${objectiveInstruction}`,
    ];

    if (customPrompt) {
      systemParts.push('', 'STRATEGY:', customPrompt);
    }

    if (context?.systemContext) {
      systemParts.push('', context.systemContext);
    }

    if (lead) {
      systemParts.push('', '--- Lead ---');
      if (lead.customerName) systemParts.push(`Customer: ${lead.customerName}`);
      if (lead.category) systemParts.push(`Service: ${lead.category}`);
      if (lead.city || lead.state) systemParts.push(`Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}`);
    }

    // Build messages array with recent conversation for context
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
      content: `Write the follow-up message now. Objective: ${step.objective}. The customer has not replied.`,
    });

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages,
        max_tokens: 150,
        temperature: 0.7,
      });

      const reply = completion.choices[0]?.message?.content?.trim();
      if (!reply) throw new Error('Empty AI response');

      this.logger.log(`[FollowUpGenerator] AI generated ${reply.length} chars for objective=${step.objective}`);

      return {
        message: reply,
        objective: step.objective,
        strategyUsed: threadState?.activeStrategy || null,
      };
    } catch (err: any) {
      this.logger.error(`[FollowUpGenerator] AI generation failed: ${err.message}`);
      // Fallback to template
      return this.generateFromTemplate(step);
    }
  }
}
