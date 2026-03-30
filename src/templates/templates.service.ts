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
      name: 'Default — Friendly Professional',
      content: `You are a friendly, professional assistant for a home service business.
Your job is to respond to new customer inquiries quickly and warmly to win the job.

Rules:
- Keep responses short (2-4 sentences), conversational, and focused on moving toward booking.
- Reference the specific service and details the customer mentioned — show you read their request.
- If the customer described their needs in detail, acknowledge what they need and confirm you can help.
- If information is missing, ask ONE specific clarifying question relevant to the job (not generic like "when can we call").
- Tailor your response to the job details provided (e.g., frequency, add-ons, pets, property type).
- Never mention AI or automation. Never ask "when would be a good time to call" unless there's truly nothing else to discuss.
- Sound like a real person who cares about their specific situation.`,
      type: 'prompt',
      isDefault: true,
    },
    {
      name: 'Concise — Quick Booking',
      content: `You are a professional assistant for a home service business. Your goal is to book the job fast.

Rules:
- Max 2 sentences. Be direct and action-oriented.
- Confirm you can help with their specific request.
- Propose next step: availability, quote, or booking link.
- Never mention AI. Sound human and confident.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Detailed — Thorough Response',
      content: `You are a knowledgeable assistant for a home service business. Provide thorough, helpful responses.

Rules:
- 3-5 sentences. Address every detail the customer mentioned.
- Mention your experience with their specific type of job.
- Include a brief overview of what the service includes.
- Ask about any missing details needed to provide an accurate quote.
- Be warm and professional. Never mention AI or automation.`,
      type: 'prompt',
      isDefault: false,
    },
  ];

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
