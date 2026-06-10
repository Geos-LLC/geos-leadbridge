/**
 * Historical Marketplace Lead Reactivation — operator-triggered activation.
 *
 * Identifies historical recovery leads, schedules them into batched 30-min
 * slots within account business hours, and (when --apply) enrolls them in
 * the dedicated "Historical Lead Reactivation" sequence via
 * `FollowUpEngineService.enrollAsHistoricalReactivation()`.
 *
 * Hard constraints (mirror the business rule):
 *   - No Lead.status writes
 *   - No SF / LB integration writes
 *   - No customer message sends from this script
 *   - Default mode is DRY-RUN; --apply required for any DB write
 *   - Never invoked from a cron / event handler / startup hook
 *
 * Pacing rule:
 *   - 20 leads per 30-minute slot (configurable via --batch-size)
 *   - Working hours only (defaults 09:00–18:00 in the account timezone)
 *   - Oldest customer activity first (365+ → 0–30d buckets)
 *   - Intra-batch stagger: 90s between leads (20 × 90s = 30 min slot)
 *
 * Usage:
 *   # Dry-run, default cohort (PR4 only), no writes
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/historical-reactivation-activate.ts
 *
 *   # Apply (writes enrollment rows; no message sends)
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/historical-reactivation-activate.ts --apply
 *
 *   # Scope to a single user/business (for sanity testing)
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/historical-reactivation-activate.ts \
 *     --user-id=<uuid> --business-id=<id>
 *
 * Optional flags:
 *   --apply                     Actually write (default: dry-run)
 *   --user-id=<uuid>            Scope to one user (default: all PR4 users)
 *   --business-id=<id>          Scope to one business
 *   --batch-size=20             Leads per 30-min slot (default 20)
 *   --slot-minutes=30           Minutes per batch slot (default 30)
 *   --start-hour=9              Local-hour start of working hours (default 9)
 *   --end-hour=18               Local-hour end of working hours (default 18)
 *   --start-after=YYYY-MM-DD    First eligible date for slot scheduling
 *                                (default: tomorrow in the account timezone)
 *   --max-leads=N               Cap how many leads to enroll this run
 *                                (deprecated alias of --limit)
 *   --limit=N                   Max leads to enroll this run
 *   --offset=N                  Skip first N rows of the eligible queue
 *                                (after standard exclusions). Used for
 *                                successive operator-paced batches:
 *                                  --limit=20            → first 20
 *                                  --limit=20 --offset=20 → next 20
 *                                  --limit=50 --offset=40 → next 50
 *                                  --limit=100 --offset=90 → next 100
 *                                  --offset=190           → remainder
 *                                Note: already-enrolled leads are filtered
 *                                automatically via `already_active_enrollment`,
 *                                so re-runs without offset would also work —
 *                                offset is for deterministic windowing.
 *   --include-non-pr4           Allow non-PR4 historical recovery matches
 *                                (Clause B: marketplace terminal outcomes)
 *
 * Post-run report (printed automatically after dry-run or apply):
 *   - enrolled this run / SF skips this run
 *   - cumulative cohort counters (sent / failed / completed / stopped /
 *     delivery failures / classifier stops / opt-outs) across ALL prior
 *     historical_reactivation enrollments in the same user/platform scope.
 *   Lets the operator review between successive --apply runs without
 *   manual Loki queries.
 */

import { PrismaClient } from '../generated/prisma';
import {
  isHistoricalMarketplaceRecovery,
  getReactivationDeliveryBlocker,
  HISTORICAL_RECOVERY_DISPLAY_LABEL,
  HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE,
} from '../src/leads/historical-recovery';

