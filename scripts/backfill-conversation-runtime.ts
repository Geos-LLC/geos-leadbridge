/**
 * Phase 1 backfill — derive durable conversation runtime state for existing
 * threads from the legacy fields. Idempotent: every write is conditional on
 * the target column being NULL, so re-running is a no-op.
 *
 * Run:
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/backfill-conversation-runtime.ts
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/backfill-conversation-runtime.ts --dry-run
 *
 * Hard rules (from Phase 1 spec):
 *   - additive only — never overwrite existing values
 *   - leave uncertain states null; do not invent
 *   - safe to re-run
 */

import { PrismaClient } from '../generated/prisma/client';

interface LegacyThreadInput {
  conversationId: string;
  awaitingCustomerReply: boolean;
  lastCustomerMessageAt: Date | null;
  lastBusinessMessageAt: Date | null;
  lastAiMessageAt: Date | null;
  followUpStatus: string | null;
  // From the linked Lead, if any:
  leadStatus: string | null;
  lostReason: string | null;
  statusSource: string | null;
}

export interface DerivedRuntime {
  conversationState: string | null;
  conversationStateReason: string | null;
  aiStatus: string | null;
  aiStatusReason: string | null;
  waitingSince: Date | null;
}

/**
 * Pure derivation function. Maps the legacy fields a conversation already has
 * to the canonical conversation runtime state. Conservative: returns `null`
 * for anything ambiguous so we don't invent state.
 *
 * Exported for unit testing.
 */
export function deriveRuntime(input: LegacyThreadInput): DerivedRuntime {
  const result: DerivedRuntime = {
    conversationState: null,
    conversationStateReason: null,
    aiStatus: null,
    aiStatusReason: null,
    waitingSince: null,
  };

  // ── conversationState ──────────────────────────────────────────────
  // Strong signals first (terminal states), then weaker ones.
  const status = (input.leadStatus || '').toLowerCase();
  const lostReason = (input.lostReason || '').toLowerCase();

  if (status === 'lost' && lostReason === 'opt_out') {
    result.conversationState = 'opted_out';
    result.conversationStateReason = 'backfill:lead_status_lost+opt_out';
    result.aiStatus = 'stopped_terminal';
    result.aiStatusReason = 'backfill:lead_status_lost+opt_out';
  } else if (status === 'lost' && lostReason === 'hired_someone') {
    result.conversationState = 'hired_elsewhere';
    result.conversationStateReason = 'backfill:lead_status_lost+hired_someone';
    result.aiStatus = 'stopped_terminal';
    result.aiStatusReason = 'backfill:lead_status_lost+hired_someone';
  } else if (status === 'booked') {
    result.conversationState = 'booked_in_lb';
    result.conversationStateReason = 'backfill:lead_status_booked';
    result.aiStatus = 'stopped_booked';
    result.aiStatusReason = 'backfill:lead_status_booked';
  } else if (status === 'archived') {
    result.conversationState = 'closed';
    result.conversationStateReason = 'backfill:lead_status_archived';
  } else if (input.followUpStatus === 'sent' && input.awaitingCustomerReply) {
    result.conversationState = 'awaiting_customer';
    result.conversationStateReason = 'backfill:awaiting_after_followup';
  } else if (input.awaitingCustomerReply && (input.lastAiMessageAt || input.lastBusinessMessageAt)) {
    // Some business-side message went out and we're waiting on the customer.
    // Pick ai_engaging vs awaiting_customer based on which side spoke last.
    const lastAi = input.lastAiMessageAt?.getTime() ?? 0;
    const lastBiz = input.lastBusinessMessageAt?.getTime() ?? 0;
    if (lastAi > 0 && lastAi >= lastBiz) {
      result.conversationState = 'ai_engaging';
      result.conversationStateReason = 'backfill:last_msg_ai';
    } else {
      result.conversationState = 'awaiting_customer';
      result.conversationStateReason = 'backfill:last_msg_business';
    }
  } else if (!input.awaitingCustomerReply && input.lastCustomerMessageAt) {
    result.conversationState = 'customer_replied';
    result.conversationStateReason = 'backfill:last_msg_customer';
  }
  // else: leave conversationState null — not enough signal

  // ── waitingSince ───────────────────────────────────────────────────
  // Best available approximation: max(lastAiMessageAt, lastBusinessMessageAt)
  // when awaitingCustomerReply=true. We don't have the exact transition
  // moment, but the most recent pro message is the closest available marker.
  if (input.awaitingCustomerReply) {
    const lastAi = input.lastAiMessageAt?.getTime() ?? 0;
    const lastBiz = input.lastBusinessMessageAt?.getTime() ?? 0;
    const maxPro = Math.max(lastAi, lastBiz);
    if (maxPro > 0) {
      result.waitingSince = new Date(maxPro);
    }
  }

  return result;
}

export interface BackfillStats {
  scanned: number;
  threadContextsUpdated: number;
  leadsUpdated: number;
  skipped: number;
  errors: number;
}

