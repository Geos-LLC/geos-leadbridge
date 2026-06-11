/**
 * Historical Reactivation — per-batch verification report.
 *
 * Run after each --immediate batch to verify against the activation
 * plan's success criteria and stop conditions:
 *
 *   Stop conditions (any one trips → halt further batches):
 *     - delivery failure rate > 15%
 *     - opt-out rate > 5%
 *     - unexpected Lead.status writes (≥1 historical_reactivation lead
 *       not in 'engaged' anymore, modulo opt_out which is allowed)
 *     - SF-linked lead receives activation
 *     - duplicate sends detected
 *     - scheduler backlog reappears (active enrollments with
 *       nextStepDueAt > 5 min in the past and no recent step execution)
 *
 *   Healthy batch (proceed to next batch):
 *     - ≥85% delivered
 *     - no duplicate sends
 *     - no SF drift
 *     - no unexpected Lead.status changes
 *     - no scheduler starvation
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL npx ts-node \
 *     scripts/historical-reactivation-batch-report.ts \
 *     --since=2026-06-10T22:00:00Z \
 *     --user-id=<uuid> --platform=thumbtack \
 *     --expected=20
 */

import { PrismaClient } from '../generated/prisma';

interface CliArgs {
  since: string;
  userId: string;
  platform: string | null;
  expected: number;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { since: '', userId: '', platform: null, expected: 20 };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--since=')) a.since = arg.slice('--since='.length);
    else if (arg.startsWith('--user-id=')) a.userId = arg.slice('--user-id='.length);
    else if (arg.startsWith('--platform=')) a.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--expected=')) a.expected = parseInt(arg.slice('--expected='.length), 10);
  }
  if (!a.since || !a.userId) {
    throw new Error('--since and --user-id are required');
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const since = new Date(args.since);
  if (Number.isNaN(since.getTime())) throw new Error(`Invalid --since: ${args.since}`);

  console.log('================================================================');
  console.log('  Historical Reactivation — Batch Report');
  console.log(`  Window: since ${since.toISOString()} (now ${new Date().toISOString()})`);
  console.log(`  Scope: userId=${args.userId} platform=${args.platform ?? 'all'}`);
  console.log(`  Expected: ${args.expected}`);
  console.log('================================================================\n');

  const leadWhere: any = { userId: args.userId };
  if (args.platform) leadWhere.platform = args.platform;

  // ── 1. Batch enrollments ──
  // Anything created since the batch start time that has
  // modeReason='historical_reactivation' and is scoped to the user/platform.
  const batchEnrollments = await prisma.followUpEnrollment.findMany({
    where: {
      modeReason: 'historical_reactivation',
      createdAt: { gte: since },
      lead: leadWhere,
    },
    select: {
      id: true, status: true, stoppedReason: true, conversationId: true,
      leadId: true, createdAt: true, completedAt: true, platform: true,
      stepExecutions: { select: { status: true, executedAt: true } },
      lead: {
        select: {
          customerName: true, status: true, lostReason: true,
          sfJobId: true, sfCustomerId: true, syncStatus: true,
          customerPhone: true, customerPhoneSubstitute: true,
          refundedAt: true, budgetVoidedAt: true, chargeStateRaw: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  // Tallies
  const enrolled = batchEnrollments.length;
  let active = 0, completed = 0, stopped = 0, paused = 0, other = 0;
  let stepsSent = 0, stepsFailed = 0;
  let optOuts = 0, classifierStops = 0, deliveryFailures = 0, customerReplies = 0;
  for (const e of batchEnrollments) {
    if (e.status === 'active') active++;
    else if (e.status === 'completed') completed++;
    else if (e.status === 'stopped') stopped++;
    else if (e.status === 'paused') paused++;
    else other++;
    for (const s of e.stepExecutions) {
      if (s.status === 'sent') stepsSent++;
      else if (s.status === 'failed') stepsFailed++;
    }
    if (e.status !== 'stopped') continue;
    const r = (e.stoppedReason ?? '').toLowerCase();
    if (r === 'classifier_opt_out') { optOuts++; classifierStops++; }
    else if (r.startsWith('classifier_')) classifierStops++;
    else if (r === 'customer_replied') customerReplies++;
    if (r === 'no_thread_id' || r.startsWith('platform_thread_') || r === 'no_delivery_channel'
        || r === 'awaiting_human_response' || r === 'deferral_phrase' || r === 'thread_closed'
        || r === 'platform_send_failed' || r.startsWith('delivery_') || r.includes('delivery_fail')) {
      deliveryFailures++;
    }
  }

  // ── 2. Post-followup enrollments created (these come from the runtime hop) ──
  const postFollowups = await prisma.followUpEnrollment.findMany({
    where: {
      modeReason: 'post_historical_reactivation_followup',
      createdAt: { gte: since },
      lead: leadWhere,
    },
    select: { id: true, conversationId: true, leadId: true, nextStepDueAt: true },
  });
  const postFollowupConvs = new Set(postFollowups.map((p) => p.conversationId));

  // ── 3. Lead.status / SF drift ──
  let statusDriftCount = 0;
  let sfDriftCount = 0;
  const driftedLeads: Array<{ name: string; status: string; lostReason: string | null; sfJobId: string | null; sfCustomerId: string | null; syncStatus: string | null }> = [];
  for (const e of batchEnrollments) {
    if (!e.lead) continue;
    const expectedStatus = e.lead.lostReason === 'opt_out' ? 'lost' : 'engaged';
    if (e.lead.status !== expectedStatus) {
      statusDriftCount++;
      driftedLeads.push({
        name: e.lead.customerName ?? '(no name)',
        status: e.lead.status,
        lostReason: e.lead.lostReason,
        sfJobId: e.lead.sfJobId,
        sfCustomerId: e.lead.sfCustomerId,
        syncStatus: e.lead.syncStatus,
      });
    }
    if (e.lead.sfJobId || e.lead.sfCustomerId || e.lead.syncStatus === 'linked') {
      sfDriftCount++;
    }
  }

  // ── 4. Customer replies (messages received after enrollment per conversation) ──
  let repliesAfterEnroll = 0;
  for (const e of batchEnrollments) {
    const cnt = await prisma.message.count({
      where: { conversationId: e.conversationId, sender: 'customer', sentAt: { gt: e.createdAt } },
    });
    repliesAfterEnroll += cnt;
  }

  // ── 5. Duplicate-send detection ──
  // Count conversations with >1 step execution of status='sent' from THIS
  // batch's enrollments. Each conversation should have exactly 0 or 1.
  let duplicateSendConvs = 0;
  for (const e of batchEnrollments) {
    const sentCount = e.stepExecutions.filter((s) => s.status === 'sent').length;
    if (sentCount > 1) duplicateSendConvs++;
  }

  // ── 6. Scheduler backlog detection ──
  // Active enrollments scoped to the user/platform whose nextStepDueAt is
  // more than 5 minutes in the past. (Active here = any modeReason, since
  // scheduler starvation would affect everyone.)
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
  const stuckActive = await prisma.followUpEnrollment.count({
    where: {
      status: 'active',
      nextStepDueAt: { lt: fiveMinAgo },
      lead: leadWhere,
    },
  });

  // ── 7. Rates ──
  const denomTried = Math.max(1, enrolled);
  const deliveryFailureRate = (deliveryFailures + stepsFailed) / denomTried;
  const optOutRate = optOuts / denomTried;
  const deliveredRate = stepsSent / denomTried;

  console.log('=== Batch report ===');
  console.log(`  enrolled:                          ${enrolled}`);
  console.log(`  sent (step executions):            ${stepsSent}`);
  console.log(`  delivered (= sent for one-shot):   ${stepsSent}`);
  console.log(`  failed (step executions):          ${stepsFailed}`);
  console.log(`  customer replies (post-enroll):    ${repliesAfterEnroll}`);
  console.log(`  opt-outs:                          ${optOuts}`);
  console.log(`  classifier stops:                  ${classifierStops}`);
  console.log(`  delivery failures (stop reason):   ${deliveryFailures}`);
  console.log(`  active post-followup enrollments:  ${postFollowups.length}`);
  console.log(`  Lead.status drift:                 ${statusDriftCount}`);
  console.log(`  SF drift:                          ${sfDriftCount}`);

  console.log('\n=== Enrollment status ===');
  console.log(`  active:     ${active}`);
  console.log(`  completed:  ${completed}`);
  console.log(`  stopped:    ${stopped}`);
  console.log(`  paused:     ${paused}`);

  console.log('\n=== Rates (denom = enrolled) ===');
  console.log(`  delivered rate:        ${(deliveredRate * 100).toFixed(1)}%   (target ≥85%)`);
  console.log(`  delivery failure rate: ${(deliveryFailureRate * 100).toFixed(1)}%   (stop > 15%)`);
  console.log(`  opt-out rate:          ${(optOutRate * 100).toFixed(1)}%   (stop > 5%)`);

  // ── 8. Stop conditions ──
  const stopReasons: string[] = [];
  if (enrolled === 0) {
    stopReasons.push('no enrollments in window — script may not have applied');
  }
  if (deliveryFailureRate > 0.15) {
    stopReasons.push(`delivery failure rate ${(deliveryFailureRate * 100).toFixed(1)}% > 15%`);
  }
  if (optOutRate > 0.05) {
    stopReasons.push(`opt-out rate ${(optOutRate * 100).toFixed(1)}% > 5%`);
  }
  if (statusDriftCount > 0) {
    stopReasons.push(`${statusDriftCount} unexpected Lead.status writes`);
  }
  if (sfDriftCount > 0) {
    stopReasons.push(`${sfDriftCount} SF-linked leads got enrolled`);
  }
  if (duplicateSendConvs > 0) {
    stopReasons.push(`${duplicateSendConvs} conversations had >1 sent step (duplicate sends)`);
  }
  if (stuckActive > 0) {
    stopReasons.push(`${stuckActive} active enrollments stuck >5min past nextStepDueAt (scheduler backlog)`);
  }

  console.log('\n=== Stop conditions ===');
  if (stopReasons.length === 0) {
    console.log('  ✓ NONE TRIPPED');
  } else {
    console.log('  ✗ STOP — do not run next batch:');
    for (const r of stopReasons) console.log(`     - ${r}`);
  }

  // ── 9. Success criteria ──
  // Batch is healthy enough to proceed if delivered rate >= 85%, no
  // duplicates, no SF drift, no status drift, no scheduler starvation.
  // Note: the activation plan says "delivery failure rate" stop fires at
  // >15% which is the harder gate; ≥85% delivered is the affirmative
  // signal. Both must agree.
  const healthy = deliveredRate >= 0.85
    && duplicateSendConvs === 0
    && sfDriftCount === 0
    && statusDriftCount === 0
    && stuckActive === 0
    && enrolled > 0;

  console.log('\n=== Verdict ===');
  if (healthy && stopReasons.length === 0) {
    console.log('  ✓ HEALTHY — proceed to next batch.');
  } else if (stopReasons.length > 0) {
    console.log('  ✗ HALT — stop conditions tripped (see above).');
  } else {
    console.log('  ⚠ WAIT — observation window may be too short; re-run after another 10 min.');
    console.log(`    delivered rate ${(deliveredRate * 100).toFixed(1)}% (need ≥85%), active still pending=${active}`);
  }

  // ── Skipped / refunded leads (visibility for operator + tenant) ──
  // These are leads from this batch the system couldn't deliver to. Each
  // row shows reason + phone (so the operator can re-engage out-of-band)
  // + chargeStateRaw (so refunds vs other unreachable cases are clear).
  // The auto-stop path that produces these rows lives in the scheduler:
  //   follow-up-scheduler.service.ts → classifyPlatformUnreachable +
  //   the `err.message?.includes('status code 404')` branch.
  type SkipRow = {
    name: string;
    platform: string;
    reason: string;
    phone: string;
    refunded: boolean;
    chargeState: string | null;
    enrollmentId: string;
  };
  const skipReasons = new Set([
    'platform_thread_unreachable',
    'platform_lead_removed_refunded',
    'platform_thread_closed',
    'platform_thread_archived',
    'lead_archived',
    'no_thread_id',
    'no_delivery_channel',
    'awaiting_human_response',
    'deferral_phrase',
    'thread_closed',
    'platform_send_failed',
    'smoke_v2_delivery_failed_retry_loop',
  ]);
  const skipped: SkipRow[] = [];
  const refunded: SkipRow[] = [];
  for (const e of batchEnrollments) {
    if (e.status !== 'stopped') continue;
    const r = (e.stoppedReason ?? '').toLowerCase();
    const isSkipBucket = skipReasons.has(r) || r.startsWith('delivery_') || r.includes('delivery_fail');
    if (!isSkipBucket) continue;
    const row: SkipRow = {
      name: e.lead?.customerName ?? '(no name)',
      platform: e.platform ?? '?',
      reason: e.stoppedReason ?? 'unknown',
      phone: e.lead?.customerPhone ?? e.lead?.customerPhoneSubstitute ?? '(no phone)',
      refunded: !!e.lead?.refundedAt,
      chargeState: e.lead?.chargeStateRaw ?? null,
      enrollmentId: e.id,
    };
    skipped.push(row);
    if (row.refunded || r === 'platform_lead_removed_refunded') refunded.push(row);
  }

  console.log('\n=== Skipped leads (this batch) ===');
  if (skipped.length === 0) {
    console.log('  none — every batch enrollment got a delivery attempt');
  } else {
    console.log(`  ${skipped.length} of ${enrolled} batch enrollments were skipped:`);
    const byReason: Record<string, SkipRow[]> = {};
    for (const s of skipped) (byReason[s.reason] = byReason[s.reason] ?? []).push(s);
    for (const [reason, rows] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n  [${rows.length}] ${reason}`);
      for (const r of rows) {
        console.log(`    - ${r.name.padEnd(24)} platform=${r.platform.padEnd(9)} phone=${r.phone.padEnd(16)} chargeState=${r.chargeState ?? '-'} enroll=${r.enrollmentId}`);
      }
    }
    console.log('\n  Phone numbers are preserved on the Lead row — operator can re-engage out-of-band.');
    console.log('  Lead.status / SF link are NOT modified by the skip — those rows remain queryable.');
  }

  console.log('\n=== Refunded leads (this batch) ===');
  if (refunded.length === 0) {
    console.log('  none refunded — no Lead.refundedAt / budgetVoidedAt writes from this batch');
  } else {
    console.log(`  ${refunded.length} of ${enrolled} batch enrollments had their lead marked refunded:`);
    for (const r of refunded) {
      console.log(`    - ${r.name.padEnd(24)} platform=${r.platform.padEnd(9)} chargeState=${r.chargeState ?? '-'}`);
      console.log(`      Lead.refundedAt + Lead.budgetVoidedAt set; analytics will exclude this lead's cost.`);
    }
  }

  if (driftedLeads.length > 0) {
    console.log('\n=== Drifted leads (Lead.status changed unexpectedly) ===');
    for (const d of driftedLeads.slice(0, 10)) {
      console.log(`  ${d.name.padEnd(24)} status=${d.status} lostReason=${d.lostReason} sf=${d.sfJobId ?? d.sfCustomerId ?? d.syncStatus ?? 'null'}`);
    }
  }

  // Machine-readable suffix for the autonomous loop to consume.
  console.log('\nREPORT_JSON=' + JSON.stringify({
    enrolled, stepsSent, stepsFailed, repliesAfterEnroll, optOuts, classifierStops,
    deliveryFailures, postFollowups: postFollowups.length, statusDriftCount, sfDriftCount,
    duplicateSendConvs, stuckActive, deliveredRate, deliveryFailureRate, optOutRate,
    skippedCount: skipped.length,
    refundedCount: refunded.length,
    healthy: healthy && stopReasons.length === 0,
    halt: stopReasons.length > 0,
    stopReasons,
    active, completed, stopped,
  }));

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
