import type { ServiceProfile } from '../services/api';

/**
 * Maps configured service pricing → which qualification fields the AI
 * actually needs to collect. Used by the AI Conversation → Qualify goal
 * card to pre-tick recommended fields and badge them as "Recommended".
 *
 * Today's signals (all derived from each ServiceProfile.pricingJson):
 *   - `priceTable` row with `bed`/`bath`  → bedrooms, bathrooms
 *   - `sqftAdjustEnabled !== false`       → square_footage
 *   - any non-zero `frequencyDiscounts`   → frequency
 *
 * Universal recommendations (not derivable from pricing) that are still
 * operationally important: `zip_code` (service area), `phone_number`
 * (handoff). Both always returned.
 *
 * `service_date` is NOT recommended automatically — it's a Booking-goal
 * concern and several tenants explicitly want it OFF for Qualify.
 *
 * Returns the union across all passed profiles (so the per-account caller
 * passes that account's enabled profiles; the all-accounts caller passes
 * the tenant's full list and gets the superset).
 */
export function deriveRecommendedFields(profiles: ServiceProfile[]): Set<string> {
  const out = new Set<string>(['zip_code', 'phone_number']);
  for (const profile of profiles) {
    if (profile.status !== 'active') continue;
    const pricing = parsePricing(profile.pricingJson);
    if (!pricing) continue;

    const priceTable = Array.isArray(pricing.priceTable) ? pricing.priceTable : [];
    const hasRoomRow = priceTable.some(
      (row: any) => row && (typeof row.bed === 'number' || typeof row.bath === 'number'),
    );
    if (hasRoomRow) {
      out.add('bedrooms');
      out.add('bathrooms');
    }

    if (pricing.sqftAdjustEnabled !== false) {
      const hasSqftCols = priceTable.some(
        (row: any) => row && (row.sqftMin != null || row.sqftMax != null),
      );
      if (hasSqftCols) out.add('square_footage');
    }

    const fd = Array.isArray(pricing.frequencyDiscounts) ? pricing.frequencyDiscounts : [];
    const hasFreq = fd.some(
      (d: any) => d && typeof d.discount === 'number' && d.discount !== 0,
    );
    if (hasFreq) out.add('frequency');
  }
  return out;
}

function parsePricing(raw: string | null): any {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
