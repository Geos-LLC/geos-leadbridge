/**
 * Cross-instance cron mutual exclusion via transaction-scoped advisory locks.
 *
 * History:
 * Crons were originally guarded with session-scoped pg_try_advisory_lock(N)
 * paired with a manual pg_advisory_unlock(N) in a finally block. Through
 * Supavisor (Supabase's PgBouncer-style transaction pooler) the unlock query
 * frequently lands on a different physical connection than the one that
 * acquired the lock and silently no-ops, leaving the lock orphaned. Once a
 * single key was orphaned every subsequent cron tick logged "Another instance
 * holds the lock" forever — observed starvation across HealthCheck (7003),
 * StalePending (7005), FollowUpScheduler (7001/7003), and others.
 *
 * pg_try_advisory_xact_lock(N) is bound to the current transaction. The
 * database releases it automatically on COMMIT or ROLLBACK regardless of
 * which physical connection runs the cleanup, so the orphan path is
 * structurally impossible. Run the work inside the same $transaction that
 * acquired the lock and you never need an explicit unlock.
 */

import type { Logger } from '@nestjs/common';
import type { PrismaService } from './prisma.service';

/**
 * The transaction client argument that Prisma hands to the `$transaction`
 * callback. Models on it have the same shape as `PrismaService` so call sites
 * can treat either as the read/write surface.
 */
export type CronLockTx = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

/** A standalone PrismaService or an in-flight transaction client. */
export type CronLockDb = PrismaService | CronLockTx;

export interface WithCronLockOptions {
  /** Prisma transaction timeout (ms). Default 120s. Bump for crons that loop
   *  through many records or do external I/O. */
  timeoutMs?: number;
  /** How long Prisma will wait to start a transaction (ms). Default 5s. */
  maxWaitMs?: number;
}

/**
 * Run `work` inside a transaction guarded by a transaction-scoped advisory
 * lock. Returns either the work's result or `{ skipped: true }` when another
 * instance already held the lock. Errors propagate from `work` and roll the
 * transaction back, releasing the lock automatically — no manual unlock is
 * ever issued.
 *
 * The lock is held for the lifetime of the transaction, so external I/O
 * inside `work` keeps the lock pinned. For long-running crons (anything that
 * may exceed 2 minutes including network calls) pass `options.timeoutMs`.
 */
export async function withCronLock<T>(
  prisma: PrismaService,
  logger: Logger,
  lockKey: number,
  label: string,
  work: (tx: CronLockTx) => Promise<T>,
  options: WithCronLockOptions = {},
): Promise<T | { skipped: true }> {
  return prisma.$transaction(
    async tx => {
      const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(${lockKey}) AS locked
      `;
      if (!rows?.[0]?.locked) {
        logger.debug(`[${label}] Another instance holds the lock — skipping`);
        return { skipped: true } as { skipped: true };
      }
      return work(tx);
    },
    {
      timeout: options.timeoutMs ?? 120_000,
      maxWait: options.maxWaitMs ?? 5_000,
    },
  );
}

/** Type guard: did the helper short-circuit because another instance held the lock? */
export function isSkipped<T>(outcome: T | { skipped: true }): outcome is { skipped: true } {
  return typeof outcome === 'object' && outcome !== null && (outcome as any).skipped === true;
}
