/**
 * A2.1 backfill: extend `providerCategoryMappingsJson` on each tenant's
 * ServiceProfile(s) so that EVERY category string TT and Yelp have
 * actually sent in the last 90 days resolves to a profile.
 *
 * Why A2.1 exists: A2 (run earlier tonight) wrote
 *   [{provider:'thumbtack', categoryName:'House Cleaning'},
 *    {provider:'yelp',       categoryName:'Home Cleaning'}]
 * onto 21 empty-mapping profiles. The cross-tenant spot-check showed
 * that Yelp essentially NEVER uses "Home Cleaning" — 99% of Yelp leads
 * use one of "Regular home cleaning", "Move-in or move-out cleaning",
 * "Deep cleaning", "Carpet and upholstery cleaning", "Maid services",
 * "Carpet cleaning", or commercial-cleaning variants. A2 also didn't
 * route upholstery leads (5 in 30d) to the right profile for tenants
 * who run both house-cleaning and upholstery (adanettka).
 *
 * Strategy (per profile, not per tenant — fixes the multi-profile bug
 * where A2.1 v1 would have appended cleaning categories onto an
 * upholstery profile):
 *
 *   1. Classify this profile by its EXISTING mappings:
 *        - cleaning  → mappings include any cleaning category
 *        - uphol     → mappings include any upholstery / carpet category
 *        - mixed     → both (rare)
 *        - empty     → no mappings (would have been backfilled by A2)
 *
 *   2. From the owning tenant's last-90d lead history, ADD only those
 *      (platform, category) pairs that match this profile's type.
 *      "House Cleaning" leads land on the cleaning profile; "Upholstery
 *      and Furniture Cleaning" leads land on the upholstery profile.
 *      Tenants with only one profile get every category (same shape as
 *      today where defaultServiceProfileId catches everything).
 *
 *   3. Special case: when a tenant has ONLY one profile and its
 *      existing mappings are pure-cleaning but the tenant's lead
 *      history is pure-upholstery, REPLACE rather than EXTEND — A2
 *      misclassified that tenant.
 *
 * Excluded from backfill:
 *   - Lead.platform === 'test' rows (debug / scaffolding leads).
 *   - Lead.category === '' or null (handled separately by A1 monitoring).
 *
 * Usage:
 *   node scripts/backfill-service-profile-mappings-v2.js
 *   node scripts/backfill-service-profile-mappings-v2.js --apply
 *
 * Idempotent. Safe to re-run.
 */

const { PrismaClient } = require('../generated/prisma');

const APPLY = process.argv.includes('--apply');

// Treat "carpet" as upholstery for matching purposes — TT and Yelp lump
// them under the same business category, and operators who run one
// usually run the other.
const UPHOLSTERY_CATS = new Set([
  'upholstery and furniture cleaning',
  'carpet and upholstery cleaning',
  'carpet cleaning',
  'furniture cleaning',
]);

const CLEANING_CATS = new Set([
  'house cleaning',
  'home cleaning',
  'regular home cleaning',
  'move-in or move-out cleaning',
  'deep cleaning',
  'maid services',
  'janitorial services',
  'commercial standard cleaning',
  'commercial move-in or move-out cleaning',
  'post-construction cleaning',
]);

function normalize(s) {
  return String(s || '').toLowerCase().trim();
}

function mappingKey(m) {
  return (m.provider || '') + '::' + normalize(m.categoryName);
}

function classifyCategory(cat) {
  const n = normalize(cat);
  if (UPHOLSTERY_CATS.has(n)) return 'uphol';
  if (CLEANING_CATS.has(n)) return 'cleaning';
  return 'other';
}

function classifyProfile(mappings) {
  let cleaning = 0, uphol = 0;
  for (const m of mappings) {
    const t = classifyCategory(m.categoryName);
    if (t === 'cleaning') cleaning++;
    else if (t === 'uphol') uphol++;
  }
  if (cleaning > 0 && uphol > 0) return 'mixed';
  if (cleaning > 0) return 'cleaning';
  if (uphol > 0) return 'uphol';
  return 'empty';
}

