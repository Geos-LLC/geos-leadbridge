/**
 * Maps a structured PlaybookSeed (extracted from a verified website) into
 * per-section `customInstructions` strings that get saved as
 * `aiPlaybookV2.{section}.customInstructions` on each SavedAccount.
 *
 * Only the 6 supported sections are emitted. FAQ, pricing table,
 * qualification guidance, follow-up tone, and phone-call guidance are
 * explicitly excluded — those either need their own dedicated UI
 * (FAQ list, pricing table) or are not derivable from a website
 * (qualification guidance, follow-up tone are situational behaviour).
 */

import type { PlaybookSeed } from './users.service';

/** The 6 Playbook V2 section keys this applier supports. */
export type SupportedPlaybookSectionKey =
  | 'business_information'
  | 'pricing_guidance'
  | 'booking_guidance'
  | 'objection_handling'
  | 'human_handoff_guidance'
  | 'personality_brand_voice';

export const SUPPORTED_SECTIONS: readonly SupportedPlaybookSectionKey[] = [
  'business_information',
  'pricing_guidance',
  'booking_guidance',
  'objection_handling',
  'human_handoff_guidance',
  'personality_brand_voice',
] as const;

/**
 * Build the per-section customInstructions text. Each section emits a short
 * prose paragraph (or undefined when no fields were extracted) — the format
 * matches what a user would naturally type in the section's textarea, so
 * the AI prompt assembly downstream needs no special handling.
 *
 * We deliberately use the SITE'S own wording (the seed already preserved
 * verbatim phrasing). This keeps the playbook truthful to the customer's
 * brand voice instead of laundering it through a paraphrase pass.
 */
export function seedToCustomInstructions(
  seed: PlaybookSeed,
): Partial<Record<SupportedPlaybookSectionKey, string>> {
  const out: Partial<Record<SupportedPlaybookSectionKey, string>> = {};

  // ---- business_information ------------------------------------------
  const b = seed.businessInformation;
  if (b) {
    const lines: string[] = [];
    if (b.serviceArea) lines.push(`Service area: ${b.serviceArea}.`);
    if (b.yearsInBusiness) lines.push(`Years in business: ${b.yearsInBusiness}.`);
    if (b.teamSize) lines.push(`Team: ${b.teamSize}.`);
    if (b.ownerName) lines.push(`Owner: ${b.ownerName}.`);
    if (b.insurance) lines.push(`Insurance: ${b.insurance}.`);
    if (b.bonding) lines.push(`Bonding: ${b.bonding}.`);
    if (b.licensing) lines.push(`Licensing: ${b.licensing}.`);
    if (b.guarantees) lines.push(`Guarantee: ${b.guarantees}.`);
    if (b.ecoFriendly) lines.push(`Products / eco: ${b.ecoFriendly}.`);
    if (b.suppliesPolicy) lines.push(`Supplies: ${b.suppliesPolicy}.`);
    if (b.petsPolicy) lines.push(`Pets: ${b.petsPolicy}.`);
    if (b.paymentMethods?.length) lines.push(`Payment methods: ${b.paymentMethods.join(', ')}.`);
    if (b.officeLocations?.length) lines.push(`Office locations: ${b.officeLocations.join('; ')}.`);
    if (lines.length > 0) out.business_information = lines.join('\n');
  }

  // ---- pricing_guidance ----------------------------------------------
  const p = seed.pricingGuidance;
  if (p) {
    const lines: string[] = [];
    if (p.pricingModel) lines.push(`Pricing model: ${p.pricingModel}.`);
    if (p.startingPrices?.length) {
      const priced = p.startingPrices.map((sp) => `${sp.service} ${sp.price}`).join('; ');
      lines.push(`Starting prices: ${priced}.`);
    }
    if (p.whatsIncluded) lines.push(`What's included: ${p.whatsIncluded}.`);
    if (p.discounts) lines.push(`Discounts: ${p.discounts}.`);
    if (lines.length > 0) out.pricing_guidance = lines.join('\n');
  }

  // ---- booking_guidance ----------------------------------------------
  const k = seed.bookingGuidance;
  if (k) {
    const lines: string[] = [];
    if (k.bookingChannels?.length) lines.push(`Booking channels: ${k.bookingChannels.join(', ')}.`);
    if (k.leadTime) lines.push(`Lead time: ${k.leadTime}.`);
    if (k.schedulingNotes) lines.push(`Scheduling: ${k.schedulingNotes}.`);
    if (lines.length > 0) out.booking_guidance = lines.join('\n');
  }

  // ---- objection_handling --------------------------------------------
  const o = seed.objectionHandling;
  if (o?.trustSignals?.length) {
    out.objection_handling =
      `Trust signals to surface when handling pricing or trust objections: ${o.trustSignals.join('; ')}.`;
  }

  // ---- human_handoff_guidance ----------------------------------------
  const h = seed.humanHandoffGuidance;
  if (h) {
    const lines: string[] = [];
    if (h.phones?.length) lines.push(`Phone: ${h.phones.join(', ')}.`);
    if (h.emails?.length) lines.push(`Email: ${h.emails.join(', ')}.`);
    if (h.addresses?.length) lines.push(`Address: ${h.addresses.join('; ')}.`);
    if (lines.length > 0) out.human_handoff_guidance = lines.join('\n');
  }

  // ---- personality_brand_voice ---------------------------------------
  if (seed.personalityBrandVoice?.toneNotes) {
    out.personality_brand_voice = seed.personalityBrandVoice.toneNotes;
  }

  return out;
}
