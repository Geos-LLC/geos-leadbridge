/**
 * Follow-Up Engine Service Tests
 *
 * Tests: enrollInSequence (dedup, step skipping, re-enroll delay),
 * evaluateThread (terminal status), handleCustomerReply (idempotent)
 */

import { FollowUpEngineService } from './follow-up-engine.service';

const USER_ID = 'user-123';
const CONVERSATION_ID = 'conv-456';
const TEMPLATE_ID = 'tmpl-789';
const LEAD_ID = 'lead-001';

function buildPrismaMock() {
  return {
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
  } as any;
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

    it('starts from step 0 for new leads (no customer replies after business message)', async () => {
      // No customer replies after first pro message
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date() }); // first pro msg exists
      prisma.message.count.mockResolvedValue(0); // no customer replies after

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      expect(createCall.data.currentStepIndex).toBe(0);
    });

    it('skips to later step for leads with prior conversation', async () => {
      // Customer replied after business message
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date('2026-04-01') }); // first pro msg
      prisma.message.count.mockResolvedValue(2); // 2 customer replies after
      // Account has default 24h re-enroll delay
      prisma.savedAccount.findFirst.mockResolvedValue({ followUpSettingsJson: null });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      // Should skip to step 2 (1440min = 24h), which is the first step >= 1440
      expect(createCall.data.currentStepIndex).toBe(2);
    });

    it('respects custom re-enroll delay from settings', async () => {
      prisma.message.findFirst.mockResolvedValue({ sentAt: new Date('2026-04-01') });
      prisma.message.count.mockResolvedValue(1);
      // Account has 4h re-enroll delay
      prisma.savedAccount.findFirst.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({ fuReEnrollDelay: '4h' }),
      });

      await service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID);

      const createCall = prisma.followUpEnrollment.create.mock.calls[0][0];
      // 4h = 240 min, first step >= 240 is step 2 (1440min)
      expect(createCall.data.currentStepIndex).toBe(2);
    });

    it('throws when template not found', async () => {
      prisma.followUpSequenceTemplate.findUnique.mockResolvedValue(null);

      await expect(
        service.enrollInSequence(CONVERSATION_ID, TEMPLATE_ID, 'yelp', LEAD_ID),
      ).rejects.toThrow('not found');
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
});
