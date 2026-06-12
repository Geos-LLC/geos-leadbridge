/**
 * SECTION_DEFAULT_PROMPTS — per-section HOW guidance shipped with the
 * Playbook V2. Each entry is the "default prompt" exposed on its section card;
 * the user's custom instructions append after it in the runtime prompt.
 *
 * Strict rule: HOW only.
 *   - DO write: tone, sales technique, communication style, what to ask first.
 *   - DON'T write: when to ask, when to enroll, follow-up timing, handoff
 *                  triggers, stop conditions. Those live in Automation.
 *
 * Two Playbook sections are NOT in this map because their content lives in
 * pre-existing data stores:
 *   - `faq`                       — content is `SavedAccount.faqJson` (existing)
 *   - `global_custom_instructions` — content is `User.globalAiPrompt` (existing)
 *
 * Those two sections still render UI cards but contribute no entry to the
 * AI PLAYBOOK block at runtime — `faqJson` is already injected as
 * `=== REFERENCE: ACCOUNT FAQ ===` and `globalAiPrompt` is already injected
 * as `=== GLOBAL ===`. No duplication.
 */

/** The 8 sections that have a default prompt + custom instructions field. */
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

/** Display labels used in BOTH UI cards and the AI PLAYBOOK block headers. */
export const PLAYBOOK_SECTION_LABELS: Record<PlaybookSectionKey, string> = {
  business_information:   'BUSINESS INFORMATION',
  pricing_guidance:       'PRICING GUIDANCE',
  qualification_guidance: 'QUALIFICATION GUIDANCE',
  booking_guidance:       'BOOKING GUIDANCE',
  objection_handling:     'OBJECTION HANDLING',
  human_handoff_guidance: 'HUMAN HANDOFF GUIDANCE',
  followup_tone:          'FOLLOW-UP TONE',
  personality_brand_voice: 'AI PERSONALITY & BRAND VOICE',
};

/** Friendlier labels for the Playbook UI cards (Title Case, prose). */
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
