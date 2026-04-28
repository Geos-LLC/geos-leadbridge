/**
 * Canonical LeadBridge pipeline statuses.
 *
 * The pipeline (`PIPELINE_ORDER`) describes the *direction* a lead moves
 * through. `quoted` is optional — a lead can jump from `contacted`/`engaged`
 * straight to `booked`. The order is only used by the no-downgrade guard.
 *
 * Off-pipeline terminals (`lost`, `cancelled`, `no_show`, `archived`) are
 * reachable from any pipeline status; they are not part of `PIPELINE_ORDER`
 * so the downgrade guard never blocks a transition into them.
 *
 * Guard semantics:
 *   - AUTOMATION_TERMINAL: blocks `lb_automation` writes only. Manual + SF
 *     can still override (e.g. operator clicks `lost` -> `engaged`).
 *   - HARD_TERMINAL: blocks all writes from all sources. Currently only
 *     `archived` qualifies — once archived, status is final.
 */

export const CANONICAL_STATUSES = [
  'new',
  'contacted',
  'engaged',
  'quoted',
  'booked',
  'scheduled',
  'in_progress',
  'completed',
  'lost',
  'cancelled',
  'no_show',
  'archived',
] as const;

export type CanonicalStatus = typeof CANONICAL_STATUSES[number];

/**
 * Forward direction of the active pipeline. Index lookup powers the
 * no-downgrade guard. Off-pipeline terminals are intentionally omitted.
 */
export const PIPELINE_ORDER: readonly CanonicalStatus[] = [
  'new',
  'contacted',
  'engaged',
  'quoted',
  'booked',
  'scheduled',
  'in_progress',
  'completed',
];

/**
 * Statuses that block `lb_automation` writes. Manual + service_flow can
 * still transition out of these.
 */
export const AUTOMATION_TERMINAL: ReadonlySet<string> = new Set([
  'lost',
  'cancelled',
  'no_show',
  'completed',
  'archived',
]);

/**
 * Statuses that block writes from every source.
 */
export const HARD_TERMINAL: ReadonlySet<string> = new Set(['archived']);

export function isCanonicalStatus(s: string | null | undefined): s is CanonicalStatus {
  if (!s) return false;
  return (CANONICAL_STATUSES as readonly string[]).includes(s);
}

/**
 * True when both statuses are on `PIPELINE_ORDER` and the new index is
 * strictly less than the old. Off-pipeline transitions (terminals) always
 * return false, so transitions like `engaged -> lost` are allowed.
 */
export function isPipelineDowngrade(oldStatus: string, newStatus: string): boolean {
  const oldIdx = PIPELINE_ORDER.indexOf(oldStatus as CanonicalStatus);
  const newIdx = PIPELINE_ORDER.indexOf(newStatus as CanonicalStatus);
  if (oldIdx < 0 || newIdx < 0) return false;
  return newIdx < oldIdx;
}
