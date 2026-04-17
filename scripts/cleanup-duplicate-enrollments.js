/**
 * Cleanup Duplicate Follow-Up Enrollments
 *
 * Finds conversations with more than one active FollowUpEnrollment and stops
 * all but the oldest (by createdAt). Also cancels any pending suggestion/
 * scheduled step executions on the stopped duplicates.
 *
 * Run BEFORE applying the partial unique index migration
 * (20260417120000_followup_duplicate_fix) on databases that pre-date it, to
 * avoid the index creation failing on existing duplicates.
 *
 * Usage:
 *   node scripts/cleanup-duplicate-enrollments.js            # dry-run (default)
 *   node scripts/cleanup-duplicate-enrollments.js --apply    # actually update
 */

const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[cleanup] mode=${mode}`);

  // Find all conversations with >1 active enrollment
  const groups = await prisma.$queryRaw`
    SELECT "conversationId", COUNT(*)::int AS active_count
    FROM "follow_up_enrollments"
    WHERE "status" = 'active'
    GROUP BY "conversationId"
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
  `;

  console.log(`[cleanup] Found ${groups.length} conversations with duplicate active enrollments`);
  if (groups.length === 0) {
    console.log('[cleanup] Nothing to do.');
    return;
  }

  let totalStopped = 0;
  let totalCancelledExecs = 0;

  for (const { conversationId, active_count } of groups) {
    const enrollments = await prisma.followUpEnrollment.findMany({
      where: { conversationId, status: 'active' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { id: true, createdAt: true, sequenceTemplateId: true, currentStepIndex: true },
    });
    const [keep, ...drop] = enrollments;

    console.log(
      `[cleanup] conversation=${conversationId} active=${active_count} keep=${keep.id} (createdAt=${keep.createdAt.toISOString()}, step=${keep.currentStepIndex})`,
    );
    for (const d of drop) {
      console.log(
        `[cleanup]   drop=${d.id} (createdAt=${d.createdAt.toISOString()}, step=${d.currentStepIndex}, template=${d.sequenceTemplateId})`,
      );
    }

    if (APPLY) {
      const stopRes = await prisma.followUpEnrollment.updateMany({
        where: { id: { in: drop.map((d) => d.id) } },
        data: {
          status: 'stopped',
          stoppedReason: 'duplicate_cleanup',
          completedAt: new Date(),
        },
      });
      totalStopped += stopRes.count;

      const cancelRes = await prisma.followUpStepExecution.updateMany({
        where: {
          enrollmentId: { in: drop.map((d) => d.id) },
          status: { in: ['scheduled', 'suggested'] },
        },
        data: { status: 'cancelled' },
      });
      totalCancelledExecs += cancelRes.count;
    } else {
      totalStopped += drop.length;
    }
  }

  console.log(
    `[cleanup] ${APPLY ? 'STOPPED' : 'WOULD STOP'} ${totalStopped} enrollments across ${groups.length} conversations`,
  );
  if (APPLY) {
    console.log(`[cleanup] Cancelled ${totalCancelledExecs} pending step executions`);
  }

  // Post-check
  const remaining = await prisma.$queryRaw`
    SELECT "conversationId", COUNT(*)::int AS active_count
    FROM "follow_up_enrollments"
    WHERE "status" = 'active'
    GROUP BY "conversationId"
    HAVING COUNT(*) > 1
  `;
  if (APPLY) {
    console.log(`[cleanup] Post-check: ${remaining.length} conversations still have duplicates (should be 0)`);
    if (remaining.length > 0) {
      console.error('[cleanup] FAILED — duplicates still present; inspect manually');
      process.exit(1);
    }
  } else {
    console.log(`[cleanup] Dry-run complete. Re-run with --apply to commit changes.`);
  }
}

main()
  .catch((err) => {
    console.error('[cleanup] error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
