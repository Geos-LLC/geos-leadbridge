/**
 * Instant Text AI generator.
 *
 * Generates a short, first-touch SMS body for the Instant Text path
 * (NotificationRule with sendToCustomer=true, triggerType='new_lead').
 * Reuses the same AiService stack the Lead Activity / AI Conversation /
 * Follow-up generators use — same Business Information / FAQ / Pricing
 * Guidance pipeline — wrapped in an SMS-optimized strategy prompt that
 * caps length and tone.
 *
 * Caller contract (see notifications.service.sendNotificationWithRule):
 *   - Caller decides whether to invoke this based on
 *     `followUpSettingsJson.instantTextMode === 'ai'`.
 *   - Failure path is the caller's responsibility — throw on error so the
 *     caller logs `INSTANT_TEXT_AI_FALLBACK_TEMPLATE` and renders the
 *     existing template instead. We never silently return a template.
 *
 * Why a dedicated service:
 *   The First Reply / Follow-up paths run inside the automation engine
 *   and own their own AI call sites. Notifications previously had no
 *   AI dependency — wiring AiService directly into NotificationsService
 *   bloated its constructor and made the SMS rules harder to test in
 *   isolation. This service contains the SMS prompt + context-loading
 *   logic, so changes to first-touch SMS behavior live in one file.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { AiService } from '../ai/ai.service';

/**
 * SMS-optimized strategy prompt. Sent as the PRIMARY INSTRUCTION layer
 * to AiService.generateReply. Tuned to produce a 1-2 sentence first-touch
 * SMS that references the request, sounds local + friendly, and never
 * volunteers price or availability unless asked.
 *
 * Tested behavior (covered in instant-text-ai.service.spec.ts source-
 * level checks):
 *   - 1-2 sentences, under ~240 chars
 *   - no bullets / lists / markdown
 *   - no "I'm an AI" disclosure
 *   - doesn't promise specific timing
 *   - quotes price only when the lead.message asks about price
 */
export const SMS_FIRST_TOUCH_PROMPT = `GOAL: First-touch SMS to a lead who just arrived from a marketplace (Thumbtack / Yelp).

You MUST:
- Write 1 or 2 short sentences. Total under 240 characters.
- Greet the customer by their first name when known.
- Reference their specific request (cleaning, plumbing, etc.) when possible.
- Sound like a friendly local business owner — warm, conversational, brief.
- Acknowledge the request, then either ask ONE clarifying question OR confirm a quick follow-up.

You MUST NOT:
- Use bullets, numbered lists, headers, or any markdown.
- Promise availability or specific timing (e.g. "we can come Thursday at 10").
- Volunteer a price unless the customer explicitly asked about price, cost, quote, or budget.
- Ask more than one question.
- Use corporate marketing-speak ("we're excited to", "look forward to serving you", "thank you for choosing us").
- Identify yourself as AI or a bot.
- Mention the marketplace name (Thumbtack / Yelp).

If the customer asked about price, use the PRICING TABLE in REFERENCE to answer with a range — and then offer to confirm availability.

Example (no price asked):
"Hi Sarah — thanks for reaching out about deep cleaning. We can definitely help. About how many square feet is the home?"

Example (price asked):
"Hi Mike — for a 3BR/2BA deep clean, our pricing usually runs around $210-230. Want me to check availability for you?"`;

export interface GenerateInstantTextBodyInput {
  /** Saved account that owns the customer-texting rule firing right now. */
  savedAccountId: string;
  /** The lead's first message body — drives intent (price vs phone vs qualify). */
  customerMessage: string;
  /** Customer's name as captured on the lead row. */
  customerName: string;
  /** Optional lead category (e.g. "House Cleaning") if known. */
  category?: string;
  /** Optional account display name override. Defaults to SavedAccount.businessName. */
  accountName?: string;
}

@Injectable()
export class InstantTextAiService {
  private readonly logger = new Logger(InstantTextAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
  ) {}

  /**
   * Build the prompt context and call AiService for a single SMS body.
   * Throws on any error — caller falls back to template path with
   * INSTANT_TEXT_AI_FALLBACK_TEMPLATE log marker.
   */
  async generateInstantTextBody(opts: GenerateInstantTextBodyInput): Promise<string> {
    const account = await this.prisma.savedAccount.findUnique({
      where: { id: opts.savedAccountId },
      select: {
        businessName: true,
        servicePricingJson: true,
        faqJson: true,
        followUpSettingsJson: true,
        followUpTimezone: true,
        userId: true,
      },
    });
    if (!account) {
      throw new Error(`SavedAccount ${opts.savedAccountId} not found`);
    }
    const user = await this.prisma.user.findUnique({
      where: { id: account.userId },
      select: { globalAiPrompt: true, name: true },
    });

    // Business context — reuse the same helper First Reply uses so the
    // brand voice / scheduling guidance stays in lockstep. SMS first-touch
    // doesn't need city/state/active-hours so we pass them through nullable
    // and let the helper decide what to include.
    const { buildBusinessContextBlock } = require('../ai/business-context');
    const businessBlock: string = buildBusinessContextBlock({
      businessName: account.businessName ?? opts.accountName ?? null,
      ownerName: user?.name ?? null,
      city: null,
      state: null,
      followUpSettingsJson: account.followUpSettingsJson ?? null,
      activeHoursStart: null,
      activeHoursEnd: null,
      timezone: account.followUpTimezone ?? null,
    });

    // FAQ block — verified answers the AI uses verbatim when relevant.
    let faqBlock = '';
    if (account.faqJson) {
      try {
        const { buildFaqBlock, parseAccountFaq } = require('../ai/faq-context');
        faqBlock = buildFaqBlock(parseAccountFaq(account.faqJson));
      } catch (err: any) {
        this.logger.warn(`[InstantTextAi] FAQ parse failed for account ${opts.savedAccountId}: ${err?.message}`);
      }
    }

    // Pricing block — only included when the table is set. The SMS prompt
    // tells the model to quote ONLY when the customer asks about price.
    let pricingBlock = '';
    if (account.servicePricingJson) {
      pricingBlock = account.servicePricingJson;
    }

    const accountName = opts.accountName ?? account.businessName ?? undefined;

    const reply = await this.ai.generateReply({
      customerName: opts.customerName,
      customerMessage: opts.customerMessage,
      category: opts.category,
      accountName,
      globalPrompt: user?.globalAiPrompt ?? undefined,
      strategyPrompt: SMS_FIRST_TOUCH_PROMPT,
      businessBlock,
      faqBlock,
      pricingBlock,
      conversationHistory: [],
      timezone: account.followUpTimezone ?? undefined,
    });

    // Safety net: strip leading/trailing whitespace + collapse internal
    // newlines that the model occasionally emits despite the no-bullets rule.
    // We DO leave the body otherwise alone — Twilio handles long SMS via
    // segmentation, and the prompt's 240-char cap already keeps it short.
    return reply.replace(/[\r\n]+/g, ' ').trim();
  }
}
