// Audit + optional cleanup for Yelp duplicate AI/Platform message rows.
//
// Background: when Yelp's POST /leads/{id}/events returned no event_id, the
// outbound send wrote a synthetic Message row (externalMessageId=null,
// senderType='ai'/'user'). The same message was then re-inserted by the
// webhook full-thread persist or runYelpBackgroundSync with the real Yelp
// event_id and senderType=null. Result: two rows in the conversation - the UI
// renders one as "AI" and one as "Platform".
//
// Phase 1 of cleanup is a fix in code (ensureMessagePersisted now backfills);
// this script handles the existing dupes already in the DB.
//
// Modes:
//   (default) report only - prints suspected duplicate pairs, no writes.
//   --merge   for each pair: copy synthetic row's senderType to the real-id
//             row when it's null, then delete the synthetic row.
//             Requires --execute to actually mutate.
//
// Safety:
//   - Only considers conversations where BOTH rows exist with the same
//     normalized content + same sender + within a configurable time window.
//   - When --merge is set, dry-runs by default. --execute is required to
//     write. Each merge logs the rows it touches.
//   - Caps the result set so a runaway never deletes the whole table.

const { PrismaClient } = require('../generated/prisma');

const args = new Set(process.argv.slice(2));
const MODE_MERGE = args.has('--merge');
const EXECUTE = args.has('--execute');
const WINDOW_HOURS = Number(process.env.AUDIT_WINDOW_HOURS || 24);
const MAX_PAIRS = Number(process.env.AUDIT_MAX_PAIRS || 500);

function normalize(s) {
  return (s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[—–]/g, '--')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

(async () => {
  const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });
  try {
    // Fetch every Yelp pro/customer message row that's a candidate for either
    // side of a dupe pair. We pull the union (null externalMessageId + non-null
    // pro rows) per conversation and pair them in JS so we can run the same
    // normalize() the runtime helper uses.
    const rows = await prisma.message.findMany({
      where: {
        platform: 'yelp',
        sender: { in: ['pro', 'customer'] },
      },
      select: {
        id: true,
        conversationId: true,
        sender: true,
        senderType: true,
        externalMessageId: true,
        content: true,
        sentAt: true,
        userId: true,
      },
      orderBy: { sentAt: 'asc' },
    });

    // Group by (conversationId, sender) for pairing.
    const groups = new Map();
    for (const r of rows) {
      const key = `${r.conversationId}::${r.sender}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }

    const windowMs = WINDOW_HOURS * 60 * 60 * 1000;
    const pairs = [];
    for (const list of groups.values()) {
      const synthetic = list.filter(m => m.externalMessageId === null);
      const real = list.filter(m => m.externalMessageId !== null);
      if (synthetic.length === 0 || real.length === 0) continue;

      for (const s of synthetic) {
        const sNorm = normalize(s.content);
        if (!sNorm) continue;
        // Find best real-id match by content + closest sentAt within window.
        let best = null;
        let bestDelta = Infinity;
        for (const r of real) {
          if (normalize(r.content) !== sNorm) continue;
          const delta = Math.abs(new Date(r.sentAt).getTime() - new Date(s.sentAt).getTime());
          if (delta > windowMs) continue;
          if (delta < bestDelta) {
            best = r;
            bestDelta = delta;
          }
        }
        if (best) {
          pairs.push({ synthetic: s, real: best, deltaMs: bestDelta });
          if (pairs.length >= MAX_PAIRS) break;
        }
      }
      if (pairs.length >= MAX_PAIRS) break;
    }

    console.log(`=== Yelp duplicate-message audit ===`);
    console.log(`window: ${WINDOW_HOURS}h | mode: ${MODE_MERGE ? (EXECUTE ? 'merge+execute' : 'merge dry-run') : 'report-only'} | total pairs found: ${pairs.length}${pairs.length === MAX_PAIRS ? ' (cap reached)' : ''}`);
    console.log('');

    if (pairs.length === 0) {
      console.log('CLEAN - no duplicate Yelp messages detected.');
      return;
    }

    // Summary table
    console.table(
      pairs.slice(0, 50).map(p => ({
        conversationId: p.synthetic.conversationId.slice(0, 8),
        sender: p.synthetic.sender,
        synthSenderType: p.synthetic.senderType || '(null)',
        realSenderType: p.real.senderType || '(null)',
        deltaSec: Math.round(p.deltaMs / 1000),
        contentPreview: (p.synthetic.content || '').slice(0, 60),
      })),
    );
    if (pairs.length > 50) console.log(`(${pairs.length - 50} more pairs not shown)`);

    // Coverage breakdown by senderType combination
    const counts = {};
    for (const p of pairs) {
      const k = `${p.synthetic.senderType || 'null'} -> ${p.real.senderType || 'null'}`;
      counts[k] = (counts[k] || 0) + 1;
    }
    console.log('');
    console.log('=== Pairs by (synthetic.senderType -> real.senderType) ===');
    console.table(counts);

    if (!MODE_MERGE) {
      console.log('');
      console.log('Run with --merge --execute to fix these (synthetic senderType is preserved on the real-id row, then synthetic row is deleted).');
      return;
    }

    // Merge mode
    console.log('');
    console.log(`=== Merge plan (${EXECUTE ? 'EXECUTING' : 'DRY-RUN'}) ===`);
    let stamped = 0;
    let deleted = 0;
    let skipped = 0;
    for (const p of pairs) {
      const wantStamp =
        (p.real.senderType === null || p.real.senderType === undefined) &&
        p.synthetic.senderType &&
        (p.synthetic.senderType === 'ai' || p.synthetic.senderType === 'user');

      if (wantStamp) {
        console.log(
          `STAMP real=${p.real.id} senderType=${p.synthetic.senderType} (was ${p.real.senderType || 'null'}) | conv=${p.synthetic.conversationId.slice(0, 8)}`,
        );
        if (EXECUTE) {
          await prisma.message.update({
            where: { id: p.real.id },
            data: { senderType: p.synthetic.senderType },
          });
        }
        stamped++;
      }

      // Only delete if real row keeps the unique externalMessageId we want to
      // preserve. Both have same conversationId/content, so the real-id row is
      // the canonical one going forward.
      if (p.real.id !== p.synthetic.id) {
        console.log(`DELETE synthetic=${p.synthetic.id} | conv=${p.synthetic.conversationId.slice(0, 8)}`);
        if (EXECUTE) {
          await prisma.message.delete({ where: { id: p.synthetic.id } });
        }
        deleted++;
      } else {
        skipped++;
      }
    }

    console.log('');
    console.log(`Result: stamped=${stamped} deleted=${deleted} skipped=${skipped}${EXECUTE ? '' : ' (DRY-RUN - re-run with --execute to apply)'}`);
  } finally {
    await prisma.$disconnect();
  }
})();
