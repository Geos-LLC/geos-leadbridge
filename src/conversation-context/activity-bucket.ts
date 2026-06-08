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
 * Optional message-timestamp signals used to refine stale TC states.
 *
 * When TC.conversationState says `customer_replied` or `human_handling`
 * — both of which would otherwise map to `human_handoff` — but an outbound
 * (AI or business) message has arrived AFTER the customer's last message,
 * the TC state is stale: the operator already responded but the runtime
 * never transitioned the state. We catch this here and rewrite the bucket
 * to `follow_up` (business is latest) or `ai_conversation` (AI is latest).
 *
 * Without the override, ~30% of "Human Handoff" badges in production today
 * are stale (operator replied days ago, TC never moved). The proper fix is
 * in the conversation runtime; this is the targeted hotfix.
 *
 * Pass an empty `{}` (or omit) when timestamps aren't available — the
 * helper falls through to the original mapping unchanged.
 */
export interface ActivityBucketContext {
  lastCustomerMessageAt?: Date | string | number | null;
  lastBusinessMessageAt?: Date | string | number | null;
  lastAiMessageAt?: Date | string | number | null;
}

function tsOrZero(v: Date | string | number | null | undefined): number {
  if (v == null) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const d = new Date(v);
  const t = d.getTime();
  return Number.isFinite(t) ? t : 0;
}

/**
 * Pure derivation: (ThreadContext.conversationState, Lead.status, optional
 * message timestamps) → ActivityBucket | null.
 *
 * Mapping (source of truth: §4 of the audit report):
 *
 *   Lead in terminal state                          → null  (no badge)
 *   TC = ai_engaging                                → ai_conversation
 *   TC = awaiting_customer / deferred / long_silent → follow_up
 *   TC = customer_replied / human_handling          → human_handoff
 *     ^ unless message timestamps in `context` show an outbound is newer
 *       than the customer's last message — then `follow_up` (business newest)
 *       or `ai_conversation` (AI newest). Stale-state hotfix.
 *   TC = new                                        → engagement
 *   TC = closed / opted_out / hired_elsewhere /
 *        booked_in_lb                                → null  (terminal TC; Lead.status should also be terminal)
 *   TC null, Lead.status = new or engaged           → engagement   (cold lead / fallback)
 */
export function activityBucketFromThreadContext(
  tcState: ConversationState | string | null | undefined,
  leadStatus: string | null | undefined,
  context: ActivityBucketContext = {},
): ActivityBucket | null {
  const status = (leadStatus ?? '').toLowerCase().trim();
  if (TERMINAL_LEAD_STATUSES.has(status)) return null;

  if (!tcState) {
    // Cold lead (no TC row yet, or TC exists with null state) — default to
    // engagement. Refinement via message history is a later PR.
    return 'engagement';
  }

  // Stale-state override for the two "customer is waiting" TC values.
  // Apply only when we have a customer timestamp to compare against — the
  // mapping is pure when no timestamps are passed.
  if (tcState === 'customer_replied' || tcState === 'human_handling') {
    const customer = tsOrZero(context.lastCustomerMessageAt);
    const business = tsOrZero(context.lastBusinessMessageAt);
    const ai       = tsOrZero(context.lastAiMessageAt);
    if (customer > 0 && (business > customer || ai > customer)) {
      // Outbound is newer → TC is stale.
      return ai > business ? 'ai_conversation' : 'follow_up';
    }
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
