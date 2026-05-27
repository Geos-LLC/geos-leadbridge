/**
 * SF Orchestration HTTP contracts — Phase 2B PR-B1.
 *
 * Typed request/response shapes for the four orchestration endpoints LB
 * calls on SF. Stable contract surface so PR-B2 callers and PR-B1 tests
 * agree on shape.
 *
 * Endpoints (all on SF):
 *   GET  /api/integrations/leadbridge/orchestration/availability
 *   POST /api/integrations/leadbridge/orchestration/booking-request
 *   POST /api/integrations/leadbridge/orchestration/booking-cancel
 *   POST /api/integrations/leadbridge/orchestration/handoff
 *
 * The four-way result discriminant (`ok` + `code`) lets PR-B2 callers
 * route on outcome without inspecting HTTP status codes:
 *   { ok: true,  data }                                    — happy path
 *   { ok: false, code: 'slot_taken',          status: 409, ...}
 *   { ok: false, code: 'slot_token_expired',  status: 410, ...}
 *   { ok: false, code: 'validation_failed',   status: 422, ...}
 *   { ok: false, code: 'orchestration_disabled', status: 403, ...}
 *   { ok: false, code: 'not_found',           status: 404, ...}
 *   { ok: false, code: 'timeout',             status: null, ...}
 *   { ok: false, code: 'network_error',       status: null, ...}
 *   { ok: false, code: 'server_error',        status: 5xx,  ...}
 *   { ok: false, code: 'unknown',             status: any,  ...}
 *
 * `orchestration_disabled` is the graceful-fallback signal: it means SF
 * accepted the request but the feature is dark for this tenant on SF's
 * side. PR-B2 must route to the existing handoff flow when this fires.
 */

// ─── Shared primitive types ─────────────────────────────────────────────

export interface TimeSlot {
  /** Stable id for the slot in SF's calendar. */
  slotId: string;
  /**
   * Short-lived token that proves SF held this slot at the time it was
   * offered. Booking-request includes it; SF validates freshness on
   * create and returns 410 slot_token_expired if too stale.
   */
  slotToken?: string | null;
  /** ISO-8601 start time in UTC. */
  start: string;
  /** ISO-8601 end time in UTC. */
  end: string;
  /** Optional assigned cleaner — may be null if SF auto-assigns later. */
  cleanerId?: string | null;
  /** Optional cost preview for display ($USD). */
  providerCost?: number | null;
}

export interface CustomerContact {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
}

// ─── GET /availability ──────────────────────────────────────────────────

export interface AvailabilityRequest {
  /** LB-side user (tenant) — used for tenant scoping in logs. */
  userId: string;
  /** Sigcore-side business id (canonical cross-tenant key). */
  sigcoreBusinessId: string;
  /** Optional LB lead id — passed through for SF-side correlation. */
  leadId?: string | null;
  /** Service type label (e.g. "standard_cleaning", "deep_cleaning"). */
  serviceType: string;
  /** Estimated duration in minutes — drives slot length search. */
  durationMinutes?: number | null;
  /** Customer-preferred start of search window (ISO-8601). */
  preferredStart?: string | null;
  /** Customer-preferred end of search window (ISO-8601). */
  preferredEnd?: string | null;
  /** Optional postcode for area-based slot filtering. */
  postcode?: string | null;
}

export interface AvailabilityResponse {
  /** Up to N candidate slots. Empty array means no availability. */
  slots: TimeSlot[];
  /**
   * Seconds the caller may cache this response. Zero means "do not cache" —
   * call again before next offering.
   */
  cachedForSeconds: number;
}

// ─── POST /booking-request ──────────────────────────────────────────────

export interface BookingRequestRequest {
  userId: string;
  sigcoreBusinessId: string;
  leadId: string;
  externalRequestId: string;
  /** SlotId returned by a prior availability call. */
  slotId: string;
  /** Slot token returned with the slot. Forwarded for SF freshness check. */
  slotToken?: string | null;
  customerContact: CustomerContact;
  serviceType: string;
  durationMinutes?: number | null;
  /** Optional free-form notes captured during the conversation. */
  notes?: string | null;
}

export interface BookingRequestResponse {
  /** SF job id assigned on successful creation. */
  sfJobId: string;
  /**
   * Canonical operational status — Phase 2A only acts on `scheduled`.
   * Other values are documented but not required to drive runtime.
   */
  canonicalStatus: 'scheduled' | string;
  /** ISO-8601 scheduled start. */
  scheduledFor: string;
}

// ─── POST /booking-cancel ───────────────────────────────────────────────

export interface BookingCancelRequest {
  userId: string;
  sigcoreBusinessId: string;
  /** SF job id from a prior booking-request. */
  sfJobId: string;
  leadId: string;
  /** Free-form reason captured from the conversation. */
  reason?: string | null;
}

export interface BookingCancelResponse {
  sfJobId: string;
  canonicalStatus: 'cancelled' | string;
}

// ─── POST /handoff ──────────────────────────────────────────────────────

export interface HandoffRequest {
  userId: string;
  sigcoreBusinessId: string;
  leadId: string;
  /** Free-form reason (e.g. "validation_failed:postcode_outside_service_area"). */
  reason: string;
  /** Optional short conversation summary — no message bodies. */
  conversationContext?: string | null;
}

export interface HandoffResponse {
  /** True if SF accepted the handoff (dispatcher paged, etc.). */
  accepted: boolean;
  /** Optional SF-side correlation id for the handoff ticket. */
  handoffId?: string | null;
}

// ─── Discriminated result type ──────────────────────────────────────────

export type OrchestrationErrorCode =
  | 'slot_taken'
  | 'slot_token_expired'
  | 'validation_failed'
  | 'orchestration_disabled'
  | 'not_found'
  | 'timeout'
  | 'network_error'
  | 'server_error'
  | 'unknown';

export type OrchestrationEndpoint =
  | 'availability'
  | 'booking_request'
  | 'booking_cancel'
  | 'handoff';

export const ORCHESTRATION_ENDPOINTS: readonly OrchestrationEndpoint[] = [
  'availability',
  'booking_request',
  'booking_cancel',
  'handoff',
] as const;

export const ORCHESTRATION_ERROR_CODES: readonly OrchestrationErrorCode[] = [
  'slot_taken',
  'slot_token_expired',
  'validation_failed',
  'orchestration_disabled',
  'not_found',
  'timeout',
  'network_error',
  'server_error',
  'unknown',
] as const;

export interface OrchestrationSuccess<T> {
  ok: true;
  status: number;
  data: T;
  correlationId: string;
  idempotencyKey: string;
  attemptCount: number;
  latencyMs: number;
}

export interface OrchestrationFailure {
  ok: false;
  code: OrchestrationErrorCode;
  status: number | null;
  /** Body returned by SF (parsed JSON if available, else null). */
  body: unknown;
  /** Short message safe to log. Never includes PII. */
  message: string;
  correlationId: string;
  idempotencyKey: string;
  attemptCount: number;
  latencyMs: number;
}

export type OrchestrationResult<T> = OrchestrationSuccess<T> | OrchestrationFailure;
