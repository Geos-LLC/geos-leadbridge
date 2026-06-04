import { BookingOrchestratorService } from './booking-orchestrator.service';

interface ThreadCtxRow {
  bookingState: string | null;
  bookingAttemptCount: number | null;
  proposedTimeSlotsJson: string | null;
  bookingStateAt: Date | null;
}

function buildDeps(opts: {
  flagEnabled?: boolean;
  threadCtx?: ThreadCtxRow | null;
  availabilityResult?: { ok: true; data: any } | { ok: false; code: string; message?: string };
  bookingResult?: { ok: true; data: any } | { ok: false; code: string; message?: string };
  phraseSource?: 'ai' | 'template';
} = {}) {
  const calls: any = {
    prisma: { lead: [], threadContext: [] },
    booking: [],
    conversation: [],
    sf: [],
    phrasing: [],
  };

  const prisma: any = {
    threadContext: {
      findUnique: jest.fn(async (args: any) => {
        calls.prisma.threadContext.push({ method: 'findUnique', args });
        return opts.threadCtx === undefined
          ? { bookingState: null, bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: null }
          : opts.threadCtx;
      }),
    },
    lead: {
      updateMany: jest.fn(async (args: any) => {
        calls.prisma.lead.push({ method: 'updateMany', args });
        return { count: 1 };
      }),
    },
  };

  const flag: any = {
    isEnabledForUser: jest.fn((uid: string) => opts.flagEnabled === true),
  };

  const sf: any = {
    getAvailability: jest.fn(async () => {
      calls.sf.push({ method: 'getAvailability' });
      return opts.availabilityResult ?? { ok: false, code: 'orchestration_disabled', message: 'env unset' };
    }),
    submitBookingRequest: jest.fn(async () => {
      calls.sf.push({ method: 'submitBookingRequest' });
      return opts.bookingResult ?? { ok: false, code: 'orchestration_disabled', message: 'env unset' };
    }),
    submitBookingCancel: jest.fn(),
    submitHandoff: jest.fn(),
  };

  const bookingRuntime: any = {
    setBookingState: jest.fn(async (...args: any) => { calls.booking.push({ method: 'setBookingState', args }); }),
    recordSlotsOffered: jest.fn(async (...args: any) => { calls.booking.push({ method: 'recordSlotsOffered', args }); }),
    recordSlotSelected: jest.fn(async (...args: any) => { calls.booking.push({ method: 'recordSlotSelected', args }); }),
    recordBookingAttempt: jest.fn(async (...args: any) => { calls.booking.push({ method: 'recordBookingAttempt', args }); }),
    recordBookingFailure: jest.fn(async (...args: any) => { calls.booking.push({ method: 'recordBookingFailure', args }); }),
  };

  const conversationRuntime: any = {
    setHandoffRequested: jest.fn(async (...args: any) => { calls.conversation.push({ method: 'setHandoffRequested', args }); }),
    setState: jest.fn(async (...args: any) => { calls.conversation.push({ method: 'setState', args }); }),
  };

  const slotPhrasing: any = {
    phrase: jest.fn(async () => {
      calls.phrasing.push({ method: 'phrase' });
      return { message: 'mock offer text', source: opts.phraseSource ?? 'template' };
    }),
    formatSlot: jest.fn((s: any) => `LABEL-${s.slotId}`),
    fallbackTemplate: jest.fn(() => 'mock template'),
  };

  const svc = new BookingOrchestratorService(
    prisma,
    flag,
    sf,
    bookingRuntime,
    conversationRuntime,
    slotPhrasing,
  );

  return { svc, calls, prisma, flag, sf, bookingRuntime, conversationRuntime, slotPhrasing };
}

const ENTRY = {
  userId: 'u1',
  leadId: 'lead1',
  conversationId: 'conv1',
  customerMessage: 'I want Tuesday morning',
  intent: 'wants_to_schedule' as const,
  sigcoreBusinessId: 'biz1',
  serviceType: 'standard',
  accountName: 'Acme',
};