interface CliArgs {
  apply: boolean;
  userId: string | null;
  businessId: string | null;
  platform: string | null;
  batchSize: number;
  slotMinutes: number;
  startHour: number;
  endHour: number;
  startAfter: string | null;
  maxLeads: number | null;
  limit: number | null;
  offset: number;
  includeNonPr4: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = {
    apply: false, userId: null, businessId: null, platform: null,
    batchSize: 20, slotMinutes: 30, startHour: 9, endHour: 18,
    startAfter: null, maxLeads: null, limit: null, offset: 0, includeNonPr4: false,
  };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') a.apply = true;
    else if (arg === '--include-non-pr4') a.includeNonPr4 = true;
    else if (arg.startsWith('--user-id=')) a.userId = arg.slice('--user-id='.length);
    else if (arg.startsWith('--business-id=')) a.businessId = arg.slice('--business-id='.length);
    else if (arg.startsWith('--platform=')) a.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--batch-size=')) a.batchSize = parseInt(arg.slice('--batch-size='.length), 10);
    else if (arg.startsWith('--slot-minutes=')) a.slotMinutes = parseInt(arg.slice('--slot-minutes='.length), 10);
    else if (arg.startsWith('--start-hour=')) a.startHour = parseInt(arg.slice('--start-hour='.length), 10);
    else if (arg.startsWith('--end-hour=')) a.endHour = parseInt(arg.slice('--end-hour='.length), 10);
    else if (arg.startsWith('--start-after=')) a.startAfter = arg.slice('--start-after='.length);
    else if (arg.startsWith('--max-leads=')) a.maxLeads = parseInt(arg.slice('--max-leads='.length), 10);
    else if (arg.startsWith('--limit=')) a.limit = parseInt(arg.slice('--limit='.length), 10);
    else if (arg.startsWith('--offset=')) a.offset = parseInt(arg.slice('--offset='.length), 10);
  }
  return a;
}

// Deferral-phrase filter mirrors `evaluateThread`'s skip rule. Operator
// activation must respect it — historical leads with a deferral signal
// should not be re-engaged via the standard sequence.
const DEFERRAL_PHRASES = [
  'get back to you', 'let me think', 'let me check', 'let me look',
  'check with my husband', 'check with my wife', 'check with my partner',
  'check with my spouse', 'check with the boss', 'shopping around',
  'comparing quotes', 'need to check', 'need to ask',
];
function deferralMatch(content: string | null | undefined): string | null {
  if (!content) return null;
  const m = content.toLowerCase();
  return DEFERRAL_PHRASES.find((p) => m.includes(p)) ?? null;
}

// Compute the Nth business-hour slot starting from `seed`, advancing to the
// next business day when the previous day's slots are exhausted. All math
// in the account's timezone (default 'America/New_York').
function computeSlotTime(
  seed: Date,
  slotIndex: number,
  slotMinutes: number,
  startHour: number,
  endHour: number,
  timezone: string,
): Date {
  const slotsPerDay = Math.floor(((endHour - startHour) * 60) / slotMinutes);
  if (slotsPerDay <= 0) throw new Error(`Invalid working window: ${startHour}-${endHour}`);

  const dayIndex = Math.floor(slotIndex / slotsPerDay);
  const slotInDay = slotIndex % slotsPerDay;
  const minutesIntoDay = startHour * 60 + slotInDay * slotMinutes;

  // Get the calendar date (Y-M-D in the target TZ) for `seed + dayIndex days`.
  const dayDate = new Date(seed.getTime() + dayIndex * 24 * 60 * 60 * 1000);
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(dayDate);
  const [y, mo, d] = ymd.split('-').map((s) => parseInt(s, 10));

  // To convert "local 00:00 on YMD in `timezone`" to a UTC timestamp, we
  // measure the timezone offset by formatting the naive UTC midnight in
  // `timezone` and comparing it to itself. `sv-SE` formats as ISO-like
  // "YYYY-MM-DD HH:mm:ss" which we parse as if it were UTC; the delta
  // between that parsed instant and the original naive Date is the offset
  // in minutes that the timezone is ahead of UTC (negative for west).
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const localStr = new Intl.DateTimeFormat('sv-SE', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(naive)).replace(' ', 'T');
  const localAsUtc = Date.parse(localStr + 'Z');
  const offsetMs = localAsUtc - naive; // negative for west-of-UTC zones
  // Local midnight on YMD as a UTC timestamp = naive - offsetMs.
  const localMidnightUtc = naive - offsetMs;
  return new Date(localMidnightUtc + minutesIntoDay * 60_000);
}

