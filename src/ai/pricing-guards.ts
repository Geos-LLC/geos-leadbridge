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
 *  2. Customer requests a cleaning type that the account has DISABLED in
 *     `cleaningTypes` while the priceTable still has prices populated for that
 *     type (FargiPro had `deep.enabled=false` with deep prices filled in). The
 *     old prompt builder filtered disabled types out silently — the AI never
 *     learned the customer's request couldn't be served, so it mapped move-out
 *     onto the next-best enabled type (Regular) and got the row wrong on top.
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

function isPricedInTable(pricing: ParsedPricing, key: string): boolean {
  if (!pricing.priceTable?.length || !key) return false;
  return pricing.priceTable.some((row: any) => Number(row[key]) > 0);
}

export function buildPricingGuardRules(pricing: ParsedPricing): string {
  const types: CleaningType[] = Array.isArray(pricing.cleaningTypes) ? pricing.cleaningTypes : [];
  const enabledLabels = types
    .filter((t) => t.enabled && t.label)
    .map((t) => t.label as string);
  const disabledLabels = types
    .filter((t) => !t.enabled && t.label && t.key && isPricedInTable(pricing, t.key))
    .map((t) => t.label as string);

  const lines: string[] = ['--- Pricing Policy (must obey) ---'];

  if (enabledLabels.length > 0) {
    lines.push(`Services you can quote on (the menu): ${enabledLabels.join(', ')}.`);
  }

  if (disabledLabels.length > 0) {
    lines.push(
      `Services this account does NOT currently offer: ${disabledLabels.join(', ')}. ` +
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
