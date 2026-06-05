/**
 * Pin: LeadsService.sendMessage calls FollowUpEngineService.handleProReply
 * after a successful platform send for user/manual sends, but NOT for
 * AI-originated sends. Closes the duplicate-message gap where a
 * pro-typed reply via SF Inbox didn't stop a previously scheduled
 * follow-up step.
 *
 * Covers:
 *   - user send → handleProReply called once with dedup key + actorType
 *   - ai   send → handleProReply NOT called (would kill the scheduler's
 *                 own enrollment mid-step)
 *   - missing externalMessageId (Yelp sometimes omits event_id) → falls
 *     back to a synthetic dedup key, still calls handleProReply
 *   - handleProReply throws → does NOT propagate; send still succeeds
 *   - followUpEngine null (Optional inject not wired) → no-op, no error
 *
 * Architecture invariants verified structurally:
 *   - handleProReply does not change Lead.status (covered by the
 *     follow-up-engine.service.spec.ts; here we only verify the call
 *     happens with the correct args).
 *   - SF-linked behaviour unchanged: sendMessage itself does NOT block
 *     on isSfLinkedLead (the existing FollowUpGate handles that
 *     elsewhere); same call still happens for lead_linked / SF-linked
 *     rows, which is correct per the joint design.
 */

import { LeadsService } from './leads.service';

const USER_ID = 'user-1';
const LEAD_PK = 'lead-pk-1';
const PLATFORM = 'thumbtack';
const EXTERNAL_REQUEST_ID = 'tt-neg-12345';
const PLATFORM_MSG_ID = 'tt-msg-abc';

function buildService({ externalMessageId = PLATFORM_MSG_ID as string | null, followUpEngine = makeFollowUpEngineMock() } = {}) {
  const lead = {
    id: LEAD_PK,
    userId: USER_ID,
    platform: PLATFORM,
    externalRequestId: EXTERNAL_REQUEST_ID,
    customerName: 'Jane D.',
    threadId: 'conv-1',
    businessId: 'biz-1',
    status: 'engaged',
    platformStatus: null,
  };

  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue(lead),
      update:   jest.fn().mockResolvedValue(lead),
    },
    conversation: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'conv-1', userId: USER_ID, platform: PLATFORM,
        externalThreadId: EXTERNAL_REQUEST_ID,
        customerName: 'Jane D.', status: 'active',
      }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    message: {
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    followUpEnrollment: {
      // Auto-enroll block reads this — returning an active enrollment makes
      // it short-circuit (we're not testing auto-enroll here, only the pause).
      findFirst: jest.fn().mockResolvedValue({ id: 'enroll-1', status: 'active' }),
    },
  };

  const platformService: any = {
    getCredentials: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
    getAccountCredentialsByBusinessId: jest.fn().mockResolvedValue({ accessToken: 'tok' }),
  };

  const sentMessage = {
    id: 'normalized-1',
    conversationId: 'conv-1',
    platform: PLATFORM,
    externalMessageId,
    sender: 'pro',
    content: 'hello',
    isRead: true,
    sentAt: new Date('2026-06-05T18:00:00Z'),
    raw: { foo: 'bar' },
  };

  const platformFactory: any = {
    getAdapter: jest.fn().mockReturnValue({
      sendMessage: jest.fn().mockResolvedValue(sentMessage),
    }),
  };

  const trialService: any = {
    canProcessLead: jest.fn().mockResolvedValue({ allowed: true }),
  };

  const conversationContext: any = {
    recordMessage: jest.fn().mockResolvedValue(undefined),
  };

  const leadStatusService: any = {
    writeStatus: jest.fn(),
  };

  const stubsAny: any = {};
  const leadCache: any = {
    invalidateLeadMessagesAndList: jest.fn().mockResolvedValue(undefined),
  };
  const noop = () => {};
  const svc = new LeadsService(
    prisma,
    platformService,
    platformFactory,
    { get: noop } as any, // configService
    stubsAny, // templatesService
    stubsAny, // analyticsService
    conversationContext,
    followUpEngine, // <-- the dependency under test
    null, // crmWebhookService
    trialService,
    leadCache,
    stubsAny, // cache
    leadStatusService,
  );

  return { svc, prisma, platformFactory, followUpEngine };
}

function makeFollowUpEngineMock() {
  return {
    handleProReply: jest.fn().mockResolvedValue({ stopped: true }),
    enrollInSequence: jest.fn().mockResolvedValue('enroll-new'),
  } as any;
}

