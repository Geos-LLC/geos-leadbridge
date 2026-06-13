/**
 * Backend mirror of `frontend/src/data/defaultPricing.ts`.
 *
 * The two files must stay in lock-step on:
 *   - default cleaningTypes (keys + labels)
 *   - default priceTable rows (bed/bath → service prices + sqft ranges)
 *   - hydratePricing rules (preserve explicit 0, backfill missing fields,
 *     merge missing cleaningTypes from defaults)
 *
 * Used by every AI pricing-block builder (ai.controller, automation.service,
 * follow-up-generator.service, instant-text-ai.service) so legacy accounts
 * whose stored JSON lacks `cleaningTypes` don't silently lose entire columns
 * from the prompt — that was the Deep Cleaning regression that started this
 * refactor.
 */

export interface PricingCleaningType {
  key: string;
  label: string;
  enabled?: boolean;
}

export interface PricingRow {
  bed: number;
  bath: number;
  sqftMin?: number;
  sqftMax?: number;
  sqft?: number;
  regular?: number;
  deep?: number;
  airbnb?: number;
  [k: string]: any;
}

export interface ServicePricing {
  serviceType: string;
  cleaningTypes: PricingCleaningType[];
  priceTable: PricingRow[];
  sqftAdjustEnabled: boolean;
  frequencyDiscounts: Array<{ key: string; label: string; discount: number }>;
  extras: Array<{ key: string; label: string; price: number }>;
  conditionSurcharges: Array<{ key: string; label: string; surcharge: number }>;
  petSurcharge: number;
  orderDiscounts: Array<{ minAmount: number; discount: number }>;
  recurringDiscount: number;
  priceRange: { minus: { type: string; value: number }; plus: { type: string; value: number } };
}

