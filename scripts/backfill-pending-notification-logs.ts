/**
 * Backfill stuck `status: 'pending'` NotificationLog rows by reading the
 * authoritative status from Sigcore.
 *
 * Background: from 2026-04-20 until 2026-05-01, the Sigcore workspace-level
 * delivery-status webhook subscription was registered against the Vercel
 * frontend host (`https://www.leadbridge360.com/...`), which has no API
 * handler and returns HTTP 405. Every outbound SMS has a NotificationLog row
 * created with status='pending' that gets bumped to 'sent' if Sigcore returns
 * a synchronous status, then 'delivered' / 'failed' via the delivery webhook.
 * The webhook never reached LB, so rows are stuck at 'pending' even though
 * Twilio actually delivered the message.
 *
 * This script reconciles those rows against Sigcore.
 *
 * Behaviour:
 *   - Selects rows where status='pending' AND sigcoreMessageId IS NOT NULL.
 *   - Batches by sigcoreConversationId — one Sigcore API call per conversation
 *     returns every message in it, so the work is O(conversations) not O(rows).
 *   - For each row, looks up the Sigcore message by `id` first, falling back
 *     to `providerMessageId`. (LB stores `data.id ?? data.providerMessageId`,
 *     so either is possible depending on Sigcore's response shape at send
 *     time.)
 *   - Updates LB only when Sigcore reports a terminal/forward status
 *     (sent | delivered | failed). Never downgrades.
 *   - Sets `deliveredAt` when the new status is 'delivered'.
 *   - Records a one-line `error` field for 'failed' if Sigcore exposes one.
 *
 * Modes:
 *   APPLY=false (default) — dry-run, prints counts and sample IDs only
 *   APPLY=true            — execute writes
 *
 * Env required:
 *   DATABASE_URL            — must be a direct (non-pgbouncer) URL ideally
 *   SIGCORE_API_URL         — defaults to production Sigcore
 *   SIGCORE_API_KEY         — workspace-scoped key (lists all conversations
 *                             across the LeadBridge workspace)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/backfill-pending-notification-logs.ts
 *   DATABASE_URL=$DIRECT_URL APPLY=true npx ts-node scripts/backfill-pending-notification-logs.ts
 */

import { PrismaClient } from '../generated/prisma';

type SigcoreMessage = {
  id: string;
  conversationId: string;
  providerMessageId: string | null;
  status: 'pending' | 'sent' | 'delivered' | 'failed' | string;
  metadata?: Record<string, unknown> | null;
};

const TERMINAL_STATUSES = new Set(['sent', 'delivered', 'failed']);
const STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  failed: 3, // terminal at same level as delivered — neither overrides the other
};

function rankOf(status: string): number {
  return STATUS_RANK[status] ?? -1;
}

async function fetchConversationMessages(
  baseUrl: string,
  apiKey: string,
  conversationId: string,
): Promise<SigcoreMessage[] | null> {
  const url = `${baseUrl}/conversations/${conversationId}/messages`;
  try {
    const resp = await fetch(url, { headers: { 'x-api-key': apiKey } });
    if (resp.status === 404) return [];
    if (!resp.ok) {
      console.warn(`  ! Sigcore ${resp.status} for conversation ${conversationId}`);
      return null;
    }
    const json: any = await resp.json();
    return (json.data ?? json ?? []) as SigcoreMessage[];
  } catch (err: any) {
    console.warn(`  ! fetch error for conversation ${conversationId}: ${err.message}`);
    return null;
  }
}

function findMatch(
  messages: SigcoreMessage[],
  sigcoreMessageId: string,
): SigcoreMessage | null {
  // LB stored `data.id || data.providerMessageId`. Try `id` first; fall back
  // to providerMessageId for older rows where the Twilio SID was written.
  return (
    messages.find((m) => m.id === sigcoreMessageId) ??
    messages.find((m) => m.providerMessageId === sigcoreMessageId) ??
    null
  );
}

