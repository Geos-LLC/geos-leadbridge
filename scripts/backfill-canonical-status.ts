/**
 * Phase 4 — Backfill legacy Lead.status values to canonical statuses.
 *
 * Targets rows where Lead.status ∈ {Open, Picked, Canceled} AND sfJobId IS NULL.
 * Mapping:
 *   Open     → new
 *   Canceled → cancelled
 *   Picked   → mapThumbtackToLbStatus(platformStatus) ?? 'engaged'
 *
 * Safety:
 *   - Skips SF-linked leads (sfJobId != null)
 *   - Skips leads whose status is already canonical
 *   - Skips when mapping returns null (Picked + no usable platformStatus
 *     could not happen here, since 'engaged' is the fallback — but the
 *     guard is defensive in case mapping changes later)
 *   - Idempotent via deterministic sourceEventId — re-runs no-op via the
 *     existing dedup guard in writeStatus
 *   - Each successful change writes a LeadStatusAuditLog row with
 *     source='backfill', actorName='canonical-status-backfill'
 *   - platformStatus is never modified (writeStatus only mutates platformStatus
 *     when source='platform_sync')
 *
 * Modes:
 *   DRY_RUN=true   — print what would change, no writes
 *   DRY_RUN=false  — execute the writes (default false; pass DRY_RUN=true
 *                    explicitly to dry-run)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-canonical-status.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-canonical-status.ts
 *
 * Exit codes:
 *   0 — finished cleanly (any number of skips/applies)
 *   1 — fatal error (DB unreachable, mapping invariant violated, etc.)
 */

import { PrismaClient } from '../generated/prisma';
import { LeadStatusService } from '../src/leads/lead-status.service';
import { mapThumbtackToLbStatus } from '../src/integrations/thumbtack-status-map';

const LEGACY_STATUSES = ['Open', 'Picked', 'Canceled'];
const BATCH_SIZE = 100;

type LegacyStatus = (typeof LEGACY_STATUSES)[number];

function mapLegacyToCanonical(
  oldStatus: string,
  platformStatus: string | null,
): string | null {
  if (oldStatus === 'Open') return 'new';
  if (oldStatus === 'Canceled') return 'cancelled';
  if (oldStatus === 'Picked') {
    // Trust platformStatus when present — it's the truer signal (e.g. a Picked
    // lead with platformStatus='Job done' is really completed, not engaged).
    const fromPlatform = mapThumbtackToLbStatus(platformStatus);
    if (fromPlatform) return fromPlatform;
    return 'engaged'; // safe fallback per spec when no platformStatus signal
  }
  return null;
}

async function main() {
  const dryRun = (process.env.DRY_RUN ?? 'false').toLowerCase() === 'true';
  const prisma = new PrismaClient();

  // Stub config + events — backfill source doesn't read config or emit events.
  const config = { get: (_k: string, def?: any) => def } as any;
  const events = { emit: () => {} } as any;
  const svc = new LeadStatusService(prisma as any, events, config);

  console.log(`\n=== Backfill canonical Lead.status (${dryRun ? 'DRY RUN' : 'LIVE WRITE'}) ===\n`);

  // Pull all candidates up front. Total volume from Phase 3 integrity check
  // was 606 + 84, well under the cost of streaming.
  const candidates = await prisma.lead.findMany({
    where: {
      status: { in: LEGACY_STATUSES },
      sfJobId: null,
    },
    select: {
      id: true,
      status: true,
      platform: true,
      platformStatus: true,
      thumbtackStatus: true,
      sfJobId: true,
      userId: true,
    },
  });

  console.log(`Found ${candidates.length} candidate leads.\n`);

  // Tally what we WOULD do, then optionally execute. Helpful for dry-run output.
  const counters = {
    total: candidates.length,
    skipSfLinked: 0, // defensive — query already excludes these
    skipNoMapping: 0,
    plannedApplies: new Map<string, number>(), // mappedStatus → count
    appliedThisRun: 0,
    duplicateSkipsThisRun: 0, // re-runs hit dedup guard
    otherSkipsThisRun: new Map<string, number>(),
    errorsThisRun: 0,
  };

  let batchIndex = 0;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    batchIndex++;
    const batch = candidates.slice(i, i + BATCH_SIZE);

    for (const lead of batch) {
      // Defensive guard — Prisma query already filtered, but tightening here
      // means a code reader of just this loop sees the rule explicitly.
      if (lead.sfJobId) {
        counters.skipSfLinked++;
        continue;
      }

      const platformVal = lead.platformStatus ?? lead.thumbtackStatus ?? null;
      const mapped = mapLegacyToCanonical(lead.status, platformVal);
      if (!mapped) {
        counters.skipNoMapping++;
        continue;
      }

      counters.plannedApplies.set(mapped, (counters.plannedApplies.get(mapped) ?? 0) + 1);

      if (dryRun) continue;

      const sourceEventId = `canonical_backfill_${lead.id}_${lead.status}`;

      try {
        const result = await svc.writeStatus({
          leadId: lead.id,
          source: 'backfill',
          newStatus: mapped,
          actorType: 'system',
          actorName: 'canonical-status-backfill',
          sourceEventId,
          reason: `legacy_canonicalization:${lead.status}->${mapped}`,
        });
        if (result.applied) {
          counters.appliedThisRun++;
        } else if (result.skipReason === 'duplicate') {
          counters.duplicateSkipsThisRun++;
        } else {
          const reason = result.skipReason ?? 'unknown';
          counters.otherSkipsThisRun.set(
            reason,
            (counters.otherSkipsThisRun.get(reason) ?? 0) + 1,
          );
        }
      } catch (err: any) {
        counters.errorsThisRun++;
        console.error(`  [error] lead=${lead.id.slice(0, 8)} status=${lead.status}->${mapped} msg=${err.message}`);
      }
    }

    console.log(
      `  batch ${batchIndex} (${i + batch.length}/${candidates.length}): ` +
        (dryRun
          ? 'dry-run, no writes'
          : `applied=${counters.appliedThisRun} dup=${counters.duplicateSkipsThisRun} other_skip=${[...counters.otherSkipsThisRun.entries()].map(([k, v]) => `${k}=${v}`).join(',') || 'none'} err=${counters.errorsThisRun}`),
    );
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log('\n=== Summary ===');
  console.table([
    { metric: 'candidate leads', n: counters.total },
    { metric: 'skip: sfJobId not null (defensive)', n: counters.skipSfLinked },
    { metric: 'skip: no mapping available', n: counters.skipNoMapping },
  ]);

  console.log('\nPlanned canonical mappings (would be / were applied):');
  console.table(
    [...counters.plannedApplies.entries()].map(([mapped, n]) => ({ mapped, n })),
  );

  if (!dryRun) {
    console.log('\nLive-run results:');
    console.table([
      { result: 'applied', n: counters.appliedThisRun },
      { result: 'duplicate (idempotent re-run)', n: counters.duplicateSkipsThisRun },
      { result: 'errors', n: counters.errorsThisRun },
    ]);
    if (counters.otherSkipsThisRun.size > 0) {
      console.log('Unexpected skip reasons (investigate):');
      console.table(
        [...counters.otherSkipsThisRun.entries()].map(([reason, n]) => ({ reason, n })),
      );
    }
  } else {
    console.log('\nDry run complete — re-run with DRY_RUN=false to apply.');
  }

  await prisma.$disconnect();

  if (counters.errorsThisRun > 0) {
    console.error(`\nFinished with ${counters.errorsThisRun} error(s).`);
    process.exit(1);
  }
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