async function main() {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const now = new Date();

  console.log('================================================================');
  console.log(`  ${HISTORICAL_RECOVERY_DISPLAY_LABEL} — Activation Script`);
  console.log(`  Mode: ${args.apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`  Ref time: ${now.toISOString()}`);
  console.log('================================================================\n');

  // ── 1. Identify candidate leads ──
  // PR 4 statusSource is the primary route; --include-non-pr4 widens to the
  // Clause B match (marketplace terminal outcome on a non-disqualified lead).
  const baseWhere: any = args.userId ? { userId: args.userId } : {};
  if (args.businessId) baseWhere.businessId = args.businessId;
  if (args.platform) baseWhere.platform = args.platform;
  if (!args.includeNonPr4) baseWhere.statusSource = 'backfill_pr4_v1';

  const leads = await prisma.lead.findMany({
    where: baseWhere,
    select: {
      id: true, threadId: true, customerName: true, businessId: true, userId: true,
      status: true, lostReason: true, statusSource: true, platform: true,
      thumbtackStatus: true, platformStatus: true,
      // Delivery-filter inputs — phone presence drives the no_delivery_channel
      // skip (Gail Counter case: smoke v2 sent 2 of 3, the 3rd looped on TT
      // 404s because no phone + a closed-on-TT thread).
      customerPhone: true, customerPhoneSubstitute: true,
      sfJobId: true, sfCustomerId: true, syncStatus: true,
    },
  });
  console.log(`Candidate pool (statusSource filter applied): ${leads.length}`);

  // Apply the predicate (handles disqualifiers + the Clause A/B match).
  const matchedByPredicate = leads.filter((l) => isHistoricalMarketplaceRecovery(l));
  console.log(`Match predicate isHistoricalMarketplaceRecovery: ${matchedByPredicate.length}`);

  // ── 2. Hard skips before scheduling ──
  const threadIds = matchedByPredicate.map((l) => l.threadId).filter(Boolean) as string[];
  const convSet = new Set(
    (await prisma.conversation.findMany({ where: { id: { in: threadIds } }, select: { id: true } })).map((c) => c.id),
  );
  const activeEnrollSet = new Set(
    (await prisma.followUpEnrollment.findMany({
      where: { conversationId: { in: threadIds }, status: 'active' }, select: { conversationId: true },
    })).map((e) => e.conversationId),
  );
  const lastCustomerMap = new Map<string, { content: string | null; sentAt: Date }>();
  for (const m of await prisma.message.findMany({
    where: { conversationId: { in: threadIds }, sender: 'customer' },
    select: { conversationId: true, content: true, sentAt: true },
    orderBy: { sentAt: 'desc' },
  })) {
    if (!lastCustomerMap.has(m.conversationId)) lastCustomerMap.set(m.conversationId, m);
  }
  // ThreadContext.conversationState — for awaiting_human_response detection.
  const tcStateMap = new Map<string, string | null>();
  for (const t of await prisma.threadContext.findMany({
    where: { conversationId: { in: threadIds } },
    select: { conversationId: true, conversationState: true },
  })) {
    tcStateMap.set(t.conversationId, t.conversationState);
  }

  const eligible: typeof matchedByPredicate = [];
  const excluded: Record<string, typeof matchedByPredicate> = {};
  function exclude(bucket: string, lead: typeof matchedByPredicate[number]) {
    (excluded[bucket] = excluded[bucket] || []).push(lead);
  }
  for (const lead of matchedByPredicate) {
    if (!lead.threadId) { exclude('no_thread_id', lead); continue; }
    if (!convSet.has(lead.threadId)) { exclude('orphan_thread_id', lead); continue; }
    if (activeEnrollSet.has(lead.threadId)) { exclude('already_active_enrollment', lead); continue; }
    // Delivery filter — stable skip reasons from getReactivationDeliveryBlocker.
    const blocker = getReactivationDeliveryBlocker({
      threadId: lead.threadId,
      platform: lead.platform,
      customerPhone: lead.customerPhone,
      customerPhoneSubstitute: lead.customerPhoneSubstitute,
      thumbtackStatus: lead.thumbtackStatus,
      platformStatus: lead.platformStatus,
      conversationState: tcStateMap.get(lead.threadId) ?? null,
      lastCustomerMessageContent: lastCustomerMap.get(lead.threadId)?.content ?? null,
    });
    if (blocker) { exclude(blocker, lead); continue; }
    eligible.push(lead);
  }
  console.log(`After eligibility filters: ${eligible.length} eligible, ${Object.values(excluded).reduce((s, l) => s + l.length, 0)} excluded`);

  // ── 3. Order oldest-first by latest customer activity ──
  function recencyBucket(lead: typeof matchedByPredicate[number]): number {
    const last = lastCustomerMap.get(lead.threadId!);
    if (!last) return 6; // unknown → very last
    const ageDays = (now.getTime() - last.sentAt.getTime()) / 86400_000;
    if (ageDays >= 365) return 0;       // oldest first
    if (ageDays >= 180) return 1;
    if (ageDays >= 90)  return 2;
    if (ageDays >= 30)  return 3;
    return 4;                           // freshest last
  }
  eligible.sort((a, b) => {
    const ra = recencyBucket(a), rb = recencyBucket(b);
    if (ra !== rb) return ra - rb;
    // tie-break: oldest lastCustomer first
    const la = lastCustomerMap.get(a.threadId!)?.sentAt?.getTime() ?? 0;
    const lb = lastCustomerMap.get(b.threadId!)?.sentAt?.getTime() ?? 0;
    return la - lb;
  });

  // Slice the eligible queue with offset + limit. `--max-leads` is the
  // deprecated alias; `--limit` wins if both are passed.
  const offset = Math.max(0, args.offset);
  const limitN = args.limit ?? args.maxLeads ?? null;
  const sliceEnd = limitN !== null ? offset + limitN : eligible.length;
  const queue = eligible.slice(offset, sliceEnd);
  console.log(`\nQueue window: offset=${offset}, limit=${limitN ?? 'all'}, picked ${queue.length} of ${eligible.length} eligible`);

  // ── 4. Compute slot times ──
  const TZ = 'America/New_York';
  // Seed: --start-after if given, else tomorrow at midnight in TZ.
  const seedBase = args.startAfter
    ? new Date(args.startAfter + 'T00:00:00')
    : new Date(now.getTime() + 24 * 60 * 60 * 1000);

  const slotsPerDay = Math.floor(((args.endHour - args.startHour) * 60) / args.slotMinutes);
  const totalSlots = Math.ceil(queue.length / args.batchSize);
  const intraBatchStaggerSec = Math.floor((args.slotMinutes * 60) / args.batchSize);

  console.log('\n=== Activation schedule ===');
  console.log(`  Working hours: ${args.startHour}:00–${args.endHour}:00 ${TZ}`);
  console.log(`  Batch size: ${args.batchSize} leads / ${args.slotMinutes}-min slot`);
  console.log(`  Slots per day: ${slotsPerDay}  (= ${slotsPerDay * args.batchSize} leads/day capacity)`);
  console.log(`  Total slots needed: ${totalSlots}`);
  console.log(`  Estimated days to complete: ${Math.ceil(totalSlots / slotsPerDay)}`);
  console.log(`  Intra-batch stagger: ${intraBatchStaggerSec}s between leads`);

  type Plan = {
    lead: typeof eligible[number];
    scheduledAt: Date;
    slotIndex: number;
    recencyDays: number | null;
  };
  const plans: Plan[] = queue.map((lead, idx) => {
    const slotIndex = Math.floor(idx / args.batchSize);
    const indexInSlot = idx % args.batchSize;
    const slotStart = computeSlotTime(seedBase, slotIndex, args.slotMinutes, args.startHour, args.endHour, TZ);
    const scheduledAt = new Date(slotStart.getTime() + indexInSlot * intraBatchStaggerSec * 1000);
    const last = lastCustomerMap.get(lead.threadId!);
    const recencyDays = last ? Math.round((now.getTime() - last.sentAt.getTime()) / 86400_000) : null;
    return { lead, scheduledAt, slotIndex, recencyDays };
  });

  // ── 5. Report ──
  console.log('\n=== Excluded buckets ===');
  for (const [k, list] of Object.entries(excluded).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${String(list.length).padStart(4)}  ${k}`);
    for (const l of list.slice(0, 2)) console.log(`         e.g. ${l.id} ${l.customerName}`);
  }

  console.log('\n=== Recency distribution (eligible queue) ===');
  const recDist: Record<string, number> = {};
  for (const p of plans) {
    const key = p.recencyDays === null
      ? 'unknown'
      : p.recencyDays >= 365 ? '365+d'
      : p.recencyDays >= 180 ? '180-365d'
      : p.recencyDays >= 90  ? '90-180d'
      : p.recencyDays >= 30  ? '30-90d'
      : '0-30d';
    recDist[key] = (recDist[key] || 0) + 1;
  }
  for (const [k, v] of Object.entries(recDist)) console.log(`  ${k.padEnd(10)} ${v}`);

  console.log('\n=== First 10 planned enrollments ===');
  for (const p of plans.slice(0, 10)) {
    console.log(`  ${p.lead.id} ${p.lead.customerName.padEnd(26)} recency=${p.recencyDays ?? '?'}d slot=${p.slotIndex} scheduledAt=${p.scheduledAt.toISOString()}`);
  }

  console.log('\n=== Last 10 planned enrollments ===');
  for (const p of plans.slice(-10)) {
    console.log(`  ${p.lead.id} ${p.lead.customerName.padEnd(26)} recency=${p.recencyDays ?? '?'}d slot=${p.slotIndex} scheduledAt=${p.scheduledAt.toISOString()}`);
  }

  if (plans.length > 0) {
    const earliest = plans[0].scheduledAt.toISOString();
    const latest = plans[plans.length - 1].scheduledAt.toISOString();
    console.log(`\n=== Schedule summary ===`);
    console.log(`  Earliest scheduledAt: ${earliest}`);
    console.log(`  Latest scheduledAt:   ${latest}`);
    console.log(`  Template used:        ${HISTORICAL_RECOVERY_DISPLAY_LABEL}`);
    console.log(`  Internal trigger:     ${HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE}`);
    console.log(`  Standard templates:   0 used (correct routing)`);
  }

  // ── 6. APPLY (or no-op for dry-run) ──
  if (!args.apply) {
    console.log('\n[DRY-RUN] No writes performed. Re-run with --apply to enroll.');
    console.log('  Reminder: --apply creates FollowUpEnrollment rows but does NOT send messages.');
    console.log('  The scheduler service fires messages from the rows at their nextStepDueAt.');
    await printCohortReport(prisma, { userId: args.userId, platform: args.platform }, 0, 0);
    await prisma.$disconnect();
    return;
  }

  console.log('\n=== APPLYING — writing FollowUpEnrollment rows ===');
  // NOTE: this script does NOT bootstrap the NestJS app. We replicate the
  // engine's enrollAsHistoricalReactivation logic inline via Prisma calls
  // to keep the script self-contained. The source-of-truth method
  // (`FollowUpEngineService.enrollAsHistoricalReactivation`) is what
  // production paths should call; the inline replica here matches its
  // semantics one-for-one (SF-link guard, active-enrollment pre-check,
  // template lookup, transactional insert + ThreadContext update).
  let wrote = 0; let skippedSf = 0; let skippedExisting = 0; let errors = 0;
  for (const plan of plans) {
    const lead = plan.lead;
    // SF-link guard (re-check at write time — could have changed since the
    // scheduling pass).
    if (lead.sfJobId || lead.sfCustomerId || lead.syncStatus === 'linked') {
      skippedSf++;
      continue;
    }
    const existing = await prisma.followUpEnrollment.findFirst({
      where: { conversationId: lead.threadId!, status: 'active' },
      select: { id: true },
    });
    if (existing) { skippedExisting++; continue; }
    const template = await prisma.followUpSequenceTemplate.findFirst({
      where: {
        userId: lead.userId, platform: lead.platform,
        triggerState: HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE,
        enabled: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, mode: true },
    });
    if (!template) { errors++; console.error(`  no template for user=${lead.userId} platform=${lead.platform}`); continue; }
    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.followUpEnrollment.create({
          data: {
            sequenceTemplateId: template.id,
            conversationId: lead.threadId!,
            leadId: lead.id,
            platform: lead.platform,
            status: 'active',
            currentStepIndex: 0,
            nextStepDueAt: plan.scheduledAt,
            mode: template.mode || 'auto_send',
            followUpMode: 'short_term',
            modeReason: 'historical_reactivation',
          },
          select: { id: true },
        });
        await tx.threadContext.updateMany({
          where: { conversationId: lead.threadId! },
          data: {
            activeEnrollmentId: created.id,
            nextFollowUpAt: plan.scheduledAt,
            followUpStatus: 'active',
          },
        });
      });
      wrote++;
      if (wrote % 50 === 0) process.stdout.write(`\r  wrote ${wrote}/${plans.length}`);
    } catch (err: any) {
      errors++;
      console.error(`\n  enroll failed lead=${lead.id}: ${err.message}`);
    }
  }
  console.log(`\n  APPLY summary: wrote=${wrote}  skipped_sf=${skippedSf}  skipped_existing=${skippedExisting}  errors=${errors}`);

  await printCohortReport(prisma, { userId: args.userId, platform: args.platform }, wrote, skippedSf);
  await prisma.$disconnect();
}

