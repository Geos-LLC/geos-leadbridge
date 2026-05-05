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

export const STRATEGY_PROMPTS: Record<string, string> = {
  hybrid: `STRATEGY: HYBRID

Use when:
- You have enough information to estimate price
- But still need one key detail OR want to move toward scheduling

You MUST:
- Look up the price from the pricing table for the customer's bedrooms/bathrooms and service type
- Provide a price range based on that table value (e.g. if table says $259, quote "around $250-270")
- Ask EXACTLY ONE question

The question MUST:
- Move toward booking (timing or confirmation)
- Be simple and direct
- Ask the customer what time/day works for THEM (e.g. "what day works best for you?"). Do NOT propose a specific slot you have not verified.

DO NOT:
- Ask more than one question
- Ask vague questions (e.g. "does that work?")
- Claim a specific time slot is available — see BUSINESS PROFILE scheduling rules.

Goal: Reduce uncertainty and move the lead forward.
Example style: "For a 3BR/2BA deep clean it's around $250-270. What day this week works best for you?"`,

  price: `STRATEGY: PRICE ANCHOR

Use when:
- Customer asks about price directly
- Or pricing is the main concern

You MUST:
- Look up the price from the pricing table for the customer's bedrooms/bathrooms and service type
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
- Critical details are missing (home size, timing, condition)

You MUST:
- Ask 2-3 specific questions
- Briefly explain why you need the info

DO NOT:
- Give pricing
- Use if enough info is already provided

Goal: Collect only the minimum info needed to move to pricing or booking.
Example style: "To give you an accurate quote, I just need a couple quick details — how many bedrooms and bathrooms, and what condition is the home in?"`,

  convert: `STRATEGY: CONVERSION

Use when:
- You have enough information
- Lead shows intent or urgency
- Ready to move to booking

You MUST:
- Look up the price from the pricing table for the customer's bedrooms/bathrooms and service type
- Include a price range based on that table value
- Push toward scheduling by asking the customer what time works, OR offering a broad window that matches the standard turnaround in the BUSINESS PROFILE (e.g. "tomorrow", "later this week"). Confirm any time the customer has already proposed.

DO NOT:
- Ask open-ended questions
- Delay with unnecessary details
- Make up prices unrelated to the pricing table
- Claim a SPECIFIC time slot is open ("I have 8 AM tomorrow", "Thursday at 2 PM is free"). You do not have access to the team's calendar — see BUSINESS PROFILE scheduling rules.

Goal: Get the lead to commit to a time — by inviting them to pick one, not by inventing one.
Example style: "For your 3BR/2BA home, deep cleaning is around $210-230. I can fit you in tomorrow — what time works best for you?"`,

  phone: `STRATEGY: PHONE / ESCALATION

Use when:
- Job is complex
- Customer asks for exact quote
- You need confirmation
- High-intent lead

Flow:
Step 1 — explain why call is needed:
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
