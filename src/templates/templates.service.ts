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
      name: 'Hybrid Strategy',
      content: `Strategy: Hybrid

- Provide a broad price range early
- Immediately ask one clarifying question
- Balance speed and accuracy
- Adjust responses dynamically as more information is received`,
      type: 'prompt',
      isDefault: true,
    },
    {
      name: 'Price-Anchor Strategy',
      content: `Strategy: Price Anchor

- Provide a realistic price range early in the conversation
- Reduce uncertainty quickly
- After giving range, ask 1 clarifying question
- Avoid exact pricing unless enough details are provided
- Keep explanation minimal`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Qualification Strategy',
      content: `Strategy: Qualification First

- Ask 1-2 high-impact questions before giving pricing
- Focus on understanding scope and details
- Delay pricing until enough context is gathered
- Keep questions natural and helpful, not interrogative`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Conversion Strategy',
      content: `Strategy: Conversion

- Focus on moving toward booking or next step
- Suggest phone call or scheduling only when appropriate
- Present next step as convenience, not pressure
- Continue answering questions if user prefers chat`,
      type: 'prompt',
      isDefault: false,
    },
  ];

  /** The global AI prompt — applied to ALL messages regardless of strategy */
  static readonly DEFAULT_GLOBAL_AI_PROMPT = `You are an AI assistant helping a local service business respond to inbound leads.

Your goal is to maximize conversion while maintaining a natural, human-like conversation.

Core principles:
- Messages must feel conversational, not scripted or automated
- Avoid repetitive phrasing across messages
- Be helpful, clear, and concise
- Do not sound pushy or overly sales-oriented
- Keep responses short (1-3 sentences unless needed)

Platform rules:
- Only respond in context of a customer inquiry
- Do not initiate unrelated outreach
- Follow-ups must feel like a continuation of the conversation, not generic check-ins
- Avoid aggressive sales tactics or pressure
- Do not ask for phone number early unless contextually appropriate

Conversation behavior:
- Always move the conversation forward
- Reduce uncertainty for the customer
- Ask at most 1-2 questions per message
- Prefer clarity over completeness
- Adapt tone based on user intent and engagement

Pricing behavior:
- Do not give exact quotes without sufficient data
- Prefer ranges early, refine later

Contact behavior:
- Offer phone call only when it feels natural or helpful
- Never force transition off-platform

Output:
- Natural, human-like response
- No formatting, no bullet points`;

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
