import { BookingRuntimeService } from './booking-runtime.service';

interface UpdateManyCall {
  where: any;
  data: any;
}

function buildPrismaMock() {
  const state = {
    updateManyCalls: [] as UpdateManyCall[],
    updateManyError: null as Error | null,
  };
  const prisma: any = {
    _state: state,
    threadContext: {
      updateMany: jest.fn(async (args: UpdateManyCall) => {
        state.updateManyCalls.push(args);
        if (state.updateManyError) throw state.updateManyError;
        return { count: 1 };
      }),
    },
  };
  return prisma;
}

describe('BookingRuntimeService', () => {
  let svc: BookingRuntimeService;
  let prisma: any;

  beforeEach(() => {
    prisma = buildPrismaMock();
    svc = new BookingRuntimeService(prisma);
  });

  describe('setBookingState', () => {
    it('writes bookingState + bookingStateAt + reason', async () => {
      await svc.setBookingState('conv-1', { state: 'gathering_preferences', reason: 'classifier_wants_to_schedule' });
      expect(prisma._state.updateManyCalls).toHaveLength(1);
      const call = prisma._state.updateManyCalls[0];
      expect(call.where).toEqual({ conversationId: 'conv-1' });
      expect(call.data.bookingState).toBe('gathering_preferences');
      expect(call.data.bookingStateReason).toBe('classifier_wants_to_schedule');
      expect(call.data.bookingStateAt).toBeInstanceOf(Date);
    });

    it('omits reason when not provided', async () => {
      await svc.setBookingState('conv-1', { state: 'idle' });
      const call = prisma._state.updateManyCalls[0];
      expect(call.data.bookingState).toBe('idle');
      expect(call.data).not.toHaveProperty('bookingStateReason');
    });

    it.each([null, undefined, ''])('no-ops on falsy conversationId %s', async (v) => {
      await svc.setBookingState(v as any, { state: 'idle' });
      expect(prisma._state.updateManyCalls).toHaveLength(0);
    });

    it('rejects unknown state strings (no write, no throw)', async () => {
      await svc.setBookingState('conv-1', { state: 'totally_made_up' as any });
      expect(prisma._state.updateManyCalls).toHaveLength(0);
    });

    it.each([
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
    ])('accepts known state %s', async (state) => {
      await svc.setBookingState('conv-1', { state: state as any });
      expect(prisma._state.updateManyCalls).toHaveLength(1);
    });

    it('swallows DB errors (best-effort, never throws to caller)', async () => {
      prisma._state.updateManyError = new Error('DB exploded');
      await expect(
        svc.setBookingState('conv-1', { state: 'idle' }),
      ).resolves.toBeUndefined();
    });
  });

  describe('recordSlotsOffered', () => {
    it('writes proposedTimeSlotsJson + flips state to offering_slots', async () => {
      const slots = [
        { slotId: 's1', start: 't1', end: 't2', presentedAt: 'now' },
        { slotId: 's2', start: 't3', end: 't4', presentedAt: 'now' },
      ];
      await svc.recordSlotsOffered('conv-1', slots);
      const call = prisma._state.updateManyCalls[0];
      expect(call.data.bookingState).toBe('offering_slots');
      expect(call.data.proposedTimeSlotsJson).toBe(JSON.stringify(slots));
    });

    it('caps storage at 5 slots (write-side trim)', async () => {
      const slots = Array.from({ length: 8 }, (_, i) => ({
        slotId: `s${i}`,
        start: 't',
        end: 't',
        presentedAt: 'now',
      }));
      await svc.recordSlotsOffered('conv-1', slots);
      const written = JSON.parse(prisma._state.updateManyCalls[0].data.proposedTimeSlotsJson);
      expect(written).toHaveLength(5);
      // Last 5 — by .slice(-5)
      expect(written[0].slotId).toBe('s3');
      expect(written[4].slotId).toBe('s7');
    });
  });

  describe('recordSlotSelected', () => {
    it('writes selectedTimeSlotJson and does NOT touch bookingState', async () => {
      await svc.recordSlotSelected('conv-1', {
        slotId: 's1',
        start: 't1',
        end: 't2',
        selectedAt: 'now',
      });
      const call = prisma._state.updateManyCalls[0];
      expect(call.data.selectedTimeSlotJson).toContain('s1');
      expect(call.data).not.toHaveProperty('bookingState');
    });
  });

  describe('recordBookingAttempt', () => {
    it('issues two updateMany calls: preserve bookingRequestedAt (if null), then bump count + flip state', async () => {
      await svc.recordBookingAttempt('conv-1');
      expect(prisma._state.updateManyCalls).toHaveLength(2);

      // First call: only writes bookingRequestedAt where it was null
      const first = prisma._state.updateManyCalls[0];
      expect(first.where).toEqual({ conversationId: 'conv-1', bookingRequestedAt: null });
      expect(Object.keys(first.data)).toEqual(['bookingRequestedAt']);

      // Second call: increment count + flip state
      const second = prisma._state.updateManyCalls[1];
      expect(second.where).toEqual({ conversationId: 'conv-1' });
      expect(second.data.bookingAttemptCount).toEqual({ increment: 1 });
      expect(second.data.bookingState).toBe('booking_requested');
      expect(second.data.lastBookingAttemptAt).toBeInstanceOf(Date);
    });
  });

  describe('recordBookingFailure', () => {
    it('writes bookingState=booking_failed + bookingFailureReason', async () => {
      await svc.recordBookingFailure('conv-1', { reason: 'slot_taken' });
      const call = prisma._state.updateManyCalls[0];
      expect(call.data.bookingState).toBe('booking_failed');
      expect(call.data.bookingFailureReason).toBe('slot_taken');
    });

    it.each([null, undefined, ''])('no-ops on falsy conversationId %s', async (v) => {
      await svc.recordBookingFailure(v as any, { reason: 'slot_taken' });
      expect(prisma._state.updateManyCalls).toHaveLength(0);
    });
  });

  describe('best-effort contract — no method ever throws', () => {
    it('every public method swallows DB errors', async () => {
      prisma._state.updateManyError = new Error('boom');
      await expect(svc.setBookingState('c', { state: 'idle' })).resolves.toBeUndefined();
      await expect(svc.recordSlotsOffered('c', [])).resolves.toBeUndefined();
      await expect(
        svc.recordSlotSelected('c', { slotId: 's', start: 't', end: 't', selectedAt: 'now' }),
      ).resolves.toBeUndefined();
      await expect(svc.recordBookingAttempt('c')).resolves.toBeUndefined();
      await expect(svc.recordBookingFailure('c', { reason: 'x' })).resolves.toBeUndefined();
    });
  });

  describe('safety: no writes outside the 9 booking columns', () => {
    it('setBookingState only writes bookingState, bookingStateAt, bookingStateReason', async () => {
      await svc.setBookingState('conv-1', { state: 'idle', reason: 'test' });
      const data = prisma._state.updateManyCalls[0].data;
      const keys = Object.keys(data).sort();
      expect(keys).toEqual(['bookingState', 'bookingStateAt', 'bookingStateReason']);
    });

    it('recordBookingAttempt only writes booking-prefixed + lastBookingAttemptAt + bookingStateAt columns', async () => {
      await svc.recordBookingAttempt('conv-1');
      const allKeys = prisma._state.updateManyCalls.flatMap((c: any) => Object.keys(c.data));
      const allowed = new Set([
        'bookingState',
        'bookingStateAt',
        'bookingStateReason',
        'bookingRequestedAt',
        'proposedTimeSlotsJson',
        'selectedTimeSlotJson',
        'bookingAttemptCount',
        'lastBookingAttemptAt',
        'bookingFailureReason',
      ]);
      for (const k of allKeys) {
        expect(allowed.has(k)).toBe(true);
      }
    });
  });
});
