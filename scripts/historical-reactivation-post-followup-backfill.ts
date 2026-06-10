/**
 * Historical Reactivation — post-followup backfill (Patrea fix).
 *
 * Before the post-send lifecycle hop landed (engine commit
 * `createPostHistoricalReactivationFollowup`), historical_reactivation
 * enrollments that one-shot-sent successfully were marked completed and
 * the lead dropped off the follow-up radar entirely. This script
 * back-creates the missing `post_historical_reactivation_followup`
 * enrollment for each already-smoked lead.
 *
 * Selection rules (mirrors the new send-time hop):
 *   - source enrollment: modeReason='historical_reactivation' AND
 *                        status='completed' AND
 *                        has at least one stepExecution with status='sent'
 *   - target conversation: NO existing active
 *                          post_historical_reactivation_followup
 *   - lead must NOT be opt_out (`lostReason='opt_out'`)
 *   - lead must NOT be SF-linked
 *   - scheduledAt = source enrollment.completedAt + 30 days
 *
 * Hard constraints (same envelope as historical-reactivation-activate.ts):
 *   - No Lead.status writes
 *   - No SF / sync writes
 *   - No customer message sends from this script
 *   - Default mode is DRY-RUN; --apply required for any DB write
 *
 * Usage:
 *   # Dry-run, all already-smoked leads
 *   DATABASE_URL=$DIRECT_URL npx ts-node \
 *     scripts/historical-reactivation-post-followup-backfill.ts
 *
 *   # Apply
 *   DATABASE_URL=$DIRECT_URL npx ts-node \
 *     scripts/historical-reactivation-post-followup-backfill.ts --apply
 *
 *   # Scope to a single user
 *   --user-id=<uuid>
 */

import { PrismaClient } from '../generated/prisma';

interface CliArgs {
  apply: boolean;
  userId: string | null;
  platform: string | null;
  delayDays: number;
}

function parseArgs(argv: string[]): CliArgs {
  const a: CliArgs = { apply: false, userId: null, platform: null, delayDays: 30 };
  for (const arg of argv.slice(2)) {
    if (arg === '--apply') a.apply = true;
    else if (arg.startsWith('--user-id=')) a.userId = arg.slice('--user-id='.length);
    else if (arg.startsWith('--platform=')) a.platform = arg.slice('--platform='.length);
    else if (arg.startsWith('--delay-days=')) a.delayDays = parseInt(arg.slice('--delay-days='.length), 10);
  }
  return a;
}

const POST_MODE_REASON = 'post_historical_reactivation_followup';
const HISTORICAL_TRIGGER_STATE = 'customer_hired_competitor';

