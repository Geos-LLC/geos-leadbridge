/**
 * Instant Text AI generator.
 *
 * Generates a short, first-touch SMS body for the Instant Text path
 * (NotificationRule with sendToCustomer=true, triggerType='new_lead').
 *
 * UNIFIED PROMPT PIPELINE (matches AI Conversation / Review Mode / Follow-ups):
 *   1. GLOBAL                       (User.globalAiPrompt)
 *   2. PRIMARY INSTRUCTION          (SMS_FIRST_TOUCH_PROMPT — SMS-specific
 *                                    length cap + tone constraint)
 *   3. BASE HARD RULES              (via renderPlaybookBlock)
 *   4. AI PLAYBOOK V2 (8 sections)  (via renderPlaybookBlock)
 *   5. REFERENCE: BUSINESS PROFILE  (buildBusinessContextBlock)
 *   6. REFERENCE: PRICING TABLE     (parsed + range/exact + guard rules,
 *                                    matching automation.service +
 *                                    follow-up-generator.service)
 *   7. REFERENCE: ACCOUNT FAQ       (buildFaqBlock + parseAccountFaq)
 *
 * SMS_FIRST_TOUCH_PROMPT is kept as the PRIMARY INSTRUCTION layer — SMS
 * has unique constraints (1-2 sentences, <240 chars, no markdown) that
 * the canonical strategy prompts do NOT enforce. The Playbook V2 block
 * supplies the user-editable HOW (brand voice, pricing guidance,
 * objection handling, etc.) on top of that constraint.
 *
 * Caller contract (see notifications.service.sendNotificationWithRule):
 *   - Caller decides whether to invoke this based on
 *     `followUpSettingsJson.instantTextMode === 'ai'`.
 *   - Failure path is the caller's responsibility — throw on error so the
 *     caller logs `INSTANT_TEXT_AI_FALLBACK_TEMPLATE` and renders the
 *     existing template instead. We never silently return a template.
 */

import { Injectable, Logger, Optional, Inject } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { AiService } from '../ai/ai.service';
import { renderPlaybookBlock } from '../ai/playbook-renderer';
import { resolveGlobalPrompt } from '../ai/global-prompt-resolver';
import { buildPriceRangeInstruction } from '../ai/price-range';
import { buildPricingGuardRules } from '../ai/pricing-guards';
import { hydratePricing } from '../users/pricing-hydrate';
import { computeQuoteAndIntent } from '../pricing/pricing-engine';
import { ServiceProfileService } from '../service-profile/service-profile.service';
import { buildPlaybookSettingsForRenderer } from '../service-profile/service-profile.types';
import { extractLeadDetails } from '../leads/extract-lead-details';

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
  /**
   * Raw lead JSON (TT request payload / Yelp project payload). Optional but
   * strongly recommended — it's the only source of bedrooms/bathrooms/sqft
   * for the deterministic pricing engine on first-touch SMS. Without this,
   * the engine can still match add-ons in the customer message but cannot
   * compute a base price.
   */
  leadRawJson?: string;
}

