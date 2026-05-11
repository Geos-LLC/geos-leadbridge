/**
 * Builds the AI instruction that controls how the pricing table is used:
 *  - priceQuoteMode='exact'  → quote the exact table price, no range, no
 *                              dispatcher hand-off.
 *  - priceQuoteMode='range'  → quote a price range and tell the customer the
 *                              dispatcher will confirm the exact number.
 *  - sqftAdjustEnabled=true  → also instruct the AI to scale the row price up
 *                              by the row's $/sqft when the lead's reported
 *                              sqft exceeds the row's default sqft.
 *
 * Backward-compat: if priceQuoteMode is undefined, the legacy 0/0 priceRange
 * inference is used (both ±0 → exact, anything else → range).
 */
export interface PriceRangeGap {
  minus?: { type?: '%' | '$'; value?: number };
  plus?: { type?: '%' | '$'; value?: number };
}

export interface PriceInstructionOpts {
  priceQuoteMode?: 'range' | 'exact';
  sqftAdjustEnabled?: boolean;
}

const PREAMBLE =
  "This pricing table is REFERENCE material. Only use it when the PRIMARY INSTRUCTION tells you to quote, OR when the customer explicitly asks about price or budget. NEVER invent prices unrelated to the table. If you are not quoting, do not bring up price.";

const SQFT_INSTRUCTION =
  "SQUARE FOOTAGE ADJUSTMENT: each row lists a sqft range (e.g. \"@ 1000-1200 sqft\") and a $/sqft rate computed at the midpoint of that range. If the lead's reported sqft is inside the row's range, use the table price as-is. If it exceeds the row's max, scale up: scaled_price = row $/sqft × lead's actual sqft. Round to the nearest $5. Never scale below the table price for under-sized properties — use the table price as the floor.";

const DISPATCHER_TAIL =
  " Tell the customer the dispatcher will confirm the exact price after a quick property check.";

function fmtRange(range: PriceRangeGap | null | undefined): string {
  const minusVal = Number(range?.minus?.value) || 0;
  const plusVal = Number(range?.plus?.value) || 0;
  const minusType = range?.minus?.type === '$' ? '$' : '%';
  const plusType = range?.plus?.type === '$' ? '$' : '%';
  // Fall back to a sane ±10% if both sides are zero in range mode.
  const effMinus = minusVal === 0 && plusVal === 0 ? 10 : minusVal;
  const effPlus = minusVal === 0 && plusVal === 0 ? 10 : plusVal;
  const effMinusType = minusVal === 0 && plusVal === 0 ? '%' : minusType;
  const effPlusType = minusVal === 0 && plusVal === 0 ? '%' : plusType;

  const fmt = (v: number, t: string) => (t === '$' ? `$${v}` : `${v}%`);
  const low = fmt(effMinus, effMinusType);
  const high = fmt(effPlus, effPlusType);

  let example = '';
  if (effMinusType === '%' && effPlusType === '%') {
    const lowMul = 1 - effMinus / 100;
    const highMul = 1 + effPlus / 100;
    example = ` Example: if the table price is $200, quote a range of $${Math.round(200 * lowMul)}–$${Math.round(200 * highMul)}.`;
  } else if (effMinusType === '$' && effPlusType === '$') {
    example = ` Example: if the table price is $200, quote a range of $${200 - effMinus}–$${200 + effPlus}.`;
  }
  return `When you DO quote, match the customer's bedrooms/bathrooms to the correct row and provide a range from ${low} below to ${high} above the row price.${example}`;
}

export function buildPriceRangeInstruction(
  range: PriceRangeGap | null | undefined,
  opts?: PriceInstructionOpts,
): string {
  // Resolve mode. Explicit opts.priceQuoteMode wins; otherwise infer from range
  // (legacy behavior: both sides 0 → exact, else range).
  let mode: 'range' | 'exact';
  if (opts?.priceQuoteMode === 'exact' || opts?.priceQuoteMode === 'range') {
    mode = opts.priceQuoteMode;
  } else {
    const mv = Number(range?.minus?.value) || 0;
    const pv = Number(range?.plus?.value) || 0;
    mode = mv === 0 && pv === 0 ? 'exact' : 'range';
    // If nothing is configured at all, force range mode with the safe default —
    // exact-quote bugs are the failure mode we explicitly want to avoid.
    if (!range) mode = 'range';
  }

  const parts: string[] = [PREAMBLE];

  if (mode === 'exact') {
    parts.push(
      "When you DO quote, match the customer's bedrooms/bathrooms to the correct row and quote the EXACT table price (no range, no qualifiers).",
    );
  } else {
    parts.push(fmtRange(range) + DISPATCHER_TAIL);
  }

  if (opts?.sqftAdjustEnabled) {
    parts.push(SQFT_INSTRUCTION);
  }

  return parts.join(' ');
}
