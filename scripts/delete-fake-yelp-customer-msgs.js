const { PrismaClient } = require('../generated/prisma');
const p = new PrismaClient();

// 11 confirmed-fake customer Message rows surfaced by audit-fake-yelp-customer-msgs.js
// Fingerprint: platform=yelp, sender=customer, rawJson=null, ms-precision sentAt,
// content matches Yelp survey-answer dump format. The matching event IDs in Yelp's
// canonical API resolve to BIZ-side messages (not customer messages).
const TARGETS = [
  '27fe041a-6f53-4174-b11b-ddf43ef43fec',
  '461e8a09-c47a-4ad8-bb99-bdb08425922e',
  'bc03ac3e-3741-4cef-be07-0b18b1916dc1',
  '828f4902-7f42-4bbe-877c-7c616634a2c8',
  '51cb6308-bbb2-4f94-a42f-c171ae67ed37',
  '7981682f-08bb-4e42-a87d-8fdbb813fc37', // Elaine — original report
  'c7aa8d26-ad68-4f9f-bf6c-5ba6ff80dae5',
  'f338bc3a-3119-461c-80be-ef5cc93db7e8',
  'd3c08f98-aa6b-4da0-bebe-0ceaa9ee1d27',
  '75fdb380-9850-4710-b0aa-a36c2e0828c9',
  '6fe7a762-fb76-4997-854e-425ce7df477a',
];

(async () => {
  const dryRun = process.env.APPLY !== 'true';
  if (dryRun) console.log('DRY RUN — set APPLY=true to actually delete.\n');

  // Re-verify each target matches the fingerprint before deleting
  const rows = await p.message.findMany({
    where: { id: { in: TARGETS } },
    select: { id: true, platform: true, sender: true, rawJson: true, sentAt: true, content: true, externalMessageId: true, conversationId: true },
  });

  if (rows.length !== TARGETS.length) {
    console.log(`Expected ${TARGETS.length} rows, found ${rows.length}. Missing rows would be skipped.`);
  }

  let safe = 0;
  const safeIds = [];
  for (const m of rows) {
    const okPlatform = m.platform === 'yelp';
    const okSender = m.sender === 'customer';
    const okRaw = m.rawJson === null;
    const okMs = m.sentAt && m.sentAt.getMilliseconds() !== 0;
    if (okPlatform && okSender && okRaw && okMs) {
      safe++;
      safeIds.push(m.id);
      console.log(`  ✓ ${m.id} thread=${m.conversationId.slice(0,8)} ext=${m.externalMessageId} sentAt=${m.sentAt.toISOString()}`);
    } else {
      console.log(`  ✗ ${m.id} fingerprint mismatch (platform=${m.platform} sender=${m.sender} hasRaw=${m.rawJson!==null} ms=${m.sentAt?.getMilliseconds()}) — SKIP`);
    }
  }
  console.log(`\n${safe}/${TARGETS.length} rows match fingerprint and would be deleted.\n`);

  if (dryRun) {
    console.log('Dry-run complete. Re-run with APPLY=true to delete.');
  } else {
    const r = await p.message.deleteMany({ where: { id: { in: safeIds } } });
    console.log(`Deleted ${r.count} rows.`);

    // Invalidate caches for affected threads — touch each conversation row.
    const threads = [...new Set(rows.map(m => m.conversationId))];
    console.log(`Affected threads (${threads.length}):`);
    for (const t of threads) console.log(`  ${t}`);
  }

  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