describe('BookingOrchestratorService — handleClassifiedIntent', () => {
  describe('Flag gating', () => {
    it('returns flag_disabled and writes NOTHING when flag is OFF', async () => {
      const { svc, calls, bookingRuntime, sf } = buildDeps({ flagEnabled: false });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('flag_disabled');
      expect(calls.booking).toHaveLength(0);
      expect(calls.sf).toHaveLength(0);
      expect(bookingRuntime.setBookingState).not.toHaveBeenCalled();
      expect(sf.getAvailability).not.toHaveBeenCalled();
    });

    it('proceeds when flag is ON', async () => {
      const { svc } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'idle', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: null },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('started_gathering');
    });
  });

  describe('Re-entry guards', () => {
    it('short-circuits when bookingState=service_scheduled', async () => {
      const { svc, calls } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'service_scheduled', bookingAttemptCount: 1, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('terminal_state');
      expect(calls.booking).toHaveLength(0);
    });

    it('short-circuits when bookingState=booking_requested (in-flight)', async () => {
      const { svc } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'booking_requested', bookingAttemptCount: 1, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('already_in_flight');
    });

    it('routes to handoff fallback when bookingAttemptCount >= MAX', async () => {
      const { svc, conversationRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'booking_failed', bookingAttemptCount: 3, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('booking_failed_terminal');
      expect(out.reason).toBe('max_attempts_reached');
      expect(conversationRuntime.setHandoffRequested).toHaveBeenCalled();
    });
  });

  describe('Fresh entry → gathering_preferences', () => {
    it('writes bookingState=gathering_preferences with classifier_wants_to_schedule reason', async () => {
      const { svc, bookingRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'idle', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: null },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('started_gathering');
      expect(bookingRuntime.setBookingState).toHaveBeenCalledTimes(1);
      const setCall = bookingRuntime.setBookingState.mock.calls[0];
      expect(setCall[0]).toBe('conv1');
      expect(setCall[1]).toEqual({ state: 'gathering_preferences', reason: 'classifier_wants_to_schedule' });
    });

    it('treats service_cancelled (re-engageable) as a fresh entry', async () => {
      const { svc, bookingRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'service_cancelled', bookingAttemptCount: 1, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('started_gathering');
      expect(bookingRuntime.setBookingState).toHaveBeenCalled();
    });
  });

  describe('Availability query', () => {
    it('on no_slots → records booking_failure with no_availability', async () => {
      const { svc, bookingRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'gathering_preferences', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
        availabilityResult: { ok: true, data: { candidateSlots: [], searchWindow: null, durationMinutes: null, cachedForSeconds: 0 } },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('no_availability');
      const failCall = bookingRuntime.recordBookingFailure.mock.calls[0];
      expect(failCall[1].reason).toBe('no_availability');
    });

    it('on slots returned → records offer + advances to awaiting_slot_selection', async () => {
      const { svc, bookingRuntime, slotPhrasing } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'gathering_preferences', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
        availabilityResult: { ok: true, data: { candidateSlots: [{ slotId: 's1', slotToken: 's1', start: '2026-06-02T13:00:00Z', end: '2026-06-02T15:00:00Z' }], cachedForSeconds: 30 } },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('offering_slots');
      expect(out.outboundMessage).toBe('mock offer text');
      expect(bookingRuntime.recordSlotsOffered).toHaveBeenCalled();
      // setBookingState should be called to advance from offering_slots → awaiting_slot_selection
      const setCalls = bookingRuntime.setBookingState.mock.calls;
      const awaiting = setCalls.find((c: any) => c[1].state === 'awaiting_slot_selection');
      expect(awaiting).toBeDefined();
      expect(slotPhrasing.phrase).toHaveBeenCalled();
    });

    it('on SF orchestration_disabled (env unset) → handoff fallback', async () => {
      const { svc, conversationRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'gathering_preferences', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
        availabilityResult: { ok: false, code: 'orchestration_disabled', message: 'env unset' },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      expect(out.decision).toBe('orchestration_disabled');
      expect(conversationRuntime.setHandoffRequested).toHaveBeenCalled();
    });

    it('passes requestedAt to SF client AND does NOT return no_availability when candidateSlots is non-empty', async () => {
      // Regression guard for the post-2026-06-04 contract fix:
      //   (a) SF requires `requestedAt` in the request (it 400s without it),
      //   (b) the response field renamed slots → candidateSlots — reading the
      //       old key returned undefined, which silently routed every probe
      //       through the no_availability branch.
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'gathering_preferences', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
        availabilityResult: {
          ok: true,
          data: {
            candidateSlots: [
              { slotId: 's1', slotToken: 's1', start: '2026-06-07T13:00:00Z', end: '2026-06-07T15:00:00Z' },
              { slotId: 's2', slotToken: 's2', start: '2026-06-07T15:00:00Z', end: '2026-06-07T17:00:00Z' },
            ],
            searchWindow: { start: '2026-06-07T13:00:00Z', end: '2026-06-07T17:00:00Z' },
            durationMinutes: 120,
            cachedForSeconds: 0,
          },
        },
      });
      const out = await svc.handleClassifiedIntent(ENTRY);
      // (a) requestedAt landed on the SF call as ISO-8601 — not undefined, not omitted.
      expect(sf.getAvailability).toHaveBeenCalledTimes(1);
      const sfReq = sf.getAvailability.mock.calls[0][0];
      expect(typeof sfReq.requestedAt).toBe('string');
      expect(sfReq.requestedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // (b) two slots in → offering_slots, NOT no_availability. Re-asserts that the
      // orchestrator reads .candidateSlots (post-fix) and not .slots (pre-fix).
      expect(out.decision).toBe('offering_slots');
      expect(out.decision).not.toBe('no_availability');
    });

    it('bails to handoff when sigcoreBusinessId is missing', async () => {
      const { svc, sf, conversationRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: { bookingState: 'gathering_preferences', bookingAttemptCount: 0, proposedTimeSlotsJson: null, bookingStateAt: new Date() },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, sigcoreBusinessId: null });
      expect(out.decision).toBe('orchestration_disabled');
      expect(sf.getAvailability).not.toHaveBeenCalled();
      expect(conversationRuntime.setHandoffRequested).toHaveBeenCalled();
    });
  });

  describe('Slot selection', () => {
    const offeredSlots = JSON.stringify([
      { slotId: 's1', start: '2026-06-02T13:00:00Z', end: '2026-06-02T15:00:00Z', presentedAt: 'now' },
      { slotId: 's2', start: '2026-06-03T20:00:00Z', end: '2026-06-03T22:00:00Z', presentedAt: 'now' },
    ]);

    it('numeric pick "1" matches first offered slot and submits booking-request', async () => {
      const { svc, sf, bookingRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: true, data: { sfJobId: 'sf-1', canonicalStatus: 'scheduled', scheduledFor: '2026-06-02T13:00:00Z' } },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      expect(out.decision).toBe('booking_accepted');
      expect(bookingRuntime.recordSlotSelected).toHaveBeenCalled();
      expect(bookingRuntime.recordBookingAttempt).toHaveBeenCalled();
      expect(sf.submitBookingRequest).toHaveBeenCalledTimes(1);
      const submitArgs = sf.submitBookingRequest.mock.calls[0][0];
      expect(submitArgs.slotId).toBe('s1');
    });

    it('ordinal "second" matches second offered slot', async () => {
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: true, data: { sfJobId: 'sf-2', canonicalStatus: 'scheduled', scheduledFor: '2026-06-03T20:00:00Z' } },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: 'the second one' });
      expect(out.decision).toBe('booking_accepted');
      const submitArgs = sf.submitBookingRequest.mock.calls[0][0];
      expect(submitArgs.slotId).toBe('s2');
    });

    it('ambiguous message (no confident pick) returns no_op — AI takes over', async () => {
      const { svc, sf, bookingRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: 'do you bring supplies?' });
      expect(out.decision).toBe('no_op');
      expect(sf.submitBookingRequest).not.toHaveBeenCalled();
      expect(bookingRuntime.recordSlotSelected).not.toHaveBeenCalled();
    });

    it('stale offer (>15min old) re-queries availability instead of accepting selection', async () => {
      const stale = new Date(Date.now() - 20 * 60 * 1000);
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: stale,
        },
        availabilityResult: { ok: true, data: { candidateSlots: [{ slotId: 's-new', slotToken: 's-new', start: '2026-06-05T13:00:00Z', end: '2026-06-05T15:00:00Z' }], cachedForSeconds: 30 } },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      expect(out.decision).toBe('offering_slots');
      expect(sf.getAvailability).toHaveBeenCalled();
      expect(sf.submitBookingRequest).not.toHaveBeenCalled();
    });

    it('SF 409 slot_taken → re-query availability', async () => {
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: false, code: 'slot_taken', message: 'taken' },
        availabilityResult: { ok: true, data: { candidateSlots: [{ slotId: 's3', slotToken: 's3', start: '2026-06-05T13:00:00Z', end: '2026-06-05T15:00:00Z' }], cachedForSeconds: 30 } },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      expect(out.decision).toBe('offering_slots');
      expect(sf.submitBookingRequest).toHaveBeenCalled();
      expect(sf.getAvailability).toHaveBeenCalled();
    });

    it('SF 410 slot_token_expired → re-query availability', async () => {
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: false, code: 'slot_token_expired', message: 'expired' },
        availabilityResult: { ok: true, data: { candidateSlots: [], searchWindow: null, durationMinutes: null, cachedForSeconds: 0 } },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      // slot_token_expired → re-query → no slots → no_availability
      expect(out.decision).toBe('no_availability');
    });

    it('SF 422 validation_failed → handoff fallback', async () => {
      const { svc, conversationRuntime } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offeredSlots,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: false, code: 'validation_failed', message: 'postcode invalid' },
      });
      const out = await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      expect(out.decision).toBe('booking_failed_terminal');
      expect(conversationRuntime.setHandoffRequested).toHaveBeenCalled();
    });
  });

  describe('Idempotency keys', () => {
    it('booking-request uses stable key per (conversationId, slotId)', async () => {
      const offered = JSON.stringify([
        { slotId: 's1', start: '2026-06-02T13:00:00Z', end: '2026-06-02T15:00:00Z' },
      ]);
      const { svc, sf } = buildDeps({
        flagEnabled: true,
        threadCtx: {
          bookingState: 'awaiting_slot_selection',
          bookingAttemptCount: 0,
          proposedTimeSlotsJson: offered,
          bookingStateAt: new Date(),
        },
        bookingResult: { ok: true, data: { sfJobId: 'sf-1', canonicalStatus: 'scheduled', scheduledFor: 't' } },
      });
      await svc.handleClassifiedIntent({ ...ENTRY, customerMessage: '1' });
      const idemKey = sf.submitBookingRequest.mock.calls[0][1];
      expect(idemKey).toBe('booking-request:conv1:s1');
    });
  });
});

