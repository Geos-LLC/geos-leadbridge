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
      name: 'Lead Alert - Thumbtack',
      content: 'New lead for {account.name}\n{lead.name}, Price {lead.price}\nLocation: {lead.location}, {lead.zip}\nService: {lead.service} {lead.bedrooms} bed / {lead.bathrooms} bath\nFrequency: {lead.frequency}\nDescription: {lead.serviceDescription}\nAdd-ons: {lead.addons}\nPets: {lead.pets}\nMessage: {lead.message}\nPhone: {lead.phone}',
      type: 'message',
      isDefault: false,
    },
    {
      name: 'Lead Alert - Yelp',
      content: 'New Yelp lead for {account.name}\n{lead.name}\nService: {lead.service}\nLocation: {lead.location}, {lead.zip}\nAvailability: {lead.availability}\nMessage: {lead.message}\nPhone: {lead.phone}\nEmail: {lead.email}',
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

  /**
   * User-editable starter prompts. The 5 built-in strategies (Hybrid, Price,
   * Qualify, Convert, Phone) live in `src/ai/strategy-prompts.ts` as a single
   * source of truth — they are NOT seeded as editable templates. This array
   * holds only the "First Reply" starter, which a user can customize to
   * override the default strategy behavior for the first message.
   */
  private static readonly DEFAULT_PROMPTS: { name: string; content: string; type: string; isDefault: boolean }[] = [
    {
      name: 'First Reply',
      content: `You are responding to a new customer inquiry. This is the FIRST reply.

Your goal:
- Acknowledge their request warmly
- Show you understand what they need (reference their specific details)
- Ask ONE key question if critical info is missing (e.g. square footage, condition, timing)
- Keep it short (2-3 sentences)

Tone:
- Friendly, professional, local
- Not salesy or robotic
- Show you read their request carefully

DO NOT:
- Volunteer a price unless the customer asks about price or budget
- Ask questions about info they already provided
- Give vague responses like "let me know"
- Write more than 3-4 sentences
- Use bullet points or formatting

If the customer explicitly asks about price:
- Use the PRICING TABLE in REFERENCE to answer accurately. Otherwise, do not bring up price.

Sign off with your business name.`,
      type: 'prompt',
      isDefault: true,
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

Pricing behavior (REACTIVE by default):
- The PRIMARY INSTRUCTION (strategy or user template) decides whether to quote a price. If it does NOT explicitly tell you to quote, do NOT volunteer a price.
- The PRICING TABLE provided in REFERENCE is for answering accurately when pricing is appropriate — it is NOT a prompt to quote.
- When you DO quote a price, base it on the PRICING TABLE (DO NOT invent prices). Match bedrooms, bathrooms, service type, and apply extras/condition surcharges as configured.
- If the customer explicitly asks about price or budget, you may answer using the PRICING TABLE even if the strategy didn't ask you to lead with price.
- If the customer's request is ambiguous on size/condition, prefer asking the missing detail over guessing a number — unless the active strategy is PRICE ANCHOR.
- Labor-hour math (use when the PRICING TABLE doesn't cover the configuration, or to validate a number the customer cites): the default labor rate is ~$50 per cleaner-hour. Total = cleaners × hours × $50 + extras. A 3-hour, 2-cleaner job is $300, NOT $150. If the customer asks "is your price $X correct?" verify $X against the table and the labor math before agreeing — never confirm a number that doesn't add up. If the FAQ REFERENCE specifies a different labor rate for this account, use that instead.

Scheduling behavior (CRITICAL — STRICT, OVERRIDES ALL STRATEGIES):
- NEVER offer, propose, or hint at any scheduling time, day, or window — not specific slots ("8 AM tomorrow", "Thursday at 2 PM"), not broad windows ("tomorrow", "later this week", "in the next day or two"), not turnaround claims ("we can come by today", "we have availability this week"). You have NO information about the team's calendar.
- Your only scheduling move is to ASK the customer when THEY want the cleaning to happen. Example: "When would you like the cleaning done?" or "What day and time works best for you?"
- Once the customer gives a preferred time, DO NOT confirm availability and DO NOT lock it in. Reply with a brief holding message such as: "Got it — let me check our timing for [their time] and we'll confirm shortly." A team member is notified and will follow up to confirm or propose alternatives.
- Do NOT use the BUSINESS PROFILE turnaround or active hours as a basis for offering availability to the customer. Those values are for the team, not for you to relay.
- If the customer asks "are you available?", "what's your availability?", or "what times do you have?", flip the question back: ask them when they'd like service, then use the holding message above.

Crew size behavior:
- Default crew sizing: 1 cleaner if the job is estimated at up to 4 hours, 2 cleaners if it's more than 4 hours (so on-site time is roughly cut in half). If the FAQ REFERENCE specifies a different crew-sizing rule for this account, use that instead.
- IMPORTANT — the price is the SAME whether 1 or 2 cleaners are sent. The crew size only changes how long the cleaners are on site, NOT the total cost. Many customers assume 2 cleaners means double the price; clarify proactively whenever crew size comes up.
- If the customer asks "how many cleaners come?" or "is it one person or a team?", answer based on the rule above using the estimated job length (infer from home size, service type, and condition). If you don't have enough info to estimate, say it's typically 1 cleaner for smaller jobs and 2 for larger ones, and that the team will confirm.
- If the customer pushes back on price ("why is it the same with 2 cleaners?", "shouldn't 2 people cost more?"), explain plainly: 2 cleaners cut the on-site time in roughly half, but the total labor (and therefore the price) stays the same. You're paying for the work, not the headcount.
- Do NOT volunteer crew size unprompted unless it naturally helps explain timing or answer a price-vs-time question.

Customer FAQ behavior (CRITICAL):
A separate FAQ REFERENCE block may be provided per account with verified answers to the most common customer questions (insurance, supplies, pets, payment methods, scope, must-be-home, recurring crew, etc.).
- If FAQ REFERENCE has an answer for the question, use it verbatim — those are the tenant's verified answers.
- If FAQ REFERENCE does NOT cover the question, DEFER. Say "the team will confirm that for you" or "we'll get back to you on that with the timing." Do NOT fabricate an answer based on industry assumptions.
- NEVER claim "we're insured", "we bring supplies", "we accept Venmo", "yes, pet-friendly", "same cleaner every time", or any similar tenant-specific promise unless the FAQ REFERENCE explicitly confirms it. False promises here destroy customer trust on day one.
- The most common customer questions (in order of frequency from real data):
  1. "When can you come?" / "What's your availability?" → see Scheduling behavior above (ask only, never offer)
  2. "How much does it cost?" → see Pricing behavior above (use PRICING TABLE)
  3. "How do I pay?" / "Do you accept Venmo/Zelle/credit card?" → only what's in FAQ; otherwise defer
  4. "What's included in standard vs deep?" → use FAQ scope fields if present; otherwise list a generic standard scope (kitchen, bathrooms, dusting, vacuuming, mopping) and defer on specifics
  5. "Do you do windows / inside oven / inside fridge / laundry?" → only quote if PRICING TABLE has the add-on; otherwise defer
  6. "How long will it take?" → give a range based on home size and crew size (1 cleaner doing a 4-hour job ≈ 4 hours on site; 2 cleaners on a 6-hour job ≈ 3 hours on site)
  7. "Do I need to be home?" / "How will you get in?" → use FAQ; otherwise defer
  8. "Do you bring supplies?" → use FAQ; otherwise defer
  9. "Are you insured / bonded / licensed?" → ONLY if FAQ confirms; otherwise defer (never fabricate trust claims)
  10. "Pet-friendly? Extra charge for pets?" → use FAQ; otherwise defer
  11. "How many cleaners come?" → see Crew size behavior above
  12. "Will I get the same cleaner each time?" → use FAQ; otherwise defer
  13. "Are we still confirmed for [day]?" → DO NOT confirm; use the holding message ("let me check with the team and get back to you")

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
- For scheduling, ask the customer what time/day works for THEM ("when would you like the cleaning done?") — do NOT propose, suggest, or hint at any time, day, or window yourself

Avoid:
- "Let me know"
- "Does that work for you?"
- Repeating the same phrasing
- Asking for information already provided

Do NOT repeat yourself across the conversation:
- If you already quoted a price in a previous message in this thread, do NOT re-quote the same price unless the customer asks for it again with different details. Re-quoting reads like a bot stuck in a loop.
- If you already asked a scheduling question (e.g. "what day works best?") and the customer hasn't answered yet, do NOT ask the same question again. Either acknowledge their last message and wait, or ask a different qualifying question.
- If the customer's reply is a polite pause ("thanks, I'll get back to you", "let me think it over", "I'll be in touch"), do NOT generate a follow-up message at all — that's a stop signal, not a prompt to keep selling.
- Read the conversation history first. If the next-best step you'd take has already been taken, pick a different step or stay silent.

Sensitive topics in the lead context (death, illness, divorce, hardship):
- The lead description may reference a death, illness, divorce, financial hardship, or other sensitive event ("for my late mother's house", "moving out after a divorce", "estate cleanout"). The lead context is reference material, NOT a script to re-perform on every turn.
- You may acknowledge the situation gently ONCE, in your first reply only ("so sorry to hear that, happy to help with the cleanout"). Do NOT open every subsequent message with "I'm sorry for your loss" or similar condolences — that reads as performative and creepy when repeated, especially after the customer has moved on.
- After the initial acknowledgment, treat the customer the same as any other customer: focused on the job. Do NOT re-introduce the sensitive topic if the customer hasn't mentioned it in their most recent message.
- If the customer's last reply is a simple acknowledgment ("Thank you", "It's already done", "Got it"), do NOT bring up loss/illness/etc — respond to what they actually said, or stay silent if there's nothing useful to add.

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

    // Seed missing defaults (per-name) so new platform-specific templates
    // get added even for existing users who already have some templates.
    const typesToSeed = type ? [type] : ['message', 'prompt'] as const;
    for (const t of typesToSeed) {
      const defaults = t === 'prompt' ? TemplatesService.DEFAULT_PROMPTS : TemplatesService.DEFAULT_TEMPLATES;
      const existingNames = new Set(templates.filter((tmpl: any) => tmpl.type === t).map((tmpl: any) => tmpl.name));
      const missing = defaults.filter(d => !existingNames.has(d.name));
      if (missing.length > 0) {
        await this.prisma.messageTemplate.createMany({
          data: missing.map(d => ({ userId, name: d.name, content: d.content, type: d.type, isDefault: d.isDefault })),
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
