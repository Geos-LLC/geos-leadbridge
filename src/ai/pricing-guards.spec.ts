/**
 * Regression tests for pricing-guards.ts — the prompt text the AI literally
 * receives. These tests pin behavior on FargiPro's incident shape:
 *
 *   - cleaningTypes.deep.enabled = false BUT priceTable rows have deep
 *     prices populated. We must emit the disabled-type "do NOT quote, defer"
 *     clause so the AI doesn't silently substitute regular.
 *   - The unconditional "ask for bed/bath first" + "no closest-match"
 *     rules must always be present.
 */
import { buildPricingGuardRules } from './pricing-guards';

const FARGIPRO_LIKE = {
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
  it('lists enabled cleaning types as the menu', () => {
    const out = buildPricingGuardRules(FARGIPRO_LIKE);
    expect(out).toContain('Regular Cleaning');
    expect(out).toContain('Airbnb Turnaround');
    expect(out).toMatch(/Services you can quote on/i);
  });

  it('lists disabled-but-priced types as "do not quote, defer"', () => {
    const out = buildPricingGuardRules(FARGIPRO_LIKE);
    expect(out).toContain('Moving / Deep Cleaning');
    expect(out).toMatch(/does NOT currently offer/i);
    expect(out).toMatch(/move-out.*deep cleaning/i);
    expect(out).toMatch(/let me confirm with the team/i);
  });

  it('omits the disabled clause when no disabled types have prices', () => {
    const pricing = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: false }, // no prices in table
      ],
      priceTable: [{ bed: 2, bath: 1, regular: 150 }], // deep column absent
    };
    const out = buildPricingGuardRules(pricing);
    expect(out).not.toMatch(/does NOT currently offer/i);
  });

  it('always emits the no-quote-without-bed/bath rule', () => {
    const out = buildPricingGuardRules(FARGIPRO_LIKE);
    expect(out).toMatch(/bedrooms.*bathrooms.*REQUIRED/i);
    expect(out).toMatch(/cheapest row/i);
  });

  it('always emits the no-closest-match rule', () => {
    const out = buildPricingGuardRules(FARGIPRO_LIKE);
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