describe('BookingOrchestratorService — handleServiceOutcomeEvent', () => {
  const event = {
    eventId: 'evt-1',
    sfJobId: 'sf-1',
    userId: 'u1',
    leadId: 'lead1',
    conversationId: 'conv1',
    scheduledFor: '2026-06-02T13:00:00Z',
  };

  describe('flag gating', () => {
    it('no-ops when flag is OFF (defense-in-depth at event handler)', async () => {
      const { svc, prisma, bookingRuntime, conversationRuntime } = buildDeps({ flagEnabled: false });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: 'service_scheduled' });
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(bookingRuntime.setBookingState).not.toHaveBeenCalled();
      expect(conversationRuntime.setState).not.toHaveBeenCalled();
    });
  });

  describe('service_scheduled', () => {
    it('writes sfJobOutcome=scheduled + bookingState=service_scheduled + aiStatus=stopped_booked + conversationState=booked_in_lb', async () => {
      const { svc, prisma, bookingRuntime, conversationRuntime } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: 'service_scheduled' });

      // Lead.sfJobOutcome — additive mirror only (no Lead.status write)
      expect(prisma.lead.updateMany).toHaveBeenCalled();
      const leadCall = prisma.lead.updateMany.mock.calls[0][0];
      expect(leadCall.where.id).toBe('lead1');
      expect(leadCall.data.sfJobOutcome).toBe('scheduled');
      // CRITICAL: no Lead.status field in the data payload
      expect(leadCall.data).not.toHaveProperty('status');

      const bookingCall = bookingRuntime.setBookingState.mock.calls[0];
      expect(bookingCall[1].state).toBe('service_scheduled');

      const convCall = conversationRuntime.setState.mock.calls[0];
      expect(convCall[1].aiStatus).toBe('stopped_booked');
      expect(convCall[1].conversationState).toBe('booked_in_lb');
    });
  });

  describe('service_rescheduled', () => {
    it('writes sfJobOutcome=scheduled + bookingState=service_rescheduled but does NOT touch aiStatus', async () => {
      const { svc, prisma, bookingRuntime, conversationRuntime } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({
        ...event,
        eventType: 'service_rescheduled',
        rescheduledSlot: { slotId: 's-new', start: '2026-06-04T13:00:00Z', end: '2026-06-04T15:00:00Z' },
      });
      const leadCall = prisma.lead.updateMany.mock.calls[0][0];
      expect(leadCall.data.sfJobOutcome).toBe('scheduled');
      expect(bookingRuntime.setBookingState.mock.calls[0][1].state).toBe('service_rescheduled');
      // setState was NOT called with aiStatus/conversationState
      expect(conversationRuntime.setState).not.toHaveBeenCalled();
      // recordSlotSelected was called with the new slot
      expect(bookingRuntime.recordSlotSelected).toHaveBeenCalled();
    });
  });

  describe('service_cancelled', () => {
    it('writes sfJobOutcome=cancelled + bookingState=service_cancelled, no AI/conv mutation (re-engageable)', async () => {
      const { svc, prisma, bookingRuntime, conversationRuntime } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: 'service_cancelled' });
      expect(prisma.lead.updateMany.mock.calls[0][0].data.sfJobOutcome).toBe('cancelled');
      expect(bookingRuntime.setBookingState.mock.calls[0][1].state).toBe('service_cancelled');
      expect(conversationRuntime.setState).not.toHaveBeenCalled();
    });
  });

  describe('service_completed', () => {
    it('writes sfJobOutcome=completed + bookingState=service_completed + aiStatus=stopped_terminal', async () => {
      const { svc, prisma, bookingRuntime, conversationRuntime } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: 'service_completed' });
      expect(prisma.lead.updateMany.mock.calls[0][0].data.sfJobOutcome).toBe('completed');
      expect(bookingRuntime.setBookingState.mock.calls[0][1].state).toBe('service_completed');
      const convCall = conversationRuntime.setState.mock.calls[0];
      expect(convCall[1].aiStatus).toBe('stopped_terminal');
    });
  });

  describe('safety: every event handler writes ONLY sfJobOutcome (not Lead.status)', () => {
    it.each([
      ['service_scheduled', 'scheduled'],
      ['service_rescheduled', 'scheduled'],
      ['service_cancelled', 'cancelled'],
      ['service_completed', 'completed'],
    ])('%s writes sfJobOutcome=%s only — no Lead.status mutation', async (eventType, expectedOutcome) => {
      const { svc, prisma } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: eventType as any });
      const data = prisma.lead.updateMany.mock.calls[0][0].data;
      expect(data.sfJobOutcome).toBe(expectedOutcome);
      expect(data).not.toHaveProperty('status');
      expect(data).not.toHaveProperty('thumbtackStatus');
    });
  });

  describe('safety: stale-write protection', () => {
    it('Lead.updateMany guards on sfJobOutcomeAt OR null', async () => {
      const { svc, prisma } = buildDeps({ flagEnabled: true });
      await svc.handleServiceOutcomeEvent({ ...event, eventType: 'service_scheduled' });
      const where = prisma.lead.updateMany.mock.calls[0][0].where;
      expect(where.OR).toEqual([
        { sfJobOutcomeAt: null },
        { sfJobOutcomeAt: { lt: expect.any(Date) } },
      ]);
    });
  });
});
