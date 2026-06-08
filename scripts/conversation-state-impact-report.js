#!/usr/bin/env node
/**
 * PR 2 — Read-only impact report for the Conversation State migration plan.
 *
 * NO MUTATIONS. Computes:
 *
 *   §A  current Lead.status distribution (global)
 *   §B  Lost-lead breakdown by (lostReason × statusSource)
 *   §C  Lost-lead breakdown by platformStatus
 *   §D  KEEP-lost vs FLIP-lost classification (per the flip rule below)
 *   §E  per-tenant flip volume
 *   §F  current Active pool sub-bucket projection — derived live from
 *       ThreadContext.conversationState + Lead.status via the same
 *       mapping defined in src/conversation-context/activity-bucket.ts
 *   §G  Hire Rate methodology — HEADLINE Cumulative + DIAGNOSTIC Resolved
 *   §H  sanity checks
 *
 * Flip rule (per the user's PR 2 spec):
 *
 *   Currently status='lost' lead FLIPS to status='engaged' (UI label "Active")
 *   UNLESS one of the keep-lost criteria holds:
 *
 *     A. lostReason = 'opt_out'        (compliance / explicit unsubscribe)
 *     B. statusSource = 'manual'       (operator close)
 *     C. createdAt < (now - 1 year)    (stale beyond default window)
 *
 *   Anything else — TT/Yelp "No hire", "Archived", "Hired Someone" automatic
 *   writes — is treated as recoverable and would flip. After flip, the
 *   activity bucket on the Active pool is derived from ThreadContext as usual.
 *
 * Hire Rate methodology — TWO numbers reported:
 *
 *   ★ HEADLINE  Cumulative Hire Rate (the dashboard metric).
 *     won / (won + true_lost + cancelled + recoverable_followup)
 *     Recoverable rows STAY in the denominator even though they surface as
 *     Active in the UI — they are not-yet-won historical opportunities.
 *     This conserves the denominator across the re-categorization, so the
 *     headline rate does not jump on migration day.
 *
 *     DIAGNOSTIC  Resolved Hire Rate (secondary, NOT headline).
 *     won / (won + true_lost + cancelled)
 *     Excludes recoverable rows. Mechanically rises as Lost shrinks.
 *
 * Usage:  node scripts/conversation-state-impact-report.js
 */

require('dotenv').config({ quiet: true });
const { PrismaClient } = require('../generated/prisma');
process.env.DATABASE_URL = process.env.DIRECT_URL;
const p = new PrismaClient();

const STALE_DAYS   = 365;
const STALE_CUTOFF = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000);

// Mirrors src/conversation-context/activity-bucket.ts — duplicated in JS so
// this report script has no TS-build dependency. Keep the two in sync; the
// activity-bucket.spec.ts pins the canonical mapping.
const TERMINAL_LEAD_STATUSES = new Set(['booked', 'completed', 'lost', 'cancelled', 'no_show', 'archived']);
function activityBucket(tcState, leadStatus) {
  const status = (leadStatus ?? '').toLowerCase().trim();
  if (TERMINAL_LEAD_STATUSES.has(status)) return null;
  if (!tcState) return 'engagement';
  switch (tcState) {
    case 'new':                return 'engagement';
    case 'ai_engaging':        return 'ai_conversation';
    case 'awaiting_customer':
    case 'deferred':
    case 'long_silent':        return 'follow_up';
    case 'customer_replied':
    case 'human_handling':     return 'human_handoff';
    case 'closed':
    case 'opted_out':
    case 'hired_elsewhere':
    case 'booked_in_lb':       return null;
    default:                   return 'engagement';
  }
}

function pctOf(num, denom, places = 2) {
  if (!denom) return '—';
  return ((num / denom) * 100).toFixed(places) + '%';
}

async function snapshot() {
  const dist = await p.$queryRawUnsafe(`
    SELECT COALESCE(status, '(null)') AS status, COUNT(*)::int AS cnt
      FROM leads GROUP BY status ORDER BY cnt DESC
  `);
  return Object.fromEntries(dist.map((r) => [r.status, r.cnt]));
}

async function lostReasonDistribution() {
  return p.$queryRawUnsafe(`
    SELECT COALESCE("lostReason", '(null)') AS lost_reason,
           COALESCE("statusSource", '(null)') AS status_source,
           COUNT(*)::int AS cnt
      FROM leads WHERE status = 'lost'
     GROUP BY "lostReason", "statusSource" ORDER BY cnt DESC
  `);
}

async function platformStatusDist() {
  return p.$queryRawUnsafe(`
    SELECT COALESCE("platformStatus", '(null)') AS platform_status, COUNT(*)::int AS cnt
      FROM leads WHERE status = 'lost'
     GROUP BY "platformStatus" ORDER BY cnt DESC
  `);
}

