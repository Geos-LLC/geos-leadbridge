const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

// Fingerprint of the Elaine bug:
//  - platform = 'yelp'
//  - sender = 'customer'  + senderType = 'customer'
//  - rawJson IS NULL
//  - sentAt has non-zero milliseconds (programmatic creation, NOT Yelp time_created)
//  - externalMessageId looks like a Yelp event id (not a "synthetic-..." prefix)
(async () => {
  // First, broad count of all yelp+customer rows
  const totalYelpCustomer = await p.message.count({ where: { platform: 'yelp', sender: 'customer' } });
  console.log(`Total yelp+customer messages: ${totalYelpCustomer}`);

  // Tier 1: rawJson IS NULL (strongest signal)
  const noRaw = await p.message.findMany({
    where: { platform: 'yelp', sender: 'customer', rawJson: null },
    select: { id: true, conversationId: true, externalMessageId: true, sentAt: true, createdAt: true, content: true, userId: true },
    orderBy: { sentAt: 'desc' },
  });
  console.log(`\nYelp customer rows with rawJson IS NULL: ${noRaw.length}\n`);

  // Tier 2: filter further to ms-precision sentAt (programmatic) AND content starts like survey-dump
  const surveyDumpPrefixes = [
    'do you need',
    'how many bedrooms',
    'how many bathrooms',
    'how often',
    'what kind of',
    'do you require',
    'are you flexible',
  ];
  const suspect = noRaw.filter(m => {
    const msMs = m.sentAt ? m.sentAt.getMilliseconds() : 0;
    const c = (m.content || '').trim().toLowerCase();
    const looksSurvey = surveyDumpPrefixes.some(p => c.startsWith(p)) || c.includes('?:') || c.includes('availability:');
    return msMs !== 0 && looksSurvey;
  });

  console.log(`STRONG-MATCH (rawJson null + ms-precision sentAt + survey-format content): ${suspect.length}\n`);
  for (const m of suspect) {
    console.log('---');
    console.log(`  msgId   : ${m.id}`);
    console.log(`  sentAt  : ${m.sentAt?.toISOString()}`);
    console.log(`  ext     : ${m.externalMessageId ?? '(null)'}`);
    console.log(`  thread  : ${m.conversationId}`);
    console.log(`  userId  : ${m.userId ?? '-'}`);
    console.log(`  content : ${(m.content || '').substring(0, 220).replace(/\n/g, ' \\n ')}`);
  }

  // Group by user to see which tenants are affected
  console.log('\n=== Strong matches by user ===');
  const byUser = new Map();
  for (const m of suspect) {
    const k = m.userId || 'null';
    byUser.set(k, (byUser.get(k) || 0) + 1);
  }
  for (const [u, n] of byUser) console.log(`  ${u}: ${n}`);

  // Also report broader "no rawJson but doesn't match strict survey pattern" — could be other bugs
  const noRawNotSurvey = noRaw.filter(m => !suspect.includes(m));
  console.log(`\nYelp customer rows with rawJson null but NOT matching strict survey pattern: ${noRawNotSurvey.length}`);
  console.log('(First 20 sample):');
  for (const m of noRawNotSurvey.slice(0, 20)) {
    console.log(`  ${m.sentAt?.toISOString()} thread=${m.conversationId?.slice(0,8)} ext=${m.externalMessageId ?? 'null'} content="${(m.content || '').substring(0, 100).replace(/\n/g, ' \\n ')}"`);
  }

  // Check downstream impact: did an AI message follow within 5 min of any suspect row?
  console.log('\n=== Downstream AI replies within 5 min of strong-match suspect ===');
  for (const m of suspect) {
    if (!m.sentAt) continue;
    const window = new Date(m.sentAt.getTime() + 5 * 60 * 1000);
    const aiAfter = await p.message.findFirst({
      where: {
        conversationId: m.conversationId,
        sender: 'pro',
        senderType: 'ai',
        sentAt: { gt: m.sentAt, lte: window },
      },
      orderBy: { sentAt: 'asc' },
      select: { id: true, sentAt: true, content: true },
    });
    if (aiAfter) {
      console.log(`  ⚠ thread=${m.conversationId.slice(0,8)} fake=${m.sentAt.toISOString()} → AI replied at ${aiAfter.sentAt.toISOString()}`);
      console.log(`     AI said: ${(aiAfter.content || '').substring(0, 200).replace(/\n/g, ' \\n ')}`);
    }
  }

  // Also: check ANY same-Yelp-event-id BIZ-side message in same thread (the smoking gun)
  console.log('\n=== Same-event-id collision check (BIZ-side row with the SAME externalMessageId?) ===');
  for (const m of suspect) {
    if (!m.externalMessageId) continue;
    const dup = await p.message.findMany({
      where: { externalMessageId: m.externalMessageId, NOT: { id: m.id } },
      select: { id: true, sender: true, senderType: true, content: true, sentAt: true, conversationId: true },
    });
    if (dup.length) {
      console.log(`  thread=${m.conversationId.slice(0,8)} ext=${m.externalMessageId} → ${dup.length} other rows share this id:`);
      for (const d of dup) {
        console.log(`     other ${d.id.slice(0,8)} ${d.sender}/${d.senderType ?? '-'} content="${(d.content || '').substring(0, 100).replace(/\n/g, ' \\n ')}"`);
      }
    }
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
