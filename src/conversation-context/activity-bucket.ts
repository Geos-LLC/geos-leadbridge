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
 * Pure derivation: (ThreadContext.conversationState, Lead.status) → ActivityBucket | null.
 *
 * Mapping (source of truth: §4 of the audit report):
 *
 *   Lead in terminal state                          → null  (no badge)
 *   TC = ai_engaging                                → ai_conversation
 *   TC = awaiting_customer / deferred / long_silent → follow_up
 *   TC = customer_replied / human_handling          → human_handoff
 *   TC = new                                        → engagement
 *   TC = closed / opted_out / hired_elsewhere /
 *        booked_in_lb                                → null  (terminal TC; Lead.status should also be terminal)
 *   TC null, Lead.status = new                      → engagement   (cold lead, no conversation yet)
 *   TC null, Lead.status = engaged                  → engagement   (fallback; PR 3 may refine via message-history derivation)
 *
 * Future PR may inspect message history to disambiguate the
 * `TC null, Lead.status='engaged'` case (e.g., latest sender → AI vs human).
 * That refinement lives outside this function so this stays a pure mapping.
 */
export function activityBucketFromThreadContext(
  tcState: ConversationState | string | null | undefined,
  leadStatus: string | null | undefined,
): ActivityBucket | null {
  const status = (leadStatus ?? '').toLowerCase().trim();
  if (TERMINAL_LEAD_STATUSES.has(status)) return null;

  if (!tcState) {
    // Cold lead (no TC row yet, or TC exists with null state) — default to
    // engagement. Refinement via message history is a later PR.
    return 'engagement';
  }

  switch (tcState) {
    case 'new':                return 'engagement';
    case 'ai_engaging':        return 'ai_conversation';
    case 'awaiting_customer':  return 'follow_up';
    case 'deferred':           return 'follow_up';
    case 'long_silent':        return 'follow_up';
    case 'customer_replied':   return 'human_handoff';
    case 'human_handling':     return 'human_handoff';
    case 'closed':             return null;
    case 'opted_out':          return null;
    case 'hired_elsewhere':    return null;
    case 'booked_in_lb':       return null;
    default:                   return 'engagement'; // unknown vocab — safest fallback
  }
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