async function classifyLostLeads() {
  const rows = await p.$queryRawUnsafe(`
    SELECT l."userId" AS user_id, l."lostReason" AS lost_reason,
           l."statusSource" AS status_source, l."createdAt" AS created_at,
           l."platformStatus" AS platform_status, l."thumbtackStatus" AS thumbtack_status,
           l.platform AS platform
      FROM leads l WHERE l.status = 'lost'
  `);
  const result = { total: rows.length, keepReasons: { opt_out: 0, manual: 0, stale: 0 },
                   flipReasons: {}, perTenant: {}, sampleFlipCauses: {} };
  for (const r of rows) {
    const t = (result.perTenant[r.user_id] = result.perTenant[r.user_id] || { keep: 0, flip: 0 });
    if (r.lost_reason === 'opt_out')   { result.keepReasons.opt_out++; t.keep++; continue; }
    if (r.status_source === 'manual')  { result.keepReasons.manual++;  t.keep++; continue; }
    if (r.created_at && new Date(r.created_at) < STALE_CUTOFF) {
                                         result.keepReasons.stale++;   t.keep++; continue; }
    const causeKey = r.lost_reason === 'hired_someone'
      ? 'lostReason=hired_someone'
      : 'no_lostReason + TT/Yelp platform_sync';
    result.flipReasons[causeKey] = (result.flipReasons[causeKey] || 0) + 1;
    const sample = `${r.lost_reason ?? '(null)'} × ${r.platform_status ?? r.thumbtack_status ?? '(null)'}`;
    result.sampleFlipCauses[sample] = (result.sampleFlipCauses[sample] || 0) + 1;
    t.flip++;
  }
  return result;
}

/**
 * Live projection of the Active pool sub-buckets using the canonical
 * derivation. Joins leads → thread_contexts and applies activityBucket() per row.
 */
async function activePoolSubBuckets() {
  const rows = await p.$queryRawUnsafe(`
    SELECT l.status AS lead_status, tc."conversationState" AS tc_state, COUNT(*)::int AS cnt
      FROM leads l
      LEFT JOIN thread_contexts tc ON tc."conversationId" = l."threadId"
     WHERE l.status IN ('new', 'engaged', 'quoted', 'in_progress', 'contacted')
     GROUP BY l.status, tc."conversationState"
  `);
  const buckets = { engagement: 0, ai_conversation: 0, follow_up: 0, human_handoff: 0, '(null — terminal-leaning TC)': 0 };
  let total = 0;
  for (const r of rows) {
    total += r.cnt;
    const b = activityBucket(r.tc_state, r.lead_status);
    if (b == null) buckets['(null — terminal-leaning TC)'] += r.cnt;
    else           buckets[b] += r.cnt;
  }
  return { rows, buckets, total };
}