(async () => {
  const p = new PrismaClient();

  const profiles = await p.serviceProfile.findMany({
    where: { status: { in: ['active', 'draft'] } },
    select: { id: true, userId: true, name: true, providerCategoryMappingsJson: true },
  });

  const since = new Date(Date.now() - 90 * 86400 * 1000);
  const leads = await p.lead.findMany({
    where: {
      createdAt: { gte: since },
      category: { not: null },
      platform: { in: ['thumbtack', 'yelp'] },
    },
    select: { userId: true, platform: true, category: true },
  });

  // Per-tenant unique (platform, original-case category) pairs from real
  // lead history. We dedupe on (platform, normalized category) so the
  // first-seen casing wins for the mapping payload.
  const tenantPairs = new Map(); // userId → Map<"platform::normCat", {platform, category}>
  for (const l of leads) {
    if (!l.category || !l.category.trim()) continue;
    if (!tenantPairs.has(l.userId)) tenantPairs.set(l.userId, new Map());
    const m = tenantPairs.get(l.userId);
    const k = l.platform + '::' + normalize(l.category);
    if (!m.has(k)) m.set(k, { platform: l.platform, category: l.category });
  }

  // Tenant-level bucket — for the REPLACE-only-uphol special case.
  function tenantBucket(userId) {
    const pairs = tenantPairs.get(userId);
    if (!pairs) return 'none';
    let uphol = 0, cleaning = 0;
    for (const { category } of pairs.values()) {
      const t = classifyCategory(category);
      if (t === 'uphol') uphol++;
      else if (t === 'cleaning') cleaning++;
    }
    if (uphol === 0 && cleaning === 0) return 'none';
    if (uphol > 0 && cleaning === 0) return 'uphol_only';
    if (cleaning > 0 && uphol === 0) return 'cleaning_only';
    return 'both';
  }

  const tenantProfileCount = new Map();
  for (const sp of profiles) tenantProfileCount.set(sp.userId, (tenantProfileCount.get(sp.userId) || 0) + 1);

  let willWrite = 0, unchanged = 0;
  const plans = [];

  for (const sp of profiles) {
    const current = Array.isArray(sp.providerCategoryMappingsJson)
      ? sp.providerCategoryMappingsJson
      : (() => { try { return JSON.parse(sp.providerCategoryMappingsJson || '[]'); } catch { return []; } })();
    const currentKeys = new Set(current.map(mappingKey));
    const profileType = classifyProfile(current);
    const bucket = tenantBucket(sp.userId);
    const soloProfile = tenantProfileCount.get(sp.userId) === 1;
    const pairs = tenantPairs.get(sp.userId) ?? new Map();

    let action = 'SKIP', reason = '', next = current.slice();

    if (profileType === 'cleaning' && bucket === 'uphol_only' && soloProfile) {
      // A2 misclassified this tenant — they run upholstery, not cleaning.
      action = 'REPLACE';
      reason = 'tenant_lead_history_upholstery_only_solo_profile';
      next = [
        { provider: 'thumbtack', categoryName: 'Upholstery and Furniture Cleaning' },
        { provider: 'yelp', categoryName: 'Carpet and upholstery cleaning' },
      ];
    } else if (bucket === 'none') {
      action = 'SKIP';
      reason = 'no_lead_history_keep_a2_default';
    } else {
      // ADD only categories matching this profile's existing type. Solo
      // profiles get everything (no other profile to route to).
      const additions = [];
      for (const { platform, category } of pairs.values()) {
        const catType = classifyCategory(category);
        const allowAdd =
          soloProfile ||
          profileType === 'mixed' ||
          (profileType === 'cleaning' && catType === 'cleaning') ||
          (profileType === 'uphol' && catType === 'uphol');
        if (!allowAdd) continue;
        const m = { provider: platform, categoryName: category };
        if (!currentKeys.has(mappingKey(m))) additions.push(m);
      }
      if (additions.length === 0) {
        action = 'SKIP';
        reason = 'no_new_categories_for_this_profile_type';
      } else {
        action = 'EXTEND';
        reason = `add_${additions.length}_categories_for_profile_type=${profileType}`;
        next = current.concat(additions);
      }
    }

    if (action === 'SKIP') unchanged++;
    else willWrite++;
    plans.push({ id: sp.id, userId: sp.userId, name: sp.name, profileType, bucket, action, reason, next });
  }

  const users = await p.user.findMany({
    where: { id: { in: [...new Set(profiles.map((sp) => sp.userId))] } },
    select: { id: true, email: true },
  });
  const emailById = Object.fromEntries(users.map((u) => [u.id, u.email]));

  console.log(`Total active+draft profiles:           ${profiles.length}`);
  console.log(`Will write (REPLACE + EXTEND):         ${willWrite}`);
  console.log(`Skip:                                  ${unchanged}`);
  console.log('');
  console.log('Plan:');
  for (const r of plans) {
    const tag = r.action.padEnd(8);
    const owner = (emailById[r.userId] || r.userId).padEnd(34);
    const ptype = `type=${r.profileType}/tenant=${r.bucket}`;
    if (r.action === 'SKIP') {
      console.log(`  ${tag} ${owner} name="${r.name}" ${ptype} reason=${r.reason}`);
    } else {
      console.log(`  ${tag} ${owner} name="${r.name}" ${ptype} reason=${r.reason}`);
      console.log(`           → ${JSON.stringify(r.next)}`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('DRY-RUN — no rows written. Re-run with --apply to commit.');
    await p.$disconnect();
    return;
  }

  console.log('');
  console.log('APPLYING…');
  let applied = 0;
  for (const r of plans) {
    if (r.action === 'SKIP') continue;
    await p.serviceProfile.update({
      where: { id: r.id },
      data: { providerCategoryMappingsJson: r.next },
    });
    applied++;
    console.log(`  ✓ ${r.id} (${r.name}) [${r.action}]`);
  }
  console.log(`DONE — wrote ${applied} rows.`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
