/**
 * Lead activity bucket — derived at query time.
 *
 * Orthogonal to Lead.status (the business pipeline). Describes how LB is
 * currently working the conversation. Computed at read time from
 * ThreadContext.conversationState (the source of truth) + Lead.status — NOT
 * stored on the Lead row. See:
 *
 *   plans/2026-06-08-conversation-state-model.md  (design rationale)
 *   src/conversation-context/conversation-runtime.ts (TC vocabulary)
 *
 * Decision history (2026-06-08): we did NOT add `Lead.conversationState`.
 * ThreadContext.conversationState already has 85% coverage on active leads
 * and a richer vocabulary (11 values + aligned `aiStatus`). Storing a Lead-
 * level mirror would create write amplification and drift risk for no
 * analytical or perf benefit (the join is cheap; cardinality is 1:1).
 *
 * Buckets surface on the Messages page as the secondary badge under the
 * main Lead.status pill (New / Active / Scheduled / Done / Lost / Cancelled).
 */

import {
  type ConversationState,
} from './conversation-runtime';

export const ACTIVITY_BUCKETS = [
  'engagement',
  'ai_conversation',
  'follow_up',
  'human_handoff',
] as const;

export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

/**
 * Lead.status values that suppress the activity badge entirely. Terminals
 * (won + lost branches) don't need a "how we're working it" sub-state —
 * we're not working it. Returns null from the derivation in these cases.
 */
const TERMINAL_LEAD_STATUSES: ReadonlySet<string> = new Set([
  'booked',
  'completed',
  'lost',
  'cancelled',
  'no_show',
  'archived',
]);

/**
 * Optional signals used to gate the `human_handoff` badge specifically.
 *
 * Without these, `human_handling` / `customer_replied` always project to
 * `human_handoff`. With these, the badge is suppressed when the operator has
 * already responded or explicitly resolved the handoff — making the badge
 * represent CURRENT pending operator action, not historical classifier
 * output.
 *
 * Mario Evans 2026-06-10 audit: TC was stamped `human_handling` at 19:58
 * because the classifier saw "Please schedule a walkthrough." That state
 * persists forever unless we look at message timestamps and handoff
 * timestamps. If the operator replies, or marks the handoff resolved, the
 * badge should drop.
 */
export interface ActivityBucketSignals {
  /** Most recent customer message (any platform). */
  lastCustomerMessageAt?: Date | null;
  /** Most recent operator/manual reply. */
  lastBusinessMessageAt?: Date | null;
  /** Most recent AI reply. */
  lastAiMessageAt?: Date | null;
  /** When a handoff was requested. */
  handoffRequestedAt?: Date | null;
  /** When the handoff was marked resolved (operator engaged). */
  handoffResolvedAt?: Date | null;
}

/**
 * Pure derivation: (ThreadContext.conversationState, Lead.status, signals?) → ActivityBucket | null.
 *
 * Mapping (source of truth: §4 of the audit report + 2026-06-11 handoff-freshness audit):
 *
 *   Lead in terminal state                          → null  (no badge)
 *   TC = ai_engaging                                → ai_conversation
 *   TC = awaiting_customer / deferred / long_silent → follow_up
 *   TC = customer_replied / human_handling          → human_handoff*
 *   TC = new                                        → engagement
 *   TC = closed / opted_out / hired_elsewhere /
 *        booked_in_lb                                → null  (terminal TC; Lead.status should also be terminal)
 *   TC null, Lead.status = new                      → engagement   (cold lead, no conversation yet)
 *   TC null, Lead.status = engaged                  → engagement   (fallback)
 *
 * *human_handoff candidates are DEMOTED to follow_up when `signals` is
 * provided and either:
 *   (a) the latest outbound (business OR AI) is newer than the latest
 *       customer message — we already responded, no operator action pending; or
 *   (b) handoffRequestedAt is set AND handoffResolvedAt is set AND
 *       handoffResolvedAt >= handoffRequestedAt — handoff was resolved.
 *
 * When `signals` is undefined the legacy state-only mapping applies. Callers
 * with full TC fields (Messages list, single-lead detail) pass signals;
 * analytics aggregates without per-lead timestamps omit them.
 */
export function activityBucketFromThreadContext(
  tcState: ConversationState | string | null | undefined,
  leadStatus: string | null | undefined,
  signals?: ActivityBucketSignals,
): ActivityBucket | null {
  const status = (leadStatus ?? '').toLowerCase().trim();
  if (TERMINAL_LEAD_STATUSES.has(status)) return null;

  if (!tcState) {
    // Cold lead (no TC row yet, or TC exists with null state) — default to
    // engagement. Refinement via message history is a later PR.
    return 'engagement';
  }

  let candidate: ActivityBucket | null;
  switch (tcState) {
    case 'new':                candidate = 'engagement'; break;
    case 'ai_engaging':        candidate = 'ai_conversation'; break;
    case 'awaiting_customer':  candidate = 'follow_up'; break;
    case 'deferred':           candidate = 'follow_up'; break;
    case 'long_silent':        candidate = 'follow_up'; break;
    case 'customer_replied':   candidate = 'human_handoff'; break;
    case 'human_handling':     candidate = 'human_handoff'; break;
    case 'closed':             return null;
    case 'opted_out':          return null;
    case 'hired_elsewhere':    return null;
    case 'booked_in_lb':       return null;
    default:                   candidate = 'engagement'; // unknown vocab — safest fallback
  }

  // Freshness + resolution guards apply only to human_handoff candidates.
  // Other buckets pass through unchanged. No-signals callers also pass through.
  if (candidate !== 'human_handoff' || !signals) return candidate;

  // Guard (a): outbound fresher than customer → we already replied, demote.
  // Customer with no recorded message timestamp is treated as not-ahead
  // (no badge), matching the "no signal" intuition.
  const lastCustomer = signals.lastCustomerMessageAt?.getTime() ?? null;
  const lastOutbound = Math.max(
    signals.lastBusinessMessageAt?.getTime() ?? 0,
    signals.lastAiMessageAt?.getTime() ?? 0,
  );
  if (lastCustomer === null || lastOutbound > lastCustomer) {
    return 'follow_up';
  }

  // Guard (b): handoff was explicitly requested AND explicitly resolved
  // at-or-after the request. Demote — operator already engaged.
  const reqAt = signals.handoffRequestedAt?.getTime() ?? null;
  const resAt = signals.handoffResolvedAt?.getTime() ?? null;
  if (reqAt !== null && resAt !== null && resAt >= reqAt) {
    return 'follow_up';
  }

  return 'human_handoff';
}

/**
 * User-facing label for the secondary badge. Returns null when the bucket
 * is null so the UI can drop the badge cleanly.
 */
export function activityBucketLabel(b: ActivityBucket | null | undefined): string | null {
  if (!b) return null;
  switch (b) {
    case 'engagement':      return 'Engagement';
    case 'ai_conversation': return 'AI Conversation';
    case 'follow_up':       return 'Follow-up';
    case 'human_handoff':   return 'Human Handoff';
  }
}

export function isActivityBucket(s: string | null | undefined): s is ActivityBucket {
  if (!s) return false;
  return (ACTIVITY_BUCKETS as readonly string[]).includes(s);
}
