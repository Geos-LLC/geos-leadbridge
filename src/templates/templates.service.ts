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

  /**
   * Message templates seeded for every tenant. Names match the UI section
   * that uses them so users can find them by feature, not by guess.
   *
   * Two groups:
   *   - Section templates (7) — one per Automation section. AI is the
   *     runtime default; the literal template is the fallback when the
   *     user flips the section to Template mode. For multi-step sections
   *     (Follow Up), the one default is reused as the seed for every step
   *     until the user customises individual steps.
   *   - Alert templates (5) — owner-facing SMS bodies, unchanged.
   *
   * The Call Connect feature has its own settings table (whisper text,
   * voicemail text) and is intentionally NOT seeded here.
   */
  private static readonly DEFAULT_TEMPLATES: { name: string; content: string; type: string; isDefault: boolean }[] = [
    // ─── Section templates (Automation) ────────────────────────────────
    {
      name: 'Instant Reply',
      content: 'Hi {firstName}, thanks for reaching out about {category}! I\'d love to help. Let me review your request and I\'ll get back to you shortly with availability and pricing. - {accountName}',
      type: 'message',
      isDefault: true,
    },
    {
      name: 'Instant Text',
      content: 'Hi {firstName}, thanks for your {category} inquiry — this is {accountName}. Reply here and I\'ll get back to you shortly!',
      type: 'message',
      isDefault: false,
    },
    {
      name: 'Instant Call',
      content: 'Hi {firstName}, this is {accountName} — I just tried to reach you about your {category} request. I\'ll try again shortly, or feel free to text back when you have a moment.',
      type: 'message',
      isDefault: false,
    },
    {
      // Manual follow-up — one default reused for every step in the
      // sequence until the user customises individual steps.
      name: 'Follow Up',
      content: 'Hi {firstName}, just following up on your {category} request. Are you still looking for help? I have availability this week and would love to assist. Let me know!',
      type: 'message',
      isDefault: false,
    },
    {
      // First message after a conversation has gone quiet for a while —
      // picks back up where the thread left off.
      name: 'Resume After Conversation',
      content: 'Hi {firstName}, picking back up on your {category} project — let me know if you\'d like to move forward and I\'ll get you on the schedule.',
      type: 'message',
      isDefault: false,
    },
    {
      // Lifted from follow-up-seed.ts (was inline on customer_deferred
      // preset). Default runtime mode for this section is AI; this
      // template is the fallback when the user flips to Template mode.
      name: 'Customer Deferral',
      content: 'Hi {{lead.name}}, just circling back — did you get a chance to think it over? Happy to answer any questions or help get you on the schedule if you\'re ready.',
      type: 'message',
      isDefault: false,
    },
    {
      // Lifted from follow-up-seed.ts (was inline on
      // customer_hired_competitor preset). Default runtime mode for this
      // section is AI; this template is the fallback for Template mode.
      name: 'Re-engage',
      content: 'Hi {{lead.name}}, hope your project went well! If anything didn\'t go the way you hoped, we\'d be happy to help next time. No pressure either way.',
      type: 'message',
      isDefault: false,
    },

    // ─── Alert templates (owner-facing SMS) ────────────────────────────
    {
      name: 'Lead Alert - Thumbtack',
      content: 'New lead for {account.name}\n{lead.name}, Price {lead.price}\nLocation: {lead.location}, {lead.zip}\nService: {lead.service} {lead.bedrooms} bed / {lead.bathrooms} bath\nFrequency: {lead.frequency}\nDescription: {lead.serviceDescription}\nAdd-ons: {lead.addons}\nPets: {lead.pets}\nMessage: {lead.message}\nPhone: {lead.phone}',
      type: 'message',
      isDefault: false,
    },
    {
      name: 'Lead Alert - Yelp',
      content: 'New Yelp lead for {account.name}\n{lead.name}\nService: {lead.service}\nLocation: {lead.location}, {lead.zip}\nAvailability: {lead.availability}\n{lead.requestDetails}\nNotes: {lead.message}\nPhone: {lead.phone}\nEmail: {lead.email}',
      type: 'message',
      isDefault: false,
    },
    {
      // Unified default for "New Lead Alerts" — applied across both
      // Thumbtack and Yelp accounts when cascading in All Accounts mode.
      // Uses only fields shared by both platforms.
      name: 'Lead Alert - SMS',
      content: 'New lead for {account.name}\n{lead.name}\nService: {lead.service}\nLocation: {lead.location}, {lead.zip}\nMessage: {lead.message}\nPhone: {lead.phone}',
      type: 'message',
      isDefault: false,
    },
    {
      // Owner SMS sent when a quiet lead replies after follow-ups. Surfaced
      // in the "Reply Alerts" picker on Settings → Communication & Alerts.
      name: 'Reply Alert',
      content: 'Lead {{lead.name}} replied: "{{message}}"',
      type: 'message',
      isDefault: false,
    },
    {
      // Owner SMS sent during AI Conversation when handoff intent is
      // detected (ready to book / wants live call). Surfaced in the "AI
      // Human Takeover Alerts" picker on Settings → Communication & Alerts.
      name: 'Handoff Alert',
      content: 'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"',
      type: 'message',
      isDefault: false,
    },
  ];

  /**
   * User-editable AI prompts — one per Automation section. Names mirror
   * the section names so the Templates page is organised by feature.
   *
   * The 5 built-in strategies (Hybrid, Price, Qualify, Convert, Phone) and
   * the SMS-first-touch primary-instruction live in code under
   * `src/ai/strategy-prompts.ts` + `src/notifications/instant-text-ai.service.ts`
   * as the single source of truth for runtime composition. The prompts
   * seeded below are user-facing starter copies for tenants to edit — the
   * UI surfaces them as the "AI Prompt" for each section.
   */
  private static readonly DEFAULT_PROMPTS: { name: string; content: string; type: string; isDefault: boolean }[] = [
    {
      name: 'Instant Reply',
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
    {
      name: 'Instant Text',
      content: `GOAL: First-touch SMS to a lead who just arrived from a marketplace.

You MUST:
- Write 1 or 2 short sentences. Total under 240 characters.
- Greet the customer by their first name when known.
- Reference their specific request (cleaning, plumbing, etc.) when possible.
- Sound like a friendly local business owner — warm, conversational, brief.
- Acknowledge the request, then either ask ONE clarifying question OR confirm a quick follow-up.

You MUST NOT:
- Use bullets, numbered lists, headers, or any markdown.
- Promise availability or specific timing.
- Volunteer a price unless the customer explicitly asked about price, cost, quote, or budget.
- Ask more than one question.
- Use corporate marketing-speak ("we're excited to", "look forward to serving you").
- Identify yourself as AI or a bot.
- Mention the marketplace name.

If the customer asked about price, use the PRICING TABLE in REFERENCE to answer with a range — and then offer to confirm availability.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Instant Call',
      content: `GOAL: Short SMS sent right after the system places an outbound bridge call to the lead, so the customer knows who is calling and why.

You MUST:
- Write 1 short sentence, under 200 characters.
- Identify the business by name.
- Reference the customer's request briefly so it doesn't read like spam.
- Invite a text reply if they missed the call.

You MUST NOT:
- Promise a callback at a specific time.
- Quote a price.
- Use markdown or formatting.
- Identify yourself as AI.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Follow Up',
      content: `GOAL: One follow-up message to a lead who hasn't replied. Used as the default for every step in the manual follow-up sequence until the user customises individual steps.

You MUST:
- Reference the original request briefly so it feels like a continuation, not a fresh outreach.
- Keep it to 1-2 sentences.
- Be warm and low-pressure.
- Ask ONE simple question OR leave the door open ("happy to help when you're ready").

You MUST NOT:
- Repeat anything you've already said in the thread verbatim.
- Apply pressure or scarcity ("last chance", "won't ask again").
- Volunteer pricing unless the customer asked.
- Use markdown.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Resume After Conversation',
      content: `GOAL: First message after a conversation has gone quiet for a while. The customer engaged before, then stopped responding. You're picking the thread back up, not starting fresh.

You MUST:
- Acknowledge the prior conversation in a friendly way ("picking back up", "circling back").
- Reference the last unresolved step if there was one (a question they didn't answer, a quote they didn't respond to).
- Offer one clear next step (a question, an availability check, or an invite to text back).
- Stay short — 1-2 sentences.

You MUST NOT:
- Pretend it's a first reply.
- Repeat the entire prior conversation.
- Apologise for following up.
- Use markdown.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Customer Deferral',
      content: `GOAL: A single check-in sent days after the customer explicitly deferred ("I'll get back to you", "let me think it over", "talking to my husband").

You MUST:
- Sound patient, not pushy.
- Reference that the customer was thinking it over.
- Offer to answer questions or get them on the schedule — without assuming they're ready.
- Keep it to 1-2 sentences.

You MUST NOT:
- Quote a price.
- Add urgency ("limited slots", "today only").
- Ask more than one question.
- Use markdown.`,
      type: 'prompt',
      isDefault: false,
    },
    {
      name: 'Re-engage',
      content: `GOAL: A polite check-in sent weeks after the customer said they hired someone else. The goal is to leave the door open for next time, not to win back this job.

You MUST:
- Be warm and non-competitive — assume the other vendor did the job.
- Offer to help next time if the experience didn't meet expectations.
- Make it clear there's no pressure.
- Keep it to 1-2 sentences.

You MUST NOT:
- Bash the competitor.
- Re-pitch your service.
- Ask for the job back.
- Quote a price.
- Use markdown.`,
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
  /**
   * One-time renames for tenants seeded under the old per-feature template
   * names. Applied before the seed-missing pass so an existing
   * "Auto Reply - New Lead" row gets renamed to "Instant Reply" in place
   * (preserving any user edits) instead of leaving the legacy row and
   * seeding a duplicate next to it.
   *
   * Skipped when a row with the new name already exists for the same
   * user+type — the user-edited new row wins.
   */
  private static readonly SEED_RENAMES: { from: string; to: string; type: 'message' | 'prompt' }[] = [
    { from: 'Auto Reply - New Lead',  to: 'Instant Reply', type: 'message' },
    { from: 'Auto Reply - Follow Up', to: 'Follow Up',     type: 'message' },
    { from: 'First Reply',            to: 'Instant Reply', type: 'prompt'  },
  ];

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

    // Rename legacy seed rows in place so they line up with the current
    // section-named seed list (Templates page becomes browsable by feature).
    //
    // Collision detection is type-agnostic to match the DB uniqueness
    // constraint. Pre-2026-06-23 the constraint was @@unique(userId, name)
    // — even after the migration to @@unique(userId, name, type), this
    // pass stays defensive so a stale schema (e.g. migration not yet
    // applied on a fresh env) can never fail the whole GET /templates
    // request mid-rename with P2002.
    for (const r of TemplatesService.SEED_RENAMES) {
      if (type && type !== r.type) continue;
      const legacy = templates.find((t: any) => t.type === r.type && t.name === r.from);
      if (!legacy) continue;
      const collidesWithNewName = templates.some((t: any) => t.name === r.to);
      if (collidesWithNewName) continue;
      try {
        await this.prisma.messageTemplate.update({
          where: { id: legacy.id },
          data: { name: r.to },
        });
        legacy.name = r.to;
      } catch (err: any) {
        // P2002 = unique-constraint race (another concurrent request
        // already created the new-name row). Leave the legacy row in
        // place — the user keeps editable access via the old name, and
        // the seed-missing pass below will add the canonical one on
        // the next call (skipDuplicates makes that idempotent).
        if (err?.code !== 'P2002') throw err;
      }
    }

    // Seed missing defaults (per-name) so new platform-specific templates
    // get added even for existing users who already have some templates.
    const typesToSeed = type ? [type] : ['message', 'prompt'] as const;
    let seededAny = false;
    for (const t of typesToSeed) {
      const defaults = t === 'prompt' ? TemplatesService.DEFAULT_PROMPTS : TemplatesService.DEFAULT_TEMPLATES;
      const existingNames = new Set(templates.filter((tmpl: any) => tmpl.type === t).map((tmpl: any) => tmpl.name));
      const missing = defaults.filter(d => !existingNames.has(d.name));
      if (missing.length > 0) {
        const result = await this.prisma.messageTemplate.createMany({
          data: missing.map(d => ({ userId, name: d.name, content: d.content, type: d.type, isDefault: d.isDefault })),
          skipDuplicates: true,
        });
        if (result.count > 0) seededAny = true;
      }
    }

    // Re-fetch whenever we seeded — the prior check ("re-fetch only if a
    // type has zero rows") missed the common case where the user already
    // had SOME templates of every type but was missing new section seeds.
    // That left freshly-inserted rows in the DB but absent from the API
    // response, so the templates page rendered stale counts (spotless
    // 2026-06-23 incident: 5 prompts shown vs 12 in DB).
    if (templates.length === 0 || seededAny) {
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