(async () => {
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log('  Conversation State Migration — PR 2 read-only impact report');
  console.log('═══════════════════════════════════════════════════════════════════');
  console.log(`  Stale cutoff: ${STALE_DAYS} days (leads older than ${STALE_CUTOFF.toISOString().slice(0,10)} stay lost)`);
  console.log(`  NO MUTATIONS performed.\n`);

  const before = await snapshot();
  const beforeTotal = Object.values(before).reduce((s, n) => s + n, 0);

  console.log('=== §A. Current Lead.status distribution (global) ===');
  console.table(Object.entries(before).map(([status, cnt]) => ({ status, cnt })));
  console.log(`  total = ${beforeTotal}\n`);

  console.log('=== §B. Lost-lead breakdown by (lostReason × statusSource) ===');
  console.table(await lostReasonDistribution());

  console.log('\n=== §C. Lost-lead breakdown by platformStatus ===');
  console.table(await platformStatusDist());

  console.log('\n=== §D. Classifying every lost lead under the flip rule ===');
  const c = await classifyLostLeads();
  const keepTotal = Object.values(c.keepReasons).reduce((s, n) => s + n, 0);
  const flipTotal = Object.values(c.flipReasons).reduce((s, n) => s + n, 0);
  console.log(`  Total currently lost:  ${c.total}`);
  console.log(`  KEEP (true terminal):  ${keepTotal}`);
  console.table(c.keepReasons);
  console.log(`  FLIP (→ engaged + activity-bucket derived from TC): ${flipTotal}`);
  console.table(c.flipReasons);
  console.log('  Top flip causes:');
  console.table(
    Object.entries(c.sampleFlipCauses).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([cause, cnt]) => ({ cause, cnt }))
  );

  console.log('\n=== §E. Per-tenant impact (top 10 by flip volume) ===');
  console.table(
    Object.entries(c.perTenant)
      .map(([userId, v]) => ({ userId: userId.slice(0, 8), ...v }))
      .filter((r) => r.flip > 0 || r.keep > 0)
      .sort((a, b) => b.flip - a.flip).slice(0, 10)
  );

  console.log('\n=== §F. Active pool sub-bucket projection (derived live from ThreadContext) ===');
  console.log('     Mapping: src/conversation-context/activity-bucket.ts');
  const ap = await activePoolSubBuckets();
  console.table(
    Object.entries(ap.buckets).map(([bucket, cnt]) => ({ bucket, cnt }))
  );
  console.log(`  → Active total: ${Object.values(ap.buckets).reduce((s, n) => s + n, 0)} (DB Active pool: ${ap.total})`);
  console.log(`  Note: AFTER the PR 4 flip, the ${flipTotal} recoverable leads will be in this Active pool too.`);
  console.log(`        Their activity bucket comes from their existing TC state — no separate backfill needed.`);

  console.log('\n=== §G. Hire Rate methodology — HEADLINE (cumulative) vs DIAGNOSTIC (resolved) ===');
  const splitFor = (counts) => {
    let neu = 0, active = 0, scheduled = 0, done = 0, lost = 0, cancelled = 0;
    for (const [status, n] of Object.entries(counts)) {
      const l = (status || '').toLowerCase();
      if (l === 'new')                                                            neu       += n;
      else if (['engaged','contacted','quoted','in_progress'].includes(l))        active   += n;
      else if (['booked','scheduled'].includes(l))                                scheduled += n;
      else if (l === 'completed')                                                 done      += n;
      else if (['lost','no_show','archived'].includes(l))                         lost      += n;
      else if (l === 'cancelled')                                                 cancelled += n;
    }
    return { neu, active, scheduled, done, lost, cancelled };
  };
  const b = splitFor(before);
  const after = { ...before, engaged: (before.engaged ?? 0) + flipTotal, lost: (before.lost ?? 0) - flipTotal };
  const a = splitFor(after);
  const won           = b.scheduled + b.done;
  const recoverable   = flipTotal;
  const cumDenomBefore = won + b.lost + b.cancelled;
  const cumDenomAfter  = won + a.lost + a.cancelled + recoverable;
  const resolvedDenomBefore = won + b.lost + b.cancelled;
  const resolvedDenomAfter  = won + a.lost + a.cancelled;

  console.table([
    { metric: '★ HEADLINE — Cumulative Hire Rate',
      formula: 'won / (won + lost + cancelled + recoverable)',
      before: pctOf(won, cumDenomBefore), after: pctOf(won, cumDenomAfter),
      note: 'STABLE across migration ✓ (recoverable stays in denom)' },
    { metric: '  Resolved Hire Rate (diagnostic only)',
      formula: 'won / (won + true_lost + cancelled)',
      before: pctOf(won, resolvedDenomBefore), after: pctOf(won, resolvedDenomAfter),
      note: 'rises mechanically as Lost shrinks — NOT the headline' },
    { metric: '  Done Rate',
      formula: 'Done / (Done + true_lost + cancelled)',
      before: pctOf(b.done, b.done + b.lost + b.cancelled),
      after:  pctOf(a.done, a.done + a.lost + a.cancelled),
      note: '' },
    { metric: '  Active Rate',
      formula: '(new + engaged) / total',
      before: pctOf(b.neu + b.active, beforeTotal),
      after:  pctOf(a.neu + a.active, beforeTotal),
      note: '' },
  ]);

  console.log(`\n  Cumulative denominator: ${cumDenomBefore} (before) ${cumDenomBefore === cumDenomAfter ? '===' : '!=='} ${cumDenomAfter} (after)  ` +
    (cumDenomBefore === cumDenomAfter ? '✓ CONSERVED' : '✗ DRIFT — bug'));
  console.log(`  Headline Hire Rate cannot shift from re-categorization alone; only real new wins/losses move it.`);

  console.log('\n=== §H. Sanity checks ===');
  console.log(`  Conservation: before total ${beforeTotal} === after total ${Object.values(after).reduce((s,n)=>s+n,0)} ` +
    (beforeTotal === Object.values(after).reduce((s,n)=>s+n,0) ? '✓' : '✗'));
  console.log(`  Lost reduction:   ${before.lost ?? 0} → ${after.lost}  (Δ = -${flipTotal})`);
  console.log(`  Engaged increase: ${before.engaged ?? 0} → ${after.engaged}  (Δ = +${flipTotal})`);

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  Report complete. NO writes performed. Review numbers before PR 3.');
  console.log('══════════════════════════════════════════════════════════════════');

  await p.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
