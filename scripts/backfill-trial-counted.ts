/**
 * Backfill — count existing trial-window leads against the new trial meter.
 *
 * The trial meter changed from "first AI auto-reply per conversation" to
 * "inbound lead delivery" (see TrialService.consumeLead in
 * src/trial/trial.service.ts and the wire-up in src/webhooks/webhooks.service.ts).
 * This script reconciles existing non-paid trial users so their
 * User.trialLeadsHandled reflects actual inbound deliveries during their
 * trial window — independent of whether they ever fired an AI reply.
 *
 * Scope per user:
 *   - subscriptionTier IS NULL  (paid users untouched)
 *   - trialStartDate IS NOT NULL  (trial actually started)
 *   - trialType IS NOT NULL  (adaptive trial config exists)
 *
 * Per user, identify in-window Leads:
 *   - userId matches
 *   - createdAt >= user.trialStartDate
 *   - trialCounted = false  (never been counted yet)
 *   - platform IN ('thumbtack', 'yelp')  (real platforms — excludes
 *     'test' synthetic leads from call-connect tests)
 *
 * Note on imports: Chrome-extension scrape imports and TT sync upserts
 * preserve the original Yelp/TT createdAt of the source lead. Historical
 * scrapes therefore have createdAt << trialStartDate and are filtered out
 * by the date predicate. The rare case of a scrape importing a recent
 * (post-trial-start) lead overlaps with the webhook delivery for the same
 * externalRequestId and produces a single Lead row — same outcome whether
 * counted or not.
 *
 * Atomic per-user transaction:
 *   1. Flip trialCounted=true on matching leads (returns count).
 *   2. SET User.trialLeadsHandled = (that count) — ground-truth reset.
 *   3. If the new count >= trialLeadsLimit on a LEAD_BASED/HYBRID trial,
 *      mark trialEndedAt=now() if not already set.
 *
 * Idempotency: re-running is safe. The CAS predicate (trialCounted=false)
 * means the second pass flips zero rows and the counter would be set to 0
 * — which is wrong. So step 2 SUMS already-counted leads plus newly-
 * counted, to converge on the same value on every run.
 *
 * Modes:
 *   DRY_RUN=true   — report what would change, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-trial-counted.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-trial-counted.ts
 *
 * Exit codes:
 *   0 — finished cleanly
 *   1 — fatal error
 */

import { PrismaClient, TrialType } from '../generated/prisma';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const COUNTED_PLATFORMS = ['thumbtack', 'yelp'];

async function main() {
  const prisma = new PrismaClient();
  console.log(`[backfill-trial-counted] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'}`);

  try {
    const users = await prisma.user.findMany({
      where: {
        subscriptionTier: null,
        trialStartDate: { not: null },
        trialType: { not: null },
      },
      select: {
        id: true,
        email: true,
        name: true,
        trialType: true,
        trialStartDate: true,
        trialEndDate: true,
        trialEndedAt: true,
        trialLeadsHandled: true,
        trialLeadsLimit: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`[backfill-trial-counted] scanning ${users.length} non-paid trial users`);

    let usersUpdated = 0;
    let totalLeadsMarked = 0;
    let trialsNowEnded = 0;

    for (const u of users) {
      const trialStart = u.trialStartDate!;

      // Sum of in-window webhook-eligible leads (already-counted + not-yet).
      // This is what trialLeadsHandled SHOULD be regardless of run count.
      const totalInWindow = await prisma.lead.count({
        where: {
          userId: u.id,
          createdAt: { gte: trialStart },
          platform: { in: COUNTED_PLATFORMS },
        },
      });

      const uncountedInWindow = await prisma.lead.count({
        where: {
          userId: u.id,
          createdAt: { gte: trialStart },
          platform: { in: COUNTED_PLATFORMS },
          trialCounted: false,
        },
      });

      if (uncountedInWindow === 0 && u.trialLeadsHandled === totalInWindow) {
        continue;
      }

      const trialExhausted =
        (u.trialType === TrialType.LEAD_BASED || u.trialType === TrialType.HYBRID) &&
        totalInWindow >= u.trialLeadsLimit;
      const willMarkEnded = trialExhausted && !u.trialEndedAt;

      console.log(
        `[backfill] user=${u.id} email=${u.email} trialType=${u.trialType} ` +
          `start=${trialStart.toISOString().slice(0, 10)} ` +
          `existingHandled=${u.trialLeadsHandled} totalInWindow=${totalInWindow} ` +
          `uncounted=${uncountedInWindow} limit=${u.trialLeadsLimit} ` +
          `markEnded=${willMarkEnded}`,
      );

      if (DRY_RUN) {
        if (uncountedInWindow > 0) totalLeadsMarked += uncountedInWindow;
        usersUpdated++;
        if (willMarkEnded) trialsNowEnded++;
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const flipResult = await tx.lead.updateMany({
          where: {
            userId: u.id,
            createdAt: { gte: trialStart },
            platform: { in: COUNTED_PLATFORMS },
            trialCounted: false,
          },
          data: { trialCounted: true },
        });
        totalLeadsMarked += flipResult.count;

        await tx.user.update({
          where: { id: u.id },
          data: { trialLeadsHandled: totalInWindow },
        });

        if (willMarkEnded) {
          await tx.user.updateMany({
            where: { id: u.id, trialEndedAt: null },
            data: { trialEndedAt: new Date() },
          });
          trialsNowEnded++;
        }
      });

      usersUpdated++;
    }

    console.log(
      `[backfill-trial-counted] done — ${DRY_RUN ? '[DRY_RUN] would have ' : ''}updated ${usersUpdated} users, ` +
        `marked ${totalLeadsMarked} leads, ended ${trialsNowEnded} trials`,
    );
  } catch (err: any) {
    console.error('[backfill-trial-counted] FAILED:', err?.message ?? err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
