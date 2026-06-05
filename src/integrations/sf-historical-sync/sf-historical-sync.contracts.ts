/**
 * SfHistoricalSync — contracts for the SF→LB historical reconciliation.
 *
 * Architecture rule: ServiceFlow is the source of truth. LB never creates
 * SF records during historical sync. LB only:
 *   - enumerates its own unsynced leads
 *   - receives match results from SF (via the bulk-link receiver endpoint)
 *   - updates its local Lead.status from the SF-supplied status, subject
 *     to existing downgrade/idempotency guards
 *   - accepts manual operator links as a fallback
 *
 * The "trigger" endpoint is a placeholder until SF exposes a /match-leads
 * endpoint LB can call. Until then, "trigger" enumerates pending leads,
 * surfaces them in the dashboard, and waits for SF (or an operator) to
 * post results to the receiver endpoint.
 */

// ─── syncStatus values ────────────────────────────────────────────────
// Stored on Lead.syncStatus. Lifecycle:
//
//   null            — never considered for SF reconciliation
//   'pending'       — connection-time enumeration marked it actionable;
//                     awaiting SF match result
//   'lead_linked'   — SF found a matching SF Lead record (pre-customer
//                     pipeline stage) but no SF Customer/Job exists yet.
//                     LB row carries sfLeadId + sfLeadStageName snapshot.
//                     Behaviorally identical to LB-only: LB still owns
//                     AI, follow-up, classifier, status writes. NOT a
//                     SF-managed state. Promoted to 'linked' organically
//                     when SF later sends a customer_job match for the
//                     same lb_lead_id (sfLeadId stays additive).
//   'linked'        — SF returned a high-confidence customer/job match
//                     and LB wrote sfJobId (and optionally sfCustomerId).
//                     SF owns customer/job lifecycle from here.
//   'no_match'      — SF returned no match; the lead is LB-only
//   'needs_review'  — ambiguous match (medium/low confidence); operator
//                     must resolve via manual-link
//   'failed'        — sync attempt errored; retry-eligible
//   'skipped'       — true hard exclusion: customer must not be contacted
//                     by SF or by LB re-engagement. Set by enumeration when:
//                       (a) platform='test'                            (noise)
//                       (b) status='lost' AND lostReason='opt_out'     (explicit unsubscribe)
//                       (c) status IN {cancelled, no_show, archived}    (operator-explicit terminals)
//                     Other terminal-LB rows (Thumbtack "No hire", Yelp
//                     Archived → lost+hired_someone, lost with null
//                     lostReason) enumerate as 'pending' — they ARE
//                     candidates for SF identity matching. The 2026-06-05
//                     rule refactor narrowed this from the prior
//                     status-only check that conflated platform-algorithmic
//                     lost with customer-initiated stop.
export const SYNC_STATUSES = [
  'pending', 'lead_linked', 'linked', 'no_match', 'needs_review', 'failed', 'skipped',
] as const;
export type SyncStatus = typeof SYNC_STATUSES[number];

// ─── Dashboard ────────────────────────────────────────────────────────

export interface SyncDashboardCounts {
  userId: string;
  sfTenantId: string | null;
  totalLeads: number;
  byStatus: Record<string, number>;          // includes <null> bucket
  bySyncStatus: Record<SyncStatus | 'null', number>;
  staleScheduled: number;                     // status=scheduled, syncStatus != linked, ≥14d
  staleBooked: number;                        // status=booked, syncStatus != linked, ≥14d
  unsyncedActionable: number;                 // pending or needs_review or failed in actionable status
  matchKeysAvailable: {
    withPhone: number;
    withEmail: number;
    withExternalRequestId: number;
    withNone: number;
  };
}

// ─── Candidates list (admin → operator dashboard) ────────────────────

export interface SyncCandidate {
  leadId: string;
  customerName: string | null;
  customerPhone: string | null;
  customerEmail: string | null;
  platform: string;                           // 'thumbtack' | 'yelp' | ...
  businessId: string | null;
  externalRequestId: string;
  status: string;                             // canonical LB status
  syncStatus: SyncStatus | null;
  sfJobId: string | null;
  sfCustomerId: string | null;
  sfLeadId: string | null;                    // populated when syncStatus='lead_linked'
  sfLeadStageName: string | null;             // SF Lead pipeline stage snapshot (e.g. "Contacted")
  sfLeadMatchedAt: string | null;             // ISO; when SF confirmed the lead-only match
  syncAttemptedAt: string | null;             // ISO
  syncReason: string | null;
  createdAt: string;                          // ISO
  statusUpdatedAt: string | null;             // ISO
  ageDays: number;
}

