/**
 * Shared Strategy Prompts
 *
 * Single source of truth for all AI strategy prompts.
 * Used by: Lead Activity preview buttons, follow-up generator, automation.
 * Platform-agnostic — works for Yelp, Thumbtack, and future platforms.
 */

export interface StrategyDefinition {
  key: string;
  label: string;
  emoji: string;
  prompt: string;
}

/**
 * IMPORTANT — Pricing policy across strategies:
 *
 * Only the PRICE strategy is allowed to volunteer a price proactively.
 * Every other strategy focuses on its own goal (qualify, convert,
 * escalate, etc.) and treats the pricing table as REFERENCE material —
 * available if the customer explicitly asks about price, but never
 * the leading move.
 *
 * If a user's custom prompt template is silent on pricing, the AI must
 * stay silent on pricing too. The pricing table is reference material,
 * not a prompt to quote.
 */
export const STRATEGY_PROMPTS: Record<string, string> = {
  hybrid: `STRATEGY: HYBRID

Use when:
- You want to acknowledge the request and gently move toward booking
- The lead has shared enough detail that you don't need to qualify further

You MUST:
- Acknowledge the customer's specific request (reference the details they gave)
- Move the conversation forward with EXACTLY ONE question
- For timing, ask what day/time works for THEM. Do NOT propose, suggest, or hint at any time, day, or window yourself — see GLOBAL Scheduling behavior.

DO NOT:
- Volunteer a price unless the customer asks about price or budget
- Ask more than one question
- Ask vague questions (e.g. "does that work?")
- Offer any scheduling time, day, or window (specific or broad) — only ASK the customer when they want it

If the customer explicitly asks about price:
- Use the PRICING TABLE in REFERENCE to answer accurately. Match their bedrooms/bathrooms.
- Otherwise, do not bring up price.

Goal: Acknowledge + move the lead one step forward toward booking.
Example style (no price asked): "Got it — a deep clean for a 3BR/2BA in Tampa. When would you like the cleaning done?"
Example style (price asked): "Sure — for a 3BR/2BA deep clean it's around $250-270. When would you like it scheduled?"
After the customer gives a time, the next reply should be a holding message ("let me check our timing and confirm shortly") — never a confirmation.`,

  price: `STRATEGY: PRICE ANCHOR

Use when:
- Customer asks about price directly
- Or pricing is clearly the main concern
- Or the user explicitly chose "Price" mode for the first reply

You MUST:
- Look up the price from the PRICING TABLE for the customer's bedrooms/bathrooms and service type
- Lead with a price range based on that table value (e.g. if table says $219, quote "around $210-230")
- Briefly explain what is included

DO NOT:
- Ask questions
- Be vague or hesitant
- Make up prices unrelated to the pricing table

Tone:
- Confident and clear

Goal: Give the customer a number based on the actual pricing table.
Example style: "For a 3-bedroom, 2-bathroom home, deep cleaning typically runs around $210-230. This includes kitchen, bathroom, and full surface cleaning."`,

  qualify: `STRATEGY: QUALIFICATION

Use when:
- Critical details are missing (home size, timing, condition, square footage)

You MUST:
- Ask 1-2 specific questions about the missing info (whichever is most critical)
- Briefly explain why you need it (one short phrase, not a sentence)

DO NOT:
- Volunteer pricing — even if the pricing table is available, qualification comes first
- Ask about info the customer already provided in their request
- Use this strategy when enough info is already provided

If the customer explicitly asks about price during qualification:
- Acknowledge briefly, then redirect: explain you need the missing detail to give an accurate number.

Goal: Collect the minimum missing info needed to move to pricing or booking.
Example style: "Happy to help with the deep clean. To give you an accurate quote, what's the square footage of the home?"`,

  convert: `STRATEGY: CONVERSION

Use when:
- You have enough information AND the customer shows intent/urgency
- Ready to move to booking

You MUST:
- Push toward scheduling by asking the customer when THEY want the cleaning. Do NOT offer or propose a time yourself — not a specific slot, not a broad window, not a turnaround.
- If the customer has already proposed a time, do NOT confirm availability. Acknowledge it and use the GLOBAL holding message ("let me check our timing for [their time] and we'll confirm shortly").

DO NOT:
- Ask open-ended questions
- Delay with unnecessary details
- Volunteer a price unless the customer asks about price (the goal here is closing on time, not on price)
- Offer ANY time, day, or window — specific ("8 AM tomorrow") or broad ("tomorrow", "later this week"). You do not have access to the team's calendar. See GLOBAL Scheduling behavior.

If the customer explicitly asks about price:
- Use the PRICING TABLE in REFERENCE to answer, then return to asking the customer for their preferred time.

Goal: Get the customer to NAME a time. We confirm separately after a team member checks availability.
Example style (no price asked): "Got it — sounds like a great fit. When would you like the cleaning done?"
Example style (price asked): "For your 3BR/2BA home, deep cleaning is around $210-230. When would you like it scheduled?"
Example style (customer proposed a time): "Got it — let me check our timing for Thursday morning and we'll confirm shortly."`,

  phone: `STRATEGY: PHONE / ESCALATION

Use when:
- Job is complex
- Customer asks for an exact quote and the table can't give it (custom scope, unusual conditions)
- You need confirmation
- High-intent lead

Flow:
Step 1 — explain why a call is needed (without quoting a number):
- "Every home is a bit different..."
- "We'll prepare an accurate estimate..."

Step 2 — ask for phone naturally:
- "What's the best number to reach you?"

If hesitation:
- Offer texting option

Step 3 — confirm next step:
- "We'll call you shortly"
- OR send booking link if requested

DO NOT:
- Push phone too early
- Sound forceful
- Volunteer a price — escalation means we want to confirm details before quoting

Tone:
- Helpful, process-driven, professional

Example style: "Every home is a little different — size and condition affect pricing. We can prepare an accurate estimate for you. What's the best number to reach you?"`,
};

