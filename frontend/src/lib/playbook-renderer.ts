/**
 * Frontend mirror of `src/ai/playbook-renderer.ts` — Playbook V2.
 *
 * V2 model: Playbook is HOW only. No automation-derived "current behavior"
 * bullets. Each section card has:
 *   - Default prompt (collapsible, system-provided)
 *   - Custom instructions textarea (user-editable)
 *
 * Two sections in the UI are NOT in this metadata because they surface
 * existing data stores instead of contributing to the AI PLAYBOOK block:
 *   - `faq`                     — uses SavedAccount.faqJson via AccountFaqForm
 *   - `global_custom_instructions` — uses User.globalAiPrompt via getGlobalAiPrompt
 *
 * Keep DEFAULT_PROMPTS in sync with src/ai/section-default-prompts.ts.
 */

export type PlaybookSectionKey =
  | 'business_information'
  | 'pricing_guidance'
  | 'qualification_guidance'
  | 'booking_guidance'
  | 'objection_handling'
  | 'human_handoff_guidance'
  | 'followup_tone'
  | 'personality_brand_voice';

export const PLAYBOOK_SECTION_ORDER: readonly PlaybookSectionKey[] = [
  'business_information',
  'pricing_guidance',
  'qualification_guidance',
  'booking_guidance',
  'objection_handling',
  'human_handoff_guidance',
  'followup_tone',
  'personality_brand_voice',
] as const;

export const PLAYBOOK_SECTION_UI_LABELS: Record<PlaybookSectionKey, string> = {
  business_information:   'Business Information',
  pricing_guidance:       'Pricing Guidance',
  qualification_guidance: 'Qualification Guidance',
  booking_guidance:       'Booking Guidance',
  objection_handling:     'Objection Handling',
  human_handoff_guidance: 'Human Handoff Guidance',
  followup_tone:          'Follow-up Tone',
  personality_brand_voice: 'AI Personality & Brand Voice',
};

/** One-line description shown under each card title in the UI. */
export const PLAYBOOK_SECTION_SUBTITLES: Record<PlaybookSectionKey, string> = {
  business_information:   'Company facts AI uses to answer customer questions.',
  pricing_guidance:       'How AI discusses pricing (not when — that\'s Automation).',
  qualification_guidance: 'How AI gathers details one or two at a time.',
  booking_guidance:       'How AI moves toward booking without offering times.',
  objection_handling:     'How AI responds to hesitation, price pushback, and concerns.',
  human_handoff_guidance: 'How AI prepares the customer for a human takeover.',
  followup_tone:          'How follow-up messages should sound (timing is in Follow-ups).',
  personality_brand_voice: 'Overall communication style.',
};

export const SECTION_DEFAULT_PROMPTS: Record<PlaybookSectionKey, string> = {
  business_information:
    `Use this section as the source of truth for company facts — service area, team, supplies, pets, guarantees, insurance, payment methods. If the customer asks about a topic covered here, answer from this content verbatim. If a fact isn't here AND isn't in the FAQ, defer to the team rather than invent.`,

  pricing_guidance:
    `Use the PRICING TABLE for actual numbers — never invent. Present ranges before exact figures when the customer is still exploring. Don't volunteer pricing unless asked or unless qualification is complete. When the customer pushes back on price, explore reduced-scope alternatives before discounting; the table is the floor, not a negotiating start.`,

  qualification_guidance:
    `Gather only the most decision-relevant details, in this priority: square footage > timing > condition (move-in/move-out, heavy soil) > scope (pets, extras, frequency). Ask 1–2 questions at a time — never more — and prefer one open-ended question over a checklist. After enough info to estimate, transition to confirming the next step rather than asking more.`,

  booking_guidance:
    `Move toward booking by asking the customer when THEY want service. Don't propose specific times — you have no calendar visibility. Once they name a time, acknowledge and use a holding message ("let me check our timing for [their time] and we'll confirm shortly"). Mention that a team member will reach out to confirm.`,

  objection_handling:
    `When the customer pushes back, acknowledge their concern before responding. For pricing objections, ask what budget they had in mind before offering anything; consider reduced scope before any discount. For timing objections, offer a near-term alternative or a follow-up window. For trust concerns, surface the FAQ insurance/policy/satisfaction answer if covered. Never argue.`,

  human_handoff_guidance:
    `When the customer needs a human, ask for the best callback time and phone number. Briefly recap what they've shared so the team can pick up cleanly. Stay warm — don't sound like you're escalating an angry call. The dispatcher will reach out within the configured response window.`,

  followup_tone:
    `Follow-up messages should feel like a continuation, not a new pitch. Keep it short. Open with something specific to the prior conversation (a detail they mentioned, a slot you said you'd check). Close warmly, no pressure. Avoid generic openers like "just checking in".`,

  personality_brand_voice:
    `Friendly, professional, and local. Match the customer's energy — formal if formal, casual if casual. Speak as the small-team business, not as an AI. Use the owner's first name in sign-offs if provided. Keep replies under 3 sentences when possible. Reserve exclamation points for genuine excitement (booking confirmed, etc.).`,
};

export type PlaybookV2Storage = {
  [K in PlaybookSectionKey]?: { customInstructions: string };
};

/** Threshold values for the soft length warning on the editor. */
export const INSTRUCTION_LENGTH_SOFT = 3000;
export const INSTRUCTION_LENGTH_WARN = 5000;
