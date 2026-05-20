const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

// Fingerprint of the unknown-outcome placeholder bug:
//  - platform = 'yelp'
//  - sender = 'customer' + senderType = 'customer'
//  - rawJson IS NULL
//  - content = '' (empty string)
//  - sentAt has non-zero milliseconds (programmatic creation)
//  - externalMessageId is a real Yelp event id (but the row is a placeholder
//    for an event that the classifier couldn't fetch due to a 401/403 token).
(async () => {
  const dryRun = process.env.APPLY !== 'true';
  if (dryRun) console.log('DRY RUN — set APPLY=true to actually delete.\n');

  const rows = await p.message.findMany({
    where: { platform: 'yelp', sender: 'customer', rawJson: null, content: '' },
    select: { id: true, conversationId: true, sentAt: true, externalMessageId: true, userId: true },
    orderBy: { sentAt: 'desc' },
  });

  let safe = 0;
  const safeIds = [];
  for (const m of rows) {
    const msMs = m.sentAt ? m.sentAt.getMilliseconds() : 0;
    if (msMs === 0) {
      console.log(`  ✗ ${m.id} no ms-precision (sentAt=${m.sentAt?.toISOString()}) — SKIP (not the bug fingerprint)`);
      continue;
    }
    safe++;
    safeIds.push(m.id);
    console.log(`  ✓ ${m.id} thread=${m.conversationId.slice(0,8)} ext=${m.externalMessageId ?? '-'} sentAt=${m.sentAt.toISOString()}`);
  }
  console.log(`\n${safe}/${rows.length} match fingerprint.`);

  if (dryRun) {
    console.log('Dry-run complete. Re-run with APPLY=true to delete.');
  } else {
    const r = await p.message.deleteMany({ where: { id: { in: safeIds } } });
    console.log(`Deleted ${r.count} rows.`);
    const threads = [...new Set(rows.filter(m => safeIds.includes(m.id)).map(m => m.conversationId))];
    console.log(`Affected threads: ${threads.length}`);
    for (const t of threads) console.log(`  ${t}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
