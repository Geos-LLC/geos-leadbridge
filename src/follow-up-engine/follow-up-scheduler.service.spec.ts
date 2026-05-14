/**
 * Follow-Up Scheduler Service Tests
 *
 * Tests: processEnrollment (terminal status, customer reply, quiet hours,
 * duplicate guard, retry on failure), advisory lock
 */

import { FollowUpSchedulerService } from './follow-up-scheduler.service';

const ENROLLMENT_ID = 'enroll-1';
const CONVERSATION_ID = 'conv-1';
const LEAD_ID = 'lead-1';

function buildPrismaMock() {
  // The xact-lock helper uses $transaction(async tx => ...) and inside the
  // callback runs `tx.$queryRaw\`SELECT pg_try_advisory_xact_lock(...) AS
  // locked\``. The mock hands itself back as `tx` so individual tests can
  // toggle lock state via `prisma.$queryRaw.mockResolvedValueOnce(...)`.
  const mock: any = {
    followUpEnrollment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({ id: ENROLLMENT_ID, status: 'active', conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date('2026-04-01'), mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [{ stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' }] }, activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: 'America/New_York', generationMode: 'ai' } }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    followUpStepExecution: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'exec-1' }),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    threadContext: {
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue({ businessId: 'biz-1', userId: 'user-1' }),
      findUnique: jest.fn().mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null, userId: 'user-1', businessId: 'biz-1' }),
    },
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({ followUpSettingsJson: null, followUpTimezone: 'America/New_York' }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ businessHoursTimezone: 'America/New_York' }),
    },
    message: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $queryRaw: jest.fn().mockResolvedValue([{ locked: true }]),
  };
  mock.$transaction = jest.fn().mockImplementation(async (fn: any, _opts?: any) => fn(mock));
  return mock as any;
}

function buildEngineMock() {
  return {
    stopEnrollment: jest.fn().mockResolvedValue(undefined),
    computeNextDueAt: jest.fn().mockReturnValue(new Date('2026-04-10T12:00:00Z')),
  } as any;
}

function buildGeneratorMock() {
  return {
    generateMessage: jest.fn().mockResolvedValue({ message: 'Hi, checking in!', strategyUsed: 'hybrid' }),
  } as any;
}

