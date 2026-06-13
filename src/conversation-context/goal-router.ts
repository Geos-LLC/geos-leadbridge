/**
 * Auto goal router — pure function.
 *
 * Picks one of the three user-visible Conversation Goals (`phone`, `price`,
 * `qualify`) from the latest customer message. Auto is *not* a goal itself;
 * it's the request to ask THIS function which goal applies.
 *
 * Design (post-audit rewrite, 2026-06-12):
 *   1. Phone wins on explicit live-contact intent — customer is asking for
 *      a human / number / callback.
 *   2. Otherwise Price wins on explicit pricing intent.
 *   3. Otherwise qualify, which is the broad default workflow after the
 *      4-goal narrowing (auto / price / qualify / phone). "Vague",
 *      "exploratory", "ready-to-book but missing details", and ex-Convert
 *      hot-engagement cases all land here.
 *
 * What this replaces:
 *   The previous score-based router (`suggestStrategy()` in
 *   `conversation-context.service.ts`) had three structural defects
 *   confirmed empirically on prod data:
 *     - 89% of outputs landed on hidden legacy goals (hybrid / convert)
 *     - Phone was unreachable (0/64 on the audit sample)
 *     - The `customerIntent === 'price_shopping'` branch was dead code
 *       (the field is never written with that value)
 *     - The `priceDiscussed` sticky flag changed 64% of outputs but
 *       helped 0 cases and hurt 0 cases against the target model
 *   See the goal-router audit reports for full data.
 *
 * What this is NOT:
 *   - Not the handoff classifier — that LLM lives in `intent-classifier.service.ts`
 *     and drives dispatcher SMS firing independently.
 *   - Not the prompt resolver — `resolveActiveGoal()` consumes this output
 *     and is also where the legacy-goal normalization sits as a safety net.
 *   - Not the place to add `priceDiscussed` / `stage='quoting'` logic. The
 *     audit retired both. A "recent price was mentioned" signal can be
 *     reintroduced later in its own PR with a sliding-window scope.
 */

/**
 * Customer wants to talk to a person OR is handing over a number. Combined
 * regex with word-boundary anchors to keep false positives down (e.g. don't
 * want "rate" matching "rate this product"). Tested phrases include the
 * ones the customer's audit spec called out:
 *   call me, can someone call, give me a call, phone number, callback,
 *   talk to someone, talk to a person, live person, speak with someone,
 *   reach me at, my number is, text me at, walkthrough call.
 *
 * Tuned to ignore the common false positive "I'll be at the phone number
 * I gave Thumbtack" — `\bphone number\b` still matches it, which we accept
 * because the customer mentioning a phone number at all is a strong-enough
 * Phone signal to err on. (The handoff classifier's `provided_phone_number`
 * signal independently fires the dispatcher SMS, so over-routing here only
 * affects the AI's reply tone, not delivery.)
 */
const PHONE_REGEX = /\b(call me|can(?: someone)? call|give (?:me a |a )?call|phone number|callback|talk to (?:someone|a person|a human|you)|live person|speak (?:with|to) (?:someone|a person|a human|you)|reach me at|my number is|text me at|walkthrough call)\b/i;

/**
 * Customer is asking about money — price, cost, quote, estimate, etc.
 * Word-boundary on `rate` to avoid the worst false positives, though
 * "hourly rate" / "rate sheet" / "what's your rate" are exactly the cases
 * we want to catch.
 */
// `s?` on the count nouns catches plurals — "prices", "quotes",
// "estimates", "costs", "rates", "charges" all show up in real messages
// at roughly the same rate as their singular forms.
const PRICE_REGEX = /\b(how much|prices?|pricing|costs?|quotes?|estimates?|budget|charges?|rates?|how expensive|ballpark|what would (?:it|that) (?:be|cost)|how much would (?:it|that) cost)\b/i;

export type RoutedGoal = 'phone' | 'price' | 'qualify';

export interface RouteResult {
  suggested: RoutedGoal;
  reason: string;
  confidence: number;
  /**
   * Score object with all five legacy keys present so existing consumers
   * (Lead Activity preview row, telemetry dashboards) don't blow up when
   * they look up scores[hybrid] or scores[convert]. The hidden goals are
   * always zeroed by the new router — they no longer appear as router
   * outputs.
   */
  scores: { hybrid: number; price: number; qualify: number; convert: number; phone: number };
}

/**
 * Pure router. No I/O, no Prisma, no Nest. Takes the customer's latest
 * message body and returns the goal to use.
 *
 * Empty / undefined messages default to qualify — the safe broad workflow.
 * That covers the silent-follow-up case where there is no customer message
 * to react to.
 */
export function routeFromCustomerMessage(latestCustomerMessage: string | null | undefined): RouteResult {
  const lower = (latestCustomerMessage ?? '').toLowerCase();

  if (PHONE_REGEX.test(lower)) {
    return {
      suggested: 'phone',
      reason: 'Customer asked for phone or live contact.',
      confidence: 0.95,
      scores: { hybrid: 0, price: 0, qualify: 0, convert: 0, phone: 0.95 },
    };
  }

  if (PRICE_REGEX.test(lower)) {
    return {
      suggested: 'price',
      reason: 'Customer asked about pricing.',
      confidence: 0.9,
      scores: { hybrid: 0, price: 0.9, qualify: 0, convert: 0, phone: 0 },
    };
  }

  return {
    suggested: 'qualify',
    reason: 'No explicit Price or Phone signal — qualifying the lead.',
    confidence: 0.7,
    scores: { hybrid: 0, price: 0, qualify: 0.7, convert: 0, phone: 0 },
  };
}
