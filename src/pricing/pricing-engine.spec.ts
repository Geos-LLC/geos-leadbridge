/**
 * Tests for the deterministic pricing engine.
 *
 * Cases pinned to the P0 + P1 spec:
 *   1. Base only — bed/bath in pricing, no extras
 *   2. Base + one add-on — fridge
 *   3. Base + multiple add-ons — fridge + oven (spec example)
 *   4. Duplicate add-on mentions are deduped
 *   5. Zero-priced add-on is dropped from the total
 *   6. Unknown add-on key is ignored
 *   7. Missing bedroom/bathroom → requiresClarification with missing labels
 *   8. Service-type with 0 across all rows → "not offered" defer
 *
 * Plus integration through buildQuoteFromContext (facade used by the AI
 * surfaces) to lock down the cross-source extraction path:
 *   - bed/bath from leadDetails
 *   - extras from customer message
 *   - ambiguous "appliances" → clarification surface
 */
import { hydratePricing } from '../users/pricing-hydrate';
import {
  calculateQuote,
  inferQuoteFacts,
  buildQuoteBlock,
  buildQuoteFromContext,
} from './pricing-engine';

const pricing = hydratePricing(null); // DEFAULT_CLEANING_PRICING

describe('calculateQuote', () => {
  it('1. base only — 3BR/2BA deep clean returns $219', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    expect(out.basePrice).toBe(219);
    expect(out.extrasPrice).toBe(0);
    expect(out.extrasMatched).toEqual([]);
    expect(out.totalPrice).toBe(219);
    expect(out.requiresClarification).toBe(false);
    expect(out.missing).toEqual([]);
    expect(out.explanation).toContain('3BR/2BA');
    expect(out.explanation).toContain('$219');
  });

  it('2. base + fridge — 3BR/2BA deep + fridge = $259', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['fridge'],
    });
    expect(out.basePrice).toBe(219);
    expect(out.extrasPrice).toBe(40);
    expect(out.totalPrice).toBe(259);
    expect(out.extrasMatched).toEqual([
      { key: 'fridge', label: 'Inside Fridge', price: 40 },
    ]);
    expect(out.explanation).toBe(
      'Moving / Deep Cleaning 3BR/2BA ($219) + Inside Fridge ($40) = $259',
    );
  });

  it('3. spec example — 3BR/2BA deep + fridge + oven = $299', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['fridge', 'oven'],
    });
    expect(out.basePrice).toBe(219);
    expect(out.extrasPrice).toBe(80);
    expect(out.totalPrice).toBe(299);
    expect(out.extrasMatched.map(m => m.key)).toEqual(['fridge', 'oven']);
    expect(out.explanation).toContain('= $299');
  });

  it('4. duplicate mentions are deduped — fridge twice still $40', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['fridge', 'FRIDGE', 'fridge'],
    });
    expect(out.extrasMatched.length).toBe(1);
    expect(out.extrasPrice).toBe(40);
    expect(out.totalPrice).toBe(259);
  });

  it('5. zero-priced add-on is dropped from total + matched', () => {
    const custom = hydratePricing({
      extras: [
        { key: 'oven', label: 'Inside Oven', price: 0 },
        { key: 'fridge', label: 'Inside Fridge', price: 40 },
      ],
    });
    const out = calculateQuote({
      pricing: custom,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['oven', 'fridge'],
    });
    // Oven is configured but priced at 0 — engine drops it from the quote.
    expect(out.extrasMatched.map(m => m.key)).toEqual(['fridge']);
    expect(out.extrasPrice).toBe(40);
  });

  it('6. unknown add-on key is silently ignored', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['unicorn-cleaning'],
    });
    expect(out.extrasMatched).toEqual([]);
    expect(out.extrasPrice).toBe(0);
    expect(out.totalPrice).toBe(219);
  });

  it('7. missing bedroom + bathroom → requiresClarification', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: null,
      bathrooms: null,
      extras: ['fridge'],
    });
    expect(out.basePrice).toBeNull();
    expect(out.totalPrice).toBeNull();
    expect(out.requiresClarification).toBe(true);
    expect(out.missing).toEqual(['bedrooms', 'bathrooms']);
    // Extras still match — the LLM can mention "fridge is $40" but must
    // not quote a total.
    expect(out.extrasMatched.map(m => m.key)).toEqual(['fridge']);
  });

  it('8. service type with 0 across all rows → defer ("not offered")', () => {
    const deepZeroed = hydratePricing({
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: true },
      ],
      priceTable: [
        { bed: 3, bath: 2, sqftMin: 1300, sqftMax: 1600, regular: 159, deep: 0 },
      ],
    });
    const out = calculateQuote({
      pricing: deepZeroed,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    expect(out.basePrice).toBeNull();
    expect(out.requiresClarification).toBe(true);
    expect(out.missing.some(m => m.includes('not offered'))).toBe(true);
  });

  it('returns the row metadata when matched (for downstream display)', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'regular',
      bedrooms: 2,
      bathrooms: 1,
      extras: [],
    });
    expect(out.row).toMatchObject({ bed: 2, bath: 1 });
    expect(out.row?.sqftMin).toBeGreaterThan(0);
  });

  it('defaults to first offered cleaningType when serviceType omitted', () => {
    const out = calculateQuote({
      pricing,
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    // Default config has regular as the first offered type at 3/2 = $159.
    expect(out.serviceType).toBe('regular');
    expect(out.basePrice).toBe(159);
  });
});

