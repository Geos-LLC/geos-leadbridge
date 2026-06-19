/**
 * Option A backfill: populate `ServiceProfile.serviceGroup` from each
 * row's existing `providerCategoryMappingsJson`.
 *
 * The new resolver in src/service-profile/service-profile.service.ts
 * routes leads by `serviceGroup` first ('cleaning' | 'upholstery_carpet'
 * | 'other'), falling back to exact category match only if no group
 * matches. New rows need a serviceGroup at create time; this script
 * one-shots the existing rows after the column ships.
 *
 * Logic: examine each mapping's categoryName, classify it, and pick the
 * MOST SPECIFIC group seen (carpet > cleaning > other). When mappings
 * span multiple groups, the more-specific one wins because the
 * operator explicitly added that niche mapping.
 *
 * Usage:
 *   node scripts/backfill-service-profile-service-group.js
 *   node scripts/backfill-service-profile-service-group.js --apply
 *
 * Idempotent. Safe to re-run.
 */

const { PrismaClient } = require('../generated/prisma');

const APPLY = process.argv.includes('--apply');

const UPHOLSTERY_CARPET_RE =
  /\b(carpet|rug|upholstery|furniture|sofa|couch|chair|drapery|drapes|curtains?)\b/i;
const CLEANING_RE =
  /\b(cleaning|cleaners?|cleanup|maids?|janitorial|housekeeping|housekeeper)\b/i;

function deriveGroup(mappings) {
  let upholstery = 0;
  let cleaning = 0;
  for (const m of mappings) {
    const name = String(m?.categoryName ?? '');
    if (UPHOLSTERY_CARPET_RE.test(name)) upholstery++;
    if (CLEANING_RE.test(name)) cleaning++;
  }
  if (upholstery > 0) return 'upholstery_carpet';
  if (cleaning > 0) return 'cleaning';
  return 'other';
}

(async () => {
  const p = new PrismaClient();

  const profiles = await p.serviceProfile.findMany({
    select: { id: true, userId: true, name: true, status: true, providerCategoryMappingsJson: true, serviceGroup: true },
  });

  let willWrite = 0;
  let unchanged = 0;
  const plans = [];

  for (const sp of profiles) {
    const mappings = Array.isArray(sp.providerCategoryMappingsJson)
      ? sp.providerCategoryMappingsJson
      : (() => { try { return JSON.parse(sp.providerCategoryMappingsJson || '[]'); } catch { return []; } })();
    const derived = deriveGroup(mappings);
    if (derived === sp.serviceGroup) {
      unchanged++;
      plans.push({ id: sp.id, name: sp.name, current: sp.serviceGroup, next: derived, action: 'SKIP' });
    } else {
      willWrite++;
      plans.push({ id: sp.id, name: sp.name, current: sp.serviceGroup, next: derived, action: 'WRITE' });
    }
  }

  const users = await p.user.findMany({
    where: { id: { in: [...new Set(profiles.map((sp) => sp.userId))] } },
    select: { id: true, email: true },
  });
  const emailById = Object.fromEntries(users.map((u) => [u.id, u.email]));

  console.log(`Total profiles:    ${profiles.length}`);
  console.log(`Will write:        ${willWrite}`);
  console.log(`Skip (unchanged):  ${unchanged}`);
  console.log('');
  console.log('Plan:');
  for (const r of plans) {
    const owner = (emailById[profiles.find((sp) => sp.id === r.id).userId] || '?').padEnd(34);
    const tag = r.action.padEnd(6);
    console.log(`  ${tag} ${owner} name="${r.name}"  ${r.current} → ${r.next}`);
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
    if (r.action !== 'WRITE') continue;
    await p.serviceProfile.update({ where: { id: r.id }, data: { serviceGroup: r.next } });
    applied++;
    console.log(`  ✓ ${r.id} (${r.name}) → ${r.next}`);
  }
  console.log(`DONE — wrote ${applied} rows.`);
  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
