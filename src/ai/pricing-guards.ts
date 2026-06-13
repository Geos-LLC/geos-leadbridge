/**
 * Pricing-policy guard rules appended to every pricing block.
 *
 * Three failure modes these guards close:
 *
 *  1. Lead arrives with no bed/bath → AI defaults to row 1 of the table
 *     (FargiPro / Meranda 2026-05-16: "$130 for 1-bedroom 1-bathroom" follow-up
 *     went out 2 min after a lead with empty description). The "closest match"
 *     instruction in the old prompt actively encouraged this.
 *
 *  2. Customer requests a cleaning type that the account does not currently
 *     offer. The signal for "not offered" is per-row prices: when EVERY row
 *     in the priceTable has `Number(row[key]) === 0` (or absent/falsy → 0),
 *     the service is treated as not offered. The old `cleaningTypes.enabled`
 *     flag is preserved on disk for back-compat but is no longer consulted —
 *     a column always renders, and the user "disables" by entering 0 in every
 *     row. See frontend/src/data/defaultPricing.ts.
 *
 *  3. Bed/bath given doesn't match any row exactly → "closest match" again.
 *
 * The guards work as PROMPT-LEVEL instructions, not upstream gating. The AI
 * is told what it's allowed to quote on and what it must defer on. The
 * deferral phrasing is intentionally non-committal ("let me check with the
 * team") so the manager has room to override.
 */

interface CleaningType { key?: string; label?: string; enabled?: boolean; }

interface ParsedPricing {
  cleaningTypes?: CleaningType[];
  priceTable?: Array<{ bed?: number; bath?: number; [k: string]: any }>;
}

/** A type is "offered" when at least one priceTable row prices it > 0. */
function isPricedInTable(pricing: ParsedPricing, key: string): boolean {
  if (!pricing.priceTable?.length || !key) return false;
  return pricing.priceTable.some((row: any) => Number(row[key]) > 0);
}

export function buildPricingGuardRules(pricing: ParsedPricing): string {
  const types: CleaningType[] = Array.isArray(pricing.cleaningTypes) ? pricing.cleaningTypes : [];

  // Offered = has at least one priced row.
  // Not offered = type is listed in cleaningTypes (so the user is aware of
  // it as a possible service) but every row is 0/missing. This is the
  // explicit "we don't do this — defer to the team" signal.
  const offeredLabels: string[] = [];
  const notOfferedLabels: string[] = [];
  for (const t of types) {
    if (!t.key || !t.label) continue;
    if (isPricedInTable(pricing, t.key)) {
      offeredLabels.push(t.label);
    } else {
      // Only emit the "do not quote" clause for types the user has
      // explicitly listed (cleaningTypes entry exists). A type that's
      // missing from the table AND missing from cleaningTypes is silent.
      notOfferedLabels.push(t.label);
    }
  }

  const lines: string[] = ['--- Pricing Policy (must obey) ---'];

  if (offeredLabels.length > 0) {
    lines.push(`Services you can quote on (the menu): ${offeredLabels.join(', ')}.`);
  }

  if (notOfferedLabels.length > 0) {
    lines.push(
      `Services this account does NOT currently offer: ${notOfferedLabels.join(', ')}. ` +
        `If the customer asks for any of these (including common synonyms — e.g. "move-out" / "move-in" ⇄ deep cleaning), ` +
        `DO NOT quote a price. Reply: "Let me confirm with the team whether we can take this on and get back to you shortly." ` +
        `Do NOT silently substitute a different service type.`,
    );
  }

  lines.push(
    'Bedrooms + bathrooms are REQUIRED before quoting. If either is missing from lead details AND has not been ' +
      'stated by the customer in the conversation so far, do NOT quote a price — ask for them first. ' +
      'A guess from the cheapest row is the most common failure mode and is unacceptable.',
  );

  lines.push(
    'Match bedrooms and bathrooms EXACTLY against a priceTable row. Do not use "closest match" or interpolate ' +
      'between rows. If the customer\'s bed/bath combination is not in the table, say: "Let me check with the team — ' +
      'that combination needs a custom quote." Then stop.',
  );

  lines.push('--- End Pricing Policy ---');
  return lines.join('\n');
}
