/**
 * SF inbound event replay-eligibility predicate.
 *
 * The `/v1/integrations/service-flow/events/:id/replay` endpoint originally
 * accepted only events in `deferred`, `unmapped_status`, or `dry_run` — the
 * three states where an explicit operator retry is obviously useful.
 *
 * Phase C smoke proved that real-world drift also lands events in `noop` and
 * `stale` when a writeStatus guard rejected the write. Those are recoverable
 * iff the rejection reason can be reversed (e.g. the SF archived-reactivation
 * carve-out flips a future `hard_terminal` rejection to `applied`).
 *
 * This module is the single source of truth for "is this row replayable?" so
 * the controller stays a thin pass-through and the matrix is unit-testable
 * without bootstrapping Nest.
 *
 * Policy summary:
 *
 *   status             | result                           | replayable?
 *   -------------------|----------------------------------|------------
 *   deferred           | (any)                            | YES
 *   unmapped_status    | (any)                            | YES
 *   dry_run            | (any)                            | YES
 *   stale              | (any — always a guard rejection) | YES
 *   noop               | lead_status_skip:hard_terminal   | YES
 *   noop               | lead_status_skip:stale_event     | YES
 *   noop               | lead_status_skip:duplicate       | YES
 *   noop               | lead_status_skip:pipeline_dgrade | YES
 *   noop               | lead_status_skip:no_change       | NO  (benign)
 *   noop               | lead_status_skip:invalid_status  | NO  (mapping bug — fix code)
 *   noop               | lead_status_skip:sf_protected    | NO  (state-based)
 *   noop               | lead_status_skip:automation_term | NO  (state-based)
 *   noop               | status_unchanged                 | NO  (true no-op)
 *   noop               | subscription_not_found / missing*| NO  (not recoverable here)
 *   applied            | (any)                            | NO  (already applied)
 *
 * Benign no-ops and bug-class rejections are intentionally NOT replayable
 * without an explicit admin-force path (out of scope for this change).
 */

export const REPLAYABLE_STATUSES: ReadonlySet<string> = new Set([
  'deferred',
  'unmapped_status',
  'dry_run',
  'stale',
]);

/**
 * Set of `writeStatus` skip reasons whose rejection is reversible by a future
 * code/state change. Surfaces as `lead_status_skip:<reason>` in
 * `SfInboundEvent.result` when the event landed in status='noop'.
 *
 * Kept narrow on purpose:
 *  - `no_change` is benign — replaying achieves nothing.
 *  - `invalid_status` is a mapping bug — fix sf-status-map.ts, not the data.
 *  - `sf_protected`, `automation_terminal` are state-based and unchanged by
 *    replay unless the underlying state shifts (flip SF_STATUS_WINS, manual
 *    transition out of the terminal); those flows have their own UI surfaces.
 */
export const REPLAYABLE_NOOP_SKIP_REASONS: ReadonlySet<string> = new Set([
  'hard_terminal',
  'stale_event',
  'duplicate',
  'pipeline_downgrade',
]);

const LEAD_STATUS_SKIP_PREFIX = 'lead_status_skip:';

export interface ReplayCandidate {
  status: string;
  result: string | null;
}

export interface ReplayEligibility {
  replayable: boolean;
  /** Short tag explaining the decision — useful for the rejection error body. */
  reason: string;
}

/**
 * Decide whether an SF inbound event is eligible for operator-triggered replay.
 *
 * The reason string is included in BadRequest responses so callers can see why
 * a given row was rejected without diffing this code.
 */
export function isReplayEligible(event: ReplayCandidate): ReplayEligibility {
  if (REPLAYABLE_STATUSES.has(event.status)) {
    return { replayable: true, reason: `status=${event.status}` };
  }

  if (event.status === 'noop') {
    const result = event.result ?? '';
    if (result.startsWith(LEAD_STATUS_SKIP_PREFIX)) {
      const skip = result.slice(LEAD_STATUS_SKIP_PREFIX.length);
      if (REPLAYABLE_NOOP_SKIP_REASONS.has(skip)) {
        return { replayable: true, reason: `noop+${skip}` };
      }
      return {
        replayable: false,
        reason: `noop+${skip}_not_replayable`,
      };
    }
    return { replayable: false, reason: `noop_benign:${result || 'unspecified'}` };
  }

  return { replayable: false, reason: `status=${event.status}` };
}
