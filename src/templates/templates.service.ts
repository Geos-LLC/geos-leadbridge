/**
 * Templates Service
 * Manages message templates (SMS/reply) and AI prompt templates.
 * type="message" — SMS/reply templates with {variables}
 * type="prompt"  — AI system prompts for auto-reply
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

export interface CreateTemplateDto {
  name: string;
  content: string;
  type?: 'message' | 'prompt';
  isDefault?: boolean;
}

export interface UpdateTemplateDto {
  name?: string;
  content?: string;
  isDefault?: boolean;
}

export interface TemplateResponse {
  id: string;
  name: string;
  content: string;
  type: string;
  isDefault: boolean;
  usageCount: number;
  lastUsedAt: string | null;
  createdAt: string;
}

@Injectable()
export class TemplatesService {
  constructor(private prisma: PrismaService) {}

  private static readonly DEFAULT_TEMPLATES: { name: string; content: string; type: string; isDefault: boolean }[] = [
    {
      name: 'Auto Reply - New Lead',
      content: 'Hi {firstName}, thanks for reaching out about {category}! I\'d love to help. Let me review your request and I\'ll get back to you shortly with availability and pricing. - {accountName}',
      type: 'message',
      isDefault: true,
    },
    {
      name: 'Auto Reply - Follow Up',
      content: 'Hi {firstName}, just following up on your {category} request. Are you still looking for help? I have availability this week and would love to assist. Let me know!',
      type: 'message',
      isDefault: false,
    },
    {
      name: 'Alert - New Lead Notification',
      content: 'New lead from Thumbtack! {customerName} is looking for {category} in {city}. Check your dashboard for details.',
      type: 'message',
      isDefault: false,
    },
    {
      name: 'Auto Reply - Welcome',
      content: 'Welcome to {accountName}! Thanks for choosing us for your {category} needs. We\'ll be in touch soon to discuss your project. Feel free to reply with any questions!',
      type: 'message',
      isDefault: false,
    },
  ];

  private static readonly DEFAULT_PROMPTS: { name: string; content: string; type: string; isDefault: boolean }[] = [
    {
      name: 'First Reply',
      content: `You are responding to a new customer inquiry. This is the FIRST reply.

Your goal:
- Acknowledge their request warmly
- Show you understand what they need (reference their specific details)
- Give a price range if you have enough info (bedrooms, bathrooms, service type)
- Ask ONE key question if critical info is missing (e.g. square footage, condition)
- Keep it short (2-3 sentences)

Tone:
- Friendly, professional, local
- Not salesy or robotic
- Show you read their request carefully

DO NOT:
- Ask questions about info they already provided
- Give vague responses like "let me know"
- Write more than 3-4 sentences
- Use bullet points or formatting

Sign off with your business name.`,
      type: 'prompt',
      isDefault: true,
    },
    {
      name: 'Price-Anchor Strategy',
      content: `STRATEGY: PRICE ANCHOR

Use when:
- Customer asks about price directly
- Or pricing is the main concern

You MUST:
- Lead with a price range based on pricing settings
- Briefly explain what is included

DO NOT:
- Ask questions
- Be vague or hesitant

Tone: Confident and clear

Goal: Give the customer a number to react to.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Qualification Strategy',
      content: `STRATEGY: QUALIFICATION

Use when:
- Critical details are missing (home size, timing, condition)

You MUST:
- Ask 2-3 specific questions
- Briefly explain why you need the info

DO NOT:
- Give pricing
- Use if enough info is already provided

Goal: Collect only the minimum info needed to move to pricing or booking.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Conversion Strategy',
      content: `STRATEGY: CONVERSION

Use when:
- You have enough information
- Lead shows intent or urgency
- Ready to move to booking

You MUST:
- Include pricing based on settings
- Offer a SPECIFIC time or 2 options
- Push toward scheduling

DO NOT:
- Ask open-ended questions
- Delay with unnecessary details

Goal: Get the lead to commit to a time.`,
      type: 'prompt',
      isDefault: false,
    },
  ];

  /** The global AI prompt — applied to ALL messages regardless of strategy */
  static readonly DEFAULT_GLOBAL_AI_PROMPT = `You are an AI assistant helping a local home cleaning business respond to inbound leads.

Your goal is to maximize booking conversion while maintaining a natural, human-like conversation.

PRIMARY OBJECTIVE:
Move the lead toward booking as efficiently as possible.

Core principles:
- Messages must feel natural and conversational (not scripted)
- Keep responses short (1-3 sentences unless needed)
- Be clear, confident, and helpful
- Avoid unnecessary questions
- Always move the conversation forward
- Reduce uncertainty for the customer

Tone:
- Friendly, professional, and local
- Not overly salesy or robotic
- Slight urgency is allowed, but never pressure

Platform behavior:
- Only respond in context of a customer inquiry
- Do not initiate unrelated outreach
- Follow-ups must feel like a continuation of the conversation
- Do not push phone calls too early unless needed

Pricing behavior:
- Use pricing settings provided by the system (DO NOT invent prices)
- Base estimates on bedrooms, bathrooms, service type, condition, and extras
- Prefer ranges early (e.g. "typically $140-180")
- If enough data is available, be confident in pricing
- If data is missing, estimate conservatively or ask for key detail

Decision logic:
Before replying, determine:
- What stage the lead is in
- What is the next best step to move toward booking

Possible next steps:
- clarify missing info
- give price
- move to scheduling
- push booking link
- escalate to phone

Question rules:
- Ask at most 1 question unless strategy requires more
- Questions must move toward booking (not generic)
- Prefer either/or or specific time questions

Avoid:
- "Let me know"
- "Does that work for you?"
- Repeating the same phrasing
- Asking for information already provided

Urgency handling:
If customer says "ASAP", "today", "urgent", "right away", or "as soon as possible":
- Acknowledge the urgency clearly
- Check the Urgency Context (if provided) for business capability
- Do NOT promise same-day or rush service unless the system says you can
- If business cannot meet the urgency, offer the closest available option
- Keep tone helpful and realistic, never misleading

Output:
- Only the message text
- No formatting, no bullets`;

  /**
   * Get templates by type. Seeds defaults if user has none of that type.
   */
  async getTemplates(userId: string, type?: 'message' | 'prompt'): Promise<TemplateResponse[]> {
    const where: any = { userId };
    if (type) where.type = type;

    let templates = await this.prisma.messageTemplate.findMany({
      where,
      orderBy: [
        { isDefault: 'desc' },
        { lastUsedAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });

    // Seed defaults for new users — check each type separately
    const typesToSeed = type ? [type] : ['message', 'prompt'] as const;
    for (const t of typesToSeed) {
      const hasType = templates.some((tmpl: any) => tmpl.type === t);
      if (!hasType) {
        const defaults = t === 'prompt' ? TemplatesService.DEFAULT_PROMPTS : TemplatesService.DEFAULT_TEMPLATES;
        await this.prisma.messageTemplate.createMany({
          data: defaults.map(d => ({ userId, name: d.name, content: d.content, type: d.type, isDefault: d.isDefault })),
          skipDuplicates: true,
        });
      }
    }

    // Re-fetch if we seeded
    if (templates.length === 0 || typesToSeed.some(t => !templates.some((tmpl: any) => tmpl.type === t))) {
      templates = await this.prisma.messageTemplate.findMany({
        where,
        orderBy: [{ isDefault: 'desc' }, { lastUsedAt: 'desc' }, { createdAt: 'desc' }],
      });
    }

    return templates.map(this.formatTemplate);
  }

  /**
   * Get a single template by ID
   */
  async getTemplate(userId: string, templateId: string): Promise<TemplateResponse> {
    const template = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, userId },
    });

    if (!template) {
      throw new NotFoundException('Template not found');
    }

    return this.formatTemplate(template);
  }

  /**
   * Create a new template
   */
  async createTemplate(userId: string, data: CreateTemplateDto): Promise<TemplateResponse> {
    const type = data.type || 'message';

    // If this template is set as default, unset any existing default OF THE SAME TYPE
    if (data.isDefault) {
      await this.prisma.messageTemplate.updateMany({
        where: { userId, type, isDefault: true },
        data: { isDefault: false },
      });
    }

    const template = await this.prisma.messageTemplate.create({
      data: {
        userId,
        name: data.name,
        content: data.content,
        type,
        isDefault: data.isDefault || false,
      },
    });

    return this.formatTemplate(template);
  }

  /**
   * Update an existing template
   */
  async updateTemplate(userId: string, templateId: string, data: UpdateTemplateDto): Promise<TemplateResponse> {
    const existing = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, userId },
    });

    if (!existing) {
      throw new NotFoundException('Template not found');
    }

    // If setting as default, unset existing default of same type
    if (data.isDefault) {
      await this.prisma.messageTemplate.updateMany({
        where: { userId, type: existing.type, isDefault: true, id: { not: templateId } },
        data: { isDefault: false },
      });
    }

    const template = await this.prisma.messageTemplate.update({
      where: { id: templateId },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.content !== undefined && { content: data.content }),
        ...(data.isDefault !== undefined && { isDefault: data.isDefault }),
      },
    });

    return this.formatTemplate(template);
  }

  /**
   * Delete a template
   */
  async deleteTemplate(userId: string, templateId: string): Promise<void> {
    const existing = await this.prisma.messageTemplate.findFirst({
      where: { id: templateId, userId },
    });

    if (!existing) {
      throw new NotFoundException('Template not found');
    }

    await this.prisma.messageTemplate.delete({
      where: { id: templateId },
    });
  }

  /**
   * Record template usage (increment count and update lastUsedAt)
   */
  async recordUsage(userId: string, templateId: string): Promise<void> {
    await this.prisma.messageTemplate.updateMany({
      where: { id: templateId, userId },
      data: {
        usageCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Personalize a template with lead data
   */
  personalizeMessage(templateContent: string, lead: {
    customerName: string;
    accountName?: string | null;
    category?: string | null;
    city?: string | null;
    state?: string | null;
  }): string {
    let message = templateContent;
    message = message.replace(/\{accountName\}/gi, lead.accountName || 'Your Business');
    message = message.replace(/\{customerName\}/gi, lead.customerName || 'there');
    const firstName = lead.customerName?.split(' ')[0] || 'there';
    message = message.replace(/\{firstName\}/gi, firstName);
    message = message.replace(/\{category\}/gi, lead.category || 'your project');
    message = message.replace(/\{city\}/gi, lead.city || '');
    message = message.replace(/\{state\}/gi, lead.state || '');
    return message;
  }

  private formatTemplate(template: any): TemplateResponse {
    return {
      id: template.id,
      name: template.name,
      content: template.content,
      type: template.type || 'message',
      isDefault: template.isDefault,
      usageCount: template.usageCount,
      lastUsedAt: template.lastUsedAt?.toISOString() || null,
      createdAt: template.createdAt.toISOString(),
    };
  }
}
