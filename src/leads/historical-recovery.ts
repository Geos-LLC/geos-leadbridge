/**
 * Historical Marketplace Lead Reactivation — eligibility predicate.
 *
 * A lead qualifies as historical marketplace recovery when EITHER:
 *   A. It carries the PR 4 backfill tag (`statusSource='backfill_pr4_v1'`).
 *   B. The marketplace platform reported a terminal outcome — that is, the
 *      lead was effectively closed on the marketplace side (No Hire,
 *      Not Hired, Hired Someone Else, Closed, Archived, Job Done Elsewhere).
 *
 * AND the lead is NOT in any of these disqualifying states:
 *   - LB pipeline terminal: cancelled, booked, scheduled (legacy), completed
 *   - Customer opted out (`lostReason='opt_out'`)
 *   - SF-linked (delegated to `isSfLinkedLead` for single source of truth)
 *
 * Used by:
 *   - Activation pipelines (PR 4 cohort, future TT/Yelp historical imports,
 *     bulk reactivation campaigns).
 *   - Future evaluateThread routing — when this rule becomes the default for
 *     newly-imported historical marketplace leads, `evaluateThread` will
 *     consult this predicate before falling through to standard derivation.
 *
 * Naming: the engine reuses the internal `customer_hired_competitor` trigger
 * state + template for the actual sequence, but the user-facing label is
 * "Historical Lead Reactivation" — see `HISTORICAL_RECOVERY_DISPLAY_LABEL`.
 */

import { isSfLinkedLead, type SfLinkInputs } from './sf-link';

/** User-facing label for any surface that displays the reactivation flow. */
export const HISTORICAL_RECOVERY_DISPLAY_LABEL = 'Historical Lead Reactivation';

/**
 * Internal trigger state the reactivation flow enrolls against. We reuse the
 * existing `customer_hired_competitor` sequence rather than introducing a new
 * trigger state — the template + cadence already exist, only the routing
 * decision is new.
 */
export const HISTORICAL_RECOVERY_INTERNAL_TRIGGER_STATE = 'customer_hired_competitor';

/**
 * Marketplace terminal outcomes that signal "the conversation closed on the
 * platform side". Mirrors the spelling that Thumbtack's inbox + Yelp's lead
 * status surface — both raw forms ("No hire") and snake_case ("no_hire") are
 * included for robustness.
 */
const HISTORICAL_MARKETPLACE_OUTCOMES: ReadonlySet<string> = new Set([
  'no hire', 'no_hire',
  'not hired', 'not_hired',
  'hired someone else', 'hired_someone_else',
  'closed',
  'archived',
  'job done', 'job_done', 'done',
]);

/**
 * LB pipeline statuses that explicitly disqualify a lead from historical
 * reactivation. These are real terminals (the lead either succeeded or was
 * cancelled), not the recoverable "lost" we're trying to re-engage.
 */
const HISTORICAL_STATUS_DISQUALIFIERS: ReadonlySet<string> = new Set([
  'cancelled', 'booked', 'scheduled', 'completed',
]);

export interface HistoricalRecoveryInputs extends SfLinkInputs {
  status: string | null;
  lostReason: string | null;
  statusSource: string | null;
  thumbtackStatus: string | null;
  platformStatus: string | null;
}

/**
 * Returns true when `lead` should enter the dedicated historical
 * reactivation flow instead of the standard follow-up sequences.
 *
 * Pure function — no DB, no side effects. Safe to call from any caller
 * (engine, scripts, controllers, tests).
 */
/**
 * Reasons a historical reactivation candidate should be skipped before
 * enrollment because the message is very likely undeliverable. Returned by
 * `getReactivationDeliveryBlocker`. Stable strings — operators grep on them
 * in dry-run reports and Loki.
 *
 * NOT a substitute for the engine's send-time error handling — this is the
 * pre-activation gate that prevents creating enrollments we know will burn
 * scheduler ticks on retry loops (Gail Counter case, smoke v2: no phone +
 * closed-side TT thread → repeated 404 from Thumbtack).
 *
 * Explicitly NOT a skip:
 *   - thumbtackStatus="No hire" / "Not hired" — that IS the target cohort.
 *     Those leads are precisely who Historical Reactivation is meant to
 *     re-engage. The closed/archived skips are different — those mean the
 *     platform has structurally walled the thread off from new messages.
 */
export type ReactivationDeliveryBlocker =
  | 'no_thread_id'
  | 'platform_thread_closed'
  | 'platform_thread_archived'
  | 'no_delivery_channel'
  | 'deferral_phrase'
  | 'awaiting_human_response';

export interface ReactivationDeliveryInputs {
  threadId: string | null;
  platform: string | null;
  customerPhone: string | null;
  customerPhoneSubstitute?: string | null;
  thumbtackStatus: string | null;
  platformStatus: string | null;
  /** ThreadContext.conversationState — optional, only needed if available */
  conversationState?: string | null;
  /** Last customer message content — for deferral phrase detection */
  lastCustomerMessageContent?: string | null;
}

