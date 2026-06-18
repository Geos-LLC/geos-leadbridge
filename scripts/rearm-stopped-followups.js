/**
 * Re-arm follow-up enrollment for auto_send accounts whose threads went
 * silent without a live enrollment.
 *
 * BACKGROUND (2026-06-17)
 *   The webhook path at webhooks.service.ts (pre-`5bf12d6a`) silently
 *   skipped follow-up re-arming when a manager typed directly on the
 *   platform's web UI (senderType='manual'). The result: any thread where
 *   the manager was the last to speak — and the AI didn't reply afterwards —
 *   sits with `followUpStatus='stopped'` and no active enrollment forever.
 *   Jeff Connor was the first symptom; Andrew Eisenbrei is one of ~50 more
 *   on the same auto_send accounts (Spotless / Lavanda / 360Cleaning).
 *
 *   The code fix at `5bf12d6a` covers all future messages. This script
 *   catches up the backlog.
 *
 * SCOPE — INTENTIONALLY NARROW
 *   Only touches conversations whose account has `followUpMode='auto_send'`.
 *   Accounts on:
 *     - 'suggest' → user wants operator approval; don't bypass.
 *     - 'off'     → user disabled follow-up; respect that.
 *     - null      → unset; respect that.
 *   These accounts can opt in by changing followUpMode in Settings.
 *
 * ELIGIBILITY (per row — matches FollowUpEngine.evaluateThread + leads.service auto-reenroll)
 *   - No active enrollment on this conversation.
 *   - ThreadContext.awaitingCustomerReply = true.
 *   - ThreadContext.stage NOT in (booked, lost, closed, done, completed, archived).
 *   - ThreadContext.lastBusinessMessageAt within --since-days (default 30).
 *   - Lead.status NOT in terminal set.
 *   - Lead.thumbtackStatus NOT in terminal set.
 *   - SavedAccount.followUpMode = 'auto_send'.
 *   - SavedAccount.followUpSettingsJson.fuReEnrollOnSilence !== false.
 *   - At least one enabled template for (userId, platform).
 *
 * USAGE
 *   node scripts/rearm-stopped-followups.js                        # dry-run, last 30d
 *   node scripts/rearm-stopped-followups.js --since-days=14        # dry-run, last 14d
 *   node scripts/rearm-stopped-followups.js --apply                # commit
 */

const { PrismaClient } = require('../generated/prisma');
const { parseDuration } = require('../dist/common/utils/parse-duration');

const APPLY = process.argv.includes('--apply');
const SINCE_DAYS_ARG = process.argv.find((a) => a.startsWith('--since-days='));
const SINCE_DAYS = SINCE_DAYS_ARG ? Number(SINCE_DAYS_ARG.split('=')[1]) : 30;

function pickTriggerState(tc) {
  const stage = (tc.stage || '').toLowerCase();
  if (stage === 'booked' || stage === 'lost' || stage === 'closed') return null;
  if (stage === 'negotiation') return 'no_reply_after_conversion';
  if (tc.priceDiscussed) return 'no_reply_after_price';
  if (tc.lastQuestionAsked) return 'no_reply_after_question';
  return 'no_reply_after_initial';
}

