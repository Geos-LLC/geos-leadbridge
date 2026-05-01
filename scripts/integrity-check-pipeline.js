/**
 * LB ↔ SF pipeline integrity check.
 *
 * Runs five drift/error queries against the live database and exits non-zero
 * when anything looks wrong. Designed to be run manually or wired into a
 * future cron without further code changes.
 *
 *   DATABASE_URL=$DIRECT_URL node scripts/integrity-check-pipeline.js
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks reported drift / errors (details printed above)
 *   2 — internal error running the script (DB unreachable, etc.)
 *
 * Checks (in print order):
 *   1. Lead.status not in canonical set
 *   2. platformStatus present but Lead.status legacy/raw (= not canonical)
 *   3. SF-linked leads with statusSource ∉ {service_flow, manual}
 *   4. sf_inbound_events with processingError in last 24h
 *   5. crm_webhook_deliveries failed/5xx in last 24h
 *
 * The canonical set is hard-coded here to keep the script standalone (no TS
 * imports). Keep in sync with src/leads/canonical-status.ts.
 */

const { PrismaClient } = require('../generated/prisma');

const CANONICAL_STATUSES = [
  'new', 'contacted', 'engaged', 'quoted', 'booked',
  'scheduled', 'in_progress', 'completed',
  'lost', 'cancelled', 'no_show', 'archived',
];

const VALID_SF_STATUS_SOURCES = ['service_flow', 'manual'];