/** Platforms where the thread itself is a deliverable channel (no phone required). */
const PLATFORM_DELIVERABLE_VIA_THREAD: ReadonlySet<string> = new Set(['thumbtack', 'yelp']);

/** Conversation states that indicate a human is mid-response — don't fire an auto-reactivation. */
const AWAITING_HUMAN_STATES: ReadonlySet<string> = new Set(['customer_replied', 'human_handling']);

/**
 * Phrases the customer said most recently that indicate they explicitly
 * asked for time to think / check with a partner. Re-engaging while a
 * deferral is pending is rude AND the dedicated `customer_deferred` flow
 * handles those cases separately.
 *
 * Kept in sync with the engine's own DEFERRAL_PHRASES list — both must
 * match for the pre-activation skip and the runtime guard to agree.
 */
const DEFERRAL_PHRASES: readonly string[] = [
  'get back to you', 'let me think', 'let me check', 'let me look',
  "i'll think", 'ill think', 'i will think',
  "i'll let you know", 'ill let you know', 'i will let you know',
  "i'll be in touch", 'ill be in touch', "we'll be in touch", 'we will be in touch',
  'need to think', 'need to discuss', 'need to talk',
  'have to think', 'have to discuss', 'have to talk',
  'thinking about it', 'thinking it over', 'talk it over', 'discuss it with',
  'shopping around', 'comparing quotes', 'comparing prices',
  'check with my husband', 'check with my wife', 'check with my partner', 'check with my spouse',
  'check with the husband', 'check with the wife', 'check with my hubby',
  'ask my husband', 'ask my wife', 'ask my partner', 'ask my spouse',
  'talk to my husband', 'talk to my wife', 'talk to my partner', 'talk to my spouse',
  'run it by', 'run this by', 'run it past', 'run this past',
  'check with the boss', 'ask the boss', 'check with my family',
  'need to check', 'need to ask', 'will need to check', 'will need to ask',
];

/**
 * Pre-activation delivery filter. Returns the first applicable skip reason,
 * or null when the lead is deliverable.
 *
 * Order matters — structural skips (no threadId, closed/archived thread)
 * run first because they're cheaper and more definitive than the content
 * checks. Same evaluation order both code paths use:
 *   - `scripts/historical-reactivation-activate.ts` (operator-triggered batch)
 *   - `FollowUpEngineService.maybeEnrollAsHistoricalReactivation` (runtime
 *     enrollment helper called by future imports / bulk reactivation tools)
 *
 * Pure function — no DB. Caller pre-loads the inputs from the Lead row,
 * ThreadContext, and last customer Message.
 */
export function getReactivationDeliveryBlocker(
  l: ReactivationDeliveryInputs,
): ReactivationDeliveryBlocker | null {
  if (!l.threadId) return 'no_thread_id';

  const ts = (l.thumbtackStatus ?? '').toLowerCase().trim();
  const ps = (l.platformStatus ?? '').toLowerCase().trim();
  if (ts === 'closed' || ps === 'closed') return 'platform_thread_closed';
  if (ts === 'archived' || ps === 'archived') return 'platform_thread_archived';

  const platform = (l.platform ?? '').toLowerCase();
  const hasPlatformChannel = PLATFORM_DELIVERABLE_VIA_THREAD.has(platform);
  const phone = (l.customerPhone ?? '').trim();
  const sub = (l.customerPhoneSubstitute ?? '').trim();
  const hasPhone = phone.length > 0 || sub.length > 0;
  if (!hasPlatformChannel && !hasPhone) return 'no_delivery_channel';

  if (l.conversationState && AWAITING_HUMAN_STATES.has(l.conversationState)) {
    return 'awaiting_human_response';
  }

  if (l.lastCustomerMessageContent) {
    const content = l.lastCustomerMessageContent.toLowerCase();
    if (DEFERRAL_PHRASES.some(p => content.includes(p))) return 'deferral_phrase';
  }

  return null;
}

export function isHistoricalMarketplaceRecovery(l: HistoricalRecoveryInputs): boolean {
  // Disqualifiers — apply first, short-circuits without evaluating sources.
  const sLB = (l.status ?? '').toLowerCase();
  if (HISTORICAL_STATUS_DISQUALIFIERS.has(sLB)) return false;
  if (l.lostReason === 'opt_out') return false;
  if (isSfLinkedLead(l)) return false;

  // Match clause A — PR 4 / future backfill tag.
  if (l.statusSource === 'backfill_pr4_v1') return true;

  // Match clause B — marketplace terminal outcome on either status field.
  const ts = (l.thumbtackStatus ?? '').toLowerCase();
  const ps = (l.platformStatus ?? '').toLowerCase();
  return HISTORICAL_MARKETPLACE_OUTCOMES.has(ts) || HISTORICAL_MARKETPLACE_OUTCOMES.has(ps);
}