describe('inferQuoteFacts', () => {
  it('pulls bedrooms / bathrooms / sqft / cleaning type from a TT-style detail bag', () => {
    const facts = inferQuoteFacts(
      {
        'Bedrooms': '3',
        'Bathrooms': '2',
        'Square footage': '1500',
        'Cleaning type': 'Deep Clean',
      },
      pricing,
    );
    expect(facts).toEqual({
      bedrooms: 3,
      bathrooms: 2,
      sqft: 1500,
      serviceType: 'deep',
    });
  });

  it('tolerates noisy answer text — "2.5 baths" rounds to 3', () => {
    // Default pricing table has no fractional bathroom rows; engine rounds.
    const facts = inferQuoteFacts({ 'Bathrooms': '2.5 baths' }, pricing);
    expect(facts.bathrooms).toBe(3);
  });

  it('returns empty when leadDetails is null', () => {
    expect(inferQuoteFacts(null, pricing)).toEqual({});
    expect(inferQuoteFacts(undefined, pricing)).toEqual({});
  });
});

describe('buildQuoteBlock', () => {
  it('emits "Calculated total" line when basePrice + totalPrice are known', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['fridge', 'oven'],
    });
    const block = buildQuoteBlock(out)!;
    expect(block).toContain('Calculated total: $299');
    expect(block).toContain('Inside Fridge: +$40');
    expect(block).toContain('Inside Oven: +$40');
    expect(block).toContain('use these numbers verbatim');
  });

  it('emits "ask one clarifying question" when requiresClarification', () => {
    const out = calculateQuote({
      pricing,
      bedrooms: null,
      bathrooms: null,
      extras: [],
    });
    const block = buildQuoteBlock(out)!;
    expect(block).toContain('NOT been calculated');
    expect(block.toLowerCase()).toContain('ask one');
    expect(block).toContain('bedrooms');
  });

  it('surfaces ambiguous add-ons separately from matched', () => {
    const out = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    const block = buildQuoteBlock(out, { ambiguousAddons: ['appliances'] })!;
    expect(block).toContain('appliances');
    expect(block).toContain('Calculated total: $219'); // base still quoted
  });

  it('returns null when there is literally nothing to inject', () => {
    const empty = calculateQuote({
      pricing,
      bedrooms: null,
      bathrooms: null,
      extras: [],
    });
    // basePrice null, no extras, no ambiguous, but `missing` is non-empty
    // → still returns a clarification block (not null).
    expect(buildQuoteBlock(empty)).not.toBeNull();

    // True empty: no facts, no missing (engine called with everything blank).
    const noop = {
      basePrice: null,
      extrasPrice: 0,
      extrasMatched: [] as never[],
      totalPrice: null,
      serviceType: null,
      serviceLabel: null,
      row: null,
      explanation: '',
      requiresClarification: false,
      missing: [] as string[],
    };
    expect(buildQuoteBlock(noop)).toBeNull();
  });
});

describe('buildQuoteFromContext (facade used by AI surfaces)', () => {
  it('extracts bed/bath from leadDetails + fridge/oven from message and produces a full quote', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: {
        'Bedrooms': '3',
        'Bathrooms': '2',
        'Cleaning type': 'Deep Clean',
      },
      customerMessage: 'Hey, can you also clean inside the fridge and inside the oven?',
    })!;
    expect(block).toContain('Calculated total: $299');
    expect(block).toContain('Inside Fridge');
    expect(block).toContain('Inside Oven');
  });

  it('ambiguous "appliances" alone → asks for clarification, no auto-add', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'Can you clean appliances too?',
    })!;
    expect(block).toContain('appliances');
    // Customer-mentioned add-ons can be omitted from the matched list AND
    // the total when only the generic word "appliances" is used.
    expect(block).not.toContain('Inside Fridge: +$40');
    expect(block).not.toContain('Inside Oven: +$40');
  });

  it('falls back to platform-data-only when no customer message is provided', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: null,
    })!;
    expect(block).toContain('Calculated total: $219');
  });

  // priceQuoteMode='range' renders the calculated total as a $low–$high
  // bracket instead of a single number. Uses the default ±10% gap when
  // no priceRange config is supplied, snapped to $5.
  it('priceQuoteMode="range" with default ±10% gap renders "Calculated range" line', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'Hey, can you also clean inside the fridge and inside the oven?',
      priceQuoteMode: 'range',
    })!;
    // $299 ±10% → $269.10–$328.90 → snapped to $5 → $270–$330.
    expect(block).toContain('Calculated range: $270–$330');
    expect(block).not.toContain('Calculated total: $299');
  });

  it('priceQuoteMode="exact" preserves the legacy single-total line', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: null,
      priceQuoteMode: 'exact',
    })!;
    expect(block).toContain('Calculated total: $219');
    expect(block).not.toContain('Calculated range');
  });

  it('priceQuoteMode unset preserves legacy single-total (no behavior change for untouched accounts)', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: null,
    })!;
    expect(block).toContain('Calculated total: $219');
    expect(block).not.toContain('Calculated range');
  });

  it('priceQuoteMode="range" with explicit $ gap uses absolute offsets', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: null,
      priceQuoteMode: 'range',
      priceRange: { minus: { type: '$', value: 25 }, plus: { type: '$', value: 25 } },
    })!;
    // $219 - $25 = $194 → snap to $195; $219 + $25 = $244 → snap to $245.
    expect(block).toContain('Calculated range: $195–$245');
  });

  it('returns null when the corpus is completely empty and pricing has no anchor', () => {
    const block = buildQuoteFromContext({
      pricing,
      leadDetails: {},
      customerMessage: null,
    });
    // No bed/bath, no extras, no ambiguous — but `missing` is non-empty
    // (bedrooms + bathrooms) so the block surfaces a clarification ask.
    expect(block).not.toBeNull();
    expect(block!.toLowerCase()).toContain('bedrooms');
  });
});
