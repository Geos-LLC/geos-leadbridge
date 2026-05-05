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
  'This pricing table is REFERENCE material. Only use it when the PRIMARY INSTRUCTION tells you to quote, OR when the customer explicitly asks about price or budget. When you DO quote, match the customer\'s bedrooms/bathrooms to the correct row, and stay within a sensible range around the table value. NEVER invent prices unrelated to the table. If you are not quoting, do not bring up price.';

export function buildPriceRangeInstruction(range: PriceRangeGap | null | undefined): string {
  if (!range) return DEFAULT_INSTRUCTION;

  const minusVal = Number(range.minus?.value) || 0;
  const plusVal = Number(range.plus?.value) || 0;
  const minusType = range.minus?.type === '$' ? '$' : '%';
  const plusType = range.plus?.type === '$' ? '$' : '%';

  if (minusVal === 0 && plusVal === 0) {
    return 'This pricing table is REFERENCE material. Only use it when the PRIMARY INSTRUCTION tells you to quote, OR when the customer explicitly asks about price or budget. When you DO quote, match the customer\'s bedrooms/bathrooms to the correct row and quote the EXACT table price (no range). NEVER invent prices unrelated to the table. If you are not quoting, do not bring up price.';
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

  return `This pricing table is REFERENCE material. Only use it when the PRIMARY INSTRUCTION tells you to quote, OR when the customer explicitly asks about price or budget. When you DO quote, match the customer's bedrooms/bathrooms to the correct row and provide a range of ${low} below to ${high} above the table price.${example} NEVER invent prices unrelated to the table. If you are not quoting, do not bring up price.`;
}