describe('LeadsService.sendMessage → handleProReply wiring', () => {
  // ──────────────────────────────────────────────────────────────────
  // user send (SF Inbox click, LB operator action)
  // ──────────────────────────────────────────────────────────────────
  describe('user/manual sends', () => {
    it('calls handleProReply ONCE with dedup key derived from externalMessageId', async () => {
      const { svc, followUpEngine } = buildService();
      await svc.sendMessage(USER_ID, LEAD_PK, 'Hi Jane, $250 for that.');

      expect(followUpEngine.handleProReply).toHaveBeenCalledTimes(1);
      const [convId, opts] = followUpEngine.handleProReply.mock.calls[0];
      expect(convId).toBe('conv-1');
      expect(opts.sourceEventId).toBe(`proreply:msg:${PLATFORM_MSG_ID}`);
      expect(opts.actorType).toBe('sendMessage');
      expect(opts.actorId).toBe('user');
    });

    it('explicit senderType=user behaves identically to default', async () => {
      const { svc, followUpEngine } = buildService();
      await svc.sendMessage(USER_ID, LEAD_PK, 'manual reply', 'user');
      expect(followUpEngine.handleProReply).toHaveBeenCalledTimes(1);
      expect(followUpEngine.handleProReply.mock.calls[0][1].actorId).toBe('user');
    });

    it('falls back to a synthetic dedup key when adapter omits externalMessageId (Yelp event_id missing)', async () => {
      const { svc, followUpEngine } = buildService({ externalMessageId: null });
      await svc.sendMessage(USER_ID, LEAD_PK, 'hi');

      expect(followUpEngine.handleProReply).toHaveBeenCalledTimes(1);
      const opts = followUpEngine.handleProReply.mock.calls[0][1];
      expect(opts.sourceEventId).toMatch(new RegExp(`^proreply:lead:${LEAD_PK}:\\d+$`));
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ai send (follow-up scheduler, automation with useAi, preview-then-send AI)
  // ──────────────────────────────────────────────────────────────────
  describe('AI sends', () => {
    it('does NOT call handleProReply for senderType=ai (scheduler firing its own step must not kill its enrollment)', async () => {
      const { svc, followUpEngine } = buildService();
      await svc.sendMessage(USER_ID, LEAD_PK, 'auto follow-up', 'ai');
      expect(followUpEngine.handleProReply).not.toHaveBeenCalled();
    });

    it('still completes the send + writes the local Message row for AI sends', async () => {
      const { svc, prisma } = buildService();
      await svc.sendMessage(USER_ID, LEAD_PK, 'auto follow-up', 'ai');
      // upsert (when externalMessageId present) or create (fallback) — assert one or the other.
      expect(prisma.message.upsert.mock.calls.length + prisma.message.create.mock.calls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // robustness
  // ──────────────────────────────────────────────────────────────────
  describe('robustness', () => {
    it('does NOT propagate when handleProReply throws — outbound send already succeeded', async () => {
      const followUpEngine = makeFollowUpEngineMock();
      followUpEngine.handleProReply.mockRejectedValue(new Error('db down during pause'));
      const { svc } = buildService({ followUpEngine });

      // The customer already received the message; surfacing a follow-up
      // pause failure to the SF Inbox would be a regression in user
      // experience for what is effectively a recoverable internal state.
      await expect(svc.sendMessage(USER_ID, LEAD_PK, 'hi')).resolves.toBeDefined();
    });

    it('no-op when followUpEngine is null (Optional inject not wired)', async () => {
      const { svc } = buildService({ followUpEngine: null as any });
      await expect(svc.sendMessage(USER_ID, LEAD_PK, 'hi')).resolves.toBeDefined();
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // lead_linked and SF-linked rows: send/path UNCHANGED, pause still fires
  // ──────────────────────────────────────────────────────────────────
  describe('SF-linked / lead_linked rows', () => {
    it('lead_linked still allowed to be messaged; pause still fires for user sends', async () => {
      // Per the joint LB↔SF design (rollout closed 2026-06-05), state-2
      // (syncStatus='lead_linked') keeps LB in conversation ownership. The
      // FollowUpGate's isSfLinkedLead check is what differentiates state-2
      // from state-3/4; sendMessage itself does not gate on syncStatus.
      const followUpEngine = makeFollowUpEngineMock();
      const { svc, prisma } = buildService({ followUpEngine });
      prisma.lead.findFirst.mockResolvedValue({
        ...await prisma.lead.findFirst(),
        syncStatus: 'lead_linked',
        sfLeadId: '107',
        sfJobId: null,
        sfCustomerId: null,
      });

      await svc.sendMessage(USER_ID, LEAD_PK, 'follow-up question');
      expect(followUpEngine.handleProReply).toHaveBeenCalledTimes(1);
    });

    it('SF-linked customer/job rows (sfJobId set) are NOT separately blocked here — gating belongs to FollowUpGate, not sendMessage', async () => {
      // This is a structural pin: sendMessage handlepro-reply path runs
      // regardless of SF-link state. The reason is that the SF-linked
      // gating happens on the OTHER direction — preventing LB from
      // CHASING the lead. Stopping an enrollment in response to a manual
      // pro send is symmetric and never wrong.
      const followUpEngine = makeFollowUpEngineMock();
      const { svc, prisma } = buildService({ followUpEngine });
      prisma.lead.findFirst.mockResolvedValue({
        ...await prisma.lead.findFirst(),
        syncStatus: 'linked',
        sfJobId: '139832',
        sfCustomerId: '23393',
      });

      await svc.sendMessage(USER_ID, LEAD_PK, 'reply');
      expect(followUpEngine.handleProReply).toHaveBeenCalledTimes(1);
    });
  });
});