// ─── Manual link ─────────────────────────────────────────────────────
// Operator provides the LB↔SF mapping directly (e.g. after looking it up
// in SF UI). Optional sfStatus lets the operator simultaneously bring the
// LB lead's status into agreement with SF.

export interface ManualLinkRequest {
  lbLeadId: string;
  sfJobId: string;                            // required
  sfCustomerId?: string | null;
  sfStatus?: string | null;                   // optional: raw SF status string
  sfPaymentStatus?: string | null;            // optional: 'paid' etc.
  occurredAt?: string;                        // ISO; defaults to now
  reason?: string;                            // free-text audit note
}

export interface ManualLinkResponse {
  ok: boolean;
  leadId: string;
  syncStatus: SyncStatus;
  linkedSfJobId?: string;
  statusUpdated?: boolean;
  newStatus?: string;
  conflict?: 'existing_sfJobId_differs' | 'lead_not_found' | 'lead_not_owned';
  conflictDetail?: string;
}

// ─── Bulk receiver (HMAC-signed, future SF push) ─────────────────────
// SF (or an operator-driven script) submits match results in bulk. Each
// row goes through the same safeguards as ManualLink. The receiver is
// HMAC-signed under the same SF_LB_PROVISIONING_SHARED_SECRET as the
// provisioning channel (different secret from the per-tenant webhook).

export interface BulkLinkRow {
  lb_lead_id: string;
  /**
   * Which SF entity tier the row maps to:
   *   'customer_job'  — SF Customer + (usually) SF Job. Default when absent
   *                     (backward-compatible — pre-2026-06-04 rows omitted
   *                     match_type entirely and meant customer_job).
   *   'lead_only'     — SF Lead record only; no SF Customer/Job yet.
   *                     Requires sf_lead_id. sf_job_id may be omitted.
   *                     Receiver writes sfLeadId + sfLeadStageName + sets
   *                     syncStatus='lead_linked'. Does NOT call writeStatus.
   */
  match_type?: 'customer_job' | 'lead_only';
  /** SF Job PK. Required for customer_job; optional/empty for lead_only. */
  sf_job_id: string;
  sf_customer_id?: string | null;
  /** SF Lead PK. Required for match_type='lead_only'. Ignored otherwise. */
  sf_lead_id?: string | number | null;
  /** Snapshot of SF Lead pipeline stage (e.g. "Contacted"). */
  sf_lead_stage_name?: string | null;
  confidence: 'exact' | 'high' | 'medium' | 'low' | 'none';
  match_basis: 'externalRequestId' | 'phone' | 'phone_name' | 'email'
    | 'name_platform' | 'manual' | 'none';
  sf_status?: string | null;                  // raw SF status
  sf_payment_status?: string | null;
  occurred_at?: string;                       // ISO
  reason?: string;
}

export interface BulkLinkRequest {
  rows: BulkLinkRow[];
}

export interface BulkLinkRowResult {
  lb_lead_id: string;
  result: 'linked' | 'lead_linked' | 'needs_review' | 'no_match' | 'skipped'
    | 'conflict' | 'not_found' | 'failed';
  sync_status: SyncStatus | null;
  detail?: string;
  status_updated?: boolean;
  new_status?: string;
}

export interface BulkLinkResponse {
  ok: boolean;
  /** Populated on top-level rejections (missing_headers, invalid_body, etc.) */
  error?: string;
  summary: {
    total: number;
    linked: number;
    lead_linked: number;
    needs_review: number;
    no_match: number;
    conflict: number;
    not_found: number;
    failed: number;
    status_updates_applied: number;
  };
  rows: BulkLinkRowResult[];
}

// ─── Sync trigger (placeholder) ──────────────────────────────────────
// "Sync from ServiceFlow" / "Resync from ServiceFlow" admin button.
// Enumerates unsynced leads, marks them pending, returns the candidate
// list. The actual SF-side call to /match-leads is deferred until SF
// exposes that endpoint; for now this is a controlled re-enumeration +
// dashboard-ready output. Operator/SF posts back via the bulk receiver.

export interface SyncTriggerRequest {
  /** If true, re-enumerate even rows already marked syncStatus. */
  forceResync?: boolean;
  /** Optional subset by status (e.g. only ["scheduled","booked"]) */
  onlyStatuses?: string[];
}

export interface SyncTriggerResponse {
  ok: boolean;
  userId: string;
  scanned: number;
  newlyPending: number;
  movedToSkipped: number;
  alreadyLinked: number;
  alreadyTerminal: number;
}

// ─── Connection-time enumeration result (internal) ───────────────────

export interface ConnectionTimeEnumerationResult {
  userId: string;
  scanned: number;
  markedPending: number;
  markedSkipped: number;
  alreadyLinked: number;
}