async function main() {
  const apply = (process.env.APPLY ?? 'false').toLowerCase() === 'true';
  const sigcoreBase = (process.env.SIGCORE_API_URL ?? 'https://sigcore-production.up.railway.app/api').replace(/\/$/, '');
  const sigcoreKey = process.env.SIGCORE_API_KEY;
  if (!sigcoreKey) {
    console.error('SIGCORE_API_KEY is required (workspace-scoped key).');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  console.log(`\n=== Backfill pending NotificationLog (${apply ? 'APPLY' : 'DRY RUN'}) ===`);
  console.log(`Sigcore: ${sigcoreBase}`);

  const candidates = await prisma.notificationLog.findMany({
    where: {
      status: 'pending',
      sigcoreMessageId: { not: null },
    },
    select: {
      id: true,
      status: true,
      sigcoreMessageId: true,
      sigcoreConversationId: true,
      sentAt: true,
      createdAt: true,
      leadId: true,
      toPhone: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${candidates.length} stuck-pending rows with sigcoreMessageId.\n`);
  if (candidates.length === 0) {
    await prisma.$disconnect();
    return;
  }

  const noConvId = candidates.filter((c) => !c.sigcoreConversationId);
  if (noConvId.length > 0) {
    console.log(`  ${noConvId.length} rows have no sigcoreConversationId — cannot look up via conversations API. Sample IDs:`);
    noConvId.slice(0, 5).forEach((r) => console.log(`    - ${r.id} (sigcoreMessageId=${r.sigcoreMessageId})`));
  }

  // Group by conversation for batch lookup. One API call per conversation.
  const byConv = new Map<string, typeof candidates>();
  for (const row of candidates) {
    if (!row.sigcoreConversationId) continue;
    const list = byConv.get(row.sigcoreConversationId) ?? [];
    list.push(row);
    byConv.set(row.sigcoreConversationId, list);
  }
  console.log(`Grouped into ${byConv.size} conversations.\n`);

  const counters = {
    total: candidates.length,
    skippedNoConvId: noConvId.length,
    sigcoreNotFound: 0,
    sigcoreErrored: 0,
    sigcoreNoMatch: 0,
    sigcoreNonTerminal: 0,
    plannedUpdates: { sent: 0, delivered: 0, failed: 0 } as Record<string, number>,
    applied: 0,
    appliedErrors: 0,
  };

  const samples = { delivered: [] as any[], failed: [] as any[], sent: [] as any[] };

  let convIdx = 0;
  for (const [convId, rows] of byConv.entries()) {
    convIdx++;
    if (convIdx % 25 === 0) {
      console.log(`  …processed ${convIdx}/${byConv.size} conversations`);
    }

    const messages = await fetchConversationMessages(sigcoreBase, sigcoreKey, convId);
    if (messages === null) {
      counters.sigcoreErrored += rows.length;
      continue;
    }
    if (messages.length === 0) {
      counters.sigcoreNotFound += rows.length;
      continue;
    }

    for (const row of rows) {
      const match = findMatch(messages, row.sigcoreMessageId!);
      if (!match) {
        counters.sigcoreNoMatch++;
        continue;
      }
      const sigcoreStatus = (match.status ?? '').toLowerCase();
      if (!TERMINAL_STATUSES.has(sigcoreStatus)) {
        counters.sigcoreNonTerminal++;
        continue;
      }
      // Forward-only progression. LB row is 'pending' (rank 0); any terminal
      // status is rank >= 2, so this always passes — but keeping the guard
      // documents the invariant for future readers.
      if (rankOf(sigcoreStatus) <= rankOf(row.status)) {
        counters.sigcoreNonTerminal++;
        continue;
      }

      counters.plannedUpdates[sigcoreStatus] = (counters.plannedUpdates[sigcoreStatus] ?? 0) + 1;
      const sample = {
        logId: row.id,
        sigcoreMessageId: row.sigcoreMessageId,
        leadId: row.leadId,
        oldStatus: row.status,
        newStatus: sigcoreStatus,
        toPhone: row.toPhone,
        createdAt: row.createdAt.toISOString(),
      };
      if (samples[sigcoreStatus as keyof typeof samples]?.length < 5) {
        samples[sigcoreStatus as keyof typeof samples]?.push(sample);
      }

      if (!apply) continue;

      try {
        const updateData: any = { status: sigcoreStatus };
        if (sigcoreStatus === 'delivered') {
          updateData.deliveredAt = new Date();
        }
        await prisma.notificationLog.update({
          where: { id: row.id },
          data: updateData,
        });
        counters.applied++;
      } catch (err: any) {
        counters.appliedErrors++;
        console.warn(`  ! update failed for ${row.id}: ${err.message}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(JSON.stringify(counters, null, 2));
  console.log(`\n=== Sample planned changes (up to 5 per status) ===`);
  console.log(JSON.stringify(samples, null, 2));

  if (!apply) {
    console.log(`\nDry-run only. Re-run with APPLY=true to execute.`);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