(async () => {
  const p = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || process.env.DIRECT_URL });
  const results = []; // { check, count, severity: 'ok' | 'fail', sample? }

  try {
    // ── 1. Lead.status outside canonical set ────────────────────────────
    const nonCanonical = await p.$queryRawUnsafe(`
      SELECT status, COUNT(*)::int AS n
      FROM leads
      WHERE status IS NOT NULL
        AND NOT (status = ANY($1::text[]))
      GROUP BY status
      ORDER BY n DESC
      LIMIT 20
    `, CANONICAL_STATUSES);
    const nonCanonicalTotal = nonCanonical.reduce((s, r) => s + r.n, 0);
    console.log(`\n=== 1. Lead.status not in canonical set ===`);
    if (nonCanonicalTotal === 0) {
      console.log('OK — all leads have canonical status.');
      results.push({ check: '1. lead_status_not_canonical', count: 0, severity: 'ok' });
    } else {
      console.table(nonCanonical);
      results.push({ check: '1. lead_status_not_canonical', count: nonCanonicalTotal, severity: 'fail' });
    }

    // ── 2. platformStatus present but Lead.status legacy/raw ───────────
    // Drift signal: platform_sync wrote platformStatus but the canonical
    // Lead.status column is still on a legacy value (anything outside the
    // canonical set). Caused by an older write path or a missed migration.
    const driftLegacy = await p.$queryRawUnsafe(`
      SELECT platform, status, "platformStatus", COUNT(*)::int AS n
      FROM leads
      WHERE "platformStatus" IS NOT NULL
        AND status IS NOT NULL
        AND NOT (status = ANY($1::text[]))
      GROUP BY platform, status, "platformStatus"
      ORDER BY n DESC
      LIMIT 20
    `, CANONICAL_STATUSES);
    const driftTotal = driftLegacy.reduce((s, r) => s + r.n, 0);
    console.log(`\n=== 2. platformStatus set but Lead.status is legacy/raw ===`);
    if (driftTotal === 0) {
      console.log('OK — every lead with platformStatus has a canonical Lead.status.');
      results.push({ check: '2. platform_status_with_legacy_lead_status', count: 0, severity: 'ok' });
    } else {
      console.table(driftLegacy);
      results.push({ check: '2. platform_status_with_legacy_lead_status', count: driftTotal, severity: 'fail' });
    }

    // ── 3. SF-linked leads with statusSource not in {service_flow, manual}
    // SF-linked leads (sfJobId set) should only ever be written by SF or by
    // an operator pushing to SF. Anything else suggests a write path bypassed
    // SF authority — a regression worth investigating.
    const sfLinkedDrift = await p.$queryRawUnsafe(`
      SELECT "statusSource", status, COUNT(*)::int AS n
      FROM leads
      WHERE "sfJobId" IS NOT NULL
        AND "statusSource" IS NOT NULL
        AND NOT ("statusSource" = ANY($1::text[]))
      GROUP BY "statusSource", status
      ORDER BY n DESC
      LIMIT 20
    `, VALID_SF_STATUS_SOURCES);
    const sfLinkedTotal = sfLinkedDrift.reduce((s, r) => s + r.n, 0);
    console.log(`\n=== 3. SF-linked leads with statusSource ∉ {service_flow, manual} ===`);
    if (sfLinkedTotal === 0) {
      console.log('OK — all SF-linked leads were last written by SF or by manual operator.');
      results.push({ check: '3. sf_linked_unexpected_status_source', count: 0, severity: 'ok' });
    } else {
      console.table(sfLinkedDrift);
      results.push({ check: '3. sf_linked_unexpected_status_source', count: sfLinkedTotal, severity: 'fail' });
    }

    // ── 4. sf_inbound_events with processingError in last 24h ──────────
    const inboundErrors = await p.$queryRawUnsafe(`
      SELECT "processingError", status, COUNT(*)::int AS n
      FROM sf_inbound_events
      WHERE "processingError" IS NOT NULL
        AND "receivedAt" > NOW() - INTERVAL '24 hours'
      GROUP BY "processingError", status
      ORDER BY n DESC
      LIMIT 20
    `);
    const inboundErrorTotal = inboundErrors.reduce((s, r) => s + r.n, 0);
    console.log(`\n=== 4. sf_inbound_events.processingError in last 24h ===`);
    if (inboundErrorTotal === 0) {
      console.log('OK — no inbound processing errors in the last 24h.');
      results.push({ check: '4. sf_inbound_processing_error_24h', count: 0, severity: 'ok' });
    } else {
      console.table(inboundErrors);
      results.push({ check: '4. sf_inbound_processing_error_24h', count: inboundErrorTotal, severity: 'fail' });
    }

    // ── 5. crm_webhook_deliveries failed/5xx in last 24h ──────────────
    const outboundFailures = await p.$queryRawUnsafe(`
      SELECT
        CASE
          WHEN state = 'failed' THEN 'state=failed'
          ELSE 'lastStatusCode>=500'
        END AS reason,
        "lastStatusCode",
        "lastError",
        COUNT(*)::int AS n
      FROM crm_webhook_deliveries
      WHERE ("state" = 'failed' OR "lastStatusCode" >= 500)
        AND "createdAt" > NOW() - INTERVAL '24 hours'
      GROUP BY reason, "lastStatusCode", "lastError"
      ORDER BY n DESC
      LIMIT 20
    `);
    const outboundTotal = outboundFailures.reduce((s, r) => s + r.n, 0);
    console.log(`\n=== 5. crm_webhook_deliveries failed/5xx in last 24h ===`);
    if (outboundTotal === 0) {
      console.log('OK — no outbound failures or 5xx in the last 24h.');
      results.push({ check: '5. crm_webhook_failed_or_5xx_24h', count: 0, severity: 'ok' });
    } else {
      console.table(outboundFailures);
      results.push({ check: '5. crm_webhook_failed_or_5xx_24h', count: outboundTotal, severity: 'fail' });
    }

    // ── Summary ────────────────────────────────────────────────────────
    console.log('\n=== Summary ===');
    console.table(results.map(r => ({ check: r.check, count: r.count, severity: r.severity })));

    const failed = results.filter(r => r.severity === 'fail');
    if (failed.length === 0) {
      console.log('\nResult: CLEAN. All 5 checks passed.');
      process.exit(0);
    } else {
      console.log(`\nResult: DRIFT/ERRORS in ${failed.length} of 5 checks: ${failed.map(f => f.check).join(', ')}`);
      process.exit(1);
    }
  } catch (err) {
    console.error('\nResult: SCRIPT ERROR —', err.message);
    if (err.stack) console.error(err.stack);
    process.exit(2);
  } finally {
    await p.$disconnect();
  }
})();
