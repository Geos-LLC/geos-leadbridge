/**
 * Maps a structured PlaybookSeed (extracted from a verified website) into
 * per-section `customInstructions` strings that get saved as
 * `aiPlaybookV2.{section}.customInstructions` on each SavedAccount.
 *
 * Playbook V2.4 — simplified UI (June 2026)
 * ─────────────────────────────────────────
 * The visible Playbook sections collapsed from 8 → 5:
 *
 *   Business Information
 *   FAQ                          (dedicated UI, not touched here)
 *   Pricing Guidance             (HOW textarea + Pricing Table)
 *   Communication Style & Brand Voice   (renamed from personality_brand_voice)
 *   Global Custom Instructions   (User.globalAiPrompt, not touched here)
 *
 * This applier writes to ONLY 3 backend section keys:
 *
 *   business_information     ← BI + handoff contact facts + booking facts
 *   pricing_guidance         ← pricing fields + price-related trust signals
 *   personality_brand_voice  ← toneNotes + non-price trust signals
 *
 * It does NOT write to booking_guidance, objection_handling,
 * human_handoff_guidance, qualification_guidance, followup_tone, or
 * phone-call guidance. Workflow logic (qualification, booking, handoff,
 * phone) lives in Automation → AI Conversation Goals — not in the Playbook.
 * Objection handling is folded into Pricing Guidance + Communication Style.
 *
 * Backend default prompts for the now-hidden sections still exist in
 * `src/ai/section-default-prompts.ts` and continue to emit into the
 * runtime AI prompt — that's intentional, since their HOW guidance still
 * shapes how the AI responds. We just don't expose the textareas in the UI
 * and don't write new content into them from website extraction.
 */

import type { PlaybookSeed } from './users.service';

/** The 3 Playbook V2 section keys this applier writes to. */
export type SupportedPlaybookSectionKey =
  | 'business_information'
  | 'pricing_guidance'
  | 'personality_brand_voice';

export const SUPPORTED_SECTIONS: readonly SupportedPlaybookSectionKey[] = [
  'business_information',
  'pricing_guidance',
  'personality_brand_voice',
] as const;

/**
 * Heuristic: does a trust-signal sentence mention pricing/value words?
 * If yes, it belongs in Pricing Guidance; if no, in Communication Style.
 *
 * We err on the side of "non-price" so generic trust statements
 * ("Fully insured", "Same-day service") don't bloat the Pricing card.
 */
const PRICE_KEYWORDS = /\b(price|pricing|cost|costs|rate|rates|fee|fees|charge|charges|discount|discounts|value|affordable|budget|quote|estimate|guarantee|guaranteed|money[- ]?back|satisfaction)\b/i;

function isPriceRelated(trustSignal: string): boolean {
  return PRICE_KEYWORDS.test(trustSignal);
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
  personality_brand_voice: string[];
}

