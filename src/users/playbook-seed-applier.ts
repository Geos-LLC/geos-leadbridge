/**
 * Maps a structured PlaybookSeed (extracted from a verified website) into
 * per-section `customInstructions` strings that get saved as
 * `aiPlaybookV2.{section}.customInstructions` on each SavedAccount.
 *
 * Playbook V2.5 — Business Information becomes the canonical store
 * ─────────────────────────────────────────────────────────────────
 * The visible Playbook narrowed to 4 sections:
 *
 *   Business Information         ← THIS APPLIER WRITES HERE
 *   FAQ                          (dedicated UI, not touched here)
 *   Pricing Guidance             ← THIS APPLIER WRITES HERE
 *   Global Custom Instructions   (User.globalAiPrompt, not touched here)
 *
 * Communication Style & Brand Voice moved to advanced mode in V2.5. The
 * friendly/professional/local default behavior already lives in
 * BASE_HARD_RULES and the system prompt, so we no longer auto-populate it
 * from website extraction — the website should not invent style/persona.
 *
 * This applier writes to ONLY 2 backend section keys now:
 *
 *   business_information  ← BI fields + contact facts + booking facts
 *                           + ALL trust signals (no longer split)
 *   pricing_guidance      ← pricing fields ONLY (no trust signals)
 *
 * It does NOT write to personality_brand_voice, booking_guidance,
 * objection_handling, human_handoff_guidance, qualification_guidance,
 * followup_tone, or phone-call guidance. Workflow logic
 * (qualification, booking, handoff, phone) lives in Automation → AI
 * Conversation Goals. Communication style comes from BASE_HARD_RULES.
 *
 * Backend default prompts for the now-hidden sections still exist in
 * `src/ai/section-default-prompts.ts` and continue to emit into the
 * runtime AI prompt — that's intentional, since their HOW guidance still
 * shapes how the AI responds. We just don't expose the textareas in the
 * normal UI and don't write new content into them from website extraction.
 */

import type { PlaybookSeed } from './users.service';

/** The 2 Playbook V2 section keys this applier writes to. */
export type SupportedPlaybookSectionKey =
  | 'business_information'
  | 'pricing_guidance';

export const SUPPORTED_SECTIONS: readonly SupportedPlaybookSectionKey[] = [
  'business_information',
  'pricing_guidance',
] as const;

/**
 * Build a "Label: Value." line, but strip trailing punctuation from the
 * value first so we don't emit "Value..." when the source ends with a
 * period. The site's extracted text varies; the prompt should look clean.
 */
function factLine(label: string, value: string): string {
  const cleaned = value.trim().replace(/[.;!?]+$/, '');
  return `${label}: ${cleaned}.`;
}

/**
 * Per-section line builders. Each returns an array of self-contained
 * one-liners (no trailing newline). The apply layer dedupes by line so the
 * output is order-stable AND robust to incremental re-applies — if the
 * site adds a new fact later, only the truly-new lines get appended.
 */
export interface SectionLines {
  business_information: string[];
  pricing_guidance: string[];
}

