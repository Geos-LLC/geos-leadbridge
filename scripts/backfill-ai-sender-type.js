/**
 * Backfill senderType='ai' on historical follow-up/AI messages
 *
 * Why: before the fix in leads.service.ts that stamps senderType onto the
 * Message row even when the Yelp webhook echo raced ahead, every Yelp pro
 * message got senderType=null. The UI "AI vs Platform" badge keys on that
 * field, so AI follow-ups display as "Platform".
 *
 * Strategy (in order of specificity):
 *   1. FollowUpStepExecution.messageId → Message.externalMessageId / Message.id
 *      (rare — adapter often returns a random UUID that doesn't map to the
 *      webhook-created row).
 *   2. Per-conversation content match (normalized whitespace + em-dash fold).
 *      This is the dominant path for Yelp follow-ups.
 *
 * AI Conversation (automation.service auto-replies) messages also match via
 * ThreadContext stats + content, but those are harder to attribute historically —
 * out of scope for this script. Going-forward, leads.service.ts now stamps
 * senderType correctly.
 *
 * Usage:
 *   node scripts/backfill-ai-sender-type.js            # dry-run
 *   node scripts/backfill-ai-sender-type.js --apply    # commit updates
 */

const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

// Normalize: trim, collapse whitespace, fold em/en dashes to hyphen, curly → straight quotes
function normalize(s) {
  return (s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"');
}

async function main() {
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // All sent/approved step executions with some message text
  const execs = await prisma.followUpStepExecution.findMany({
    where: {
      status: { in: ['sent', 'approved'] },
      OR: [{ finalMessage: { not: null } }, { generatedMessage: { not: null } }],
    },
    select: {
      id: true,
      messageId: true,
      finalMessage: true,
      generatedMessage: true,
      executedAt: true,
      enrollment: { select: { conversationId: true, platform: true } },
    },
  });

  console.log(`[backfill] Found ${execs.length} step executions to process`);

  let stampedViaId = 0;
  let stampedViaContent = 0;
  let alreadyTagged = 0;
  let unmatched = 0;

  for (const exec of execs) {
    const convId = exec.enrollment?.conversationId;
    if (!convId) { unmatched++; continue; }

    const text = exec.finalMessage || exec.generatedMessage;
    if (!text) { unmatched++; continue; }

    let targetMsg = null;

    // Strategy 1: direct messageId lookup (rare success path)
    if (exec.messageId) {
      targetMsg = await prisma.message.findFirst({
        where: {
          conversationId: convId,
          sender: 'pro',
          OR: [
            { externalMessageId: exec.messageId },
            { id: exec.messageId },
          ],
        },
        select: { id: true, senderType: true },
      });
    }

    // Strategy 2: per-conversation content match with normalization
    if (!targetMsg) {
      const candidates = await prisma.message.findMany({
        where: { conversationId: convId, sender: 'pro' },
        select: { id: true, content: true, senderType: true, sentAt: true },
      });
      const target = normalize(text);
      // Prefer the closest sentAt to exec.executedAt if there are ties
      const matches = candidates.filter((c) => normalize(c.content) === target);
      if (matches.length > 0 && exec.executedAt) {
        matches.sort(
          (a, b) =>
            Math.abs(a.sentAt.getTime() - exec.executedAt.getTime()) -
            Math.abs(b.sentAt.getTime() - exec.executedAt.getTime()),
        );
      }
      if (matches.length > 0) {
        targetMsg = matches[0];
        if (exec.messageId) {
          // Strategy 2 hit, not strategy 1 — still count as content path
          stampedViaContent++;
        } else {
          stampedViaContent++;
        }
      }
    } else {
      stampedViaId++;
    }

    if (!targetMsg) { unmatched++; continue; }
    if (targetMsg.senderType === 'ai' || targetMsg.senderType === 'user') {
      alreadyTagged++;
      continue;
    }

    if (APPLY) {
      await prisma.message.update({
        where: { id: targetMsg.id },
        data: { senderType: 'ai' },
      });
    }
  }

  console.log(`[backfill] ${APPLY ? 'Stamped' : 'Would stamp'} senderType=ai — via messageId: ${stampedViaId}, via content: ${stampedViaContent}, already tagged (skipped): ${alreadyTagged}, unmatched: ${unmatched}`);
  console.log(`[backfill] total = ${stampedViaId + stampedViaContent}`);

  if (!APPLY) {
    console.log('[backfill] Dry-run complete. Re-run with --apply to commit.');
  }
}

main()
  .catch((err) => {
    console.error('[backfill] error:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