async function main() {
  const prisma = new PrismaClient();
  console.log(`[rearm] mode=${APPLY ? 'APPLY' : 'DRY-RUN'} since-days=${SINCE_DAYS}`);

  const rows = await prisma.$queryRawUnsafe(
    `
    SELECT
      tc."conversationId", tc.stage, tc."priceDiscussed", tc."lastQuestionAsked",
      tc."lastBusinessMessageAt", tc."awaitingCustomerReply",
      c."userId", c.platform,
      l.id AS lead_id, l."customerName", l."businessId",
      sa."followUpMode", sa."followUpSettingsJson", sa."businessName"
    FROM thread_contexts tc
    JOIN conversations c ON c.id = tc."conversationId"
    LEFT JOIN leads l ON l."threadId" = c.id
    LEFT JOIN saved_accounts sa ON sa."userId" = c."userId" AND sa."businessId" = l."businessId"
    WHERE NOT EXISTS (
            SELECT 1 FROM follow_up_enrollments e
            WHERE e."conversationId" = tc."conversationId" AND e.status = 'active'
          )
      AND tc."awaitingCustomerReply" = true
      AND tc.stage NOT IN ('booked','lost','closed','done','completed','archived')
      AND tc."lastBusinessMessageAt" > NOW() - INTERVAL '${SINCE_DAYS} days'
      AND l.id IS NOT NULL
      AND LOWER(COALESCE(l.status,'')) NOT IN ('done','scheduled','in_progress','in progress','booked','hired','completed','archived','lost')
      AND LOWER(COALESCE(l."thumbtackStatus",'')) NOT IN ('done','scheduled','in_progress','in progress','booked','hired','completed','archived','lost','not hired','not_hired')
      AND sa."followUpMode" = 'auto_send'
      AND EXISTS (
        SELECT 1 FROM follow_up_sequence_templates t
        WHERE t."userId" = c."userId" AND t.platform = c.platform AND t.enabled = true
      )
    ORDER BY tc."lastBusinessMessageAt" DESC
  `,
  );

  console.log(`[rearm] Found ${rows.length} candidate conversations on auto_send accounts`);

  let reenrolled = 0;
  let skippedSilence = 0;
  let skippedNoTemplate = 0;
  let skippedTerminalStage = 0;

  for (const r of rows) {
    let reEnrollDelayMinutes = 360;
    let optedOut = false;
    if (r.followUpSettingsJson) {
      try {
        const s = JSON.parse(r.followUpSettingsJson);
        if (s.fuReEnrollOnSilence === false) optedOut = true;
        if (s.fuReEnrollDelay) reEnrollDelayMinutes = parseDuration(s.fuReEnrollDelay, 360);
      } catch {}
    }
    if (optedOut) {
      skippedSilence++;
      continue;
    }

    const triggerState = pickTriggerState({
      stage: r.stage,
      priceDiscussed: r.priceDiscussed,
      lastQuestionAsked: r.lastQuestionAsked,
    });
    if (!triggerState) {
      skippedTerminalStage++;
      continue;
    }

    // Prefer per-account template, fall back to user-global.
    const template =
      (await prisma.followUpSequenceTemplate.findFirst({
        where: {
          userId: r.userId,
          platform: r.platform,
          triggerState,
          enabled: true,
          savedAccount: { businessId: r.businessId },
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, name: true, mode: true },
      })) ??
      (await prisma.followUpSequenceTemplate.findFirst({
        where: {
          userId: r.userId,
          platform: r.platform,
          triggerState,
          enabled: true,
        },
        orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
        select: { id: true, name: true, mode: true },
      }));

    if (!template) {
      skippedNoTemplate++;
      continue;
    }

    const nextStepDueAt = new Date(Date.now() + Math.max(5, reEnrollDelayMinutes) * 60_000);

    console.log(
      `[rearm]   ${r.conversationId} (${r.customerName}, ${r.businessName}) ` +
        `template="${template.name}" triggerState=${triggerState} ` +
        `nextStepDueAt=${nextStepDueAt.toISOString()} delay=${reEnrollDelayMinutes}m`,
    );

    if (APPLY) {
      try {
        await prisma.$transaction(async (tx) => {
          const created = await tx.followUpEnrollment.create({
            data: {
              sequenceTemplateId: template.id,
              conversationId: r.conversationId,
              leadId: r.lead_id,
              platform: r.platform,
              status: 'active',
              currentStepIndex: 0,
              nextStepDueAt,
              // auto_send-only sweep → enrollment.mode mirrors that.
              mode: 'auto_send',
            },
            select: { id: true },
          });
          await tx.threadContext.updateMany({
            where: { conversationId: r.conversationId },
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
              reason: 'rearm_stopped_followups_2026_06_17',
              actorType: 'manual',
              actorId: 'rearm-stopped-followups.js',
              occurredAt: new Date(),
            },
          });
        });
        reenrolled++;
      } catch (err) {
        console.error(`[rearm]   ${r.conversationId} ← INSERT FAILED: ${err.message}`);
      }
    } else {
      reenrolled++;
    }
  }

  console.log('');
  console.log(`[rearm] Summary (${APPLY ? 'APPLY' : 'DRY-RUN'}):`);
  console.log(`[rearm]   ${reenrolled} ${APPLY ? 're-enrolled' : 'would re-enroll'}`);
  console.log(`[rearm]   ${skippedSilence} skipped fuReEnrollOnSilence=false`);
  console.log(`[rearm]   ${skippedNoTemplate} skipped no template for triggerState`);
  console.log(`[rearm]   ${skippedTerminalStage} skipped TC stage terminal`);

  if (!APPLY) console.log('\n[rearm] Dry-run complete. Re-run with --apply to commit.');

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[rearm] error:', err);
  process.exit(1);
});
