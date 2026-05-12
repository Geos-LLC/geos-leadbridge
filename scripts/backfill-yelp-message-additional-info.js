// Backfills Yelp Lead.message to contain ONLY the customer's free-form
// "Additional details" text (raw.project.additional_info) — matching the new
// adapter behavior. Previously Lead.message was a bundled string of survey
// Q&A + availability + additional_info, which cluttered the chat with
// structured data that already shows on the right-side lead details panel.
//
// Also rewrites the corresponding initial Message row (created at webhook
// time with content == lead.message) so the chat itself reflects the new
// behavior. When additional_info is empty, the initial Message row is
// deleted — leaving the chat blank, matching Thumbtack.
//
// Match strategy is safe: we only touch Message rows whose content exactly
// equals the lead's old bundled message string. A real customer-written
// message cannot match this format, so no real conversation content is
// touched.
//
// Idempotent. Skips leads where Lead.message already matches additional_info.
// Skips Thumbtack and other platforms entirely.
//
// DRY RUN by default. Set EXECUTE=1 to apply.

const { PrismaClient } = require('../generated/prisma');

function extractAdditionalInfo(rawJson) {
  if (!rawJson) return null;
  let raw;
  try { raw = JSON.parse(rawJson); } catch { return null; }
  // rawJson may be the Yelp API response directly, or a NormalizedLead with
  // raw nested under .raw (defensive — supports both shapes).
  const info =
    raw?.project?.additional_info ??
    raw?.raw?.project?.additional_info ??
    null;
  return typeof info === 'string' ? info : null;
}

(async () => {
  const p = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

  try {
    const leads = await p.lead.findMany({
      where: { platform: 'yelp' },
      select: {
        id: true,
        externalRequestId: true,
        message: true,
        rawJson: true,
        threadId: true,
      },
    });

    const candidates = [];
    let noRaw = 0;
    let alreadyCorrect = 0;
    let willClear = 0;
    let willShrink = 0;

    for (const l of leads) {
      if (!l.rawJson) { noRaw++; continue; }
      const additionalInfo = extractAdditionalInfo(l.rawJson);
      const newMessage = additionalInfo ?? '';
      const oldMessage = l.message ?? '';

      if (oldMessage === newMessage) {
        alreadyCorrect++;
        continue;
      }

      if (newMessage === '') willClear++;
      else if (newMessage.length < oldMessage.length) willShrink++;

      candidates.push({
        id: l.id,
        threadId: l.threadId,
        externalRequestId: l.externalRequestId,
        oldMessage,
        newMessage,
      });
    }

    console.log('=== Yelp Lead.message → additional_info backfill scan ===');
    console.table([{
      total: leads.length,
      noRawJson: noRaw,
      alreadyCorrect,
      willClearToEmpty: willClear,
      willShrink,
      backfillCandidates: candidates.length,
    }]);

    if (candidates.length === 0) {
      console.log('Nothing to backfill.');
      return;
    }

    // Count how many initial Message rows we would touch (where content
    // exactly equals the bundled-string lead.message). This is the chat-side
    // cleanup — the part the user actually sees in the conversation thread.
    let willUpdateMsg = 0;
    let willDeleteMsg = 0;
    for (const c of candidates) {
      if (!c.threadId || !c.oldMessage) continue;
      const count = await p.message.count({
        where: {
          conversationId: c.threadId,
          sender: 'customer',
          content: c.oldMessage,
        },
      });
      if (count === 0) continue;
      if (c.newMessage === '') willDeleteMsg += count;
      else willUpdateMsg += count;
    }

    console.log('\n=== Chat Message rows affected ===');
    console.table([{
      willUpdateInitialMsg: willUpdateMsg,
      willDeleteInitialMsg: willDeleteMsg,
    }]);

    console.log('\n=== Sample (first 10 candidates) ===');
    console.table(candidates.slice(0, 10).map(c => ({
      externalRequestId: c.externalRequestId,
      oldLen: c.oldMessage.length,
      newLen: c.newMessage.length,
      newMessagePreview: c.newMessage.length > 80
        ? c.newMessage.slice(0, 80) + '…'
        : c.newMessage || '(empty)',
    })));

    if (process.env.EXECUTE !== '1') {
      console.log('\nDRY RUN — no writes. Re-run with EXECUTE=1 to backfill.');
      return;
    }

    let updatedLeads = 0;
    let updatedMsgs = 0;
    let deletedMsgs = 0;

    for (const c of candidates) {
      // Update Message rows first (so a partial failure leaves Lead.message
      // matching the still-extant Message content, keeping the system
      // self-consistent on retry).
      if (c.threadId && c.oldMessage) {
        if (c.newMessage === '') {
          const res = await p.message.deleteMany({
            where: {
              conversationId: c.threadId,
              sender: 'customer',
              content: c.oldMessage,
            },
          });
          deletedMsgs += res.count;
        } else {
          const res = await p.message.updateMany({
            where: {
              conversationId: c.threadId,
              sender: 'customer',
              content: c.oldMessage,
            },
            data: { content: c.newMessage },
          });
          updatedMsgs += res.count;
        }
      }

      await p.lead.update({
        where: { id: c.id },
        data: { message: c.newMessage },
      });
      updatedLeads++;
      if (updatedLeads % 25 === 0) {
        console.log(`  ...${updatedLeads}/${candidates.length} leads`);
      }
    }

    console.log(`\nBackfill complete:`);
    console.log(`  Leads updated: ${updatedLeads}`);
    console.log(`  Initial messages updated: ${updatedMsgs}`);
    console.log(`  Initial messages deleted: ${deletedMsgs}`);
  } finally {
    await p.$disconnect();
  }
})();