export function seedToSectionLines(seed: PlaybookSeed): SectionLines {
  const out: SectionLines = {
    business_information: [],
    pricing_guidance: [],
  };

  // ─── BUSINESS INFORMATION ─────────────────────────────────────────────
  // Canonical AI knowledge store for the business. Everything factual
  // about the company — identity, policies, contact info, booking
  // channels, and trust signals — lands here. Workflow logic is
  // deliberately NOT generated (e.g. no "AI should move toward booking").
  const b = seed.businessInformation;
  if (b) {
    if (b.serviceArea)     out.business_information.push(factLine('Service area',     b.serviceArea));
    if (b.yearsInBusiness) out.business_information.push(factLine('Years in business', b.yearsInBusiness));
    if (b.teamSize)        out.business_information.push(factLine('Team',             b.teamSize));
    if (b.ownerName)       out.business_information.push(factLine('Owner',            b.ownerName));
    if (b.insurance)       out.business_information.push(factLine('Insurance',        b.insurance));
    if (b.bonding)         out.business_information.push(factLine('Bonding',          b.bonding));
    if (b.licensing)       out.business_information.push(factLine('Licensing',        b.licensing));
    if (b.guarantees)      out.business_information.push(factLine('Guarantee',        b.guarantees));
    if (b.ecoFriendly)     out.business_information.push(factLine('Products / eco',   b.ecoFriendly));
    if (b.suppliesPolicy)  out.business_information.push(factLine('Supplies',         b.suppliesPolicy));
    if (b.petsPolicy)      out.business_information.push(factLine('Pets',             b.petsPolicy));
    if (b.paymentMethods?.length)  out.business_information.push(factLine('Payment methods',   b.paymentMethods.join(', ')));
    if (b.officeLocations?.length) out.business_information.push(factLine('Office locations', b.officeLocations.join('; ')));
  }

  // Absorb contact facts from the (no-longer-visible) Human Handoff section.
  // Phone, email, address are business identity facts — they describe the
  // business, not how the AI should hand off.
  const h = seed.humanHandoffGuidance;
  if (h) {
    if (h.phones?.length)    out.business_information.push(factLine('Phone',   h.phones.join(', ')));
    if (h.emails?.length)    out.business_information.push(factLine('Email',   h.emails.join(', ')));
    if (h.addresses?.length) out.business_information.push(factLine('Address', h.addresses.join('; ')));
  }

  // Absorb booking FACTS from the (no-longer-visible) Booking Guidance
  // section. We deliberately convert action-shaped fields into factual
  // statements — "Booking channels: …", not "AI should move toward
  // booking …". The latter is automation logic, not Playbook content.
  const k = seed.bookingGuidance;
  if (k) {
    if (k.bookingChannels?.length) out.business_information.push(factLine('Booking channels', k.bookingChannels.join(', ')));
    if (k.leadTime)                out.business_information.push(factLine('Lead time',        k.leadTime));
    if (k.schedulingNotes)         out.business_information.push(factLine('Scheduling notes', k.schedulingNotes));
  }

  // ALL trust signals → Business Information. V2.5 stops splitting them
  // between Pricing and Communication Style: trust signals describe the
  // business ("Fully insured", "Same-day service", "Best prices in town"),
  // so they belong with the other business facts. The pricing card stays
  // focused on actual pricing rules.
  const trustSignals = seed.objectionHandling?.trustSignals ?? [];
  if (trustSignals.length > 0) {
    const cleaned = trustSignals
      .filter((ts): ts is string => typeof ts === 'string')
      .map(ts => ts.trim())
      .filter(ts => ts.length > 0);
    if (cleaned.length > 0) {
      out.business_information.push(factLine('Trust signals', cleaned.join('; ')));
    }
  }

  // ─── PRICING GUIDANCE ─────────────────────────────────────────────────
  // Pricing fields only. Stores the business's pricing facts and policy
  // hooks — the actual prices live in the Pricing Table; this card
  // captures rules and ranges. Trust signals are no longer appended here.
  const p = seed.pricingGuidance;
  if (p) {
    if (p.pricingModel) out.pricing_guidance.push(factLine('Pricing model', p.pricingModel));
    if (p.startingPrices?.length) {
      const priced = p.startingPrices.map(sp => `${sp.service} ${sp.price}`).join('; ');
      out.pricing_guidance.push(factLine('Starting prices', priced));
    }
    if (p.whatsIncluded) out.pricing_guidance.push(factLine("What's included", p.whatsIncluded));
    if (p.discounts)     out.pricing_guidance.push(factLine('Discounts',       p.discounts));
  }

  // ─── COMMUNICATION STYLE & BRAND VOICE — NOT WRITTEN (V2.5) ──────────
  // We deliberately no longer populate personality_brand_voice from the
  // website. The website doesn't invent style/persona. BASE_HARD_RULES
  // already covers friendly/professional/local tone. Users who want to
  // personalize tone can edit the section in advanced mode or use the
  // (future) AI assistant chat.

  return out;
}

/**
 * Legacy adapter — preserved for any caller still expecting
 * `Partial<Record<section, string>>` output. The new line-level apply
 * path in users.service.ts calls `seedToSectionLines` directly so it can
 * dedupe per-line.
 */