export function seedToSectionLines(seed: PlaybookSeed): SectionLines {
  const out: SectionLines = {
    business_information: [],
    pricing_guidance: [],
    personality_brand_voice: [],
  };

  // ─── BUSINESS INFORMATION ─────────────────────────────────────────────
  // Core BI fields + absorbed contact facts (phones/emails/addresses) +
  // booking facts (channels/leadTime/notes) — everything that's an
  // immutable BUSINESS FACT goes here. Workflow logic (e.g. "move toward
  // booking") is intentionally NOT generated.
  const b = seed.businessInformation;
  if (b) {
    if (b.serviceArea)     out.business_information.push(`Service area: ${b.serviceArea}.`);
    if (b.yearsInBusiness) out.business_information.push(`Years in business: ${b.yearsInBusiness}.`);
    if (b.teamSize)        out.business_information.push(`Team: ${b.teamSize}.`);
    if (b.ownerName)       out.business_information.push(`Owner: ${b.ownerName}.`);
    if (b.insurance)       out.business_information.push(`Insurance: ${b.insurance}.`);
    if (b.bonding)         out.business_information.push(`Bonding: ${b.bonding}.`);
    if (b.licensing)       out.business_information.push(`Licensing: ${b.licensing}.`);
    if (b.guarantees)      out.business_information.push(`Guarantee: ${b.guarantees}.`);
    if (b.ecoFriendly)     out.business_information.push(`Products / eco: ${b.ecoFriendly}.`);
    if (b.suppliesPolicy)  out.business_information.push(`Supplies: ${b.suppliesPolicy}.`);
    if (b.petsPolicy)      out.business_information.push(`Pets: ${b.petsPolicy}.`);
    if (b.paymentMethods?.length)  out.business_information.push(`Payment methods: ${b.paymentMethods.join(', ')}.`);
    if (b.officeLocations?.length) out.business_information.push(`Office locations: ${b.officeLocations.join('; ')}.`);
  }

  // Absorb contact facts from the (no-longer-visible) Human Handoff section.
  // Phone, email, address are business identity facts — they describe the
  // business, not how the AI should hand off.
  const h = seed.humanHandoffGuidance;
  if (h) {
    if (h.phones?.length)    out.business_information.push(`Phone: ${h.phones.join(', ')}.`);
    if (h.emails?.length)    out.business_information.push(`Email: ${h.emails.join(', ')}.`);
    if (h.addresses?.length) out.business_information.push(`Address: ${h.addresses.join('; ')}.`);
  }

  // Absorb booking FACTS from the (no-longer-visible) Booking Guidance
  // section. We deliberately convert action-shaped fields into factual
  // statements — "Booking channels: …", not "AI should move toward
  // booking …". The latter is automation logic, not Playbook content.
  const k = seed.bookingGuidance;
  if (k) {
    if (k.bookingChannels?.length) out.business_information.push(`Booking channels: ${k.bookingChannels.join(', ')}.`);
    if (k.leadTime)                out.business_information.push(`Lead time: ${k.leadTime}.`);
    if (k.schedulingNotes)         out.business_information.push(`Scheduling notes: ${k.schedulingNotes}.`);
  }

  // ─── PRICING GUIDANCE ─────────────────────────────────────────────────
  const p = seed.pricingGuidance;
  if (p) {
    if (p.pricingModel) out.pricing_guidance.push(`Pricing model: ${p.pricingModel}.`);
    if (p.startingPrices?.length) {
      const priced = p.startingPrices.map(sp => `${sp.service} ${sp.price}`).join('; ');
      out.pricing_guidance.push(`Starting prices: ${priced}.`);
    }
    if (p.whatsIncluded) out.pricing_guidance.push(`What's included: ${p.whatsIncluded}.`);
    if (p.discounts)     out.pricing_guidance.push(`Discounts: ${p.discounts}.`);
  }

  // ─── COMMUNICATION STYLE & BRAND VOICE ────────────────────────────────
  // (Backend key still `personality_brand_voice` — only the UI label
  // changes to "Communication Style & Brand Voice".)
  const pbv = seed.personalityBrandVoice;
  if (pbv?.toneNotes) {
    out.personality_brand_voice.push(pbv.toneNotes);
  }

  // ─── TRUST-SIGNAL SPLIT ───────────────────────────────────────────────
  // Distribute Objection Handling trust signals across Pricing Guidance
  // and Communication Style, depending on whether the signal mentions
  // price/value language. The same fact never appears in both sections.
  const trustSignals = seed.objectionHandling?.trustSignals ?? [];
  if (trustSignals.length > 0) {
    const priceRelated: string[] = [];
    const generic: string[] = [];
    for (const ts of trustSignals) {
      if (typeof ts !== 'string') continue;
      const cleaned = ts.trim();
      if (cleaned.length === 0) continue;
      if (isPriceRelated(cleaned)) priceRelated.push(cleaned);
      else generic.push(cleaned);
    }
    if (priceRelated.length > 0) {
      out.pricing_guidance.push(`Value / trust signals: ${priceRelated.join('; ')}.`);
    }
    if (generic.length > 0) {
      out.personality_brand_voice.push(`Trust signals to surface naturally when customers hesitate: ${generic.join('; ')}.`);
    }
  }

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
  if (lines.business_information.length > 0)    out.business_information = lines.business_information.join('\n');
  if (lines.pricing_guidance.length > 0)        out.pricing_guidance = lines.pricing_guidance.join('\n');
  if (lines.personality_brand_voice.length > 0) out.personality_brand_voice = lines.personality_brand_voice.join('\n');
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
