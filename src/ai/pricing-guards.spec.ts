/**
 * Regression tests for pricing-guards.ts — the prompt text the AI literally
 * receives. The rule changed in the 2026-06-13 pricing-source-of-truth fix:
 *
 *   OLD: a type was "not offered" when cleaningTypes[].enabled === false
 *        AND priceTable still had non-zero prices for it (FargiPro shape).
 *   NEW: a type is "not offered" when every priceTable row prices it 0
 *        (or absent → 0). The legacy `enabled` flag is preserved on disk
 *        for back-compat but is no longer consulted here.
 *
 * The unconditional bed/bath + no-closest-match rules still always emit.
 */
import { buildPricingGuardRules } from './pricing-guards';

// Fresh "FargiPro-like": deep is the not-offered service. Under the NEW
// rule the user signals that by zeroing deep across every row.
const DEEP_NOT_OFFERED = {
  cleaningTypes: [
    { key: 'regular', label: 'Regular Cleaning', enabled: true },
    { key: 'deep', label: 'Moving / Deep Cleaning', enabled: true },
    { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
  ],
  priceTable: [
    { bed: 1, bath: 1, regular: 130, deep: 0, airbnb: 130 },
    { bed: 4, bath: 3, regular: 200, deep: 0, airbnb: 210 },
  ],
};

// Back-compat: a record carried over from before the rule change still has
// `enabled: false` on deep alongside non-zero prices. We deliberately do NOT
// treat it as not-offered any more — the value > 0 wins.
const LEGACY_ENABLED_FALSE_BUT_PRICED = {
  cleaningTypes: [
    { key: 'regular', label: 'Regular Cleaning', enabled: true },
    { key: 'deep', label: 'Moving / Deep Cleaning', enabled: false },
    { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
  ],
  priceTable: [
    { bed: 1, bath: 1, regular: 130, deep: 180, airbnb: 130 },
    { bed: 4, bath: 3, regular: 200, deep: 350, airbnb: 210 },
  ],
};

describe('buildPricingGuardRules', () => {
  it('lists every priced cleaning type as the offered menu', () => {
    const out = buildPricingGuardRules(DEEP_NOT_OFFERED);
    expect(out).toContain('Regular Cleaning');
    expect(out).toContain('Airbnb Turnaround');
    expect(out).toMatch(/Services you can quote on/i);
    // Deep has zero everywhere → must NOT be in the offered list.
    expect(out).not.toMatch(/Services you can quote on[^\n]*Moving \/ Deep Cleaning/);
  });

  it('lists zero-priced types as "do not quote, defer"', () => {
    const out = buildPricingGuardRules(DEEP_NOT_OFFERED);
    expect(out).toContain('Moving / Deep Cleaning');
    expect(out).toMatch(/does NOT currently offer/i);
    expect(out).toMatch(/move-out.*deep cleaning/i);
    expect(out).toMatch(/let me confirm with the team/i);
  });

  it('treats legacy `enabled: false` as a no-op when prices > 0 — service IS offered', () => {
    const out = buildPricingGuardRules(LEGACY_ENABLED_FALSE_BUT_PRICED);
    // Deep has 180 / 350 → offered. Should appear in the menu, not the deferral.
    expect(out).toMatch(/Services you can quote on[\s\S]*Moving \/ Deep Cleaning/);
    expect(out).not.toMatch(/does NOT currently offer[\s\S]*Moving \/ Deep Cleaning/);
  });

  it('omits the not-offered clause when every listed type has prices', () => {
    const allOffered = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: true },
      ],
      priceTable: [{ bed: 2, bath: 1, regular: 150, deep: 200 }],
    };
    const out = buildPricingGuardRules(allOffered);
    expect(out).not.toMatch(/does NOT currently offer/i);
  });

  it('always emits the no-quote-without-bed/bath rule', () => {
    const out = buildPricingGuardRules(DEEP_NOT_OFFERED);
    expect(out).toMatch(/bedrooms.*bathrooms.*REQUIRED/i);
    expect(out).toMatch(/cheapest row/i);
  });

  it('always emits the no-closest-match rule', () => {
    const out = buildPricingGuardRules(DEEP_NOT_OFFERED);
    expect(out).toMatch(/Match.*EXACTLY/);
    expect(out).toMatch(/closest match/i);
    expect(out).toMatch(/custom quote/i);
  });

  it('handles empty cleaningTypes without crashing', () => {
    expect(() => buildPricingGuardRules({})).not.toThrow();
    const out = buildPricingGuardRules({});
    expect(out).toContain('--- Pricing Policy');
    expect(out).toMatch(/bedrooms.*bathrooms.*REQUIRED/i);
  });
});
