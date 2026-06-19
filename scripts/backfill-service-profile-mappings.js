/**
 * A2 backfill: populate `providerCategoryMappingsJson` on ServiceProfile
 * rows that currently carry an empty array.
 *
 * Why this exists:
 *   Today's resolver falls through to `User.defaultServiceProfileId` when
 *   no profile's `providerCategoryMappingsJson` matches the lead's
 *   category. As of 2026-06-18, 21 of 23 profiles in prod have an empty
 *   mappings array and rely on that fallback to ever match a lead. PR A3
 *   removes the fallback — without this backfill, those 21 tenants would
 *   stop getting any AI quotes the moment A3 ships.
 *
 * Strategy (per profile):
 *   - If pricingJson contains the cleaning grid shape (`priceTable` +
 *     `cleaningTypes`), classify as House Cleaning and write:
 *       [{provider:'thumbtack', categoryName:'House Cleaning'},
 *        {provider:'yelp',      categoryName:'Home Cleaning'}]
 *     This matches what Thumbtack sends in lead.category for cleaning
 *     leads (verified live on the Raye Boyce lead today) and what Yelp
 *     surfaces in its category labels. Case-insensitive match in the
 *     resolver covers minor variants.
 *   - If the profile's name explicitly contains "Upholstery" or
 *     "Carpet", write the matching TT category instead.
 *   - Otherwise: leave it alone and print a manual-review warning. The
 *     A1 monitoring alert will fire when leads against the profile fail
 *     to match, so operators get a clean signal.
 *
 * Usage:
 *   node scripts/backfill-service-profile-mappings.js          # dry-run
 *   node scripts/backfill-service-profile-mappings.js --apply  # write
 *
 * Idempotent — only touches rows with empty mappings, skips any that
 * already have at least one mapping.
 */

const { PrismaClient } = require('../generated/prisma');

const APPLY = process.argv.includes('--apply');

const CLEANING_MAPPINGS = [
  { provider: 'thumbtack', categoryName: 'House Cleaning' },
  { provider: 'yelp', categoryName: 'Home Cleaning' },
];
const UPHOLSTERY_MAPPINGS = [
  { provider: 'thumbtack', categoryName: 'Upholstery and Furniture Cleaning' },
];
const CARPET_MAPPINGS = [
  { provider: 'thumbtack', categoryName: 'Carpet Cleaning' },
];

function hasCleaningGrid(pricing) {
  let p = pricing;
  if (typeof p === 'string') {
    try { p = JSON.parse(p); } catch { return false; }
  }
  return !!(p && Array.isArray(p.priceTable) && Array.isArray(p.cleaningTypes));
}

function classify(profile, ownerSavedAccounts) {
  const name = (profile.name || '').toLowerCase();
  if (/upholstery|furniture/.test(name)) return { mappings: UPHOLSTERY_MAPPINGS, reason: 'name_match_upholstery' };
  if (/carpet/.test(name)) return { mappings: CARPET_MAPPINGS, reason: 'name_match_carpet' };
  // Cleaning detection — three independent signals so a profile is
  // classified as cleaning when ANY of them fire. LB's tenant mix is
  // ~100% house-cleaning, so the residual "no signal" case usually
  // means a fresh tenant with no pricing entered yet — we still
  // backfill as cleaning so the resolver matches their next lead
  // (operator can edit later if wrong, but in practice nobody is).
  if (hasCleaningGrid(profile.pricingJson)) return { mappings: CLEANING_MAPPINGS, reason: 'pricing_shape_cleaning_grid' };
  if (/house ?cleaning|home ?cleaning|cleaning/.test(name)) return { mappings: CLEANING_MAPPINGS, reason: 'name_match_cleaning' };
  // Legacy fallback signal — pricing lives in SavedAccount.servicePricingJson
  // for tenants who haven't migrated to ServiceProfile pricing yet.
  if (ownerSavedAccounts.some((a) => hasCleaningGrid(a.servicePricingJson))) {
    return { mappings: CLEANING_MAPPINGS, reason: 'legacy_saved_account_cleaning_grid' };
  }
  // Last resort for "Default Service" with no signal: LB is a
  // cleaning-services product; write cleaning mappings so the tenant's
  // future leads route to *something* the resolver can act on. If the
  // tenant turns out NOT to be cleaning, the A1 monitoring warning
  // will fire on their first real lead and surface the bad mapping
  // for operator review.
  if (/default service/i.test(name)) return { mappings: CLEANING_MAPPINGS, reason: 'default_service_assumed_cleaning' };
  return { mappings: null, reason: 'unclassified' };
}

(async () => {
  const p = new PrismaClient();
  const all = await p.serviceProfile.findMany({
    where: { status: { in: ['active', 'draft'] } },
    select: { id: true, userId: true, name: true, status: true, isDefault: true, providerCategoryMappingsJson: true, pricingJson: true },
  });
  // Build a userId → SavedAccount[] map for the legacy-pricing signal.
  const userIds = [...new Set(all.map((sp) => sp.userId))];
  const savedAccounts = await p.savedAccount.findMany({
    where: { userId: { in: userIds } },
    select: { userId: true, servicePricingJson: true },
  });
  const savedByUser = new Map();
  for (const sa of savedAccounts) {
    if (!savedByUser.has(sa.userId)) savedByUser.set(sa.userId, []);
    savedByUser.get(sa.userId).push(sa);
  }

  let candidates = 0;
  let willWrite = 0;
  let skipped = 0;
  const plans = [];
  for (const sp of all) {
    const mappings = Array.isArray(sp.providerCategoryMappingsJson)
      ? sp.providerCategoryMappingsJson
      : (() => { try { return JSON.parse(sp.providerCategoryMappingsJson || '[]'); } catch { return []; } })();
    if (mappings.length > 0) continue;
    candidates++;
    const { mappings: chosen, reason } = classify(sp, savedByUser.get(sp.userId) || []);
    if (!chosen) {
      skipped++;
      plans.push({ id: sp.id, userId: sp.userId, name: sp.name, status: sp.status, action: 'SKIP', reason });
      continue;
    }
    willWrite++;
    plans.push({ id: sp.id, userId: sp.userId, name: sp.name, status: sp.status, action: 'WRITE', reason, mappings: chosen });
  }

  console.log(`Total ServiceProfiles (active+draft): ${all.length}`);
  console.log(`Empty-mapping candidates:             ${candidates}`);
  console.log(`Will write mappings:                  ${willWrite}`);
  console.log(`Will skip (unclassified):             ${skipped}`);
  console.log('');
  console.log('Plan:');
  for (const r of plans) {
    if (r.action === 'WRITE') {
      console.log(`  WRITE  id=${r.id} status=${r.status} name="${r.name}" reason=${r.reason} → ${JSON.stringify(r.mappings)}`);
    } else {
      console.log(`  SKIP   id=${r.id} status=${r.status} name="${r.name}" reason=${r.reason} (manual review needed)`);
    }
  }
  console.log('');

  if (!APPLY) {
    console.log('DRY-RUN — no rows written. Re-run with --apply to commit.');
    await p.$disconnect();
    return;
  }

  console.log('APPLYING…');
  let applied = 0;
  for (const r of plans) {
    if (r.action !== 'WRITE') continue;
    await p.serviceProfile.update({
      where: { id: r.id },
      data: { providerCategoryMappingsJson: r.mappings },
    });
    applied++;
    console.log(`  ✓ ${r.id} (${r.name})`);
  }
  console.log(`DONE — wrote ${applied} rows.`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
