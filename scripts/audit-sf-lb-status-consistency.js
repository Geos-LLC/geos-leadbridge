// SF vs LB status consistency check.
//
// Compares canonical Lead.status (LB) against the most recent SF status we've
// received via the inbound webhook (sf_inbound_events.payloadJson) for every
// SF-linked lead. SF's authoritative jobs table lives in a separate database;
// the latest accepted SfInboundEvent payload per sfJobId is the closest proxy
// LB has — which is exactly the data SF asked us to compare against.
//
// Mapping uses mapSfStatus() from src/integrations/service-flow/sf-status-map.ts
// (the same function the inbound webhook uses for live writes), so the audit
// can never drift from production canonicalization.
//
// Usage:
//   DATABASE_URL=$DIRECT_URL node scripts/audit-sf-lb-status-consistency.js
//
// Output: per-classification counts, then up to 25 sample rows per class.
// Columns: lead_id | sf_job_id | lb_status | sf_status (canonical) | source | classification.
//
// Classifications (per spec):
//   CRITICAL          — statusSource='service_flow' yet mismatch (should NEVER happen)
//   POSSIBLE_DELAY    — statusSource='leadbridge'/'manual'/'lb_automation' (timing/race)
//   EXPECTED          — statusSource='platform_sync' (SF authority blocked overwrite)
//   NO_SF_EVENT       — sfJobId set but no SfInboundEvent ever received (data integrity)
//   UNMAPPED_SF_STATUS — SF event exists but raw status didn't map (vocabulary drift)
const path = require('path');
const { PrismaClient } = require('../generated/prisma');

// Reuse the production mapping. Compiled .js is preferred (production layout);
// fall back to .ts via ts-node for local runs.
let mapSfStatus;
try {
  ({ mapSfStatus } = require('../dist/integrations/service-flow/sf-status-map'));
} catch (_) {
  try {
    require('ts-node/register/transpile-only');
    ({ mapSfStatus } = require('../src/integrations/service-flow/sf-status-map'));
  } catch (e) {
    console.error('Could not load sf-status-map. Build dist/ or install ts-node.', e.message);
    process.exit(1);
  }
}

const SAMPLE_LIMIT = 25;

function classify({ statusSource, hasEvent, mappedSfStatus }) {
  if (!hasEvent) return 'NO_SF_EVENT';
  if (mappedSfStatus === null) return 'UNMAPPED_SF_STATUS';
  if (statusSource === 'service_flow') return 'CRITICAL';
  if (statusSource === 'platform_sync') return 'EXPECTED';
  // 'leadbridge', 'lb_automation', 'manual', null/unknown sources
  return 'POSSIBLE_DELAY';
}