/**
 * Post-run cohort report.
 *
 * Operator runs the script iteratively (20 → review → 20 → review → …)
 * and needs to know after each batch:
 *   - what this run wrote (enrolled / SF-skipped),
 *   - what the cumulative health of the cohort looks like across ALL
 *     prior historical_reactivation enrollments in the same scope.
 *
 * The cumulative counters are joined to FollowUpStepExecution for delivery
 * status (sent/failed step counts) and bucketed by `stoppedReason` for
 * delivery-vs-classifier-vs-opt-out attribution. No external log dive needed.
 *
 * Scope is the same user/platform the script was run against — so a Spotless
 * TT operator sees Spotless TT cohort health, not other tenants'.
 */
async function printCohortReport(
  prisma: PrismaClient,
  scope: { userId: string | null; platform: string | null },
  thisRunEnrolled: number,
  thisRunSfSkipped: number,
): Promise<void> {
  const leadWhere: any = {};
  if (scope.userId) leadWhere.userId = scope.userId;
  if (scope.platform) leadWhere.platform = scope.platform;

  const enrollments = await prisma.followUpEnrollment.findMany({
    where: {
      modeReason: 'historical_reactivation',
      ...(Object.keys(leadWhere).length ? { lead: leadWhere } : {}),
    },
    select: {
      id: true,
      status: true,
      stoppedReason: true,
      stepExecutions: { select: { status: true } },
    },
  });

  // Enrollment status tallies.
  let active = 0, completed = 0, stopped = 0, paused = 0, other = 0;
  // Step-execution tallies — counts attempts, not enrollments.
  let stepsSent = 0, stepsFailed = 0;
  // Stop-reason buckets — only count when status='stopped' so we don't
  // double-count active rows that previously had a transient reason.
  let deliveryFailures = 0;
  let classifierStops = 0;
  let optOuts = 0;
  let customerReplies = 0;
  let leadStatusStops = 0;
  let sfStatusStops = 0;
  let otherStops = 0;

  // Delivery-blocker strings the runtime + script share (kept in sync with
  // `ReactivationDeliveryBlocker` in src/leads/historical-recovery.ts) plus
  // a few send-time delivery reasons the scheduler may write.
  const DELIVERY_BLOCKER_REASONS = new Set([
    'no_thread_id',
    'platform_thread_closed',
    'platform_thread_archived',
    'no_delivery_channel',
    'awaiting_human_response',
    'deferral_phrase',
    'thread_closed',
    'platform_send_failed',
    'delivery_failed',
  ]);

  for (const e of enrollments) {
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
    // Delivery bucket catches the canonical blocker strings + the substring
    // 'delivery_fail' so ad-hoc operator labels (e.g.
    // 'smoke_v2_delivery_failed_retry_loop') still classify correctly.
    if (DELIVERY_BLOCKER_REASONS.has(r) || r.startsWith('delivery_') || r.includes('delivery_fail')) {
      deliveryFailures++;
    } else if (r === 'classifier_opt_out') {
      // Opt-out is a classifier stop, but it's also the most important
      // single category for operator review — show it on its own line.
      optOuts++;
      classifierStops++;
    } else if (r.startsWith('classifier_')) {
      classifierStops++;
    } else if (r === 'customer_replied') {
      customerReplies++;
    } else if (r.startsWith('lead_status_')) {
      leadStatusStops++;
    } else if (r.startsWith('sf_status_')) {
      sfStatusStops++;
    } else {
      otherStops++;
    }
  }

  console.log('\n================================================================');
  console.log('  Cohort report — historical_reactivation enrollments in scope');
  if (scope.userId) console.log(`  Scope: userId=${scope.userId} platform=${scope.platform ?? 'all'}`);
  else console.log('  Scope: ALL users (no --user-id filter)');
  console.log('================================================================');

  console.log('\n=== This run ===');
  console.log(`  enrolled:      ${thisRunEnrolled}`);
  console.log(`  SF skips:      ${thisRunSfSkipped}`);

  console.log('\n=== Cumulative enrollment status ===');
  console.log(`  active:        ${active}`);
  console.log(`  completed:     ${completed}`);
  console.log(`  stopped:       ${stopped}`);
  console.log(`  paused:        ${paused}`);
  if (other > 0) console.log(`  other:         ${other}`);
  console.log(`  TOTAL:         ${enrollments.length}`);

  console.log('\n=== Delivery (step executions) ===');
  console.log(`  sent:          ${stepsSent}`);
  console.log(`  failed:        ${stepsFailed}`);

  console.log('\n=== Stop reasons ===');
  console.log(`  delivery failures: ${deliveryFailures}`);
  console.log(`  classifier stops:  ${classifierStops}`);
  console.log(`  opt-outs:          ${optOuts}   (subset of classifier stops)`);
  console.log(`  customer replies:  ${customerReplies}`);
  console.log(`  lead-status stops: ${leadStatusStops}`);
  console.log(`  sf-status stops:   ${sfStatusStops}`);
  if (otherStops > 0) console.log(`  other:             ${otherStops}`);

  console.log('\n=== Operator review hints ===');
  if (stepsFailed > stepsSent && stepsFailed >= 5) {
    console.log(`  WARN: failed >= sent (${stepsFailed} failed vs ${stepsSent} sent) — pause before next batch.`);
  }
  if (deliveryFailures >= 3 && deliveryFailures >= Math.max(1, stopped * 0.2)) {
    console.log(`  WARN: ${deliveryFailures} delivery-blocker stops — investigate before widening cohort.`);
  }
  if (active > 0) {
    console.log(`  ${active} enrollments still scheduled — let them play out before the next batch.`);
  }
  if (stepsSent === 0 && active > 0) {
    console.log(`  No sends yet — first send fires at the earliest scheduledAt above.`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
