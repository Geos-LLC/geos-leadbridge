/**
 * One-time cleanup for false-positive Yelp account-health flags.
 *
 * Before commit 63b8791-followup, FollowUpScheduler retried sends to leads
 * the customer had archived, and each failure wrote a SystemErrorLog row
 * with category='automation' and message containing "(403)" — which the
 * Yelp /health endpoint matched as "Yelp message send failed — reconnect".
 *
 * That's a false positive: tokens are fine, only the per-lead state is bad.
 *
 * This script marks resolved any unresolved category='automation' rows on
 * Yelp accounts whose message looks like that generic "(403)" wrapper.
 *
 * Safe to re-run. Skips rows newer than 60 minutes (current failures stay flagged).
 *
 * Usage: node scripts/resolve-stale-yelp-archived-errors.js
 */
require('dotenv').config();
const { PrismaClient } = require('../generated/prisma');

(async () => {
  const p = new PrismaClient();
  try {
    const yelpAccounts = await p.savedAccount.findMany({
      where: { platform: 'yelp' },
      select: { id: true, businessId: true, businessName: true },
    });
    const yelpIds = yelpAccounts.map(a => a.id);
    console.log(`Found ${yelpAccounts.length} Yelp accounts`);

    const cutoff = new Date(Date.now() - 60 * 60 * 1000);

    const stale = await p.systemErrorLog.findMany({
      where: {
        resolved: false,
        accountId: { in: yelpIds },
        category: 'automation',
        OR: [
          { message: { contains: '403' } },
          { message: { contains: 'NO_BUSINESS_ACCESS' } },
          { message: { contains: 'NOT_AUTHORIZED' } },
        ],
        createdAt: { lt: cutoff },
      },
      select: { id: true, accountId: true, message: true, createdAt: true },
    });

    if (stale.length === 0) {
      console.log('Nothing to clean up.');
      return;
    }

    console.log(`Will mark ${stale.length} stale entries resolved:`);
    for (const e of stale) {
      const a = yelpAccounts.find(x => x.id === e.accountId);
      console.log(`  ${e.createdAt.toISOString()}  ${a?.businessName || e.accountId}  ${e.message.slice(0, 100)}`);
    }

    const res = await p.systemErrorLog.updateMany({
      where: { id: { in: stale.map(x => x.id) } },
      data: { resolved: true },
    });
    console.log(`\nResolved ${res.count} entries.`);
  } finally {
    await p.$disconnect();
  }
})();
