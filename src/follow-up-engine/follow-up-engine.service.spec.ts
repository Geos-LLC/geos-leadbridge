/**
 * Follow-Up Engine Service Tests
 *
 * Tests: enrollInSequence (dedup, step skipping, re-enroll delay, P2002 race),
 * evaluateThread (terminal status), handleCustomerReply (idempotent)
 */

import { FollowUpEngineService } from './follow-up-engine.service';
import { Prisma } from '../../generated/prisma';

const USER_ID = 'user-123';
const CONVERSATION_ID = 'conv-456';
const TEMPLATE_ID = 'tmpl-789';
const LEAD_ID = 'lead-001';

function buildPrismaMock() {
  const mock: any = {
    followUpEnrollment: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation((args: any) => Promise.resolve({ id: 'enroll-new', ...args.data })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    followUpSequenceTemplate: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({
        id: TEMPLATE_ID,
        mode: 'auto_send',
        stepsJson: { steps: [
          { stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' },
          { stepOrder: 1, delayMinutes: 60, objective: 'follow_up' },
          { stepOrder: 2, delayMinutes: 1440, objective: 'follow_up' },
          { stepOrder: 3, delayMinutes: 4320, objective: 'soft_nudge' },
        ]},
        activeHoursStart: '09:00',
        activeHoursEnd: '21:00',
        activeHoursTimezone: 'America/New_York',
      }),
    },
    followUpStepExecution: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    threadContext: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null, threadId: CONVERSATION_ID }),
      findUnique: jest.fn().mockResolvedValue({ id: LEAD_ID, threadId: CONVERSATION_ID, userId: USER_ID, businessId: 'biz-1' }),
    },
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({ followUpMode: 'auto_send', followUpSettingsJson: null }),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
    },
  };
  // Simulate $transaction by invoking the callback with the same mock client.
  // Tests that need to simulate P2002 can override `create` to throw it.
  mock.$transaction = jest.fn().mockImplementation(async (cb: any) => cb(mock));
  return mock;
}

/** Build a Prisma P2002 error with the correct class identity for instanceof checks. */
function buildP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`conversationId`)',
    { code: 'P2002', clientVersion: 'test' } as any,
  );
}

function buildContextMock() {
  return {
    getThreadState: jest.fn().mockResolvedValue({
      stage: 'initial',
      engagementLevel: 'warm',
      awaitingCustomerReply: true,
      priceDiscussed: false,
      lastQuestionAsked: null,
      businessMessages: 1,
      aiMessages: 0,
      customerMessages: 1,
    }),
  } as any;
}

function buildStateMock() {
  return {
    deriveFollowUpState: jest.fn().mockReturnValue('no_reply_after_initial'),
  } as any;
}