export const DEFAULT_CLEANING_PRICING: ServicePricing = {
  serviceType: 'cleaning',
  cleaningTypes: [
    { key: 'regular', label: 'Regular Cleaning', enabled: true },
    { key: 'deep', label: 'Moving / Deep Cleaning', enabled: true },
    { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
  ],
  priceTable: [
    { bed: 1, bath: 1, sqftMin: 600,  sqftMax: 800,  regular: 129, deep: 179, airbnb: 139 },
    { bed: 1, bath: 2, sqftMin: 700,  sqftMax: 900,  regular: 129, deep: 179, airbnb: 139 },
    { bed: 2, bath: 1, sqftMin: 800,  sqftMax: 1000, regular: 139, deep: 179, airbnb: 149 },
    { bed: 2, bath: 2, sqftMin: 1000, sqftMax: 1200, regular: 139, deep: 189, airbnb: 159 },
    { bed: 2, bath: 3, sqftMin: 1100, sqftMax: 1300, regular: 149, deep: 199, airbnb: 169 },
    { bed: 3, bath: 1, sqftMin: 1000, sqftMax: 1200, regular: 149, deep: 209, airbnb: 169 },
    { bed: 3, bath: 2, sqftMin: 1300, sqftMax: 1600, regular: 159, deep: 219, airbnb: 179 },
    { bed: 3, bath: 3, sqftMin: 1500, sqftMax: 1800, regular: 169, deep: 229, airbnb: 189 },
    { bed: 3, bath: 4, sqftMin: 1800, sqftMax: 2200, regular: 179, deep: 239, airbnb: 199 },
    { bed: 4, bath: 2, sqftMin: 1800, sqftMax: 2200, regular: 189, deep: 259, airbnb: 209 },
    { bed: 4, bath: 3, sqftMin: 2200, sqftMax: 2600, regular: 209, deep: 279, airbnb: 229 },
    { bed: 4, bath: 4, sqftMin: 2600, sqftMax: 3000, regular: 229, deep: 309, airbnb: 249 },
    { bed: 4, bath: 5, sqftMin: 3000, sqftMax: 3600, regular: 249, deep: 339, airbnb: 269 },
    { bed: 5, bath: 2, sqftMin: 2400, sqftMax: 2800, regular: 239, deep: 319, airbnb: 259 },
    { bed: 5, bath: 3, sqftMin: 2800, sqftMax: 3400, regular: 249, deep: 329, airbnb: 279 },
    { bed: 5, bath: 4, sqftMin: 3200, sqftMax: 3800, regular: 269, deep: 349, airbnb: 299 },
    { bed: 5, bath: 5, sqftMin: 3600, sqftMax: 4200, regular: 289, deep: 369, airbnb: 319 },
    { bed: 6, bath: 3, sqftMin: 3000, sqftMax: 3600, regular: 289, deep: 379, airbnb: 329 },
    { bed: 6, bath: 4, sqftMin: 3600, sqftMax: 4200, regular: 309, deep: 389, airbnb: 349 },
    { bed: 6, bath: 5, sqftMin: 4000, sqftMax: 4800, regular: 329, deep: 409, airbnb: 369 },
  ],
  sqftAdjustEnabled: true,
  frequencyDiscounts: [
    { key: 'weekly', label: 'Weekly', discount: 15 },
    { key: 'biweekly', label: 'Every 2 Weeks', discount: 10 },
    { key: 'monthly', label: 'Monthly', discount: 10 },
    { key: 'once', label: 'One Time', discount: 0 },
  ],
  extras: [
    { key: 'oven', label: 'Inside Oven', price: 40 },
    { key: 'fridge', label: 'Inside Fridge', price: 40 },
    { key: 'cabinet', label: 'Inside Kitchen Cabinets', price: 30 },
    { key: 'laundry', label: 'Laundry (per load)', price: 20 },
    { key: 'dishes', label: 'Dishes (1 load included)', price: 20 },
    { key: 'windows', label: 'Inside Windows (per window)', price: 20 },
    { key: 'blinds', label: 'Blinds (per window)', price: 10 },
    { key: 'baseboard', label: 'Baseboard Cleaning (per room)', price: 15 },
    { key: 'patio_door', label: 'Patio Door', price: 50 },
    { key: 'patio_garage', label: 'Patio / Garage', price: 50 },
  ],
  conditionSurcharges: [
    { key: 'well_maintained', label: 'Well Maintained', surcharge: 0 },
    { key: 'fair', label: 'Fair Condition', surcharge: 50 },
    { key: 'needs_attention', label: 'Needs Attention', surcharge: 100 },
  ],
  petSurcharge: 20,
  orderDiscounts: [
    { minAmount: 200, discount: 10 },
    { minAmount: 300, discount: 15 },
  ],
  recurringDiscount: 10,
  priceRange: {
    minus: { type: '%', value: 10 },
    plus: { type: '%', value: 10 },
  },
};

function hasValue(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function mergeCleaningTypes(
  saved: PricingCleaningType[] | undefined,
  defaults: PricingCleaningType[],
): PricingCleaningType[] {
  const byKey = new Map<string, PricingCleaningType>();
  if (Array.isArray(saved)) {
    for (const t of saved) {
      if (t && typeof t.key === 'string') byKey.set(t.key, t);
    }
  }
  const merged: PricingCleaningType[] = [];
  for (const def of defaults) {
    const existing = byKey.get(def.key);
    if (existing) {
      merged.push({
        key: def.key,
        label: existing.label || def.label,
        enabled: existing.enabled === false ? false : true,
      });
      byKey.delete(def.key);
    } else {
      merged.push({ ...def });
    }
  }
  for (const extra of byKey.values()) merged.push(extra);
  return merged;
}

function hydrateRow(
  row: PricingRow,
  cleaningTypes: PricingCleaningType[],
  defaultsByBedBath: Map<string, PricingRow>,
): PricingRow {
  const def = defaultsByBedBath.get(`${row.bed}/${row.bath}`);
  const next: PricingRow = { ...row };
  const legacy = Number(next.sqft) || 0;
  if (!hasValue(next.sqftMin) || next.sqftMin === 0) {
    next.sqftMin = legacy || (def ? def.sqftMin : undefined);
  }
  if (!hasValue(next.sqftMax) || next.sqftMax === 0) {
    next.sqftMax = legacy || (def ? def.sqftMax : undefined);
  }
  for (const t of cleaningTypes) {
    if (!hasValue(next[t.key])) {
      next[t.key] = def && hasValue(def[t.key]) ? def[t.key] : 0;
    }
  }
  return next;
}

/**
 * Idempotent. Safe to call on raw saved JSON or on an already-hydrated object.
 * Critical rule: never overwrite an explicit `0` — that's the user's "we
 * don't offer this service" signal.
 */
export function hydratePricing(pricing: any): ServicePricing {
  if (!pricing || typeof pricing !== 'object') {
    return JSON.parse(JSON.stringify(DEFAULT_CLEANING_PRICING));
  }

  const cleaningTypes = mergeCleaningTypes(
    pricing.cleaningTypes,
    DEFAULT_CLEANING_PRICING.cleaningTypes,
  );

  const defaultsByBedBath = new Map<string, PricingRow>();
  for (const def of DEFAULT_CLEANING_PRICING.priceTable) {
    defaultsByBedBath.set(`${def.bed}/${def.bath}`, def);
  }

  const priceTable = Array.isArray(pricing.priceTable)
    ? pricing.priceTable.map((r: any) => hydrateRow(r, cleaningTypes, defaultsByBedBath))
    : DEFAULT_CLEANING_PRICING.priceTable.map((r) => ({ ...r }));

  return {
    serviceType: pricing.serviceType || DEFAULT_CLEANING_PRICING.serviceType,
    cleaningTypes,
    priceTable,
    sqftAdjustEnabled:
      pricing.sqftAdjustEnabled === undefined ? true : !!pricing.sqftAdjustEnabled,
    frequencyDiscounts: Array.isArray(pricing.frequencyDiscounts)
      ? pricing.frequencyDiscounts
      : DEFAULT_CLEANING_PRICING.frequencyDiscounts.map((f) => ({ ...f })),
    extras: Array.isArray(pricing.extras)
      ? pricing.extras
      : DEFAULT_CLEANING_PRICING.extras.map((e) => ({ ...e })),
    conditionSurcharges: Array.isArray(pricing.conditionSurcharges)
      ? pricing.conditionSurcharges
      : DEFAULT_CLEANING_PRICING.conditionSurcharges.map((c) => ({ ...c })),
    petSurcharge: hasValue(pricing.petSurcharge)
      ? Number(pricing.petSurcharge) || 0
      : DEFAULT_CLEANING_PRICING.petSurcharge,
    orderDiscounts: Array.isArray(pricing.orderDiscounts)
      ? pricing.orderDiscounts
      : DEFAULT_CLEANING_PRICING.orderDiscounts.map((o) => ({ ...o })),
    recurringDiscount: hasValue(pricing.recurringDiscount)
      ? Number(pricing.recurringDiscount) || 0
      : DEFAULT_CLEANING_PRICING.recurringDiscount,
    priceRange:
      pricing.priceRange && typeof pricing.priceRange === 'object'
        ? pricing.priceRange
        : { ...DEFAULT_CLEANING_PRICING.priceRange },
  };
}

/**
 * True when a cleaning type has at least one row priced > 0. Explicit `0`
 * across every row → not offered (the user's "we don't do this" signal).
 */
export function isServiceOffered(pricing: ServicePricing, key: string): boolean {
  if (!key || !Array.isArray(pricing.priceTable)) return false;
  return pricing.priceTable.some((row) => Number(row[key]) > 0);
}

/** Parse + hydrate the raw JSON column from SavedAccount.servicePricingJson. */
export function parseAndHydratePricing(json: string | null | undefined): ServicePricing | null {
  if (!json) return null;
  try {
    return hydratePricing(JSON.parse(json));
  } catch {
    return null;
  }
}
