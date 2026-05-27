/**
 * Booking orchestration runtime vocabulary — Phase 2A.
 *
 * LeadBridge owns the booking *attempt* (a conversation-level state
 * machine). ServiceFlow owns the resulting job's operational lifecycle.
 * The two systems meet at three handshake points only:
 *
 *   1. GET  /api/integrations/leadbridge/orchestration/availability
 *   2. POST /api/integrations/leadbridge/orchestration/booking-request
 *   3. POST /api/integrations/leadbridge/orchestration/booking-cancel
 *   4. POST /api/integrations/leadbridge/orchestration/handoff
 *
 * LB does NOT create jobs. LB submits booking *requests*; SF validates
 * and owns the resulting job. The `service_*` terminal states below are
 * mirrored from SF outcomes — not authored by LB.
 *
 * Phase 2A introduces the vocabulary and schema only. No SF API calls,
 * no follow-up/AI gating changes, no Lead.status changes. PR-B (after SF
 * orchestration endpoints exist) will wire the actual writes.
 */

export const BOOKING_STATES = [
  // ─── LB orchestration runtime — booking attempt lifecycle ─────────────
  'idle',                     // no booking conversation active
  'gathering_preferences',    // AI collecting service / date window / address
  'awaiting_availability',    // LB requested SF availability; awaiting response
  'offering_slots',           // SF returned slots; AI is presenting them
  'awaiting_slot_selection',  // slots offered; awaiting customer pick
  'booking_requested',        // LB submitted booking-request to SF; awaiting outcome

  // ─── SF operational outcomes (mirrored, not owned) ────────────────────
  // These are written by LB only in response to SF telling us the
  // service-level outcome. SF is authoritative for transitions among them.
  'service_scheduled',        // SF created/confirmed job at slot
  'service_rescheduled',      // SF moved an existing scheduled service
  'service_cancelled',        // SF cancelled the service
  'service_completed',        // SF marked service complete

  // ─── LB-side terminal (request rejected before SF owned a job) ────────
  'booking_failed',           // submission rejected, no SF job created
] as const;

export type BookingState = (typeof BOOKING_STATES)[number];

/** Terminal states absorbing the booking attempt. */
export const BOOKING_TERMINAL_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'service_scheduled',
  'service_rescheduled',
  'service_cancelled',
  'service_completed',
  'booking_failed',
]);

/** Active states where the booking attempt is in flight. */
export const BOOKING_ACTIVE_STATES: ReadonlySet<BookingState> = new Set<BookingState>([
  'gathering_preferences',
  'awaiting_availability',
  'offering_slots',
  'awaiting_slot_selection',
  'booking_requested',
]);

/**
 * Canonical reason tags written to ThreadContext.bookingStateReason.
 * Free-form strings allowed at runtime; this enum is the canonical taxonomy
 * so logs and dashboards stay greppable.
 */
export const BOOKING_STATE_REASONS = {
  CLASSIFIER_WANTS_TO_SCHEDULE: 'classifier_wants_to_schedule',
  PREFERENCES_GATHERED: 'preferences_gathered',
  SF_AVAILABILITY_RETURNED: 'sf_availability_returned',
  SF_NO_AVAILABILITY: 'sf_no_availability',
  AI_OFFERED_SLOTS: 'ai_offered_slots',
  CUSTOMER_SELECTED_SLOT: 'customer_selected_slot',
  CUSTOMER_DECLINED_ALL_SLOTS: 'customer_declined_all_slots',
  LB_SUBMITTED_BOOKING_REQUEST: 'lb_submitted_booking_request',
  SF_BOOKING_ACCEPTED: 'sf_booking_accepted',
  SF_BOOKING_REJECTED: 'sf_booking_rejected',
  SF_RESCHEDULE_RECEIVED: 'sf_reschedule_received',
  SF_CANCEL_RECEIVED: 'sf_cancel_received',
  SF_COMPLETE_RECEIVED: 'sf_complete_received',
  CUSTOMER_ABANDONED: 'customer_abandoned',
} as const;

/**
 * Canonical reason tags written to ThreadContext.bookingFailureReason.
 * Only used when the resulting state is `booking_failed`.
 */
export const BOOKING_FAILURE_REASONS = {
  SLOT_TAKEN: 'slot_taken',
  VALIDATION_FAILED: 'validation_failed',
  NO_AVAILABILITY: 'no_availability',
  SF_UNAVAILABLE: 'sf_unavailable',
  CUSTOMER_ABANDONED: 'customer_abandoned',
} as const;

/**
 * Phase 2A introduces `wants_to_schedule` as a distinct classifier intent.
 *
 * Previously `wants_live_contact` was the only "customer wants action"
 * intent, but it conflates two different signals:
 *
 *   - "Can someone call me?"          → wants_live_contact (handoff)
 *   - "I want Tuesday morning"        → wants_to_schedule  (booking)
 *
 * The intent classifier itself is unchanged in PR-A; this constant is the
 * forward declaration so display labels and downstream code can reference
 * the canonical string ahead of the classifier upgrade in a later PR.
 */
export const CLASSIFIER_INTENT_WANTS_TO_SCHEDULE = 'wants_to_schedule';

export function isBookingState(s: string | null | undefined): s is BookingState {
  if (!s) return false;
  return (BOOKING_STATES as readonly string[]).includes(s);
}

export function isBookingTerminalState(s: string | null | undefined): boolean {
  return isBookingState(s) && BOOKING_TERMINAL_STATES.has(s);
}

export function isBookingActiveState(s: string | null | undefined): boolean {
  return isBookingState(s) && BOOKING_ACTIVE_STATES.has(s);
}
