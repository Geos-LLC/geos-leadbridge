/**
 * Tests for the canonical pricing hydrator. These tests pin the rules the
 * UI and every AI pricing-block builder rely on:
 *
 *   - Legacy accounts (no cleaningTypes, no Airbnb column) get backfilled
 *     to the full Regular/Deep/Airbnb shape — Deep Cleaning must never
 *     silently disappear from the AI prompt.
 *   - Explicit `0` is the user's "we don't offer this" signal and must
 *     survive hydration unchanged.
 *   - User-entered prices on rows that exist are preserved.
 *   - Partial cleaningTypes get the missing entries merged from default.
 *   - The legacy `enabled` flag is preserved (for back-compat round-trips
 *     and for `isServiceOffered`-style readers), but it does not gate
 *     anything in the hydrator itself.
 */
import {
  DEFAULT_CLEANING_PRICING,
  hydratePricing,
  isServiceOffered,
  PricingCleaningType,
  PricingRow,
} from './pricing-hydrate';

describe('hydratePricing', () => {
  describe('legacy pricing with no cleaningTypes (Deep regression case)', () => {
    const legacy = {
      serviceType: 'cleaning',
      priceTable: [
        { bed: 2, bath: 1, regular: 150 },
        { bed: 3, bath: 2, regular: 200 },
      ],
    };

    it('backfills cleaningTypes from defaults so Regular/Deep/Airbnb all render', () => {
      const out = hydratePricing(legacy);
      const keys = out.cleaningTypes.map((t: PricingCleaningType) => t.key);
      expect(keys).toEqual(['regular', 'deep', 'airbnb']);
    });

    it('backfills missing per-row service keys from the default row for the same bed/bath', () => {
      const out = hydratePricing(legacy);
      const row2x1 = out.priceTable.find((r: PricingRow) => r.bed === 2 && r.bath === 1)!;
      // User-entered regular is preserved.
      expect(row2x1.regular).toBe(150);
      // Missing deep/airbnb backfilled from DEFAULT (2/1 row = deep 179, airbnb 149).
      expect(row2x1.deep).toBe(179);
      expect(row2x1.airbnb).toBe(149);
    });

    it('backfills sqftMin/sqftMax from defaults when absent', () => {
      const out = hydratePricing(legacy);
      const row2x1 = out.priceTable.find((r: PricingRow) => r.bed === 2 && r.bath === 1)!;
      // Default 2/1 row carries sqftMin 800, sqftMax 1000.
      expect(row2x1.sqftMin).toBe(800);
      expect(row2x1.sqftMax).toBe(1000);
    });

    it('isServiceOffered reports Deep as offered after hydration (defaults > 0)', () => {
      const out = hydratePricing(legacy);
      expect(isServiceOffered(out, 'deep')).toBe(true);
    });
  });

  describe('explicit zero (user says "we do not offer this")', () => {
    const withZeroDeep = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular Cleaning', enabled: true },
        { key: 'deep', label: 'Moving / Deep Cleaning', enabled: true },
        { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
      ],
      priceTable: [
        { bed: 1, bath: 1, regular: 129, deep: 0, airbnb: 139 },
        { bed: 2, bath: 2, regular: 139, deep: 0, airbnb: 159 },
      ],
    };

    it('preserves explicit 0 — does NOT overwrite with default 179/189', () => {
      const out = hydratePricing(withZeroDeep);
      for (const row of out.priceTable) {
        expect(row.deep).toBe(0);
      }
    });

    it('isServiceOffered reports deep as NOT offered when every row is 0', () => {
      const out = hydratePricing(withZeroDeep);
      expect(isServiceOffered(out, 'deep')).toBe(false);
    });

    it('preserves explicit 0 across multiple hydration passes (idempotent)', () => {
      const once = hydratePricing(withZeroDeep);
      const twice = hydratePricing(once);
      for (const row of twice.priceTable) {
        expect(row.deep).toBe(0);
      }
    });

    it('preserves explicit 0 on petSurcharge, recurringDiscount, frequencyDiscounts', () => {
      const out = hydratePricing({
        petSurcharge: 0,
        recurringDiscount: 0,
        frequencyDiscounts: [{ key: 'weekly', label: 'Weekly', discount: 0 }],
      });
      expect(out.petSurcharge).toBe(0);
      expect(out.recurringDiscount).toBe(0);
      expect(out.frequencyDiscounts[0].discount).toBe(0);
    });
  });

  describe('partial cleaningTypes (e.g. user has only Regular)', () => {
    const onlyRegular = {
      cleaningTypes: [{ key: 'regular', label: 'Regular Only', enabled: true }],
      priceTable: [{ bed: 2, bath: 1, regular: 175 }],
    };

    it('merges missing default cleaningTypes (Deep, Airbnb) onto the end of the user list', () => {
      const out = hydratePricing(onlyRegular);
      const keys = out.cleaningTypes.map((t: PricingCleaningType) => t.key);
      expect(keys).toContain('regular');
      expect(keys).toContain('deep');
      expect(keys).toContain('airbnb');
    });

    it('preserves the user label override on the existing entry', () => {
      const out = hydratePricing(onlyRegular);
      const reg = out.cleaningTypes.find((t: PricingCleaningType) => t.key === 'regular');
      expect(reg?.label).toBe('Regular Only');
    });

    it('backfills the missing service columns onto each row from defaults', () => {
      const out = hydratePricing(onlyRegular);
      const row = out.priceTable[0];
      expect(row.regular).toBe(175);
      expect(row.deep).toBe(179); // default 2/1 deep
      expect(row.airbnb).toBe(149); // default 2/1 airbnb
    });
  });

  describe('back-compat: legacy `enabled: false` is preserved but ignored', () => {
    const fargiproLike = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular Cleaning', enabled: true },
        { key: 'deep', label: 'Moving / Deep Cleaning', enabled: false },
        { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
      ],
      priceTable: [
        { bed: 1, bath: 1, regular: 130, deep: 180, airbnb: 130 },
      ],
    };

    it('keeps the enabled: false on the JSON for round-trip back-compat', () => {
      const out = hydratePricing(fargiproLike);
      const deep = out.cleaningTypes.find((t: PricingCleaningType) => t.key === 'deep');
      expect(deep?.enabled).toBe(false);
    });

    it('does NOT treat enabled:false as not-offered — non-zero prices win', () => {
      const out = hydratePricing(fargiproLike);
      // Deep still has price 180 → service is "offered" under the new rule.
      // (To genuinely mark it not-offered the user must zero the prices.)
      expect(isServiceOffered(out, 'deep')).toBe(true);
    });
  });

  describe('legacy single-value `sqft` field (pre min/max split)', () => {
    it('collapses sqft onto both sqftMin and sqftMax', () => {
      const out = hydratePricing({
        priceTable: [{ bed: 7, bath: 2, sqft: 1234, regular: 100 }], // 7/2 has no default row
      });
      const row = out.priceTable[0];
      expect(row.sqftMin).toBe(1234);
      expect(row.sqftMax).toBe(1234);
    });
  });

  describe('falsy inputs', () => {
    it('returns a deep-cloned default for null', () => {
      const out = hydratePricing(null);
      expect(out.cleaningTypes.length).toBe(DEFAULT_CLEANING_PRICING.cleaningTypes.length);
      // Mutating the result must NOT mutate the constant.
      out.cleaningTypes.push({ key: 'extra', label: 'x' });
      expect(DEFAULT_CLEANING_PRICING.cleaningTypes.length).toBe(3);
    });

    it('returns defaults for undefined', () => {
      const out = hydratePricing(undefined);
      expect(out.priceTable.length).toBeGreaterThan(0);
    });

    it('returns defaults for an empty object', () => {
      const out = hydratePricing({});
      expect(out.cleaningTypes.map((t: PricingCleaningType) => t.key)).toEqual(['regular', 'deep', 'airbnb']);
    });
  });

  describe('wizard and AI Playbook column parity', () => {
    // Both surfaces feed the default through hydratePricing and render columns
    // from the resulting cleaningTypes. As long as both call hydratePricing,
    // they share the same column set — this test pins the contract.
    it('the default, when hydrated, exposes the same cleaningType keys both UIs render', () => {
      const out = hydratePricing(DEFAULT_CLEANING_PRICING);
      expect(out.cleaningTypes.map((t: PricingCleaningType) => t.key)).toEqual(['regular', 'deep', 'airbnb']);
    });

    it('a legacy account hydrates to the same cleaningType keys as a fresh-default account', () => {
      const legacy = hydratePricing({
        priceTable: [{ bed: 2, bath: 1, regular: 150 }],
      });
      const fresh = hydratePricing(DEFAULT_CLEANING_PRICING);
      expect(legacy.cleaningTypes.map((t) => t.key)).toEqual(
        fresh.cleaningTypes.map((t) => t.key),
      );
    });
  });
});

describe('isServiceOffered', () => {
  it('returns true when at least one row prices the service > 0', () => {
    const pricing = hydratePricing({
      priceTable: [
        { bed: 1, bath: 1, deep: 0 },
        { bed: 2, bath: 2, deep: 200 },
      ],
    });
    expect(isServiceOffered(pricing, 'deep')).toBe(true);
  });

  it('returns false when every row has 0 or absent for that key', () => {
    const pricing = hydratePricing({
      cleaningTypes: [
        { key: 'regular', label: 'Regular' },
        { key: 'deep', label: 'Deep' },
      ],
      priceTable: [
        { bed: 1, bath: 1, regular: 100, deep: 0 },
        { bed: 2, bath: 2, regular: 120, deep: 0 },
      ],
    });
    expect(isServiceOffered(pricing, 'deep')).toBe(false);
  });

  it('returns false for an unknown key', () => {
    const pricing = hydratePricing(DEFAULT_CLEANING_PRICING);
    expect(isServiceOffered(pricing, 'wood-polishing')).toBe(false);
  });
});
