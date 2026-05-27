import {
  BOOKING_STATES,
  BOOKING_TERMINAL_STATES,
  BOOKING_ACTIVE_STATES,
  BOOKING_STATE_REASONS,
  BOOKING_FAILURE_REASONS,
  CLASSIFIER_INTENT_WANTS_TO_SCHEDULE,
  isBookingState,
  isBookingTerminalState,
  isBookingActiveState,
} from './booking-runtime';

describe('booking-runtime vocabulary', () => {
  describe('BOOKING_STATES', () => {
    it('contains every documented state in the agreed Phase 2A vocabulary', () => {
      // Locked vocabulary. Adding/removing here is a contract change with
      // SF orchestration and the LegacyComparisonCard categories — must
      // be a deliberate PR, not a typo fix.
      expect([...BOOKING_STATES].sort()).toEqual(
        [
          'idle',
          'gathering_preferences',
          'awaiting_availability',
          'offering_slots',
          'awaiting_slot_selection',
          'booking_requested',
          'service_scheduled',
          'service_rescheduled',
          'service_cancelled',
          'service_completed',
          'booking_failed',
        ].sort(),
      );
    });

    it('has no duplicates', () => {
      expect(new Set(BOOKING_STATES).size).toBe(BOOKING_STATES.length);
    });
  });

  describe('terminal vs active partitioning', () => {
    it('every terminal state is a valid BOOKING_STATE', () => {
      for (const s of BOOKING_TERMINAL_STATES) {
        expect(BOOKING_STATES).toContain(s);
      }
    });

    it('every active state is a valid BOOKING_STATE', () => {
      for (const s of BOOKING_ACTIVE_STATES) {
        expect(BOOKING_STATES).toContain(s);
      }
    });

    it('terminal and active sets are disjoint', () => {
      for (const s of BOOKING_TERMINAL_STATES) {
        expect(BOOKING_ACTIVE_STATES.has(s as any)).toBe(false);
      }
    });

    it('"idle" is neither active nor terminal (it is the rest state)', () => {
      expect(BOOKING_TERMINAL_STATES.has('idle')).toBe(false);
      expect(BOOKING_ACTIVE_STATES.has('idle')).toBe(false);
    });

    it('all service_* states are terminal (SF outcomes, not LB attempts)', () => {
      for (const s of BOOKING_STATES) {
        if (s.startsWith('service_')) {
          expect(BOOKING_TERMINAL_STATES.has(s)).toBe(true);
        }
      }
    });

    it('booking_failed is terminal', () => {
      expect(BOOKING_TERMINAL_STATES.has('booking_failed')).toBe(true);
    });
  });

  describe('isBookingState type guard', () => {
    it.each(BOOKING_STATES)('accepts %s', (s) => {
      expect(isBookingState(s)).toBe(true);
    });

    it.each([null, undefined, ''])('rejects %s', (v) => {
      expect(isBookingState(v as any)).toBe(false);
    });

    it('rejects unknown strings', () => {
      expect(isBookingState('confirmed')).toBe(false);
      expect(isBookingState('booking_confirmed')).toBe(false); // old proposal
      expect(isBookingState('booking_cancelled')).toBe(false); // old proposal
    });
  });

  describe('isBookingTerminalState', () => {
    it('returns true for service_scheduled / cancelled / completed / rescheduled', () => {
      expect(isBookingTerminalState('service_scheduled')).toBe(true);
      expect(isBookingTerminalState('service_rescheduled')).toBe(true);
      expect(isBookingTerminalState('service_cancelled')).toBe(true);
      expect(isBookingTerminalState('service_completed')).toBe(true);
    });

    it('returns true for booking_failed', () => {
      expect(isBookingTerminalState('booking_failed')).toBe(true);
    });

    it('returns false for in-flight states', () => {
      expect(isBookingTerminalState('gathering_preferences')).toBe(false);
      expect(isBookingTerminalState('offering_slots')).toBe(false);
      expect(isBookingTerminalState('booking_requested')).toBe(false);
    });

    it('returns false for null / unknown', () => {
      expect(isBookingTerminalState(null)).toBe(false);
      expect(isBookingTerminalState('wat')).toBe(false);
    });
  });

  describe('isBookingActiveState', () => {
    it('returns true for in-flight states', () => {
      expect(isBookingActiveState('gathering_preferences')).toBe(true);
      expect(isBookingActiveState('awaiting_availability')).toBe(true);
      expect(isBookingActiveState('offering_slots')).toBe(true);
      expect(isBookingActiveState('awaiting_slot_selection')).toBe(true);
      expect(isBookingActiveState('booking_requested')).toBe(true);
    });

    it('returns false for idle and terminal states', () => {
      expect(isBookingActiveState('idle')).toBe(false);
      expect(isBookingActiveState('service_scheduled')).toBe(false);
      expect(isBookingActiveState('booking_failed')).toBe(false);
    });
  });

  describe('BOOKING_STATE_REASONS taxonomy', () => {
    it('exposes the canonical reason tags used by Phase 2B writes', () => {
      // Spot-check the high-signal tags. This isn't an exhaustive lock —
      // additions are fine — but renaming a tag changes log greppability.
      expect(BOOKING_STATE_REASONS.CLASSIFIER_WANTS_TO_SCHEDULE).toBe('classifier_wants_to_schedule');
      expect(BOOKING_STATE_REASONS.SF_BOOKING_ACCEPTED).toBe('sf_booking_accepted');
      expect(BOOKING_STATE_REASONS.SF_BOOKING_REJECTED).toBe('sf_booking_rejected');
      expect(BOOKING_STATE_REASONS.SF_CANCEL_RECEIVED).toBe('sf_cancel_received');
      expect(BOOKING_STATE_REASONS.SF_COMPLETE_RECEIVED).toBe('sf_complete_received');
    });
  });

  describe('BOOKING_FAILURE_REASONS taxonomy', () => {
    it('covers the four SF rejection cases plus customer abandonment', () => {
      expect(BOOKING_FAILURE_REASONS.SLOT_TAKEN).toBe('slot_taken');
      expect(BOOKING_FAILURE_REASONS.VALIDATION_FAILED).toBe('validation_failed');
      expect(BOOKING_FAILURE_REASONS.NO_AVAILABILITY).toBe('no_availability');
      expect(BOOKING_FAILURE_REASONS.SF_UNAVAILABLE).toBe('sf_unavailable');
      expect(BOOKING_FAILURE_REASONS.CUSTOMER_ABANDONED).toBe('customer_abandoned');
    });
  });

  describe('CLASSIFIER_INTENT_WANTS_TO_SCHEDULE', () => {
    it('is the literal string the classifier upgrade will emit', () => {
      // Forward-declared in PR-A so display labels and downstream code
      // can reference the canonical string before the classifier itself
      // is updated.
      expect(CLASSIFIER_INTENT_WANTS_TO_SCHEDULE).toBe('wants_to_schedule');
    });
  });
});
