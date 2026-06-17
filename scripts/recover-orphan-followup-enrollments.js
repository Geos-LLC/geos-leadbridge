/**
 * Recover orphan ThreadContexts pointing to non-existent FollowUpEnrollments.
 *
 * BACKGROUND (2026-06-17, Jeff Connor incident)
 *   A series of manual SQL operations against production (intent: fix something
 *   else) hard-deleted rows from `follow_up_enrollments` while leaving
 *   `thread_contexts.activeEnrollmentId` pointing at the now-vanished ids.
 *   The scheduler claim filter is `status='active'` AND lives only on the
 *   enrollment table — so these conversations are invisible to follow-up
 *   processing forever. 10 conversations are affected (sweep snapshot).
 *
 * WHAT THIS DOES (per orphan TC)
 *   1. Confirms the pointer is dangling (defense in depth — re-checks live).
 *   2. Loads the lead + saved account + a fresh enabled template.
 *   3. Eligibility gate (matches leads.service.ts:1188-1212 auto re-enroll):
 *        - lead.status NOT in terminal list
 *        - savedAccount.followUpSettingsJson.fuReEnrollOnSilence !== false
 *        - at least one enabled template exists for (userId, platform)
 *   4. Eligible → in one transaction:
 *        - INSERT a fresh follow_up_enrollments row (status=active, step=0,
 *          nextStepDueAt = now + max(5 min, account.fuReEnrollDelay))
 *        - UPDATE thread_contexts.activeEnrollmentId to the new row
 *      Ineligible → UPDATE thread_contexts to clear the dangling pointer
 *      (activeEnrollmentId=null, nextFollowUpAt=null, followUpStatus='stopped').
 *
 * USAGE
 *   node scripts/recover-orphan-followup-enrollments.js            # dry-run
 *   node scripts/recover-orphan-followup-enrollments.js --apply    # commit
 *
 * The script reads DATABASE_URL from env. For prod, set DATABASE_URL to the
 * Railway DIRECT_URL (port 5432) before running.
 */

const { PrismaClient } = require('../generated/prisma');
const { parseDuration } = require('../dist/common/utils/parse-duration');

const TERMINAL_STATUSES = new Set([
  'done',
  'scheduled',
  'in_progress',
  'in progress',
  'booked',
  'hired',
  'completed',
  'archived',
  'lost',
]);

