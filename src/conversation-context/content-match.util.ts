/**
 * Content-match dedup helper for outbound platform messages.
 *
 * Why this exists
 * ---------------
 * Some platforms (notably Yelp) don't always return an event_id on the POST
 * /events response. When that happens, `LeadsService.sendMessage` writes the
 * outbound row with `externalMessageId=null` so the UI gets an immediate echo.
 * Later the platform delivers the same message back via webhook (or it shows
 * up in a thread fetch / background sync) carrying a real event_id. Looking up
 * by `(platform, externalMessageId)` misses the local row, so a second copy is
 * inserted — once with `senderType='ai'` and the synthetic id, once with the
 * Yelp event_id and no senderType. The UI then renders both ("AI" + "Platform").
 *
 * This helper centralizes the "find the local synthetic row that matches an
 * incoming real-id event" lookup, so callers can backfill the existing row
 * instead of creating a duplicate. Shared by:
 *   - ConversationContextService.ensureMessagePersisted (webhook full-thread
 *     persist + runYelpBackgroundSync flow into this)
 *   - LeadsService.syncYelpMessagesToLocal (cold-start API fallback)
 */

import type { Message, PrismaClient } from '../../generated/prisma';

/** Default backfill window. AI sends are typically echoed within seconds; we
 * give a generous window to absorb webhook delivery delays / retries while
 * staying well clear of unrelated identical short messages on long threads. */
export const CONTENT_MATCH_DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Normalize a message body for cross-source equality:
 *   - collapse whitespace
 *   - fold em/en dashes to `--`
 *   - fold curly quotes to straight
 *
 * Yelp routinely re-encodes em-dash and smart quotes between the local copy
 * (what we POSTed) and the echoed event content, so equality must be done on
 * normalized strings, not raw ones. Mirrors the normalize() inline-defined in
 * the original syncYelpMessagesToLocal so we don't drift from the legacy match.
 */
export function normalizeMessageContent(s: string | null | undefined): string {
  return (s || '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[—–]/g, '--')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"');
}

export interface FindBackfillCandidateInput {
  conversationId: string;
  platform: string;
  sender: 'pro' | 'customer' | 'system';
  content: string;
  /** Timestamp of the incoming (real-id) event. Used to bound which legacy
   * null-id rows are considered for backfill. */
  sentAt?: Date;
  /** ± window applied around `sentAt`. Defaults to 24h. */
  windowMs?: number;
}

/**
 * Find a Message row in the same conversation that:
 *   - matches platform + sender
 *   - has externalMessageId IS NULL (i.e. a synthetic local row)
 *   - has normalized content equal to the incoming content
 *   - was created within ±windowMs of the incoming sentAt (when sentAt is given)
 *
 * Returns the closest-in-time candidate, or `null`.
 *
 * Caller is responsible for the actual UPDATE — this helper only locates the
 * row, so it stays trivially testable and reusable from both create paths
 * (ensureMessagePersisted) and bespoke sync paths (syncYelpMessagesToLocal).
 */
export async function findBackfillCandidate(
  prisma: Pick<PrismaClient, 'message'>,
  input: FindBackfillCandidateInput,
): Promise<Message | null> {
  const window = input.windowMs ?? CONTENT_MATCH_DEFAULT_WINDOW_MS;
  const sentAt = input.sentAt ?? new Date();
  const lower = new Date(sentAt.getTime() - window);
  const upper = new Date(sentAt.getTime() + window);

  const candidates = await (prisma.message as any).findMany({
    where: {
      conversationId: input.conversationId,
      platform: input.platform,
      sender: input.sender,
      externalMessageId: null,
      sentAt: { gte: lower, lte: upper },
    },
    orderBy: { sentAt: 'desc' },
  });

  const target = normalizeMessageContent(input.content);
  if (!target) return null;

  let best: Message | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of candidates as Message[]) {
    if (normalizeMessageContent(row.content) !== target) continue;
    const delta = Math.abs(new Date(row.sentAt).getTime() - sentAt.getTime());
    if (delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}