export async function runBackfill(opts: { dryRun: boolean; batchSize?: number }): Promise<BackfillStats> {
  const prisma = new PrismaClient();
  const batchSize = opts.batchSize ?? 500;
  const stats: BackfillStats = {
    scanned: 0,
    threadContextsUpdated: 0,
    leadsUpdated: 0,
    skipped: 0,
    errors: 0,
  };

  try {
    // ── Pass 1: ThreadContext runtime + waitingSince ──────────────────
    // Only scan rows where ALL Phase-1 columns are null (true idempotency).
    // If even one was set by a parallel runtime write since the migration,
    // skip — that write is more authoritative than this derivation.
    let cursor: string | null = null;
    while (true) {
      const rows: any[] = await prisma.threadContext.findMany({
        where: {
          conversationState: null,
          aiStatus: null,
          waitingSince: null,
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          conversationId: true,
          leadId: true,
          awaitingCustomerReply: true,
          lastCustomerMessageAt: true,
          lastBusinessMessageAt: true,
          lastAiMessageAt: true,
          followUpStatus: true,
          lead: {
            select: {
              status: true,
              lostReason: true,
              statusSource: true,
            },
          },
        },
      });

      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      stats.scanned += rows.length;

      for (const row of rows) {
        const derived = deriveRuntime({
          conversationId: row.conversationId,
          awaitingCustomerReply: row.awaitingCustomerReply,
          lastCustomerMessageAt: row.lastCustomerMessageAt,
          lastBusinessMessageAt: row.lastBusinessMessageAt,
          lastAiMessageAt: row.lastAiMessageAt,
          followUpStatus: row.followUpStatus,
          leadStatus: row.lead?.status ?? null,
          lostReason: row.lead?.lostReason ?? null,
          statusSource: row.lead?.statusSource ?? null,
        });

        const dataPatch: Record<string, any> = {};
        if (derived.conversationState !== null) {
          dataPatch.conversationState = derived.conversationState;
          dataPatch.conversationStateAt = new Date();
          dataPatch.conversationStateReason = derived.conversationStateReason;
        }
        if (derived.aiStatus !== null) {
          dataPatch.aiStatus = derived.aiStatus;
          dataPatch.aiStatusAt = new Date();
          dataPatch.aiStatusReason = derived.aiStatusReason;
        }
        if (derived.waitingSince !== null) {
          dataPatch.waitingSince = derived.waitingSince;
        }

        if (Object.keys(dataPatch).length === 0) {
          stats.skipped++;
          continue;
        }

        if (!opts.dryRun) {
          try {
            // updateMany so a row mutated by a concurrent runtime write
            // (any new field now non-null) is skipped automatically.
            const result = await prisma.threadContext.updateMany({
              where: {
                id: row.id,
                conversationState: null,
                aiStatus: null,
                waitingSince: null,
              },
              data: dataPatch,
            });
            if (result.count === 1) stats.threadContextsUpdated++;
            else stats.skipped++;
          } catch (err: any) {
            console.error(`[backfill] threadContext ${row.id} failed: ${err.message}`);
            stats.errors++;
          }
        } else {
          stats.threadContextsUpdated++; // would-update count
        }
      }
    }

    // ── Pass 2: Lead.sfJobOutcome from existing statusSource=service_flow ─
    // Copy each SF-linked lead's current Lead.status (which today carries
    // SF's lifecycle) into sfJobOutcome. Conservative: skip leads where
    // sfJobOutcome is already non-null (already covered by Phase-1 inbound
    // writes since the migration).
    cursor = null;
    while (true) {
      const leads: any[] = await prisma.lead.findMany({
        where: {
          statusSource: 'service_flow',
          sfJobOutcome: null,
          sfLastEventAt: { not: null },
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          status: true,
          sfLastEventAt: true,
        },
      });

      if (leads.length === 0) break;
      cursor = leads[leads.length - 1].id;

      for (const lead of leads) {
        if (!opts.dryRun) {
          try {
            const result = await prisma.lead.updateMany({
              where: { id: lead.id, sfJobOutcome: null },
              data: {
                sfJobOutcome: lead.status,
                sfJobOutcomeAt: lead.sfLastEventAt,
              },
            });
            if (result.count === 1) stats.leadsUpdated++;
            else stats.skipped++;
          } catch (err: any) {
            console.error(`[backfill] lead ${lead.id} failed: ${err.message}`);
            stats.errors++;
          }
        } else {
          stats.leadsUpdated++;
        }
      }
    }
  } finally {
    await prisma.$disconnect();
  }

  return stats;
}

// CLI entry point
if (require.main === module) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const batchSizeArg = args.find((a) => a.startsWith('--batch-size='));
  const batchSize = batchSizeArg ? parseInt(batchSizeArg.split('=')[1], 10) : 500;

  console.log(`[backfill] starting dryRun=${dryRun} batchSize=${batchSize}`);
  runBackfill({ dryRun, batchSize })
    .then((stats) => {
      console.log('[backfill] done', JSON.stringify(stats, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error('[backfill] fatal:', err);
      process.exit(1);
    });
}