describe('FollowUpSchedulerService', () => {
  let service: FollowUpSchedulerService;
  let prisma: ReturnType<typeof buildPrismaMock>;
  let engineService: ReturnType<typeof buildEngineMock>;
  let generatorService: ReturnType<typeof buildGeneratorMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    engineService = buildEngineMock();
    generatorService = buildGeneratorMock();
    const contextService = { recordMessage: jest.fn().mockResolvedValue(undefined) } as any;
    const leadsService = { sendMessage: jest.fn().mockResolvedValue({ id: 'msg-1' }) } as any;
    const eventEmitter = { emit: jest.fn() } as any;
    const configService = { get: jest.fn().mockReturnValue(undefined) } as any;
    const trialService = { canProcessLead: jest.fn().mockResolvedValue({ allowed: true, reason: null }) } as any;
    const platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLeadEvents: jest.fn().mockResolvedValue([]) }) } as any;
    // Default classifier stub returns low-confidence engaged so the gate falls
    // through. Individual gate tests override this with mockResolvedValueOnce.
    const intentClassifier = {
      classify: jest.fn().mockResolvedValue({
        intent: 'engaged', confidence: 0, reason: 'test stub', fromLlm: false,
      }),
    } as any;
    const leadStatusService = {
      writeStatus: jest.fn().mockResolvedValue({ leadId: LEAD_ID, applied: true, status: 'lost' }),
    } as any;
    // Real gate service wired to the same prisma + classifier mocks the
    // scheduler uses. Existing scheduler tests stay accurate because they
    // validate end-to-end gate-then-side-effect behavior, not the internal
    // shape of classifyAndMaybeStop.
    const { FollowUpGateService } = require('./follow-up-gate.service');
    const gateService = new FollowUpGateService(prisma, intentClassifier);
    service = new FollowUpSchedulerService(prisma, contextService, leadsService, engineService, generatorService, eventEmitter, configService, trialService, platformFactory, intentClassifier, leadStatusService, gateService);
    jest.clearAllMocks();
    // Reset mocks after construction
    prisma.followUpEnrollment.findUnique.mockResolvedValue({
      id: ENROLLMENT_ID, status: 'active', conversationId: CONVERSATION_ID,
      leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date('2026-04-01'),
      mode: 'auto_send', platform: 'yelp',
      sequenceTemplate: {
        stepsJson: { steps: [{ stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' }] },
        activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: 'America/New_York',
        generationMode: 'ai',
      },
    });
  });

  describe('processEnrollment (via processFollowUps)', () => {
    it('stops enrollment when lead has terminal status', async () => {
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'done', thumbtackStatus: null });

      // Call processEnrollment directly
      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date(), mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [] } } },
        new Date(),
      );

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'lead_status_done');
    });

    it('stops enrollment when lead has hired thumbtackStatus', async () => {
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'contacted', thumbtackStatus: 'hired' });

      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date(), mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [] } } },
        new Date(),
      );

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'lead_status_hired');
    });

    it('stops enrollment when customer replied after enrollment', async () => {
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null });
      prisma.message.findFirst.mockResolvedValue({ id: 'msg-customer', sender: 'customer', sentAt: new Date() });

      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date('2026-04-01'), mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } },
        new Date(),
      );

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'customer_replied');
    });

    it('stops enrollment when Lead.lastCustomerActivityAt is newer than enrollment.createdAt (Phase A self-heal)', async () => {
      // No Message row exists (simulates Yelp pre-Phase-A state) but
      // Lead.lastCustomerActivityAt was bumped directly — scheduler must
      // still stop the enrollment.
      const enrollmentCreated = new Date('2026-04-01T00:00:00Z');
      const customerActivity = new Date('2026-04-01T01:00:00Z');

      prisma.message.findFirst.mockResolvedValue(null);
      // processEnrollment calls lead.findUnique multiple times with different
      // `select` shapes (trial userId, terminal status, quiet-hours businessId,
      // self-heal lastCustomerActivityAt). Return a superset that satisfies all.
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        status: 'new',
        thumbtackStatus: null,
        userId: 'user-1',
        businessId: 'biz-1',
        lastCustomerActivityAt: customerActivity,
      });

      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: enrollmentCreated, mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } },
        new Date('2026-04-01T02:00:00Z'),
      );

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'customer_replied');
    });

    it('does not stop enrollment when lastCustomerActivityAt predates enrollment.createdAt', async () => {
      // Customer activity BEFORE the enrollment started — stale signal, ignore.
      const enrollmentCreated = new Date('2026-04-01T10:00:00Z');
      const staleActivity = new Date('2026-04-01T09:00:00Z');

      prisma.message.findFirst.mockResolvedValue(null);
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        status: 'new',
        thumbtackStatus: null,
        userId: 'user-1',
        businessId: 'biz-1',
        lastCustomerActivityAt: staleActivity,
      });

      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: enrollmentCreated, mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] }, activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: 'America/New_York', generationMode: 'ai' } },
        new Date('2026-04-01T12:00:00Z'),
      );

      expect(engineService.stopEnrollment).not.toHaveBeenCalledWith(ENROLLMENT_ID, 'customer_replied');
    });

    it('skips already-sent step (duplicate guard)', async () => {
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null });
      prisma.message.findFirst.mockResolvedValue(null); // no customer reply
      prisma.followUpStepExecution.findFirst.mockResolvedValue({ id: 'exec-1', stepIndex: 0, status: 'sent' });

      await (service as any).processEnrollment(
        { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, leadId: LEAD_ID, currentStepIndex: 0, createdAt: new Date('2026-04-01'), mode: 'auto_send', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }, { delayMinutes: 60, objective: 'test2' }] }, activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: 'America/New_York' } },
        new Date(),
      );

      // Should advance past the already-sent step, not send again
      expect(prisma.followUpEnrollment.update).toHaveBeenCalled();
      expect(generatorService.generateMessage).not.toHaveBeenCalled();
    });

    it('conversation-level cooldown reschedules and does not send', async () => {
      // ThreadContext says we sent something 5 minutes ago — inside the 10-min cooldown
      const now = new Date('2026-04-17T12:00:00Z');
      const lastSent = new Date(now.getTime() - 5 * 60_000);
      prisma.threadContext.findFirst.mockResolvedValue({ lastFollowUpSentAt: lastSent });
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null });

      await (service as any).processEnrollment(
        {
          id: ENROLLMENT_ID,
          conversationId: CONVERSATION_ID,
          leadId: LEAD_ID,
          currentStepIndex: 0,
          createdAt: new Date('2026-04-01'),
          mode: 'auto_send',
          sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } },
        },
        now,
      );

      // Should reschedule to lastSent + 10min and NOT send a new message
      expect(prisma.followUpEnrollment.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: ENROLLMENT_ID },
          data: expect.objectContaining({
            nextStepDueAt: new Date(lastSent.getTime() + 10 * 60_000),
          }),
        }),
      );
      expect(generatorService.generateMessage).not.toHaveBeenCalled();
      // Terminal-status check runs AFTER cooldown, so it should also not fire
      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
    });

    it('conversation-level cooldown holds across duplicate enrollments', async () => {
      // Even if multiple active enrollments exist, ThreadContext.lastFollowUpSentAt
      // is the single source of truth — any enrollment for this conversation
      // should be blocked by a recent send on a sibling.
      const now = new Date('2026-04-17T12:00:00Z');
      const lastSent = new Date(now.getTime() - 2 * 60_000); // 2 min ago
      prisma.threadContext.findFirst.mockResolvedValue({ lastFollowUpSentAt: lastSent });
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null });

      // Different enrollment id (simulating a sibling duplicate)
      await (service as any).processEnrollment(
        {
          id: 'enroll-sibling',
          conversationId: CONVERSATION_ID,
          leadId: LEAD_ID,
          currentStepIndex: 0,
          createdAt: new Date('2026-04-01'),
          mode: 'auto_send',
          sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } },
        },
        now,
      );

      // The sibling must NOT send — gated by conversation-level state, not its own lastExecutedAt
      expect(generatorService.generateMessage).not.toHaveBeenCalled();
    });

    it('writes lastFollowUpSentAt on successful auto-send', async () => {
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null, userId: 'user-1' });
      prisma.message.findFirst.mockResolvedValue(null);
      prisma.threadContext.findFirst.mockResolvedValue(null);
      prisma.followUpStepExecution.findFirst.mockResolvedValue(null);
      // findUnique for lead with userId (the auto-send path)
      prisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID, status: 'new', thumbtackStatus: null, userId: 'user-1' });

      const now = new Date('2026-04-17T12:00:00Z');

      await (service as any).processEnrollment(
        {
          id: ENROLLMENT_ID,
          conversationId: CONVERSATION_ID,
          leadId: LEAD_ID,
          currentStepIndex: 0,
          createdAt: new Date('2026-04-01'),
          mode: 'auto_send',
          platform: 'yelp',
          nextStepDueAt: now,
          sequenceTemplate: {
            stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] },
            activeHoursStart: null, activeHoursEnd: null, activeHoursTimezone: 'America/New_York',
            generationMode: 'ai',
          },
        },
        now,
      );

      // After successful auto-send, lastFollowUpSentAt must be bumped on ThreadContext
      const updates = prisma.threadContext.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.data?.lastFollowUpSentAt,
      );
      expect(updates.length).toBeGreaterThan(0);
    });
  });

  describe('per-conversation grouping in processFollowUps', () => {
    it('stops duplicate active enrollments and processes only the oldest canonical', async () => {
      // 3 due enrollments on the SAME conversation — simulate historical data or race.
      const enrollments = [
        { id: 'dup-1', conversationId: CONVERSATION_ID, createdAt: new Date('2026-04-01T10:00:00Z'), currentStepIndex: 1, status: 'active', nextStepDueAt: new Date(), mode: 'auto_send', leadId: LEAD_ID, platform: 'yelp', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } },
        { id: 'dup-2', conversationId: CONVERSATION_ID, createdAt: new Date('2026-04-01T09:00:00Z'), currentStepIndex: 0, status: 'active', nextStepDueAt: new Date(), mode: 'auto_send', leadId: LEAD_ID, platform: 'yelp', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } },
        { id: 'dup-3', conversationId: CONVERSATION_ID, createdAt: new Date('2026-04-01T11:00:00Z'), currentStepIndex: 2, status: 'active', nextStepDueAt: new Date(), mode: 'auto_send', leadId: LEAD_ID, platform: 'yelp', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } },
      ];
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue(enrollments);
      // Claim succeeds for canonical
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      // Stub processEnrollment to isolate the grouping behavior
      const processSpy = jest.spyOn(service as any, 'processEnrollment').mockResolvedValue(undefined);

      await service.processFollowUps();

      // processEnrollment should be invoked exactly once — with dup-2 (oldest createdAt)
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect((processSpy.mock.calls[0][0] as any).id).toBe('dup-2');

      // Duplicates dup-1 and dup-3 should be stopped with duplicate_cleanup
      const stopCalls = (prisma.followUpEnrollment.updateMany.mock.calls as any[]).filter(
        (c: any[]) => c[0]?.data?.stoppedReason === 'duplicate_cleanup',
      );
      expect(stopCalls.length).toBe(1);
      expect(stopCalls[0][0].where.id.in.sort()).toEqual(['dup-1', 'dup-3']);

      processSpy.mockRestore();
    });

    it('does not process an enrollment when atomic claim fails', async () => {
      const enrollment = { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, createdAt: new Date('2026-04-01'), currentStepIndex: 0, status: 'active', nextStepDueAt: new Date(), mode: 'auto_send', leadId: LEAD_ID, platform: 'yelp', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } };
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      // Claim returns count=0 — another worker already holds the lease
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 0 });

      const processSpy = jest.spyOn(service as any, 'processEnrollment').mockResolvedValue(undefined);

      await service.processFollowUps();

      expect(processSpy).not.toHaveBeenCalled();
      processSpy.mockRestore();
    });

    it('releases the lease only when the caller still holds the token', async () => {
      const enrollment = { id: ENROLLMENT_ID, conversationId: CONVERSATION_ID, createdAt: new Date('2026-04-01'), currentStepIndex: 0, status: 'active', nextStepDueAt: new Date(), mode: 'auto_send', leadId: LEAD_ID, platform: 'yelp', sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } } };
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      jest.spyOn(service as any, 'processEnrollment').mockResolvedValue(undefined);

      await service.processFollowUps();

      // Release call must be scoped by processingToken, not just id
      const releaseCalls = prisma.followUpEnrollment.updateMany.mock.calls.filter(
        (c: any[]) => c[0]?.where?.processingToken && c[0]?.data?.processingUntil === null,
      );
      expect(releaseCalls.length).toBe(1);
      expect(releaseCalls[0][0].where.id).toBe(ENROLLMENT_ID);
    });
  });

  describe('processFollowUps (advisory lock)', () => {
    it('skips when another instance holds the lock', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: false }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([]);

      await service.processFollowUps();

      // Should not query for enrollments
      expect(prisma.followUpEnrollment.findMany).not.toHaveBeenCalled();
    });

    it('processes when lock is acquired', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([]);

      await service.processFollowUps();

      expect(prisma.followUpEnrollment.findMany).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Two-phase claim-then-process design
  //
  // Phase 1: claimDueEnrollments runs inside a short xact-locked transaction.
  // Phase 2: processEnrollment runs OUTSIDE the transaction so SMS/AI I/O
  // doesn't hold the advisory lock or risk hitting a transaction timeout.
  // =========================================================================
  describe('processFollowUps (claim-then-process)', () => {
    function makeEnrollment(id: string, conversationId: string, createdAt: Date) {
      return {
        id, conversationId, createdAt,
        leadId: LEAD_ID, currentStepIndex: 0, status: 'active',
        nextStepDueAt: new Date(), mode: 'auto_send', platform: 'yelp',
        sequenceTemplate: { stepsJson: { steps: [{ delayMinutes: 2, objective: 'test' }] } },
      };
    }

    it('1. claim phase makes no SMS/AI/external calls (only DB queries)', async () => {
      // Sniff the things processEnrollment would touch — they must not be
      // invoked while we're still inside the $transaction.
      let processCalledDuringTx = false;
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const result = await fn(prisma);
        // After the callback returns but before the test continues, see if
        // processEnrollment ran. It shouldn't have — it should only be called
        // by the OUTSIDE-tx phase 2 loop.
        processCalledDuringTx = (service as any).processEnrollment.mock?.calls?.length > 0;
        return result;
      });

      const enrollment = makeEnrollment('claim-1', CONVERSATION_ID, new Date('2026-04-01'));
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const processSpy = jest.spyOn(service as any, 'processEnrollment').mockResolvedValue(undefined);

      await service.processFollowUps();

      expect(processCalledDuringTx).toBe(false);
      // It was still called — just AFTER the tx committed.
      expect(processSpy).toHaveBeenCalledTimes(1);
      processSpy.mockRestore();
    });

    it('2. claimed rows are processed after the claim transaction commits', async () => {
      const txCommittedAt: number[] = [];
      const processStartedAt: number[] = [];
      prisma.$transaction.mockImplementation(async (fn: any) => {
        const result = await fn(prisma);
        txCommittedAt.push(Date.now());
        return result;
      });

      const enrollment = makeEnrollment('claim-1', CONVERSATION_ID, new Date('2026-04-01'));
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const processSpy = jest.spyOn(service as any, 'processEnrollment').mockImplementation(async () => {
        processStartedAt.push(Date.now());
      });

      await service.processFollowUps();

      expect(txCommittedAt).toHaveLength(1);
      expect(processStartedAt).toHaveLength(1);
      // Claim tx must end (commit) before processing starts.
      expect(processStartedAt[0]).toBeGreaterThanOrEqual(txCommittedAt[0]);
      processSpy.mockRestore();
    });

    it('3. concurrent claim attempts on the same enrollment — only one wins (atomic UPDATE)', async () => {
      // Simulate two instances racing on the same row by toggling the
      // claim updateMany to count=1 once, then count=0 thereafter (the
      // real DB enforces this via the WHERE processingUntil-OR clause).
      const enrollment = makeEnrollment('claim-1', CONVERSATION_ID, new Date('2026-04-01'));

      // Instance A
      const prismaA = buildPrismaMock();
      prismaA.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prismaA.followUpEnrollment.updateMany.mockResolvedValueOnce({ count: 1 });
      // Instance B
      const prismaB = buildPrismaMock();
      prismaB.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prismaB.followUpEnrollment.updateMany.mockResolvedValueOnce({ count: 0 });

      const claimsA = await (service as any).claimDueEnrollments.call(
        { ...service, prisma: prismaA, logger: (service as any).logger },
        prismaA,
      );
      const claimsB = await (service as any).claimDueEnrollments.call(
        { ...service, prisma: prismaB, logger: (service as any).logger },
        prismaB,
      );

      // Exactly one instance walks away with the claim.
      expect(claimsA).toHaveLength(1);
      expect(claimsB).toHaveLength(0);
      expect(claimsA[0].enrollment.id).toBe('claim-1');
    });

    it('4. a failed enrollment does not block the rest of the batch', async () => {
      const e1 = makeEnrollment('e1', 'conv-A', new Date('2026-04-01T10:00:00Z'));
      const e2 = makeEnrollment('e2', 'conv-B', new Date('2026-04-01T10:01:00Z'));
      const e3 = makeEnrollment('e3', 'conv-C', new Date('2026-04-01T10:02:00Z'));
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([e1, e2, e3]);
      // Each conversation's atomic claim wins (we're not racing here).
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });

      const processSpy = jest.spyOn(service as any, 'processEnrollment')
        .mockImplementationOnce(async () => { throw new Error('e1 boom'); })
        .mockResolvedValueOnce(undefined)  // e2
        .mockResolvedValueOnce(undefined); // e3

      await service.processFollowUps();

      // All three were attempted despite e1 throwing.
      expect(processSpy).toHaveBeenCalledTimes(3);
      const ids = processSpy.mock.calls.map((c: any[]) => c[0].id).sort();
      expect(ids).toEqual(['e1', 'e2', 'e3']);

      // Lease release for each of the 3 enrollments — phase-2 finally branch
      // runs even when processEnrollment threw.
      const releaseCalls = (prisma.followUpEnrollment.updateMany.mock.calls as any[][]).filter(
        c => c[0]?.where?.processingToken && c[0]?.data?.processingUntil === null,
      );
      expect(releaseCalls.length).toBe(3);
      processSpy.mockRestore();
    });

    it('5. expired lease is reclaimable (claim WHERE matches processingUntil < now)', async () => {
      // The claim updateMany WHERE clause must accept rows whose lease has
      // expired. Verify the shape directly on the mock call.
      const enrollment = makeEnrollment('claim-1', CONVERSATION_ID, new Date('2026-04-01'));
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([enrollment]);
      prisma.followUpEnrollment.updateMany.mockResolvedValue({ count: 1 });
      jest.spyOn(service as any, 'processEnrollment').mockResolvedValue(undefined);

      await service.processFollowUps();

      const claimCall = (prisma.followUpEnrollment.updateMany.mock.calls as any[][]).find(
        c => c[0]?.data?.processingToken && c[0]?.data?.processingUntil instanceof Date,
      );
      expect(claimCall).toBeDefined();
      // OR clause must include both null AND lt:now branches so an expired
      // lease can be reclaimed by a later cycle.
      expect(claimCall![0].where.OR).toEqual(
        expect.arrayContaining([
          { processingUntil: null },
          { processingUntil: { lt: expect.any(Date) } },
        ]),
      );
    });

    it('6. claim-phase transaction is short — no 10-minute timeout configured', async () => {
      // Verify the timeout passed to $transaction is bounded for the claim
      // path. The work itself is just DB queries; anything longer than ~30s
      // would reintroduce the long-tx-holds-lock anti-pattern.
      let observedTimeout: number | undefined;
      prisma.$transaction.mockImplementation(async (fn: any, opts?: any) => {
        observedTimeout = opts?.timeout;
        return fn(prisma);
      });
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.followUpEnrollment.findMany.mockResolvedValue([]);

      await service.processFollowUps();

      expect(observedTimeout).toBeDefined();
      expect(observedTimeout).toBeLessThanOrEqual(30_000);
    });
  });

  describe('reconcileYelpEvents', () => {
    it('skips when advisory lock 7003 is held by another instance', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: false }]);

      await service.reconcileYelpEvents();

      expect(prisma.webhookEvent.findMany).not.toHaveBeenCalled();
    });

    it('marks reconciled:echo when retry classifies latest event as BIZ', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.webhookEvent.findMany.mockResolvedValue([
        {
          id: 'evt-1',
          payload: '{}',
          processingError: 'reconcile:yelp:lead-X:biz-Y:empty_events_from_adapter:attempts=0',
        },
      ]);
      // Non-null credentialsJson is enough — decryption will fail and we fall
      // through to the api key (which is also empty from the mocked config).
      // The adapter is fully mocked so the token value is irrelevant.
      prisma.savedAccount.findFirst.mockResolvedValue({ credentialsJson: 'unparseable' });

      const getLeadEvents = jest.fn().mockResolvedValue([
        { id: 'e-biz', user_type: 'BIZ', event_type: 'TEXT', time_created: '2026-04-20T12:00:01Z' },
        { id: 'e-cons', user_type: 'CONSUMER', event_type: 'TEXT', time_created: '2026-04-20T11:00:00Z' },
      ]);
      (service as any).platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLeadEvents }) };

      await service.reconcileYelpEvents();

      const updates = (prisma.webhookEvent.update.mock.calls as any[]).map(c => c[0]);
      expect(updates[0].data.processingError).toContain('reconciled:echo');
    });

    it('bumps attempts when retry fetch still fails', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.webhookEvent.findMany.mockResolvedValue([
        {
          id: 'evt-2',
          payload: '{}',
          processingError: 'reconcile:yelp:lead-X:biz-Y:fetch_threw_timeout:attempts=2',
        },
      ]);
      prisma.savedAccount.findFirst.mockResolvedValue({ credentialsJson: 'unparseable' });

      const getLeadEvents = jest.fn().mockResolvedValue([]);
      (service as any).platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLeadEvents }) };

      await service.reconcileYelpEvents();

      const updates = (prisma.webhookEvent.update.mock.calls as any[]).map(c => c[0]);
      expect(updates[0].data.processingError).toMatch(/attempts=3/);
    });

    it('caps at 5 attempts and marks reconciled:max_attempts', async () => {
      prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
      prisma.webhookEvent.findMany.mockResolvedValue([
        {
          id: 'evt-3',
          payload: '{}',
          processingError: 'reconcile:yelp:lead-X:biz-Y:empty_events_from_adapter:attempts=5',
        },
      ]);

      await service.reconcileYelpEvents();

      const updates = (prisma.webhookEvent.update.mock.calls as any[]).map(c => c[0]);
      expect(updates[0].data.processingError).toContain('reconciled:max_attempts');
    });
  });

  describe('classifier gate (classifyAndMaybeStop)', () => {
    /**
     * The classifier gate runs late in processEnrollment — after terminal
     * status, customer-replied-since-enrollment, quiet hours, and step
     * duplication checks all pass. To exercise it we set up a "happy path"
     * enrollment with no customer reply since enrollment, then simulate the
     * thread containing a terminal-intent customer message that the inbound
     * classifier missed (or pre-dated).
     */

    function happyPathEnrollment(opts: { triggerState?: string } = {}) {
      return {
        id: ENROLLMENT_ID,
        conversationId: CONVERSATION_ID,
        leadId: LEAD_ID,
        currentStepIndex: 0,
        createdAt: new Date('2026-04-01T00:00:00Z'),
        mode: 'auto_send' as const,
        platform: 'yelp',
        nextStepDueAt: new Date('2026-04-17T12:00:00Z'),
        sequenceTemplate: {
          stepsJson: { steps: [{ stepOrder: 0, delayMinutes: 2, objective: 'quick_check_in' }] },
          activeHoursStart: null,
          activeHoursEnd: null,
          activeHoursTimezone: 'America/New_York',
          generationMode: 'ai' as const,
          triggerState: opts.triggerState ?? 'no_reply_after_initial',
        },
      };
    }

    function setUpHappyPath(classifierResult: any, opts: { lastCustomerMsg?: string } = {}) {
      const now = new Date('2026-04-17T12:00:00Z');
      const customerMsg = opts.lastCustomerMsg ?? "It's already done, thanks";

      // Lead is non-terminal so terminal-status check passes.
      // Multiple findUnique call sites with different selects — return a
      // superset that satisfies all (status, lastCustomerActivityAt, userId).
      // Crucially: lastCustomerActivityAt is BEFORE enrollment.createdAt so
      // the customer-replied-since-enrollment check passes.
      prisma.lead.findUnique.mockImplementation((args: any) => {
        // The classifier gate's own findUnique queries `category` — return that too.
        return Promise.resolve({
          id: LEAD_ID,
          status: 'engaged',
          thumbtackStatus: null,
          userId: 'user-1',
          businessId: 'biz-1',
          lastCustomerActivityAt: new Date('2026-03-30T00:00:00Z'),
          category: 'Deep cleaning',
        });
      });

      // No Message row newer than enrollment (passes the
      // customer-replied-since-enrollment check). But there IS a customer
      // message overall — the gate's own findFirst returns it.
      // The scheduler calls message.findFirst twice:
      //   1. (sender='customer', sentAt > enrollment.createdAt) — for the
      //      customer-replied check. Must return null to pass through.
      //   2. (sender='customer', orderBy createdAt desc) — for the gate.
      //      Must return the latest customer message.
      // Match on the `sentAt` filter to distinguish.
      prisma.message.findFirst.mockImplementation((args: any) => {
        if (args?.where?.sentAt) return Promise.resolve(null);
        return Promise.resolve({
          id: 'msg-customer-old',
          content: customerMsg,
          createdAt: new Date('2026-03-30T00:00:00Z'),
        });
      });

      // The gate also pulls last 5 turns via findMany.
      prisma.message.findMany = jest.fn().mockResolvedValue([
        { sender: 'customer', content: customerMsg },
      ]);

      // Use the classifier mock attached during construction.
      const classifier = (service as any).intentClassifier;
      classifier.classify.mockResolvedValueOnce(classifierResult);

      return now;
    }

    it('stops enrollment and flips lead to lost on opt_out at confidence ≥ threshold', async () => {
      const now = setUpHappyPath(
        { intent: 'opt_out', confidence: 0.95, reason: 'explicit info removal', fromLlm: true },
        { lastCustomerMsg: 'Please lose my information' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_opt_out');
      expect(generatorService.generateMessage).not.toHaveBeenCalled();

      const ws = (service as any).leadStatusService.writeStatus;
      expect(ws).toHaveBeenCalledTimes(1);
      expect(ws.mock.calls[0][0]).toMatchObject({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'opt_out',
        reason: 'followup_classifier_opt_out',
        reengageAt: null,
      });
      // Idempotency: deterministic sourceEventId per (enrollment, intent)
      expect(ws.mock.calls[0][0].sourceEventId).toBe(`followup_classifier_${ENROLLMENT_ID}_opt_out`);
    });

    it('stops + flips to lost with hired_someone reason on hired_elsewhere', async () => {
      const now = setUpHappyPath(
        { intent: 'hired_elsewhere', confidence: 0.92, reason: 'hired competitor', fromLlm: true },
        { lastCustomerMsg: 'we already booked someone else' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_hired_elsewhere');
      const ws = (service as any).leadStatusService.writeStatus;
      expect(ws.mock.calls[0][0]).toMatchObject({
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reason: 'followup_classifier_hired_elsewhere',
      });
      expect(ws.mock.calls[0][0].reengageAt).toBeInstanceOf(Date);
    });

    it('stops + flips to lost with hired_someone reason on completed (Donna case)', async () => {
      const now = setUpHappyPath(
        { intent: 'completed', confidence: 0.88, reason: 'work finished elsewhere', fromLlm: true },
        { lastCustomerMsg: 'The house has already been cleaned' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_completed');
      const ws = (service as any).leadStatusService.writeStatus;
      expect(ws.mock.calls[0][0]).toMatchObject({
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reason: 'followup_classifier_completed',
      });
    });

    it('stops + flips to booked on agreed (manager handoff)', async () => {
      const now = setUpHappyPath(
        { intent: 'agreed', confidence: 0.9, reason: 'price accepted', fromLlm: true },
        { lastCustomerMsg: "Sounds good, let's book it" },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_agreed');
      const ws = (service as any).leadStatusService.writeStatus;
      expect(ws.mock.calls[0][0]).toMatchObject({
        newStatus: 'booked',
        reason: 'followup_classifier_agreed',
      });
      // No lostReason on booked transition
      expect(ws.mock.calls[0][0].lostReason).toBeUndefined();
    });

    it('stops on deferring WITHOUT flipping lead status (pause, not lost)', async () => {
      const now = setUpHappyPath(
        { intent: 'deferring', confidence: 0.85, reason: 'I will get back to you', fromLlm: true },
        { lastCustomerMsg: "Thanks, I'll get back to you" },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_deferring');
      // Deferring is a pause — no status flip
      expect((service as any).leadStatusService.writeStatus).not.toHaveBeenCalled();
    });

    it('passes through to generation on engaged intent', async () => {
      const now = setUpHappyPath(
        { intent: 'engaged', confidence: 0.9, reason: 'continuing conversation', fromLlm: true },
        { lastCustomerMsg: 'Yes 3 bedrooms' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('passes through on asking intent (customer wants an answer)', async () => {
      const now = setUpHappyPath(
        { intent: 'asking', confidence: 0.95, reason: 'pricing question', fromLlm: true },
        { lastCustomerMsg: 'How much for 3 bed?' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('passes through when classifier returns low confidence', async () => {
      const now = setUpHappyPath(
        { intent: 'completed', confidence: 0.5, reason: 'unclear', fromLlm: true },
        { lastCustomerMsg: 'ok' },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('passes through when classifier failed (fromLlm=false)', async () => {
      const now = setUpHappyPath(
        { intent: 'engaged', confidence: 0, reason: 'classifier_failed: timeout', fromLlm: false },
      );

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('passes through re-engagement (customer_deferred) sequence on deferring intent (bounded pause)', async () => {
      // The narrow bypass: a customer in a re-engagement sequence who says
      // "back in 2 weeks" is exactly the case the sequence was designed for.
      // Let the scheduled message land.
      const now = setUpHappyPath(
        { intent: 'deferring', confidence: 0.9, reason: 'bounded pause', fromLlm: true },
      );

      await (service as any).processEnrollment(happyPathEnrollment({ triggerState: 'customer_deferred' }), now);

      expect(engineService.stopEnrollment).not.toHaveBeenCalled();
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('STOPS re-engagement on completed intent (Savanna 2026-05-12 regression)', async () => {
      // Pre-fix: completed on a re-engagement sequence bypassed the gate, and
      // a customer who confirmed a booking + replied "Thank you!" got blasted
      // with follow-ups. Post-fix: completed always stops, even in a
      // re-engagement sequence.
      const now = setUpHappyPath(
        { intent: 'completed', confidence: 0.9, reason: 'job done', fromLlm: true },
      );

      await (service as any).processEnrollment(happyPathEnrollment({ triggerState: 'customer_hired_competitor' }), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_completed');
      expect(generatorService.generateMessage).not.toHaveBeenCalled();
    });

    it('STOPS re-engagement (customer_hired_competitor) sequence on opt_out — explicit unsubscribe overrides', async () => {
      // Re-engagement sequences must respect opt_out — even paused customers
      // who explicitly say "stop" should not get more messages.
      const now = setUpHappyPath(
        { intent: 'opt_out', confidence: 0.99, reason: 'explicit unsubscribe', fromLlm: true },
        { lastCustomerMsg: 'stop messaging me' },
      );

      await (service as any).processEnrollment(happyPathEnrollment({ triggerState: 'customer_hired_competitor' }), now);

      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_opt_out');
      expect(generatorService.generateMessage).not.toHaveBeenCalled();
    });

    it('passes through when there is no customer message in the thread', async () => {
      const now = new Date('2026-04-17T12:00:00Z');
      prisma.lead.findUnique.mockResolvedValue({
        id: LEAD_ID,
        status: 'new',
        thumbtackStatus: null,
        userId: 'user-1',
        businessId: 'biz-1',
        lastCustomerActivityAt: null,
        category: 'Deep cleaning',
      });
      // Both findFirst variants return null (no messages yet)
      prisma.message.findFirst.mockResolvedValue(null);

      await (service as any).processEnrollment(happyPathEnrollment(), now);

      // Classifier should never have been called (no message to classify)
      expect((service as any).intentClassifier.classify).not.toHaveBeenCalled();
      // And we proceed to generate
      expect(generatorService.generateMessage).toHaveBeenCalled();
    });

    it('does not flip lead status when enrollment has no leadId (defensive)', async () => {
      const now = setUpHappyPath(
        { intent: 'opt_out', confidence: 0.95, reason: 'explicit', fromLlm: true },
      );
      const enrollment = { ...happyPathEnrollment(), leadId: null };

      await (service as any).processEnrollment(enrollment, now);

      // Enrollment still stopped
      expect(engineService.stopEnrollment).toHaveBeenCalledWith(ENROLLMENT_ID, 'classifier_opt_out');
      // But no lead.status write
      expect((service as any).leadStatusService.writeStatus).not.toHaveBeenCalled();
    });
  });
});
