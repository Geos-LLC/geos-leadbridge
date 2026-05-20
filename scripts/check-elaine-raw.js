const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

(async () => {
  // Pull the May 5 customer message with rawJson
  const msg = await p.message.findFirst({
    where: { externalMessageId: 'kyISWzRFRELjTEPZlr9lrg' },
  });
  if (!msg) { console.log('Message not found'); return; }
  console.log('=== Message row ===');
  console.log('id:', msg.id);
  console.log('sender:', msg.sender, 'senderType:', msg.senderType);
  console.log('sentAt:', msg.sentAt?.toISOString());
  console.log('createdAt:', msg.createdAt?.toISOString());
  console.log('platform:', msg.platform);
  console.log('externalMessageId:', msg.externalMessageId);
  console.log('notificationLogId:', msg.notificationLogId);
  console.log('aiGenerated:', msg.aiGenerated);
  console.log('strategyUsed:', msg.strategyUsed);
  console.log('isAutoFollowUp:', msg.isAutoFollowUp);
  console.log('content:');
  console.log(msg.content);
  console.log('--- rawJson ---');
  console.log(msg.rawJson || '(null)');

  // Also pull the immediately preceding/following AI message for comparison
  console.log('\n=== Surrounding messages in thread ===');
  const around = await p.message.findMany({
    where: { conversationId: msg.conversationId },
    orderBy: { sentAt: 'asc' },
    select: { id: true, sender: true, senderType: true, content: true, sentAt: true, externalMessageId: true, rawJson: true, createdAt: true, notificationLogId: true },
  });
  for (const m of around) {
    const mark = m.externalMessageId === 'kyISWzRFRELjTEPZlr9lrg' ? '>>>' : '   ';
    console.log(`${mark} ${m.sentAt?.toISOString()} ${m.sender}/${m.senderType ?? '-'} ext=${m.externalMessageId ?? 'NULL'} hasRaw=${!!m.rawJson} notif=${m.notificationLogId ?? '-'}`);
  }

  // Also check the lead's rawJson for survey answers
  const lead = await p.lead.findFirst({
    where: { threadId: msg.conversationId },
    select: { id: true, customerName: true, rawJson: true },
  });
  if (lead?.rawJson) {
    try {
      const raw = JSON.parse(lead.rawJson);
      console.log('\n=== Lead.rawJson survey_answers ===');
      console.log(JSON.stringify(raw.project?.survey_answers, null, 2));
      console.log('availability:', JSON.stringify(raw.project?.availability));
      console.log('additional_info:', raw.project?.additional_info);
    } catch (e) { console.log('rawJson parse error:', e.message); }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
