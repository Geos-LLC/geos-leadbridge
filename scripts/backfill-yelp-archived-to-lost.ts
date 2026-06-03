/**
 * One-off backfill: remap historical Yelp leads from canonical `archived`
 * to canonical `lost` (lostReason='hired_someone').
 *
 * Why this exists
 * ───────────────
 * Through 2026-06-03 the Yelp status map sent raw "Archived" to canonical
 * `archived`. Per the spec landed in [feat(yelp): archive → No hire, with
 * SF-link protection], that mapping is wrong: Yelp "archived" really means
 * "the lead didn't convert" and should surface in LB as "No hire"
 * (`status=lost`, `lostReason=hired_someone`). The frontend pill groups
 * `lost` under "No hire" already.
 *
 * This script corrects the 152 prod rows that landed at canonical `archived`
 * before the fix. Going forward, new archives flow through the corrected
 * mapping + SF-link guard in `applyPlatformSync`.
 *
 * Why direct writes (not LeadStatusService.writeStatus)
 * ─────────────────────────────────────────────────────
 * `archived` is HARD_TERMINAL in canonical-status.ts. Every source other
 * than service_flow's archived-reactivation carve-out is hard-blocked from
 * mutating an archived lead. That guard is correct for live writes — we
 * don't want a marketplace sweep undoing an explicit archive — but it
 * blocks this one-off correction. So this script bypasses the service
 * with a direct transactional update + manual LeadStatusAuditLog row.
 *
 * Safety guarantees
 * ─────────────────
 *   - **SF-link guard**: skips any candidate whose sfJobId, sfCustomerId,
 *     or syncStatus='linked' is set. Matches the live SF-link guard
 *     semantics, so even though today the scope query says 0/152 are
 *     linked, a row that becomes linked between scope and apply still
 *     gets skipped.
 *   - **Yelp-only**: filters platform='yelp'. Thumbtack archives go via
 *     a separate map (`thumbtack-status-map.ts`) that still maps Archived
 *     to canonical archived (intentional — TT semantics differ).
 *   - **Idempotent**: each write carries a deterministic sourceEventId
 *     `yelp_archived_remap_<leadId>`. A second run finds the prior audit
 *     row and reports `dup`, no second update.
 *   - **Audit row**: every applied change writes a LeadStatusAuditLog
 *     row with source='backfill', actorName='yelp-archive-remap',
 *     reason='yelp_archive_canonical_remap', metadata carrying the
 *     pre/post snapshot for forensic replay.
 *   - **lostReason='hired_someone'**: matches what new archive events
 *     now persist via getYelpLostReason() in yelp-status-map.ts.
 *   - **platformStatus preserved**: keeps the raw "Archived" breadcrumb.
 *
 * Modes
 * ─────
 *   DRY_RUN=true   — count only, no writes (default)
 *   DRY_RUN=false  — apply
 *
 * Usage
 * ─────
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-yelp-archived-to-lost.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-yelp-archived-to-lost.ts
 */

import { Prisma, PrismaClient } from '../generated/prisma';

const BATCH_SIZE = 50;