export function seedToCustomInstructions(
  seed: PlaybookSeed,
): Partial<Record<SupportedPlaybookSectionKey, string>> {
  const lines = seedToSectionLines(seed);
  const out: Partial<Record<SupportedPlaybookSectionKey, string>> = {};
  if (lines.business_information.length > 0) out.business_information = lines.business_information.join('\n');
  if (lines.pricing_guidance.length > 0)     out.pricing_guidance = lines.pricing_guidance.join('\n');
  return out;
}

/**
 * Map the seed's businessInformation block into a partial `faqJson` patch.
 * Unlike the playbook mapping (prose), the FAQ has typed enums (yes/no/unset,
 * pet_friendly/extra_charge/no_pets) so we parse the seed's free text into
 * enum values. Ambiguous text is left as 'unset' with the raw text stored
 * in `details` so the user can still see what we found.
 *
 * Used by `applyFaqFromWebsiteSeed` in users.service.ts.
 */
export interface FaqPatch {
  insuredAndBonded?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  bringsSupplies?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  petPolicy?: { value?: 'pet_friendly' | 'extra_charge' | 'no_pets' | 'unset'; details?: string };
  paymentMethods?: string[];
}

export function seedToFaqPatch(seed: PlaybookSeed): FaqPatch {
  const out: FaqPatch = {};
  const b = seed.businessInformation;
  if (!b) return out;

  // Insurance + bonding fold into a single FAQ field.
  if (b.insurance || b.bonding) {
    const parts = [b.insurance, b.bonding].filter(Boolean) as string[];
    out.insuredAndBonded = { value: 'yes', details: parts.join('; ') };
  }

  // Supplies — disambiguate "we bring" vs "customer provides".
  if (b.suppliesPolicy) {
    const text = b.suppliesPolicy;
    let value: 'yes' | 'no' | 'unset' = 'unset';
    const customerProvides = /(customer|client|you).{0,30}(provide|supply|bring)/i.test(text);
    const weBring = /(we|our team|cleaners?).{0,30}(provide|supply|bring)/i.test(text)
      || /bring.{0,15}(own|all|supplies|equipment)/i.test(text)
      || /own.{0,15}(suppl|equipment)/i.test(text);
    if (customerProvides && !weBring) value = 'no';
    else if (weBring) value = 'yes';
    out.bringsSupplies = { value, details: text };
  }

  // Pet policy — three-way classify.
  if (b.petsPolicy) {
    const text = b.petsPolicy;
    const lower = text.toLowerCase();
    let value: 'pet_friendly' | 'extra_charge' | 'no_pets' | 'unset' = 'unset';
    if (/extra.{0,10}(fee|charge|surchar|cost)/i.test(lower)) value = 'extra_charge';
    else if (/no.{0,10}pet|not.{0,15}(accept|allow)|no.{0,10}animal|don.{0,5}t.{0,15}(accept|allow)/i.test(lower)) value = 'no_pets';
    else if (/pet.?friend|love.{0,15}pet|welcome.{0,15}pet|comfortable.{0,15}pet|yes/i.test(lower)) value = 'pet_friendly';
    out.petPolicy = { value, details: text };
  }

  // Payment methods — normalize the model's free-form labels to the keys
  // the FAQ form's chip selector uses.
  if (b.paymentMethods?.length) {
    const map: Array<[RegExp, string]> = [
      [/credit.?card|debit.?card|^card$/i, 'credit_card'],
      [/cash/i, 'cash'],
      [/\bcheck\b/i, 'check'],
      [/venmo/i, 'venmo'],
      [/zelle/i, 'zelle'],
      [/paypal/i, 'paypal'],
      [/invoice|net\s*\d+/i, 'invoice'],
    ];
    const normalized: string[] = [];
    for (const raw of b.paymentMethods) {
      for (const [re, key] of map) {
        if (re.test(raw) && !normalized.includes(key)) {
          normalized.push(key);
          break;
        }
      }
    }
    if (normalized.length > 0) out.paymentMethods = normalized;
  }

  return out;
}
