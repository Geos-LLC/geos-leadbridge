/**
 * Price-Intent Runtime Guard.
 *
 * When the latest customer message explicitly asks for a price ("how
 * much?", "send me an estimate", "what's your quote?", etc.) and the
 * deterministic pricing engine has produced a calculated total, we
 * inject a high-priority PRIMARY-overriding instruction so the LLM is
 * obligated to LEAD WITH the quote instead of asking a scheduling or
 * qualification question first.
 *
 * The architecture problem this closes:
 *   - GLOBAL prompt allows price-volunteering only when the customer
 *     asks. PRIMARY INSTRUCTION (strategy) drives most replies.
 *   - When PRIMARY is the strict PRICE_ANCHOR strategy, the model
 *     usually quotes. But when the tenant has a custom "First Reply"
 *     template with softer conditional language ("Give a price range
 *     IF you have enough info"), the model defers — even on a clear
 *     price ask.
 *   - This guard runs OUTSIDE the strategy/template layer. It looks
 *     at THIS turn's customer message and the engine's output, and
 *     adds a layer that the base hard rules treat as authoritative
 *     for this single reply.
 *
 * Peter Pidochev 2026-06-10 incident: classifier=engaged, account
 * strategy=price, deterministic engine could have priced 5BR/4BA
 * regular + baseboards = $284 — but the AI replied "When would you
 * like the cleaning done?". The user-customised First Reply prompt
 * softened the strategy's MUST-QUOTE rule. This guard fixes that
 * without re-litigating which prompt won.
 */

import type { PricingCalculationResult } from './pricing-engine';

/**
 * Whole-word(ish) match against the price-intent vocabulary. Tolerant
 * of plurals, possessives, and adjacent punctuation. Intentionally
 * permissive — false negatives are worse than false positives here
 * (the guard only fires when the engine ALSO produced a calculated
 * quote, so a stray match without a quote does nothing).
 */
const PRICE_TOKENS = [
  // "price", "prices", "pricing"
  /\bpric(?:e|es|ing)\b/i,
  // "estimate", "estimates", "estimating"
  /\bestimat(?:e|es|ing|or)\b/i,
  // "quote", "quotes", "quoting"
  /\bquot(?:e|es|ing|ation)\b/i,
  // "cost", "costs"
  /\bcost(?:s|ing)?\b/i,
  // "how much" / "how much is" / "how much would"
  /\bhow\s+much\b/i,
  // "what does it cost / what's the cost" / "what's the price"
  /\bwhat['’]?s?\s+(?:the\s+|your\s+)?(?:cost|price|rate|charge|fee)\b/i,
  // "what would it run" — colloquial price ask
  /\bwhat\s+would\s+it\s+run\b/i,
  // "rate", "rates", "fee", "fees", "charge", "charges" — pricing nouns
  /\b(?:rate|fee|charge)s?\b/i,
  // "budget" — usually means the customer wants to know if their budget fits
  /\bbudget\b/i,
];

export function detectPriceIntent(message: string | null | undefined): boolean {
  if (typeof message !== 'string') return false;
  const text = message.trim();
  if (!text) return false;
  for (const rx of PRICE_TOKENS) {
    if (rx.test(text)) return true;
  }
  return false;
}

/**
 * Spec-spelling alias for `detectPriceIntent`. The Price Intent
 * Enforcement spec (Peter Pidochev 2026-06-10 follow-up) names the
 * helper `isPriceSeekingMessage`. Same regex set — exposed under both
 * names so call-site readability matches the spec the implementation
 * pins.
 */
export const isPriceSeekingMessage = detectPriceIntent;

export interface PriceIntentInput {
  /** Latest customer message — the only turn the guard cares about. */
  customerMessage?: string | null;
  /** Engine output. Required to know whether quote is ready or needs clarification. */
  calculation?: PricingCalculationResult | null;
}

/**
 * Build the PRICE INTENT ENFORCEMENT block when price intent fires AND
 * the engine produced a meaningful result. Returns null when:
 *   - The customer message has no price-intent token, OR
 *   - No calculation result was provided (engine couldn't run — e.g.
 *     no pricing JSON on the account).
 *
 * Three quote-readiness branches drive the instruction body:
 *   1. totalPrice present       → "lead with $X, do not ask first"
 *   2. extrasMatched only       → "lead with the matched add-on prices"
 *   3. requiresClarification    → "ask ONE specific missing field"
 */
export function buildPriceIntentBlock(input: PriceIntentInput): string | null {
  if (!detectPriceIntent(input.customerMessage)) return null;
  const calc = input.calculation;
  if (!calc) return null;

  const lines: string[] = [];

  if (calc.totalPrice !== null) {
    // Ready quote — strictest directive.
    lines.push('The customer just asked about price.');
    lines.push(
      `Lead THIS reply with the calculated quote: $${calc.totalPrice}.` +
      (calc.explanation ? ` (${calc.explanation})` : ''),
    );
    lines.push(
      'DO NOT ask for scheduling, square footage, or any qualifying detail before quoting. ' +
      'Give the number first. You may ask one follow-up question AFTER the quote if needed (typically a short offer to schedule).',
    );
    lines.push(
      'This instruction overrides any softer "give a price range if you have enough info" wording in the PRIMARY INSTRUCTION or template — the system already verified the inputs and computed the number. Use it verbatim.',
    );
    return lines.join('\n');
  }

  if (calc.extrasMatched.length > 0 && calc.basePrice === null) {
    // Partial — we know the add-on prices but base isn't known.
    // Surface those numbers so the customer at least gets a directional
    // answer, then ask for the missing bed/bath.
    lines.push('The customer just asked about price.');
    lines.push('Acknowledge the matched add-ons with their prices:');
    for (const m of calc.extrasMatched) {
      lines.push(`  - ${m.label}: +$${m.price}`);
    }
    if (calc.missing.length > 0) {
      lines.push(
        `Then ask exactly ONE question to fill the missing input(s): ${calc.missing.join(', ')}. ` +
        'Do not ask about scheduling or anything else until the base price can be calculated.',
      );
    } else {
      lines.push('Then offer to confirm the base price once their home size is known.');
    }
    return lines.join('\n');
  }

  if (calc.requiresClarification && calc.missing.length > 0) {
    // No quote possible — but the customer asked. Direct the model to
    // ask ONLY for the missing pricing input, not scheduling.
    lines.push('The customer just asked about price. Pricing has NOT been calculated.');
    lines.push(`Missing inputs: ${calc.missing.join(', ')}.`);
    lines.push(
      'Ask ONE specific question to fill the FIRST missing input above. ' +
      'Do not ask about scheduling, availability, or any non-pricing detail. ' +
      'Do not invent or estimate a number.',
    );
    return lines.join('\n');
  }

  // Engine returned something we can't act on (e.g. base=null + no
  // extras + no missing list). Nothing constructive to inject.
  return null;
}