async function main() {
  const dryRun = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
  const prisma = new PrismaClient();

  console.log(
    `\n=== Yelp archived → lost backfill (${dryRun ? 'DRY RUN' : 'LIVE WRITE'}) ===\n`,
  );

  const candidates = await prisma.lead.findMany({
    where: {
      platform: 'yelp',
      status: 'archived',
      // SF-link guard mirror — skip linked leads at scope time. The
      // per-lead guard inside the loop is a defense in depth against
      // a row becoming linked between scope and apply.
      sfJobId: null,
      sfCustomerId: null,
      OR: [{ syncStatus: null }, { syncStatus: { not: 'linked' } }],
    },
    select: {
      id: true,
      userId: true,
      status: true,
      platformStatus: true,
      sfJobId: true,
      sfCustomerId: true,
      syncStatus: true,
      lostReason: true,
      statusUpdatedAt: true,
    },
  });

  console.log(`Found ${candidates.length} candidate Yelp 'archived' leads.\n`);

  const counters = {
    total: candidates.length,
    skipSfLinkedDefensive: 0,
    skipNotArchived: 0,
    applied: 0,
    duplicateSkips: 0,
    errors: 0,
  };

  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batch = candidates.slice(i, i + BATCH_SIZE);

    for (const lead of batch) {
      // Defense in depth — query already filtered, but a concurrent SF
      // linkage between scope and apply must still be skipped.
      if (
        lead.sfJobId ||
        lead.sfCustomerId ||
        lead.syncStatus === 'linked'
      ) {
        counters.skipSfLinkedDefensive++;
        continue;
      }
      // Defense against status drift between scope and apply.
      if (lead.status !== 'archived') {
        counters.skipNotArchived++;
        continue;
      }

      if (dryRun) continue;

      const sourceEventId = `yelp_archived_remap_${lead.id}`;

      try {
        // Idempotency check — bail before any write if we've already
        // logged this exact remap. Mirrors the dedup guard in writeStatus.
        const prior = await prisma.leadStatusAuditLog.findFirst({
          where: {
            leadId: lead.id,
            source: 'backfill',
            sourceEventId,
          },
          select: { id: true },
        });
        if (prior) {
          counters.duplicateSkips++;
          continue;
        }

        const now = new Date();
        await prisma.$transaction(async (tx) => {
          await tx.lead.update({
            where: { id: lead.id },
            data: {
              status: 'lost',
              statusSource: 'backfill',
              statusUpdatedAt: now,
              lostReason: 'hired_someone',
              // Don't touch reengageAt — backfill has no opinion; later
              // writes (manual or SF) can set it if relevant.
            },
          });

          await tx.leadStatusAuditLog.create({
            data: {
              leadId: lead.id,
              activityType: 'status_changed',
              oldStatus: 'archived',
              newStatus: 'lost',
              source: 'backfill',
              sourceEventId,
              actorType: 'system',
              actorName: 'yelp-archive-remap',
              reason: 'yelp_archive_canonical_remap',
              metadata: {
                platformStatus: lead.platformStatus,
                priorLostReason: lead.lostReason,
                priorStatusUpdatedAt: lead.statusUpdatedAt?.toISOString() ?? null,
                note: 'Yelp Archived is "No hire" per 2026-06-03 spec; old map left these at canonical archived.',
              } as Prisma.InputJsonValue,
              conflict: false,
              conflictNote: null,
              occurredAt: now,
            },
          });
        });

        counters.applied++;
      } catch (err: any) {
        counters.errors++;
        console.error(
          `  [error] lead=${lead.id.slice(0, 8)} msg=${err?.message ?? err}`,
        );
      }
    }

    console.log(
      `  batch ${Math.floor(i / BATCH_SIZE) + 1} (${Math.min(i + BATCH_SIZE, candidates.length)}/${candidates.length}): ` +
        (dryRun
          ? 'dry-run, no writes'
          : `applied=${counters.applied} dup=${counters.duplicateSkips} sf_skipped=${counters.skipSfLinkedDefensive} drift_skipped=${counters.skipNotArchived} err=${counters.errors}`),
    );
  }

  console.log('\n=== Summary ===');
  console.table([
    { metric: 'candidate leads', n: counters.total },
    { metric: 'skip: SF-linked (defensive, post-scope)', n: counters.skipSfLinkedDefensive },
    { metric: 'skip: status drift (no longer archived)', n: counters.skipNotArchived },
    {
      metric: dryRun ? 'would apply' : 'applied',
      n: dryRun ? counters.total - counters.skipSfLinkedDefensive - counters.skipNotArchived : counters.applied,
    },
    { metric: 'duplicate (idempotent re-run)', n: counters.duplicateSkips },
    { metric: 'errors', n: counters.errors },
  ]);

  if (dryRun) {
    console.log('\nDry run complete — re-run with DRY_RUN=false to apply.');
  } else {
    console.log('\nLive write complete.');
  }

  await prisma.$disconnect();

  if (counters.errors > 0) {
    console.error(`\nFinished with ${counters.errors} error(s).`);
    process.exit(1);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