async function main() {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();

  console.log('================================================================');
  console.log('  Historical Reactivation — Post-Followup Backfill');
  console.log(`  Mode: ${args.apply ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}`);
  console.log(`  Delay: +${args.delayDays} days from completedAt`);
  if (args.userId) console.log(`  Scope: userId=${args.userId} platform=${args.platform ?? 'all'}`);
  else console.log('  Scope: ALL users');
  console.log('================================================================\n');

  // ── 1. Find source enrollments ──
  // historical_reactivation enrollments that completed AND have at least one
  // sent step. We rely on the application enforcing one-shot completion, so
  // the existence of `completedAt` + a sent step is sufficient.
  const leadWhere: any = {};
  if (args.userId) leadWhere.userId = args.userId;
  if (args.platform) leadWhere.platform = args.platform;
  // Note: we DON'T filter opt_out in the DB query — Prisma's `not: 'opt_out'`
  // excludes NULL rows due to Postgres NULL comparison semantics, which
  // would zero out the majority of leads (most have lostReason=null). We
  // filter opt_out per-row in the JS loop below instead.

  const completed = await prisma.followUpEnrollment.findMany({
    where: {
      modeReason: 'historical_reactivation',
      status: 'completed',
      completedAt: { not: null },
      ...(Object.keys(leadWhere).length ? { lead: leadWhere } : {}),
    },
    select: {
      id: true,
      conversationId: true,
      leadId: true,
      completedAt: true,
      stepExecutions: { where: { status: 'sent' }, select: { id: true, executedAt: true } },
      lead: {
        select: {
          id: true,
          customerName: true,
          userId: true,
          platform: true,
          lostReason: true,
          sfJobId: true,
          sfCustomerId: true,
          syncStatus: true,
        },
      },
    },
    orderBy: { completedAt: 'asc' },
  });
  console.log(`Source pool — completed historical_reactivation enrollments: ${completed.length}`);

  // ── 2. Filter ──
  type Candidate = {
    sourceEnrollmentId: string;
    conversationId: string;
    leadId: string;
    customerName: string;
    completedAt: Date;
    scheduledAt: Date;
    userId: string;
    platform: string;
  };
  const candidates: Candidate[] = [];
  const skipped: Record<string, number> = {};
  function skip(reason: string) {
    skipped[reason] = (skipped[reason] || 0) + 1;
  }

  // Pre-load existing post-followup enrollments by conversationId to avoid N
  // round-trips. One findMany scoped to the conversation universe.
  const conversationIds = completed.map((c) => c.conversationId);
  const existingPost = await prisma.followUpEnrollment.findMany({
    where: {
      conversationId: { in: conversationIds },
      modeReason: POST_MODE_REASON,
      status: 'active',
    },
    select: { conversationId: true },
  });
  const existingPostSet = new Set(existingPost.map((e) => e.conversationId));

  for (const c of completed) {
    if (!c.lead) { skip('lead_missing'); continue; }
    if (c.stepExecutions.length === 0) { skip('no_sent_step'); continue; }
    if (c.lead.lostReason === 'opt_out') { skip('opt_out'); continue; }
    if (c.lead.sfJobId || c.lead.sfCustomerId || c.lead.syncStatus === 'linked') {
      skip('sf_linked'); continue;
    }
    if (existingPostSet.has(c.conversationId)) { skip('already_has_post_followup'); continue; }
    if (!c.completedAt) { skip('null_completedAt'); continue; }

    const scheduledAt = new Date(
      c.completedAt.getTime() + args.delayDays * 24 * 60 * 60 * 1000,
    );
    candidates.push({
      sourceEnrollmentId: c.id,
      conversationId: c.conversationId,
      leadId: c.leadId!,
      customerName: c.lead.customerName ?? '(no name)',
      completedAt: c.completedAt,
      scheduledAt,
      userId: c.lead.userId!,
      platform: c.lead.platform!,
    });
  }

  console.log(`Eligible for backfill:      ${candidates.length}`);
  if (Object.keys(skipped).length) {
    console.log('Skipped buckets:');
    for (const [k, v] of Object.entries(skipped).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(v).padStart(4)}  ${k}`);
    }
  }

  // ── 3. Per-user template availability ──
  // The new post-followup uses the same `customer_hired_competitor` trigger
  // state. Pre-check so we report "no_template" candidates separately
  // instead of failing mid-loop at --apply time.
  const userPlatformPairs = Array.from(
    new Set(candidates.map((c) => `${c.userId}|${c.platform}`)),
  );
  const templateMap = new Map<string, string>();
  for (const pair of userPlatformPairs) {
    const [userId, platform] = pair.split('|');
    const tmpl = await prisma.followUpSequenceTemplate.findFirst({
      where: { userId, platform, triggerState: HISTORICAL_TRIGGER_STATE, enabled: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    if (tmpl) templateMap.set(pair, tmpl.id);
  }
  const withoutTemplate = candidates.filter(
    (c) => !templateMap.has(`${c.userId}|${c.platform}`),
  );
  if (withoutTemplate.length) {
    console.log(`\nWARN: ${withoutTemplate.length} candidates lack an enabled '${HISTORICAL_TRIGGER_STATE}' template — will be skipped at apply time.`);
    for (const c of withoutTemplate.slice(0, 3)) {
      console.log(`  e.g. user=${c.userId} platform=${c.platform} lead=${c.leadId}`);
    }
  }

  // ── 4. Preview ──
  console.log('\n=== Preview (first 10 candidates) ===');
  for (const c of candidates.slice(0, 10)) {
    console.log(
      `  ${c.leadId} ${c.customerName.padEnd(24)} ` +
      `completedAt=${c.completedAt.toISOString()} ` +
      `scheduledAt=${c.scheduledAt.toISOString()}`,
    );
  }
  if (candidates.length > 10) {
    console.log('\n=== Preview (last 5 candidates) ===');
    for (const c of candidates.slice(-5)) {
      console.log(
        `  ${c.leadId} ${c.customerName.padEnd(24)} ` +
        `completedAt=${c.completedAt.toISOString()} ` +
        `scheduledAt=${c.scheduledAt.toISOString()}`,
      );
    }
  }

  // ── 5. Apply (or no-op for dry-run) ──
  if (!args.apply) {
    console.log('\n[DRY-RUN] No writes performed. Re-run with --apply to backfill.');
    console.log('  Reminder: --apply creates FollowUpEnrollment rows but does NOT send messages.');
    console.log(`  Each new enrollment is scheduled +${args.delayDays}d from its source enrollment's completedAt.`);
    await prisma.$disconnect();
    return;
  }

  console.log('\n=== APPLYING — writing post_historical_reactivation_followup rows ===');
  let wrote = 0, skippedExistingAtApply = 0, skippedTemplate = 0, errors = 0;
  for (const c of candidates) {
    const templateId = templateMap.get(`${c.userId}|${c.platform}`);
    if (!templateId) { skippedTemplate++; continue; }

    // Race-aware re-check (someone could have backfilled in parallel).
    const racedIn = await prisma.followUpEnrollment.findFirst({
      where: { conversationId: c.conversationId, status: 'active', modeReason: POST_MODE_REASON },
      select: { id: true },
    });
    if (racedIn) { skippedExistingAtApply++; continue; }

    try {
      await prisma.$transaction(async (tx) => {
        const created = await tx.followUpEnrollment.create({
          data: {
            sequenceTemplateId: templateId,
            conversationId: c.conversationId,
            leadId: c.leadId,
            platform: c.platform,
            status: 'active',
            currentStepIndex: 0,
            nextStepDueAt: c.scheduledAt,
            mode: 'auto_send',
            followUpMode: 'long_term',
            modeReason: POST_MODE_REASON,
          },
          select: { id: true },
        });
        await tx.threadContext.updateMany({
          where: { conversationId: c.conversationId },
          data: {
            activeEnrollmentId: created.id,
            nextFollowUpAt: c.scheduledAt,
            followUpStatus: 'active',
            conversationState: 'awaiting_customer',
          },
        });
      });
      wrote++;
      if (wrote % 25 === 0) process.stdout.write(`\r  wrote ${wrote}/${candidates.length}`);
    } catch (err: any) {
      errors++;
      console.error(`\n  backfill failed lead=${c.leadId}: ${err.message}`);
    }
  }
  console.log(
    `\n  APPLY summary: wrote=${wrote}  skipped_template=${skippedTemplate}  skipped_existing_at_apply=${skippedExistingAtApply}  errors=${errors}`,
  );

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