(async () => {
  const p = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  try {
    // 1. All SF-linked leads.
    const leads = await p.$queryRawUnsafe(`
      SELECT
        l.id            AS lead_id,
        l."sfJobId"     AS sf_job_id,
        l.status        AS lb_status,
        l."statusSource" AS status_source,
        l."statusUpdatedAt" AS lb_status_updated_at,
        l."sfLastEventAt"   AS sf_last_event_at
      FROM leads l
      WHERE l."sfJobId" IS NOT NULL
    `);
    console.log(`=== SF-linked leads: ${leads.length} ===`);
    if (leads.length === 0) {
      console.log('No SF-linked leads. Nothing to compare.');
      return;
    }

    // 2. Latest SF event per sfJobId. We pull the highest occurredAt that
    //    actually has a usable status payload. status='applied' OR 'noop' are
    //    both fine — both represent SF's then-current view of the job. We
    //    deliberately DO NOT filter on status='applied' because a 'noop'
    //    (status_unchanged) confirms SF is still on the same value as LB.
    const sfJobIds = leads.map((r) => r.sf_job_id);
    const events = await p.sfInboundEvent.findMany({
      where: { sfJobId: { in: sfJobIds } },
      orderBy: { occurredAt: 'desc' },
      select: {
        sfJobId: true,
        eventId: true,
        occurredAt: true,
        status: true,
        result: true,
        payloadJson: true,
      },
    });

    // Index: sfJobId -> latest event row.
    const latestBySfJob = new Map();
    for (const e of events) {
      if (!latestBySfJob.has(e.sfJobId)) latestBySfJob.set(e.sfJobId, e);
    }

    // 3. Compare + classify.
    const rows = [];
    for (const lead of leads) {
      const evt = latestBySfJob.get(lead.sf_job_id);
      if (!evt) {
        rows.push({
          lead_id: lead.lead_id,
          sf_job_id: lead.sf_job_id,
          lb_status: lead.lb_status,
          sf_status_raw: null,
          sf_status: null,
          source: lead.status_source,
          classification: 'NO_SF_EVENT',
          mismatch: true,
          lb_updated_at: lead.lb_status_updated_at,
          sf_event_at: null,
        });
        continue;
      }

      const payload = evt.payloadJson || {};
      const statusObj = payload.status || {};
      const rawSf = statusObj.canonical || statusObj.new || null;
      const mapped = mapSfStatus(rawSf);

      const mismatch = mapped !== lead.lb_status;
      // Only emit a row when there's actually something to look at.
      if (!mismatch && mapped !== null) continue;

      rows.push({
        lead_id: lead.lead_id,
        sf_job_id: lead.sf_job_id,
        lb_status: lead.lb_status,
        sf_status_raw: rawSf,
        sf_status: mapped,
        source: lead.status_source,
        classification: classify({
          statusSource: lead.status_source,
          hasEvent: true,
          mappedSfStatus: mapped,
        }),
        mismatch,
        lb_updated_at: lead.lb_status_updated_at,
        sf_event_at: evt.occurredAt,
      });
    }

    // 4. Summary by classification.
    const byClass = rows.reduce((acc, r) => {
      acc[r.classification] = (acc[r.classification] || 0) + 1;
      return acc;
    }, {});

    console.log('\n=== Mismatch summary ===');
    console.log(`Total SF-linked leads checked: ${leads.length}`);
    console.log(`Matches (lb_status === mapped sf_status): ${leads.length - rows.length}`);
    console.log(`Mismatches/issues: ${rows.length}`);
    console.table(
      Object.entries(byClass)
        .map(([classification, n]) => ({ classification, n }))
        .sort((a, b) => b.n - a.n),
    );

    // 5. Per-class sample rows.
    const classes = ['CRITICAL', 'NO_SF_EVENT', 'UNMAPPED_SF_STATUS', 'POSSIBLE_DELAY', 'EXPECTED'];
    for (const cls of classes) {
      const sample = rows.filter((r) => r.classification === cls).slice(0, SAMPLE_LIMIT);
      if (sample.length === 0) continue;
      console.log(`\n=== ${cls} — showing ${sample.length} of ${byClass[cls]} ===`);
      console.table(
        sample.map((r) => ({
          lead: r.lead_id.slice(0, 8),
          sf_job: r.sf_job_id?.slice(0, 12) ?? null,
          lb: r.lb_status,
          sf_raw: r.sf_status_raw,
          sf_mapped: r.sf_status,
          source: r.source,
          lb_at: r.lb_updated_at?.toISOString?.().slice(0, 19) ?? null,
          sf_at: r.sf_event_at?.toISOString?.().slice(0, 19) ?? null,
        })),
      );
    }

    // 6. Hard-fail signal for CI/cron consumers — exit non-zero if any CRITICAL.
    if ((byClass.CRITICAL || 0) > 0) {
      console.log(
        `\n[CRITICAL] ${byClass.CRITICAL} SF-authoritative leads disagree with the latest SF event. ` +
          `This should be impossible — investigate writeStatus() bypass paths.`,
      );
      process.exitCode = 2;
    }
  } finally {
    await p.$disconnect();
  }
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
