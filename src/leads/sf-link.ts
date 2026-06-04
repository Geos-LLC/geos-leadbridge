/**
 * SF-link predicate — single source of truth for "is this LB lead converted
 * into an SF-managed customer/job?".
 *
 * Architecture:
 *   LB runs in one of two modes per-lead:
 *     - Autonomous mode: no SF link. LB owns the full lifecycle (intent
 *       classifier drives status, follow-up engine chases, AI replies and
 *       can mark lost/booked).
 *     - SF-connected mode: lead is linked to an SF customer or job. SF owns
 *       the customer/job lifecycle. LB stops mirroring SF state into
 *       Lead.status and stops chasing the lead. AI still answers questions
 *       and pages handoffs; bookings still route through SF orchestration.
 *
 * The conversion condition is "any one of these is set":
 *   - sfCustomerId  (Lead was matched to an SF customer record)
 *   - sfJobId       (Lead was linked to a specific SF job)
 *   - syncStatus='linked'  (historical-sync confirmed the link)
 *
 * Callers MUST go through this predicate. Inlining the OR-chain at call sites
 * drifts the moment a new linkage column is added (e.g. an `sfQuoteId` for a
 * future quote flow). One place to update.
 */

export interface SfLinkInputs {
  sfJobId?: string | null;
  sfCustomerId?: string | null;
  syncStatus?: string | null;
}

/**
 * Returns true when the lead is in SF-connected mode.
 *
 * `pendingUpdates` covers the "becoming SF-linked in this very operation"
 * edge case — when the live SF webhook arrives for a lead that doesn't yet
 * have an sfJobId (it was found via the externalRequestId fallback), the
 * extraLeadUpdates payload carries the about-to-be-written sfJobId. Without
 * this check, the very first SF event for a lead would slip past the guard
 * and write Lead.status before the link "officially" exists.
 *
 * The historical-sync paths (manual link, bulk link) set sfJobId BEFORE
 * calling writeStatus, so for those paths `lead.sfJobId` is already truthy
 * and `pendingUpdates` is a no-op. The live-webhook path is the one that
 * relies on `pendingUpdates`.
 */
export function isSfLinkedLead(
  lead: SfLinkInputs,
  pendingUpdates?: Record<string, any> | null,
): boolean {
  if (lead.sfJobId || lead.sfCustomerId || lead.syncStatus === 'linked') {
    return true;
  }
  if (pendingUpdates) {
    if (pendingUpdates.sfJobId || pendingUpdates.sfCustomerId) return true;
    if (pendingUpdates.syncStatus === 'linked') return true;
  }
  return false;
}