@Injectable()
export class InstantTextAiService {
  private readonly logger = new Logger(InstantTextAiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiService,
    // ServiceProfile resolver (Phase 1b adoption). @Inject + @Optional
    // is the right Nest spelling for "use this provider when available,
    // fall back to null otherwise" — bare @Optional with a class-typed
    // param sometimes resolves to null even when the provider IS wired
    // (Nest reads constructor metadata for the lookup token, but the
    // optional flag suppresses any reflect-metadata diagnostic that
    // would normally surface the mis-wire). Explicit token closes that.
    @Optional()
    @Inject(ServiceProfileService)
    private readonly serviceProfile: ServiceProfileService | null = null,
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
        id: true,
        businessName: true,
        servicePricingJson: true,
        faqJson: true,
        serviceOverridesJson: true,
        serviceProfileAssignmentsJson: true,
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
      select: { globalAiPrompt: true, globalAiChatInstructionsJson: true, name: true },
    });

    // ServiceProfile resolver (Phase 1b adoption). Instant Text has no
    // Lead object on the call signature, so we synthesize the minimal
    // LeadForResolver shape from opts — the resolver only needs userId
    // for profile lookup and category for mapping match. `id` is purely
    // a log handle.
    //
    // Optional dep: when not wired (legacy unit tests), profileInputs
    // stays null and the legacy account reads below win unchanged.
    const profileInputs = this.serviceProfile
      ? await this.serviceProfile.resolveEffectivePromptInputs(
          {
            id: `instant-text:${opts.savedAccountId}`,
            userId: account.userId,
            category: opts.category ?? null,
            categoryId: null,
          },
          {
            id: account.id,
            servicePricingJson: account.servicePricingJson,
            faqJson: account.faqJson,
            serviceOverridesJson: account.serviceOverridesJson,
            followUpSettingsJson: account.followUpSettingsJson,
          },
        )
      : null;

    // Draft profile short-circuit. Caller (notifications.service) catches
    // any throw and renders the existing template instead — matching the
    // INSTANT_TEXT_AI_FALLBACK_TEMPLATE contract documented in the file
    // header. The lead/notification log is unaffected; only the AI
    // generation is skipped.
    if (profileInputs?.aiPaused) {
      this.logger.log(
        `[service-profile] AI paused — skipping reply path=instant_text ` +
        `savedAccountId=${opts.savedAccountId} userId=${account.userId} ` +
        `profileId=${profileInputs.profileId} reason=service_profile_ai_paused`,
      );
      const err = new Error(
        `service_profile_ai_paused: profileId=${profileInputs.profileId} userId=${account.userId}`,
      );
      (err as any).code = 'SERVICE_PROFILE_AI_PAUSED';
      throw err;
    }

    // Effective values from the resolver, with safe fallback to account
    // direct reads when resolver isn't wired (legacy unit test path).
    const effectivePricingJson = profileInputs?.pricingJson ?? account.servicePricingJson;
    const effectiveFaqJson = profileInputs?.faqJson ?? account.faqJson;
    const effectivePlaybookSettingsJson = buildPlaybookSettingsForRenderer(
      profileInputs?.aiInstructionsJson ?? null,
      account.followUpSettingsJson ?? null,
    );

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
    // Resolver-supplied: profile FAQ when populated, else SavedAccount
    // FAQ via per-field fallback (Spotless-shape safety).
    let faqBlock = '';
    if (effectiveFaqJson) {
      try {
        const { buildFaqBlock, parseAccountFaq } = require('../ai/faq-context');
        faqBlock = buildFaqBlock(parseAccountFaq(effectiveFaqJson));
      } catch (err: any) {
        this.logger.warn(`[InstantTextAi] FAQ parse failed for account ${opts.savedAccountId}: ${err?.message}`);
      }
    }

    // PRICING block — canonical pattern shared with automation.service +
    // follow-up-generator.service. Parses the table, lists enabled cleaning
    // types per row, then appends the range/exact quoting instruction and
    // the hard guard rules (FargiPro: no quote when bed/bath unknown or
    // service type is disabled). Previously this path dumped raw JSON,
    // bypassing all of the above — that drift is closed here.
    let pricingBlock = '';
    if (effectivePricingJson) {
      try {
        // Hydrate: same source-of-truth rules as automation.service /
        // follow-up-generator / ai.controller — legacy accounts missing
        // cleaningTypes still emit Deep Cleaning, and explicit 0 prices
        // are preserved (pricing-guards turns them into a defer rule).
        // Resolver-supplied: profile pricingJson when populated.
        const p = hydratePricing(JSON.parse(effectivePricingJson));
        const allTypes = p.cleaningTypes;
        if (p.priceTable.length > 0 && allTypes.length > 0) {
          // Quote shape lives on pricing JSON (since 2026-06-18 — picker
          // moved from Conversation goal=Price to the pricing table
          // editor). Hydrator default is 'range'.
          const priceQuoteMode: 'range' | 'exact' = p.priceQuoteMode;
          const sqftAdjustEnabled = p.sqftAdjustEnabled !== false;
          const priceParts: string[] = [];
          for (const row of p.priceTable.slice(0, 10)) {
            const legacy = Number(row.sqft) || 0;
            const sqftMin = Number(row.sqftMin) || legacy;
            const sqftMax = Number(row.sqftMax) || legacy;
            const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
            const prices = allTypes.map((t) => {
              const price = Number(row[t.key]) || 0;
              const perSqft = midpoint > 0 ? (price / midpoint).toFixed(3) : null;
              return perSqft && sqftAdjustEnabled
                ? `${t.label}: $${price} ($${perSqft}/sqft)`
                : `${t.label}: $${price}`;
            }).join(', ');
            let sizeLabel = `${row.bed}BR/${row.bath}BA`;
            if (sqftMin && sqftMax && sqftMin !== sqftMax) sizeLabel += ` @ ${sqftMin}-${sqftMax} sqft`;
            else if (midpoint > 0) sizeLabel += ` @ ${midpoint} sqft`;
            priceParts.push(`  ${sizeLabel} — ${prices}`);
          }
          priceParts.push('');
          priceParts.push(buildPriceRangeInstruction(p.priceRange, { priceQuoteMode, sqftAdjustEnabled }));
          priceParts.push(buildPricingGuardRules(p));
          pricingBlock = priceParts.join('\n');
        }
      } catch (err: any) {
        this.logger.warn(`[InstantTextAi] Pricing parse failed for account ${opts.savedAccountId}: ${err?.message}`);
      }
    }

    // PLAYBOOK V2 — BASE HARD RULES + 8 HOW sections (default + custom).
    // Unifies Instant Text with AI Conversation / Review Mode / Follow-ups
    // so user-edited Playbook sections (brand voice, pricing guidance,
    // objection handling, etc.) automatically apply to first-touch SMS.
    // Resolver-supplied: profile aiInstructionsJson spliced over legacy
    // settings (or pure legacy when profile field empty).
    const playbookBlock = renderPlaybookBlock({
      followUpSettingsJson: effectivePlaybookSettingsJson,
    });

    // Deterministic quote + price-intent guard — same pricing engine
    // that runs in AI Conversation / Review Mode / Follow-ups. On
    // first-touch SMS there is no conversation history (the customer's
    // message IS the only turn), so the engine sees customerMessage +
    // platform-derived facts. If `leadRawJson` was not passed in,
    // base-price calculation falls back to "missing inputs" and the
    // LLM asks rather than guessing.
    const { quoteBlock, priceIntentBlock } = this.buildQuoteAndIntent({
      pricingJson: effectivePricingJson,
      leadRawJson: opts.leadRawJson,
      customerMessage: opts.customerMessage,
    });

    const accountName = opts.accountName ?? account.businessName ?? undefined;

    const reply = await this.ai.generateReply({
      customerName: opts.customerName,
      customerMessage: opts.customerMessage,
      category: opts.category,
      accountName,
      globalPrompt: resolveGlobalPrompt(user),
      strategyPrompt: SMS_FIRST_TOUCH_PROMPT,
      businessBlock,
      pricingBlock: pricingBlock || undefined,
      quoteBlock: quoteBlock || undefined,
      priceIntentBlock: priceIntentBlock || undefined,
      faqBlock: faqBlock || undefined,
      playbookBlock: playbookBlock || undefined,
      conversationHistory: [],
      timezone: account.followUpTimezone ?? undefined,
    });

    // Safety net: strip leading/trailing whitespace + collapse internal
    // newlines that the model occasionally emits despite the no-bullets rule.
    // We DO leave the body otherwise alone — Twilio handles long SMS via
    // segmentation, and the prompt's 240-char cap already keeps it short.
    return reply.replace(/[\r\n]+/g, ' ').trim();
  }

  /**
   * Run the deterministic pricing engine for the first-touch SMS context.
   * Pure helper — parses pricing + lead JSON, calls
   * computeQuoteAndIntent, returns BOTH the calculated-quote reference
   * block AND the runtime price-intent enforcement block. Empty strings
   * when the engine has nothing meaningful to inject.
   */
  private buildQuoteAndIntent(opts: {
    pricingJson: string | null;
    leadRawJson: string | null | undefined;
    customerMessage: string;
  }): { quoteBlock: string; priceIntentBlock: string } {
    const empty = { quoteBlock: '', priceIntentBlock: '' };
    if (!opts.pricingJson) return empty;
    let pricing;
    try {
      pricing = hydratePricing(JSON.parse(opts.pricingJson));
    } catch {
      return empty;
    }
    const leadDetails = extractLeadDetails(opts.leadRawJson);
    let additionalInfo: string | null = null;
    if (opts.leadRawJson) {
      try {
        const raw = JSON.parse(opts.leadRawJson);
        if (raw?.project?.additional_info) additionalInfo = String(raw.project.additional_info);
      } catch {}
    }
    try {
      // priceQuoteMode is resolved from pricing.priceQuoteMode inside the
      // engine (default 'range' since 2026-06-18 picker move).
      const built = computeQuoteAndIntent({
        pricing,
        leadDetails,
        customerMessage: opts.customerMessage,
        conversationHistory: null,
        additionalInfo,
      });
      return {
        quoteBlock: built.quoteBlock ?? '',
        priceIntentBlock: built.priceIntentBlock ?? '',
      };
    } catch (err: any) {
      this.logger.warn(`[InstantTextAi] quote engine threw: ${err?.message}`);
      return empty;
    }
  }

}
