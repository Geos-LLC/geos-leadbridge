#!/usr/bin/env node
/**
 * Status simplification migration runner + verification report.
 *
 * Snapshots Lead.status distribution, applies the contacted→engaged +
 * scheduled→booked UPDATEs in a single transaction, snapshots again, and
 * prints a unified before/after diff.
 *
 * Idempotent — safe to re-run. The UPDATEs match zero rows after the first
 * successful run.
 *
 * Usage:
 *   node scripts/status-simplification-migrate-and-verify.js               # dry-run (snapshot only)
 *   node scripts/status-simplification-migrate-and-verify.js --apply       # apply migration
 */

require('dotenv').config();
const { PrismaClient } = require('../generated/prisma');

const APPLY = process.argv.includes('--apply');

process.env.DATABASE_URL = process.env.DIRECT_URL || process.env.DATABASE_URL;
const prisma = new PrismaClient();

async function snapshot(label) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(status, '(null)') AS status, COUNT(*)::int AS cnt
       FROM leads
      GROUP BY status
      ORDER BY cnt DESC`,
  );
  const total = rows.reduce((s, r) => s + r.cnt, 0);
  console.log(`\n=== ${label} (total = ${total}) ===`);
  console.table(rows);
  return Object.fromEntries(rows.map((r) => [r.status, r.cnt]));
}

async function outcomeBreakdown(label) {
  // Same classification as analytics/analytics.service.ts.
  const ACTIVE = new Set(['new', 'engaged', 'quoted', 'in_progress', 'contacted']);
  const WON    = new Set(['booked', 'completed', 'scheduled']);
  const LOST   = new Set(['lost', 'cancelled', 'no_show', 'archived']);
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COALESCE(LOWER(TRIM(status)), '') AS status, COUNT(*)::int AS cnt
       FROM leads
      GROUP BY status`,
  );
  let active = 0, won = 0, lost = 0;
  for (const r of rows) {
    if (WON.has(r.status))    won    += r.cnt;
    else if (LOST.has(r.status)) lost += r.cnt;
    else if (ACTIVE.has(r.status)) active += r.cnt;
  }
  const total = active + won + lost;
  const resolved = won + lost;
  const conv = resolved > 0 ? (won / resolved) * 100 : null;
  const actR = total > 0 ? (active / total) * 100 : null;
  console.log(`\n=== ${label} — KPI breakdown ===`);
  console.table([{
    active, won, lost, total,
    'conversion_rate (%)': conv?.toFixed(2) ?? '—',
    'active_lead_rate (%)': actR?.toFixed(2) ?? '—',
  }]);
  return { active, won, lost, total, conv, actR };
}

async function main() {
  console.log(`Mode: ${APPLY ? 'APPLY (will mutate)' : 'DRY-RUN (snapshot only)'}`);

  const before = await snapshot('BEFORE');
  const kpiBefore = await outcomeBreakdown('BEFORE');

  if (!APPLY) {
    console.log('\nDry-run complete. Re-run with --apply to perform the migration.');
    await prisma.$disconnect();
    return;
  }

  console.log('\n→ Applying migration in transaction…');
  const [u1, u2] = await prisma.$transaction([
    prisma.$executeRawUnsafe(`UPDATE leads SET status='engaged' WHERE status='contacted'`),
    prisma.$executeRawUnsafe(`UPDATE leads SET status='booked'  WHERE status='scheduled'`),
  ]);
  console.log(`   contacted→engaged: ${u1} rows updated`);
  console.log(`   scheduled→booked:  ${u2} rows updated`);

  const after = await snapshot('AFTER');
  const kpiAfter = await outcomeBreakdown('AFTER');

  // Diff
  console.log('\n=== DIFF ===');
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diff = [...keys].sort().map((k) => ({
    status: k,
    before: before[k] ?? 0,
    after:  after[k]  ?? 0,
    delta:  (after[k] ?? 0) - (before[k] ?? 0),
  }));
  console.table(diff);

  // Sanity assertions
  const failures = [];
  if ((after['contacted'] ?? 0) !== 0) failures.push(`contacted should be 0, got ${after['contacted']}`);
  if ((after['scheduled'] ?? 0) !== 0) failures.push(`scheduled should be 0, got ${after['scheduled']}`);
  const beforeTotal = Object.values(before).reduce((s, n) => s + n, 0);
  const afterTotal  = Object.values(after).reduce((s, n) => s + n, 0);
  if (beforeTotal !== afterTotal) failures.push(`row count changed: ${beforeTotal} → ${afterTotal} (must be conserved)`);

  if (failures.length) {
    console.error('\n❌ Verification FAILED:');
    failures.forEach((f) => console.error('   - ' + f));
    process.exitCode = 1;
  } else {
    console.log('\n✅ Verification passed:');
    console.log(`   contacted = 0, scheduled = 0`);
    console.log(`   row count conserved (${beforeTotal} = ${afterTotal})`);
    console.log(`   Conversion Rate: ${kpiBefore.conv?.toFixed(2)}% → ${kpiAfter.conv?.toFixed(2)}% (unchanged class totals)`);
    console.log(`   Active Lead Rate: ${kpiBefore.actR?.toFixed(2)}% → ${kpiAfter.actR?.toFixed(2)}%`);
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