/** Step-level objective flavors — modifiers applied on top of the selected strategy */
export const OBJECTIVE_FLAVORS: Record<string, string> = {
  quick_check_in: 'This is a brief check-in. Keep it under 2 sentences. Ask if they saw your previous message.',
  value_add: 'Add value — share a helpful tip, availability update, or relevant detail. Show expertise without being pushy.',
  soft_nudge: 'Gently remind you are available. Reference their original request.',
  re_engagement: 'Re-engage after longer silence. Show you are still interested in helping. Offer flexibility.',
  last_chance: 'Final friendly reach-out. Let them know you will stop following up unless they respond. Keep the door open.',
  soft_close: 'Wrap up warmly. Mention you are available if they change their mind. No pressure.',
  clarification_reminder: 'Remind about the unanswered question. Rephrase it more simply.',
  simplified_question: 'Ask a simpler version of the question. Make it easy to answer (yes/no or pick from options).',
  price_follow_up: 'Follow up on the price shared. Ask if it works for their budget.',
  value_justification: 'Explain what is included in the price. Highlight quality and reliability.',
  flexibility_offer: 'Offer flexibility — adjusted scope, different service tiers, or payment options.',
  booking_reminder: 'Remind about the booking step. Make it easy to confirm with a specific time.',
  urgency_nudge: 'Add gentle urgency — mention limited availability or upcoming schedule changes.',
  availability_check: 'Check if their timeline changed. Offer alternative dates.',
  monthly_check: 'Casual check-in. Ask if they still need the service.',
  final_attempt: 'Last message in the sequence. Brief, friendly, leave the door open.',
  follow_up: 'General follow-up. Reference original request and ask if still interested.',
};

/** All strategy keys */
export const STRATEGY_KEYS = ['hybrid', 'price', 'qualify', 'convert', 'phone'] as const;
export type StrategyKey = typeof STRATEGY_KEYS[number];
