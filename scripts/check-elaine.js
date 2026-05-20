const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

(async () => {
  const leads = await p.lead.findMany({
    where: {
      customerName: { contains: 'Elaine', mode: 'insensitive' },
      platform: 'yelp',
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
  });
  if (!leads.length) { console.log('No Elaine Yelp lead found.'); return; }

  for (const lead of leads) {
    console.log('============================================================');
    console.log('LEAD');
    console.log(`  id            : ${lead.id}`);
    console.log(`  customer      : ${lead.customerName}`);
    console.log(`  platform      : ${lead.platform}`);
    console.log(`  status        : ${lead.status}`);
    console.log(`  category      : ${lead.category}`);
    console.log(`  businessId    : ${lead.businessId}`);
    console.log(`  externalReqId : ${lead.externalRequestId}`);
    console.log(`  threadId      : ${lead.threadId}`);
    console.log(`  createdAt     : ${lead.createdAt.toISOString()}`);
    console.log(`  lead.message  : ${(lead.message || '(empty)').substring(0, 600).replace(/\n/g, ' \\n ')}`);
    console.log('');

    let acct = null;
    if (lead.businessId) {
      acct = await p.savedAccount.findFirst({
        where: { businessId: lead.businessId, platform: 'yelp' },
        select: { id: true, businessName: true },
      });
      if (acct) console.log(`  account       : ${acct.businessName} (${acct.id})`);
    }
    console.log('');

    if (lead.threadId) {
      const messages = await p.message.findMany({
        where: { conversationId: lead.threadId },
        orderBy: { sentAt: 'asc' },
        select: { id: true, sender: true, senderType: true, content: true, sentAt: true, externalMessageId: true, rawJson: true },
      });
      console.log(`MESSAGES in thread (${messages.length}):`);
      for (const m of messages) {
        const dt = m.sentAt?.toISOString();
        const edt = m.sentAt ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, month: 'short', day: '2-digit' }).format(m.sentAt) : '';
        console.log(`  ---`);
        console.log(`  ${dt} (${edt} EDT) ${m.sender}/${m.senderType ?? '-'} ext=${m.externalMessageId ?? '-'}`);
        console.log(`    ${(m.content || '').substring(0, 700).replace(/\n/g, ' \\n ')}`);
        if (m.rawJson) {
          try {
            const raw = JSON.parse(m.rawJson);
            console.log(`    raw.event_type=${raw.event_type ?? '?'} user_type=${raw.user_type ?? '?'} user_display_name=${raw.user_display_name ?? '?'}`);
            if (raw.event_content) {
              const ec = JSON.stringify(raw.event_content).substring(0, 400);
              console.log(`    raw.event_content=${ec}`);
            }
          } catch {}
        }
      }
      console.log('');
    }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