describe('FollowUpEngineService', () => {
  let service: FollowUpEngineService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let contextService: ReturnType<typeof buildContextMock>;
  let stateService: ReturnType<typeof buildStateMock>;
  let eventEmitter: any;

  beforeEach(() => {
    prisma = buildPrismaMock();
    contextService = buildContextMock();
    stateService = buildStateMock();
    eventEmitter = { emit: jest.fn() };
    service = new FollowUpEngineService(prisma, contextService, stateService, eventEmitter);
    jest.clearAllMocks();
  });

  describe('enrollInSequence', () => {
    it('creates enrollment for new conversation', async () => {
      const id = await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);
      expect(id).toBe('enroll-new');
      expect(prisma.followUpEnrollment.create).toHaveBeenCalledTimes(1);
    });

    it('returns existing enrollment ID if already active', async () => {
      prisma.followUpEnrollment.findFirst.mockResolvedValue({ id: 'existing-enroll', status: 'active' });

      const id = await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);
      expect(id).toBe('existing-enroll');
      expect(prisma.followUpEnrollment.create).not.toHaveBeenCalled();
    });

    it('starts from step 0 for new leads (no prior follow-up executions)', async () => {
      // Initial AI auto-reply exists but NO prior follow-up sends.
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date() });
      prisma.followUpStepExecution.count.mockResolvedValue(0);

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      expect(createCall.data.currentStepIndex).toBe(0);
    });

    it('does NOT count the initial AI auto-reply as a follow-up (Ruth regression)', async () => {
      // Ruth-style state: 1 pro message (the initial AI auto-reply) but 0
      // follow-up step executions yet. Start must be step 0 so the configured
      // "2 min" first follow-up fires, not the template's 30-min step.
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date() });
      prisma.followUpStepExecution.count.mockResolvedValue(0);

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      expect(createCall.data.currentStepIndex).toBe(0);
    });

    it('skips ahead when prior follow-up executions exist', async () => {
      // Re-enrollment after a previous enrollment actually SENT follow-ups.
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date('2026-04-01') });
      prisma.followUpStepExecution.count.mockResolvedValue(2); // 2 prior follow-ups sent
      prisma.savedAccount.findFirst.mockResolvedValue({ followUpSettingsJson: null });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      // 2 prior follow-ups → messageBasedIndex=2, + 24h re-enroll delay
      // (template step 2 = 1440min) → start at step 2.
      expect(createCall.data.currentStepIndex).toBe(2);
    });

    it('respects custom re-enroll delay from settings when prior follow-ups exist', async () => {
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date('2026-04-01') });
      prisma.followUpStepExecution.count.mockResolvedValue(1);
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({ fuReEnrollDelay: '4h' }),
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      // 4h = 240 min, first step >= 240 is step 2 (1440min)
      expect(createCall.data.currentStepIndex).toBe(2);
    });

    it('uses user-configured step delays (not template) when computing first nextDue', async () => {
      // User configured first step as "2 min"; template has 30 min. Verify
      // enrollInSequence picks up the user delay so the first follow-up fires
      // at now+2min, not now+30min (Ruth regression).
      const now = new Date('2026-04-20T22:03:00Z');
      jest.useFakeTimers({ now });

      prisma.message.findFirst.mockResolvedValue({ sentAt: now });
      prisma.followUpStepExecution.count.mockResolvedValue(0);
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpMode: 'auto_send',
        followUpSettingsJson: JSON.stringify({
          followUpSteps: [
            { label: '1st', delay: '2 min', message: 'checkin' },
            { label: '2nd', delay: '10 min', message: 'followup' },
          ],
        }),
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      const expected = new Date(now.getTime() + 2 * 60_000);
      expect(createCall.data.nextStepDueAt.getTime()).toBe(expected.getTime());
      jest.useRealTimers();
    });

    it('firstStepDelayMinutesOverride wins on step 0 (Devi case — customer-stated re-engage window)', async () => {
      // Customer said "in 2 weeks". Classifier extracts 14 days → 20160 min.
      // Configured first step is 2 min; override should anchor next-due to
      // now + 14 days, NOT now + 2 min.
      const now = new Date('2026-04-20T22:03:00Z');
      jest.useFakeTimers({ now });

      prisma.message.findFirst.mockResolvedValue({ sentAt: now });
      prisma.followUpStepExecution.count.mockResolvedValue(0);
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpMode: 'auto_send',
        followUpSettingsJson: JSON.stringify({
          followUpSteps: [{ label: '1st', delay: '2 min', message: 'checkin' }],
        }),
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID, 14 * 24 * 60);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      const expected = new Date(now.getTime() + 14 * 24 * 60 * 60_000);
      expect(createCall.data.nextStepDueAt.getTime()).toBe(expected.getTime());
      jest.useRealTimers();
    });

    it('firstStepDelayMinutesOverride is ignored on re-enrollment (startStepIndex > 0)', async () => {
      // If prior follow-ups have been sent, the customer's stale "in 2 weeks"
      // would mis-anchor a fresh enrollment. Keep the configured cadence.
      const now = new Date('2026-04-20T22:03:00Z');
      jest.useFakeTimers({ now });

      prisma.message.findFirst.mockResolvedValue({ sentAt: now });
      prisma.followUpStepExecution.count.mockResolvedValue(2); // re-enrollment
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpMode: 'auto_send',
        followUpSettingsJson: null,
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID, 14 * 24 * 60);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      // Should land on step 2 (1440 min from template) — override ignored
      // because startStepIndex > 0.
      const expected = new Date(now.getTime() + 1440 * 60_000);
      expect(createCall.data.nextStepDueAt.getTime()).toBe(expected.getTime());
      jest.useRealTimers();
    });

    it('falls back to configured first step when override is undefined', async () => {
      const now = new Date('2026-04-20T22:03:00Z');
      jest.useFakeTimers({ now });

      prisma.message.findFirst.mockResolvedValue({ sentAt: now });
      prisma.followUpStepExecution.count.mockResolvedValue(0);
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpMode: 'auto_send',
        followUpSettingsJson: JSON.stringify({
          followUpSteps: [{ label: '1st', delay: '3 days', message: 'checkin' }],
        }),
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID); // no override

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      const expected = new Date(now.getTime() + 3 * 24 * 60 * 60_000);
      expect(createCall.data.nextStepDueAt.getTime()).toBe(expected.getTime());
      jest.useRealTimers();
    });

    it('throws when template not found', async () => {
      prisma.followUpSequenceTemplate.findUnique.mockResolvedValue(null);

      await expect(
        service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID),
      ).rejects.toThrow('not found');
    });

    it('P2002 race — returns existing winner id instead of duplicating', async () => {
      // Simulate: pre-check in txn sees no existing, but create trips the partial
      // unique index (another concurrent caller won the race). Fallback lookup
      // should find the winner and return its id.
      prisma.followUpEnrollment.create.mockRejectedValueOnce(buildP2002());
      // Second findFirst (outside txn, fallback) returns the winner
      prisma.followUpEnrollment.findFirst
        .mockResolvedValueOnce(null) // inside-txn pre-check — appears empty
        .mockResolvedValueOnce({ id: 'winner-enroll' }); // fallback lookup after P2002

      const id = await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);
      expect(id).toBe('winner-enroll');
    });

    it('non-P2002 Prisma errors are re-thrown', async () => {
      const otherErr = new Prisma.PrismaClientKnownRequestError(
        'Some other error',
        { code: 'P2003', clientVersion: 'test' } as any,
      );
      prisma.followUpEnrollment.create.mockRejectedValueOnce(otherErr);

      await expect(
        service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID),
      ).rejects.toThrow('Some other error');
    });

    it('concurrent parallel enrolls collapse to one enrollment id (P2002 race)', async () => {
      // Simulate the true race: both calls race through the pre-check and both
      // reach `create`. The DB partial unique index allows only one INSERT —
      // the loser throws P2002, and the service must return the winner's id.
      let persisted: any = null;
      prisma.followUpEnrollment.findFirst.mockImplementation(async () => persisted);
      prisma.followUpEnrollment.create.mockImplementation(async (args: any) => {
        if (persisted) {
          // Second create hits the unique index in production — simulate P2002.
          throw buildP2002();
        }
        persisted = { id: 'enroll-first', ...args.data };
        return persisted;
      });

      const [a, b] = await Promise.all([
        service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID),
        service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID),
      ]);
      // Both callers observe the same winning id — the invariant is "one id",
      // not "one create call" (the partial unique index is the real guard; the
      // service just translates P2002 into idempotent behavior).
      expect(a).toBe(b);
      expect(a).toBe('enroll-first');
      // Exactly one row survives in our simulated store.
      expect(persisted).not.toBeNull();
    });
  });

  describe('evaluateThread', () => {
    it('skips leads with terminal status', async () => {
      prisma.lead.findFirst.mockResolvedValue({ status: 'done', thumbtackStatus: null });

      await service.evaluateThread(CONVERSATION_ID, 'yelp');

      expect(prisma.followUpEnrollment.create).not.toHaveBeenCalled();
    });

    it('skips leads with hired thumbtackStatus', async () => {
      prisma.lead.findFirst.mockResolvedValue({ status: 'new', thumbtackStatus: 'hired' });

      await service.evaluateThread(CONVERSATION_ID, 'yelp');

      expect(prisma.followUpEnrollment.create).not.toHaveBeenCalled();
    });

    it('skips when thread state is null', async () => {
      prisma.lead.findFirst.mockResolvedValue({ status: 'new', thumbtackStatus: null });
      contextService.getThreadState.mockResolvedValue(null);

      await service.evaluateThread(CONVERSATION_ID, 'yelp');

      expect(prisma.followUpEnrollment.create).not.toHaveBeenCalled();
    });

    it('skips when not eligible for follow-up', async () => {
      prisma.lead.findFirst.mockResolvedValue({ status: 'new', thumbtackStatus: null });
      stateService.deriveFollowUpState.mockReturnValue(null);

      await service.evaluateThread(CONVERSATION_ID, 'yelp');

      expect(prisma.followUpEnrollment.create).not.toHaveBeenCalled();
    });
  });

  describe('handleCustomerReply', () => {
    it('stops active enrollments', async () => {
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      await service.handleCustomerReply(CONVERSATION_ID);

      expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledWith({
        where: { conversationId: CONVERSATION_ID, status: 'active' },
        data: expect.objectContaining({ status: 'stopped', stoppedReason: 'customer_replied' }),
      });
    });

    it('clears thread context when enrollment stopped', async () => {
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      await service.handleCustomerReply(CONVERSATION_ID);

      expect(prisma.threadContext.updateMany).toHaveBeenCalledWith({
        where: { conversationId: CONVERSATION_ID },
        data: expect.objectContaining({ activeEnrollmentId: null, followUpStatus: 'stopped' }),
      });
    });

    it('is idempotent — no error when no active enrollment', async () => {
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.handleCustomerReply(CONVERSATION_ID)).resolves.not.toThrow();
      // ThreadContext should NOT be updated when count=0
      expect(prisma.threadContext.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('stopEnrollment', () => {
    it('stops enrollment with reason', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({ conversationId: CONVERSATION_ID });

      await service.stopEnrollment('enroll-1', 'lead_status_done');

      expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledWith({
        where: { id: 'enroll-1', status: 'active' },
        data: expect.objectContaining({ status: 'stopped', stoppedReason: 'lead_status_done' }),
      });
    });
  });

  // ======================================================================
  // Engagement-aware follow-up (SF sync plan §7)
  // ======================================================================

  describe('isEngaged', () => {
    it('returns true when customer has replied at least once', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'cold', awaitingCustomerReply: true,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 1,
      });
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });

    it('returns true when priceDiscussed is true', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'cold', awaitingCustomerReply: true,
        priceDiscussed: true, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 0,
      });
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });

    it('returns true when stage is booking/scheduled', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'booking', engagementLevel: 'cold', awaitingCustomerReply: false,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 0,
      });
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });

    it('returns true when total messages ≥ 4', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'cold', awaitingCustomerReply: false,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 2, aiMessages: 2, customerMessages: 0,
      });
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });

    it('returns true when engagement level is warm', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'warm', awaitingCustomerReply: true,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 0,
      });
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });

    it('returns false for ghost lead (no reply, cold, short thread, no price)', async () => {
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'cold', awaitingCustomerReply: true,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 0,
      });
      prisma.message.count.mockResolvedValue(0);
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(false);
    });

    it('falls back to direct count when ThreadContext missing', async () => {
      contextService.getThreadState.mockResolvedValue(null);
      prisma.message.count
        .mockResolvedValueOnce(1) // customer count
        .mockResolvedValueOnce(0);
      expect(await service.isEngaged(CONVERSATION_ID)).toBe(true);
    });
  });

  describe('switchToLongTermMode', () => {
    it('switches active enrollment and schedules first step 7 days out', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'short_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn().mockResolvedValue({});

      const before = Date.now();
      const result = await service.switchToLongTermMode('enroll-1', 'platform_not_hired_engaged');
      const after = Date.now();

      expect(result).toBe(true);
      const call = (prisma.followUpEnrollment.update as jest.Mock).mock.calls[0][0];
      expect(call.where).toEqual({ id: 'enroll-1' });
      expect(call.data.followUpMode).toBe('long_term');
      expect(call.data.currentStepIndex).toBe(0);
      expect(call.data.modeReason).toBe('platform_not_hired_engaged');
      const dueMs = call.data.nextStepDueAt.getTime();
      expect(dueMs).toBeGreaterThanOrEqual(before + 7 * 24 * 60 * 60 * 1000 - 1000);
      expect(dueMs).toBeLessThanOrEqual(after + 7 * 24 * 60 * 60 * 1000 + 1000);
    });

    it('is idempotent — does not re-switch if already long_term', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'long_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn();

      const result = await service.switchToLongTermMode('enroll-1', 'any_reason');

      expect(result).toBe(false);
      expect(prisma.followUpEnrollment.update).not.toHaveBeenCalled();
    });

    it('refuses to switch non-active enrollments', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'stopped', followUpMode: 'short_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn();

      const result = await service.switchToLongTermMode('enroll-1', 'any');

      expect(result).toBe(false);
      expect(prisma.followUpEnrollment.update).not.toHaveBeenCalled();
    });
  });

  describe('switchToShortTermMode', () => {
    it('flips long_term back to short_term and resets step', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'long_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn().mockResolvedValue({});

      const result = await service.switchToShortTermMode('enroll-1', 'ghost_returned');

      expect(result).toBe(true);
      const call = (prisma.followUpEnrollment.update as jest.Mock).mock.calls[0][0];
      expect(call.data.followUpMode).toBe('short_term');
      expect(call.data.currentStepIndex).toBe(0);
      expect(call.data.modeReason).toBe('ghost_returned');
    });

    it('is a no-op when already short_term', async () => {
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'short_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn();

      const result = await service.switchToShortTermMode('enroll-1', 'any');

      expect(result).toBe(false);
      expect(prisma.followUpEnrollment.update).not.toHaveBeenCalled();
    });
  });

  describe('handlePlatformSignal', () => {
    function mockEnrollment(overrides: any = {}) {
      prisma.followUpEnrollment.findFirst.mockResolvedValue({
        id: 'enroll-1',
        followUpMode: 'short_term',
        leadId: LEAD_ID,
        ...overrides,
      });
    }

    it('returns no_enrollment when no active enrollment exists', async () => {
      prisma.followUpEnrollment.findFirst.mockResolvedValue(null);
      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Not hired');
      expect(result).toBe('no_enrollment');
    });

    it('Not hired + ghost → stops', async () => {
      mockEnrollment();
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'cold', awaitingCustomerReply: true,
        priceDiscussed: false, lastQuestionAsked: null,
        businessMessages: 1, aiMessages: 0, customerMessages: 0,
      });
      prisma.message.count.mockResolvedValue(0);

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Not hired');

      expect(result).toBe('stopped');
      expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledWith({
        where: { id: 'enroll-1', status: 'active' },
        data: expect.objectContaining({ stoppedReason: 'platform_not_hired_ghost' }),
      });
    });

    it('Not hired + engaged → switches to long_term', async () => {
      mockEnrollment({ followUpMode: 'short_term' });
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'warm', awaitingCustomerReply: true,
        priceDiscussed: true, lastQuestionAsked: null,
        businessMessages: 2, aiMessages: 1, customerMessages: 1,
      });
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'short_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn().mockResolvedValue({});

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Not hired');

      expect(result).toBe('switched_long');
      const updateCall = (prisma.followUpEnrollment.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.followUpMode).toBe('long_term');
    });

    it('SF status terminal always wins (even if engaged)', async () => {
      mockEnrollment();
      prisma.lead.findUnique.mockResolvedValue({
        status: 'completed',
        statusSource: 'service_flow',
      });
      contextService.getThreadState.mockResolvedValue({
        stage: 'booking', engagementLevel: 'hot', awaitingCustomerReply: false,
        priceDiscussed: true, lastQuestionAsked: null,
        businessMessages: 5, aiMessages: 3, customerMessages: 4,
      });

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Not hired');

      expect(result).toBe('stopped');
      expect(prisma.followUpEnrollment.updateMany).toHaveBeenCalledWith({
        where: { id: 'enroll-1', status: 'active' },
        data: expect.objectContaining({ stoppedReason: 'sf_status_completed' }),
      });
    });

    it('Hired signal on long-term enrollment → switches back to short_term', async () => {
      mockEnrollment({ followUpMode: 'long_term' });
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'long_term',
        conversationId: CONVERSATION_ID,
      });
      prisma.followUpEnrollment.update = jest.fn().mockResolvedValue({});

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Hired');

      expect(result).toBe('switched_short');
      const updateCall = (prisma.followUpEnrollment.update as jest.Mock).mock.calls[0][0];
      expect(updateCall.data.followUpMode).toBe('short_term');
    });

    it('Hired signal on short-term enrollment → no change', async () => {
      mockEnrollment({ followUpMode: 'short_term' });
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Hired');

      expect(result).toBe('no_change');
    });

    it('unknown signal → no change', async () => {
      mockEnrollment();
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'something-else');

      expect(result).toBe('no_change');
    });

    it('engaged Not hired on already-long_term enrollment → no_change (idempotent)', async () => {
      mockEnrollment({ followUpMode: 'long_term' });
      prisma.lead.findUnique.mockResolvedValue({ status: 'new', statusSource: null });
      contextService.getThreadState.mockResolvedValue({
        stage: 'initial', engagementLevel: 'warm', awaitingCustomerReply: true,
        priceDiscussed: true, lastQuestionAsked: null,
        businessMessages: 2, aiMessages: 1, customerMessages: 1,
      });
      prisma.followUpEnrollment.findUnique.mockResolvedValue({
        id: 'enroll-1', status: 'active', followUpMode: 'long_term',
        conversationId: CONVERSATION_ID,
      });

      const result = await service.handlePlatformSignal(CONVERSATION_ID, 'Not hired');

      expect(result).toBe('no_change');
    });
  });
});
