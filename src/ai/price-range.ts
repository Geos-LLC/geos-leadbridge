/**
 * Converts a user-configured price range gap (stored in servicePricingJson)
 * into an AI prompt instruction. Used by the Instant Reply Price mode so the
 * AI quotes the customer a range around the table price that matches the
 * user's preference — or an exact price when both sides are 0.
 */
export interface PriceRangeGap {
  minus?: { type?: '%' | '$'; value?: number };
  plus?: { type?: '%' | '$'; value?: number };
}

const DEFAULT_INSTRUCTION =
  'Use these prices as your reference. Match the customer\'s bedrooms/bathrooms to the correct row. You may quote a range around the table price but it MUST be based on the actual table values — do NOT invent prices unrelated to the table.';

export function buildPriceRangeInstruction(range: PriceRangeGap | null | undefined): string {
  if (!range) return DEFAULT_INSTRUCTION;

  const minusVal = Number(range.minus?.value) || 0;
  const plusVal = Number(range.plus?.value) || 0;
  const minusType = range.minus?.type === '$' ? '$' : '%';
  const plusType = range.plus?.type === '$' ? '$' : '%';

  if (minusVal === 0 && plusVal === 0) {
    return 'Use these prices as your reference. Match the customer\'s bedrooms/bathrooms to the correct row. Quote the EXACT table price for the match — do NOT quote a range, and do NOT invent prices unrelated to the table.';
  }

  const fmt = (val: number, type: string) => (type === '$' ? `$${val}` : `${val}%`);
  const low = fmt(minusVal, minusType);
  const high = fmt(plusVal, plusType);

  let example = '';
  if (minusType === '%' && plusType === '%') {
    const lowMul = (1 - minusVal / 100).toFixed(2);
    const highMul = (1 + plusVal / 100).toFixed(2);
    example = ` Example: if the table price is $200, quote a range of around $${Math.round(200 * Number(lowMul))}-${Math.round(200 * Number(highMul))}.`;
  } else if (minusType === '$' && plusType === '$') {
    example = ` Example: if the table price is $200, quote a range of around $${200 - minusVal}-${200 + plusVal}.`;
  }

  return `Use these prices as your reference. Match the customer's bedrooms/bathrooms to the correct row. When quoting, provide a range of ${low} below to ${high} above the table price.${example} Do NOT invent prices unrelated to the table.`;
}