const APPLY = process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();
  const mode = APPLY ? 'APPLY' : 'DRY-RUN';
  console.log(`[recover] mode=${mode}`);

  const orphans = await prisma.$queryRawUnsafe(`
    SELECT tc."conversationId", tc."activeEnrollmentId", tc."followUpStatus", tc."nextFollowUpAt"
    FROM thread_contexts tc
    WHERE tc."activeEnrollmentId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM follow_up_enrollments e WHERE e.id = tc."activeEnrollmentId"
      )
  `);

  console.log(`[recover] Found ${orphans.length} orphan ThreadContext rows`);
  if (orphans.length === 0) {
    await prisma.$disconnect();
    return;
  }

  // Map ThreadContext signal → triggerState. Mirrors FollowUpStateService.
  // deriveFollowUpState but relaxes `awaitingCustomerReply` (we are deliberately
  // re-enrolling threads where that signal may be stale after a manager-on-
  // platform reply that bypassed the engine).
  function pickTriggerState(tc) {
    if (!tc) return 'no_reply_after_initial';
    const stage = (tc.stage || '').toLowerCase();
    if (stage === 'booked' || stage === 'lost' || stage === 'closed') return null;
    if (stage === 'negotiation') return 'no_reply_after_conversion';
    if (tc.priceDiscussed) return 'no_reply_after_price';
    if (tc.lastQuestionAsked) return 'no_reply_after_question';
    return 'no_reply_after_initial';
  }

  let cleared = 0;
  let reenrolled = 0;
  let skippedTerminal = 0;
  let skippedDisabled = 0;
  let skippedNoTemplate = 0;
  let skippedAlreadyActive = 0;
  let skippedTcStage = 0;

  for (const { conversationId, activeEnrollmentId } of orphans) {
    // Defense in depth: race-aware re-check inside the loop.
    const exists = await prisma.followUpEnrollment.findUnique({
      where: { id: activeEnrollmentId },
      select: { id: true },
    });
    if (exists) {
      console.log(`[recover]   ${conversationId} ← pointer is no longer dangling (race), skipping`);
      continue;
    }

    // Look up the lead via the conversation relation.
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: {
        id: true,
        userId: true,
        platform: true,
        leads: { select: { id: true, status: true, businessId: true, customerName: true } },
      },
    });
    if (!conv || conv.leads.length === 0) {
      console.log(`[recover]   ${conversationId} ← no conversation or no leads, clearing pointer only`);
      if (APPLY) {
        await prisma.threadContext.updateMany({
          where: { conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
        });
      }
      cleared++;
      continue;
    }
    const lead = conv.leads[0];

    // Idempotency: if an active enrollment now exists (race vs another worker),
    // just repoint TC and skip insertion.
    const alreadyActive = await prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      select: { id: true, nextStepDueAt: true },
    });
    if (alreadyActive) {
      console.log(`[recover]   ${conversationId} (${lead.customerName}) ← already has active enrollment ${alreadyActive.id}, repointing TC only`);
      if (APPLY) {
        await prisma.threadContext.updateMany({
          where: { conversationId },
          data: {
            activeEnrollmentId: alreadyActive.id,
            nextFollowUpAt: alreadyActive.nextStepDueAt,
            followUpStatus: 'active',
          },
        });
      }
      skippedAlreadyActive++;
      continue;
    }

    // Eligibility 1: terminal status?
    const status = (lead.status || '').toLowerCase();
    if (TERMINAL_STATUSES.has(status)) {
      console.log(`[recover]   ${conversationId} (${lead.customerName}) ← lead.status='${status}' is terminal, clearing TC`);
      if (APPLY) {
        await prisma.threadContext.updateMany({
          where: { conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
        });
      }
      skippedTerminal++;
      cleared++;
      continue;
    }

    // Eligibility 2: account opted out of re-enroll on silence?
    let reEnrollDelayMinutes = 360; // default 6h if not specified
    if (lead.businessId) {
      const acct = await prisma.savedAccount.findFirst({
        where: { userId: conv.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (acct?.followUpSettingsJson) {
        try {
          const s = JSON.parse(acct.followUpSettingsJson);
          if (s.fuReEnrollOnSilence === false) {
            console.log(`[recover]   ${conversationId} (${lead.customerName}) ← fuReEnrollOnSilence=false, clearing TC`);
            if (APPLY) {
              await prisma.threadContext.updateMany({
                where: { conversationId },
                data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
              });
            }
            skippedDisabled++;
            cleared++;
            continue;
          }
          if (s.fuReEnrollDelay) {
            reEnrollDelayMinutes = parseDuration(s.fuReEnrollDelay, 360);
          }
        } catch {}
      }
    }

    // Eligibility 3: pick template by ThreadContext stage → triggerState
    const tc = await prisma.threadContext.findUnique({
      where: { conversationId },
      select: { stage: true, priceDiscussed: true, lastQuestionAsked: true, engagementLevel: true },
    });
    const triggerState = pickTriggerState(tc);
    if (!triggerState) {
      console.log(`[recover]   ${conversationId} (${lead.customerName}) ← TC stage='${tc?.stage}' is terminal, clearing TC`);
      if (APPLY) {
        await prisma.threadContext.updateMany({
          where: { conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
        });
      }
      skippedTcStage++;
      cleared++;
      continue;
    }

    // Prefer per-account template when a savedAccountId match exists; fall back
    // to user+platform global. Matches engine search order.
    const template =
      (lead.businessId
        ? await prisma.followUpSequenceTemplate.findFirst({
            where: {
              userId: conv.userId,
              platform: lead.platform || conv.platform,
              triggerState,
              enabled: true,
              savedAccount: { businessId: lead.businessId },
            },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
            select: { id: true, name: true, mode: true },
          })
        : null) ??
      (await prisma.followUpSequenceTemplate.findFirst({
        where: {
          userId: conv.userId,
          platform: lead.platform || conv.platform,
          triggerState,
          enabled: true,
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, name: true, mode: true },
      }));
    if (!template) {
      console.log(`[recover]   ${conversationId} (${lead.customerName}) ← no enabled template for ${conv.platform}, clearing TC`);
      if (APPLY) {
        await prisma.threadContext.updateMany({
          where: { conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
        });
      }
      skippedNoTemplate++;
      cleared++;
      continue;
    }

    // Effective due time: now + max(5 min, fuReEnrollDelay)
    const delayMs = Math.max(5, reEnrollDelayMinutes) * 60_000;
    const nextStepDueAt = new Date(Date.now() + delayMs);

    // Resolve enrollment mode. Mirrors enrollInSequence (follow-up-engine.service
    // .ts:538-549): account.followUpMode wins when set and != 'off', else fall
    // back to template.mode. Without this, every recovered enrollment lands in
    // 'suggest' mode and stalls behind the claim filter that excludes rows with
    // any 'suggested' step execution — the same trap that left 22 enrollments
    // stuck for weeks.
    let enrollMode = template.mode || 'auto_send';
    if (lead.businessId) {
      const acctMode = await prisma.savedAccount
        .findFirst({
          where: { userId: conv.userId, businessId: lead.businessId },
          select: { followUpMode: true },
        })
        .catch(() => null);
      if (acctMode?.followUpMode && acctMode.followUpMode !== 'off') {
        enrollMode = acctMode.followUpMode;
      }
    }

    console.log(
      `[recover]   ${conversationId} (${lead.customerName}) ← re-enrolling ` +
        `template="${template.name}" triggerState=${triggerState} mode=${enrollMode} ` +
        `nextStepDueAt=${nextStepDueAt.toISOString()} (delay=${reEnrollDelayMinutes}m)`,
    );

    if (APPLY) {
      try {
        await prisma.$transaction(async (tx) => {
          const created = await tx.followUpEnrollment.create({
            data: {
              sequenceTemplateId: template.id,
              conversationId,
              leadId: lead.id,
              platform: lead.platform || conv.platform,
              status: 'active',
              currentStepIndex: 0,
              nextStepDueAt,
              mode: enrollMode,
            },
            select: { id: true },
          });
          await tx.threadContext.updateMany({
            where: { conversationId },
            data: {
              activeEnrollmentId: created.id,
              nextFollowUpAt: nextStepDueAt,
              followUpStatus: 'active',
            },
          });
          await tx.followUpEnrollmentAuditLog.create({
            data: {
              enrollmentId: created.id,
              oldStatus: 'none',
              newStatus: 'active',
              reason: 'orphan_recovery_2026_06_17',
              actorType: 'manual',
              actorId: 'recover-orphan-followup-enrollments.js',
              occurredAt: new Date(),
            },
          });
        });
        reenrolled++;
      } catch (err) {
        console.error(`[recover]   ${conversationId} ← INSERT FAILED: ${err.message}`);
      }
    } else {
      reenrolled++;
    }
  }

  console.log('');
  console.log(`[recover] Summary (${mode}):`);
  console.log(`[recover]   ${reenrolled} ${APPLY ? 're-enrolled' : 'would re-enroll'}`);
  console.log(`[recover]   ${cleared} ${APPLY ? 'cleared (no re-enroll)' : 'would clear (no re-enroll)'}`);
  console.log(`[recover]     - ${skippedTerminal} terminal lead status`);
  console.log(`[recover]     - ${skippedTcStage} terminal TC stage`);
  console.log(`[recover]     - ${skippedDisabled} fuReEnrollOnSilence=false`);
  console.log(`[recover]     - ${skippedNoTemplate} no enabled template`);
  console.log(`[recover]   ${skippedAlreadyActive} already had active enrollment (TC repoint only)`);

  if (!APPLY) {
    console.log('');
    console.log('[recover] Dry-run complete. Re-run with --apply to commit changes.');
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[recover] error:', err);
  process.exit(1);
});
