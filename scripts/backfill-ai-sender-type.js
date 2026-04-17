/**
 * Backfill senderType='ai' on historical follow-up/AI messages
 *
 * When the Yelp webhook echo landed before our sendMessage completed, the Message
 * row was stored with senderType=null. As a result, the UI shows "Platform" for
 * those messages instead of "AI". This script fixes historical rows by cross-
 * referencing FollowUpStepExecution.messageId and FollowUpStepExecution.finalMessage
 * content matches.
 *
 * Usage:
 *   node scripts/backfill-ai-sender-type.js            # dry-run
 *   node scripts/backfill-ai-sender-type.js --apply    # commit updates
 */

const { PrismaClient } = require('../generated/prisma');

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(`[backfill] mode=${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // Strategy 1: direct match via FollowUpStepExecution.messageId → Message.id
  const execsWithMessageId = await prisma.followUpStepExecution.findMany({
    where: { messageId: { not: null }, status: { in: ['sent', 'approved'] } },
    select: { id: true, messageId: true, finalMessage: true, generatedMessage: true, enrollment: { select: { conversationId: true, platform: true } } },
  });

  console.log(`[backfill] Found ${execsWithMessageId.length} step executions with messageId`);

  let stampedViaId = 0;
  let stampedViaContent = 0;

  for (const exec of execsWithMessageId) {
    if (!exec.messageId) continue;
    const msg = await prisma.message.findFirst({
      where: { id: exec.messageId },
      select: { id: true, senderType: true },
    });
    if (msg && !msg.senderType) {
      if (APPLY) {
        await prisma.message.update({
          where: { id: msg.id },
          data: { senderType: 'ai' },
        });
      }
      stampedViaId++;
    }
  }

  // Strategy 2: match by conversation + content for execs that have no messageId
  // (these are cases where sendMessage failed to capture externalMessageId)
  const execsNoMessageId = await prisma.followUpStepExecution.findMany({
    where: { messageId: null, status: { in: ['sent', 'approved'] }, finalMessage: { not: null } },
    select: { id: true, finalMessage: true, generatedMessage: true, enrollment: { select: { conversationId: true, platform: true } } },
  });

  console.log(`[backfill] Found ${execsNoMessageId.length} step executions without messageId`);

  const normalize = (s) => (s || '').trim().replace(/\s+/g, ' ');

  for (const exec of execsNoMessageId) {
    const text = exec.finalMessage || exec.generatedMessage;
    if (!text || !exec.enrollment?.conversationId) continue;

    const candidates = await prisma.message.findMany({
      where: {
        conversationId: exec.enrollment.conversationId,
        sender: 'pro',
        senderType: null,
      },
      select: { id: true, content: true, senderType: true },
      take: 20,
    });

    const normalizedTarget = normalize(text);
    for (const c of candidates) {
      if (normalize(c.content) === normalizedTarget) {
        if (APPLY) {
          await prisma.message.update({
            where: { id: c.id },
            data: { senderType: 'ai' },
          });
        }
        stampedViaContent++;
        break;
      }
    }
  }

  console.log(`[backfill] ${APPLY ? 'Stamped' : 'Would stamp'} senderType=ai on ${stampedViaId} (via messageId) + ${stampedViaContent} (via content match) = ${stampedViaId + stampedViaContent} total`);

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
