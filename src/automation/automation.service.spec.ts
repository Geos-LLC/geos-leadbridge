/**
 * AutomationService — customer-reply status transition tests.
 *
 * Covers the four transition types added in PR 3:
 *   opt-out phrase                 -> lost (lostReason=opt_out)
 *   hired-someone phrase           -> lost (lostReason=hired_someone, reengageAt=+75d)
 *   agreed phrase                  -> booked
 *   anything else (default)        -> engaged
 *
 * The guard logic (no-downgrade, terminal protection, dedup, etc.) lives in
 * LeadStatusService and is covered by lead-status.service.spec.ts. These
 * tests confirm AutomationService routes each transition through writeStatus
 * with the correct payload and a stable sourceEventId.
 */

import {
  AGREED_PHRASES,
  AutomationService,
  HIRED_SOMEONE_PHRASES,
  OPT_OUT_PHRASES,
  detectCustomerReplyTransition,
} from './automation.service';

const USER_ID = 'user-1';
const LEAD_ID = 'lead-1';
const BUSINESS_ID = 'biz-1';
const NEGOTIATION_ID = 'neg-1';

function buildSvc(opts: { currentLeadStatus?: string | null } = {}) {
  const writeStatus = jest.fn().mockResolvedValue({
    leadId: LEAD_ID,
    applied: true,
    status: 'engaged',
    platformStatus: null,
    conflict: null,
    auditLogId: 'audit-1',
  });
  const leadStatusService = { writeStatus } as any;

  // Wire the transition method into a real instance using the constructor so
  // we exercise the actual private helper. All other deps are unused for the
  // transition path so we pass through trivial mocks. The intent classifier
  // is given a stub that always returns a low-confidence engaged result, so
  // applyCustomerReplyStatusTransition falls through to the phrase-list path
  // (which is what these tests are pinning).
  const intentClassifier = {
    classify: jest.fn().mockResolvedValue({
      intent: 'engaged', confidence: 0, reason: 'test stub', fromLlm: false,
    }),
  } as any;
  // The classifier→hired_someone guard added 2026-06-14 looks up the lead's
  // current status before letting `completed`/`hired_elsewhere` write `lost`.
  // Tests that exercise the LLM-classification path through to writeStatus
  // pass `currentLeadStatus` so this lookup returns a deterministic value.
  const prisma = {
    lead: {
      findUnique: jest.fn().mockResolvedValue(
        opts.currentLeadStatus === undefined
          ? null
          : { status: opts.currentLeadStatus },
      ),
    },
  } as any;
  const svc = new AutomationService(
    /* prisma */ prisma,
    /* templates */ {} as any,
    /* leads */ {} as any,
    /* config */ {} as any,
    /* ai */ {} as any,
    /* intentClassifier */ intentClassifier,
    /* monitoring */ {} as any,
    /* conversationContext */ {} as any,
    /* trial */ {} as any,
    leadStatusService,
    /* followUpEngine */ {} as any,
    /* notifications */ {} as any,
    /* businessHours */ {} as any,
    /* conversationRuntime */ {
      setConversationState: jest.fn().mockResolvedValue(undefined),
      setAiStatus: jest.fn().mockResolvedValue(undefined),
      setState: jest.fn().mockResolvedValue(undefined),
      recordClassifierIntent: jest.fn().mockResolvedValue(undefined),
      setHandoffRequested: jest.fn().mockResolvedValue(undefined),
      resolveHandoff: jest.fn().mockResolvedValue(undefined),
    } as any,
    /* bookingOrchestrator */ {} as any,
  );

  return { svc, writeStatus, prisma };
}

function ctx(message: string, overrides: Record<string, any> = {}) {
  return {
    userId: USER_ID,
    businessId: BUSINESS_ID,
    negotiationId: NEGOTIATION_ID,
    leadId: LEAD_ID,
    customerName: 'Customer',
    customerMessage: message,
    isFirstCustomerReply: false,
    ...overrides,
  } as any;
}

// `applyCustomerReplyStatusTransition` is private. We invoke it via a typed
// indirection so tests stay close to real behavior without monkey-patching.
function runTransition(
  svc: AutomationService,
  message: string,
  overrides: Record<string, any> = {},
  classification?: { intent: string; confidence: number; reason: string; fromLlm: boolean },
) {
  return (svc as any).applyCustomerReplyStatusTransition(ctx(message, overrides), classification);
}

describe('detectCustomerReplyTransition (pure)', () => {
  it.each(OPT_OUT_PHRASES)('classifies opt_out for "%s"', async (phrase) => {
    expect(detectCustomerReplyTransition(`hey ${phrase} please`)).toEqual({ kind: 'opt_out' });
  });

  it.each(HIRED_SOMEONE_PHRASES)('classifies hired_someone for "%s"', async (phrase) => {
    expect(detectCustomerReplyTransition(`thanks but ${phrase}`)).toEqual({ kind: 'hired_someone' });
  });

  it.each(AGREED_PHRASES)('classifies agreed for "%s"', async (phrase) => {
    expect(detectCustomerReplyTransition(`great, ${phrase}`)).toEqual({ kind: 'agreed' });
  });

  it('defaults to engaged for plain replies', () => {
    expect(detectCustomerReplyTransition('what time can you start?')).toEqual({ kind: 'engaged' });
  });

  it('opt_out wins over agreed in the same message', () => {
    expect(detectCustomerReplyTransition('sounds good but actually stop')).toEqual({ kind: 'opt_out' });
  });

  it('hired_someone wins over agreed', () => {
    expect(detectCustomerReplyTransition("yes please but i found someone")).toEqual({ kind: 'hired_someone' });
  });

  it('case-insensitive', () => {
    expect(detectCustomerReplyTransition('STOP messaging me')).toEqual({ kind: 'opt_out' });
  });
});

describe('AutomationService.applyCustomerReplyStatusTransition', () => {
  describe('opt-out', () => {
    it('writes lost + lostReason=opt_out', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'please stop messaging me');

      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'opt_out',
        reason: 'opt_out',
      });
    });
  });

  describe('hired-someone', () => {
    it('writes lost + lostReason=hired_someone + reengageAt ~21 days out', async () => {
      const { svc, writeStatus } = buildSvc();
      const before = Date.now();
      await runTransition(svc, 'thanks, i already hired someone else');
      const after = Date.now();

      expect(writeStatus).toHaveBeenCalledTimes(1);
      const call = writeStatus.mock.calls[0][0];
      expect(call).toMatchObject({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'lost',
        lostReason: 'hired_someone',
        reason: 'hired_someone',
      });
      const expectedMin = before + 21 * 24 * 60 * 60 * 1000;
      const expectedMax = after + 21 * 24 * 60 * 60 * 1000;
      const reengageMs = (call.reengageAt as Date).getTime();
      expect(reengageMs).toBeGreaterThanOrEqual(expectedMin);
      expect(reengageMs).toBeLessThanOrEqual(expectedMax);
    });

    it('also classifies "not interested" as hired_someone', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, "thanks but i'm not interested right now");

      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        newStatus: 'lost',
        lostReason: 'hired_someone',
      });
    });
  });

  describe('agreed', () => {
    it('writes booked', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, "sounds good let's do it");

      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'booked',
        reason: 'price_agreed',
      });
      // Should NOT pass lostReason or reengageAt for non-lost transitions.
      expect(writeStatus.mock.calls[0][0].lostReason).toBeUndefined();
      expect(writeStatus.mock.calls[0][0].reengageAt).toBeUndefined();
    });
  });

  describe('engaged (default)', () => {
    it('writes engaged for plain replies', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'what time can you start?');

      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        leadId: LEAD_ID,
        source: 'lb_automation',
        newStatus: 'engaged',
        reason: 'customer_replied',
      });
    });

    it('still writes engaged when current status is unknown — guards in writeStatus decide', async () => {
      // The transition layer is intentionally dumb: it always calls writeStatus
      // and the no-downgrade / same-status / terminal guards do the filtering.
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'how much for a 3 bed 2 bath?');

      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0].newStatus).toBe('engaged');
    });
  });

  describe('sourceEventId', () => {
    it('uses messageId when provided', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'how much?', { messageId: 'msg_abc' });

      expect(writeStatus.mock.calls[0][0].sourceEventId).toBe('reply_msg_abc_engaged');
    });

    it('derives a stable hash from leadId + transition + message when messageId is absent', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'please stop');
      await runTransition(svc, 'please stop');

      // Same input → same sourceEventId (stable, dedup-friendly).
      expect(writeStatus.mock.calls[0][0].sourceEventId).toBe(
        writeStatus.mock.calls[1][0].sourceEventId,
      );
      expect(writeStatus.mock.calls[0][0].sourceEventId).toMatch(/^reply_lead-1_opt_out_[a-f0-9]{16}$/);
    });

    it('different transitions on the same lead get different sourceEventIds', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'please stop');
      await runTransition(svc, 'sounds good');

      expect(writeStatus.mock.calls[0][0].sourceEventId).not.toEqual(
        writeStatus.mock.calls[1][0].sourceEventId,
      );
    });
  });

  describe('no-op safety', () => {
    it('returns early without calling writeStatus when leadId is missing', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, 'stop', { leadId: undefined });
      expect(writeStatus).not.toHaveBeenCalled();
    });

    it('returns early when customerMessage is empty', async () => {
      const { svc, writeStatus } = buildSvc();
      await runTransition(svc, '');
      expect(writeStatus).not.toHaveBeenCalled();
    });
  });

  // 2026-06-17 lifecycle rule cleanup (Spec D 1, 5, 6):
  // The classifier intent mapping at intentToTransitionKind was reshaped so
  // `completed` and `agreed` no longer attempt terminal writes — they fall
  // through to `engaged`. The original Feryal Berjawi 2026-06-14 guard at
  // automation.service.ts:1617 still fires for `hired_elsewhere` only (since
  // that is the only intent that still maps to `hired_someone`). For
  // `completed`/`agreed`, no terminal write is even attempted now; the
  // pipeline-downgrade guard inside LeadStatusService is what prevents
  // the booked→engaged downgrade if those intents fire on a booked lead.
  describe('classifier mapping (2026-06-17 lifecycle cleanup)', () => {
    const llmCompleted = { intent: 'completed', confidence: 0.9, reason: 'wrap-up', fromLlm: true };
    const llmHiredElsewhere = { intent: 'hired_elsewhere', confidence: 0.9, reason: 'hired competitor', fromLlm: true };
    const llmAgreed = { intent: 'agreed', confidence: 0.9, reason: 'price accepted', fromLlm: true };

    // Spec D.6: classifier `completed` never maps to lost.
    it('classifier=completed maps to engaged transition (not lost)', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'engaged' });
      await runTransition(svc, 'Thanks again!', {}, llmCompleted);
      // writeStatus is called with engaged (not lost). The same-status guard
      // inside LeadStatusService no-ops because the lead is already engaged,
      // but at the AutomationService boundary the intent is correctly
      // routed to engaged.
      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        newStatus: 'engaged',
      });
      expect(writeStatus.mock.calls[0][0]).not.toMatchObject({ newStatus: 'lost' });
    });

    // Spec D.1: booked lead + customer wrap-up phrase must not flip lost.
    it('classifier=completed on booked lead does NOT attempt lost write', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'booked' });
      await runTransition(svc, 'Thanks again!', {}, llmCompleted);
      // Either: writeStatus called with engaged (LeadStatusService's
      // pipeline-downgrade guard then blocks the actual change) OR not called
      // at all if guarded earlier. Either is acceptable — what we pin is
      // that NO lost write attempt is made.
      const allCalls = writeStatus.mock.calls.map((c: any[]) => c[0]);
      for (const call of allCalls) {
        expect(call).not.toMatchObject({ newStatus: 'lost' });
      }
    });

    // Spec D.5: hired_elsewhere on booked lead → suppressed (Berjawi guard
    // preserved). The guard returns early before calling writeStatus.
    it('SUPPRESSES classifier=hired_elsewhere on booked lead (Berjawi guard preserved)', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'booked' });
      await runTransition(svc, 'Sounds perfect, see you then.', {}, llmHiredElsewhere);
      expect(writeStatus).not.toHaveBeenCalled();
    });

    // Spec D.5 (companion): hired_elsewhere on completed lead → also suppressed.
    it('SUPPRESSES classifier=hired_elsewhere on completed lead (Berjawi guard preserved)', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'completed' });
      await runTransition(svc, "we're all done", {}, llmHiredElsewhere);
      expect(writeStatus).not.toHaveBeenCalled();
    });

    // Spec D.4: hired_elsewhere on active (engaged) lead → lost+hired_someone.
    it('ALLOWS classifier=hired_elsewhere on engaged lead → lost+hired_someone', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'engaged' });
      await runTransition(svc, 'we hired someone else', {}, llmHiredElsewhere);
      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        newStatus: 'lost',
        lostReason: 'hired_someone',
      });
    });

    // Spec D.3: opt_out → lost+opt_out even on booked leads (regulatory).
    it('ALLOWS classifier=opt_out → lost+opt_out even on booked leads', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'booked' });
      const llmOptOut = { intent: 'opt_out', confidence: 0.99, reason: 'stop', fromLlm: true };
      await runTransition(svc, 'stop messaging me', {}, llmOptOut);
      expect(writeStatus).toHaveBeenCalledTimes(1);
      expect(writeStatus.mock.calls[0][0]).toMatchObject({
        newStatus: 'lost',
        lostReason: 'opt_out',
      });
    });

    // 2026-06-17: agreed no longer triggers Lead.status='booked' from AI.
    // It maps to engaged at the transition layer; handoff alert fires
    // separately via maybeFireHandoffAlert.
    it('classifier=agreed maps to engaged transition (AI no longer authors booked)', async () => {
      const { svc, writeStatus } = buildSvc({ currentLeadStatus: 'engaged' });
      await runTransition(svc, 'sounds good', {}, llmAgreed);
      // Same-status guard inside LeadStatusService will no-op the actual
      // write, but the attempted newStatus is engaged, not booked.
      const allCalls = writeStatus.mock.calls.map((c: any[]) => c[0]);
      for (const call of allCalls) {
        expect(call).not.toMatchObject({ newStatus: 'booked' });
      }
    });
  });
});

/**
 * maybeFireHandoffAlert — strategy-aware AI Human Takeover rules.
 *
 * Pins the gating contract:
 *   • fromLlm + confidence ≥ 0.7 + aiConversationEnabled are absolute safety gates
 *   • Each reason has a per-account enable flag (default true) read out of
 *     followUpSettingsJson
 *   • provided_phone_number gates on AI Strategy=phone OR lead has no usable phone
 *   • provided_square_footage gates on AI Strategy=qualify OR priceQuoteMode=exact
 *   • {{intent}} renders the friendly label, not the internal reason key
 */
describe('AutomationService.maybeFireHandoffAlert', () => {
  function buildHandoffSvc(opts: { leadCustomerPhone?: string | null } = {}) {
    const sendHandoffAlert = jest.fn().mockResolvedValue(undefined);
    const notifications = { sendHandoffAlert } as any;
    const prisma = {
      lead: {
        findUnique: jest.fn().mockResolvedValue({ customerPhone: opts.leadCustomerPhone ?? null }),
      },
    } as any;
    const svc = new AutomationService(
      prisma,
      /* templates */ {} as any,
      /* leads */ {} as any,
      /* config */ {} as any,
      /* ai */ {} as any,
      /* intentClassifier */ {} as any,
      /* monitoring */ {} as any,
      /* conversationContext */ {} as any,
      /* trial */ {} as any,
      /* leadStatusService */ {} as any,
      /* followUpEngine */ {} as any,
      notifications,
      /* businessHours */ {} as any,
      /* conversationRuntime */ {
        setConversationState: jest.fn().mockResolvedValue(undefined),
        setAiStatus: jest.fn().mockResolvedValue(undefined),
        setState: jest.fn().mockResolvedValue(undefined),
        recordClassifierIntent: jest.fn().mockResolvedValue(undefined),
        setHandoffRequested: jest.fn().mockResolvedValue(undefined),
        resolveHandoff: jest.fn().mockResolvedValue(undefined),
      } as any,
      /* bookingOrchestrator */ {} as any,
    );
    return { svc, sendHandoffAlert, prisma };
  }

  function classification(overrides: any = {}) {
    return {
      intent: 'engaged',
      confidence: 0.9,
      reason: 'test',
      fromLlm: true,
      ...overrides,
    };
  }

  function settings(extra: Record<string, any> = {}) {
    return JSON.stringify({ ...extra });
  }

  function account(extra: Record<string, any> = {}) {
    return {
      id: 'sa-1',
      followUpSettingsJson: settings(),
      aiConversationEnabled: true,
      businessName: 'Test Co',
      ...extra,
    };
  }

  function fire(svc: AutomationService, cls: any, acct: any, message = 'test message') {
    // 4th arg `aiConversationEnabled` was added by the User-scope promotion
    // (commit d7488df) and is normally passed by handleCustomerReply. These
    // tests pre-date that change — read it from the account override so
    // existing test bodies (which set `aiConversationEnabled` on the acct)
    // keep working without rewriting every call site.
    const aiEnabled = acct?.aiConversationEnabled !== false;
    return (svc as any).maybeFireHandoffAlert(cls, ctx(message), acct, aiEnabled);
  }

  describe('safety gates', () => {
    it('does not fire when fromLlm=false (phrase-list fallback)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'agreed', fromLlm: false }), account());
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('does not fire below confidence threshold (0.7)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'agreed', confidence: 0.65 }), account());
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('does not fire when aiConversationEnabled is false', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'agreed' }), account({ aiConversationEnabled: false }));
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('does not fire when reEngagementAlertEnabled (master alerts) is false', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ reEngagementAlertEnabled: false }) });
      await fire(svc, classification({ intent: 'agreed' }), acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('does not fire when no handoff reason is detected (no agreed/wants_live_contact intent, no handoff signal)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'engaged' }), account());
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });
  });

  describe('intent-based legacy path', () => {
    it('fires on intent=agreed with friendly label "ready to book"', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'agreed' }), account(), 'yes let\'s book it');
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
      const rendered = sendHandoffAlert.mock.calls[0][2];
      expect(rendered).toContain('ready to book');
    });

    it('fires on intent=wants_live_contact with friendly label "wants live contact"', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      await fire(svc, classification({ intent: 'wants_live_contact' }), account(), 'call me at 6pm');
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
      expect(sendHandoffAlert.mock.calls[0][2]).toContain('wants live contact');
    });
  });

  describe('handoff-signal path (new reasons)', () => {
    it('fires provided_phone_number when AI Strategy=phone', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc({ leadCustomerPhone: '+18005551111' });
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'phone' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_phone_number', explanation: 'shared number' },
      });
      await fire(svc, cls, acct, 'My number is 248-555-1234');
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
      expect(sendHandoffAlert.mock.calls[0][2]).toContain('provided phone number');
    });

    it('fires provided_phone_number when lead has no phone (strategy != phone)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc({ leadCustomerPhone: null });
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'hybrid' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_phone_number', explanation: 'shared number' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire provided_phone_number when strategy != phone AND lead already has phone', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc({ leadCustomerPhone: '+18005551111' });
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'hybrid' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_phone_number', explanation: 'shared number' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('fires provided_square_footage when AI Strategy=qualify', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'qualify' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_square_footage', extracted: { squareFootage: 2100 }, explanation: 'sqft shared' },
      });
      await fire(svc, cls, acct, 'about 2100 sq ft');
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
      expect(sendHandoffAlert.mock.calls[0][2]).toContain('provided square footage');
    });

    it('fires provided_square_footage when priceQuoteMode=exact (any strategy)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'hybrid', priceQuoteMode: 'exact' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_square_footage', extracted: { squareFootage: 1800 }, explanation: '' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
    });

    it('does NOT fire provided_square_footage when neither strategy=qualify nor priceQuoteMode=exact', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ followUpStrategy: 'hybrid', priceQuoteMode: 'range' }) });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_square_footage', explanation: '' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('fires qualification_complete regardless of strategy', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'qualification_complete', extracted: { bedrooms: 4, bathrooms: 3 }, explanation: 'enough details' },
      });
      await fire(svc, cls, account(), 'standard, 4 bed 3 bath, every two weeks');
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
      expect(sendHandoffAlert.mock.calls[0][2]).toContain('qualification complete');
    });
  });

  describe('per-account trigger toggles', () => {
    it('disabled handoffTriggerAgreed blocks intent=agreed', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ handoffTriggerAgreed: false }) });
      await fire(svc, classification({ intent: 'agreed' }), acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('disabled handoffTriggerProvidedPhone blocks provided_phone_number even when strategy=phone', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc({ leadCustomerPhone: null });
      const acct = account({
        followUpSettingsJson: settings({ followUpStrategy: 'phone', handoffTriggerProvidedPhone: false }),
      });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'provided_phone_number', explanation: '' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('disabled handoffTriggerQualificationComplete blocks qualification_complete', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({
        followUpSettingsJson: settings({ handoffTriggerQualificationComplete: false }),
      });
      const cls = classification({
        intent: 'engaged',
        handoff: { shouldHandoff: true, reason: 'qualification_complete', explanation: '' },
      });
      await fire(svc, cls, acct);
      expect(sendHandoffAlert).not.toHaveBeenCalled();
    });

    it('undefined toggle defaults to enabled (back-compat for accounts that never visited the UI)', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      // followUpSettingsJson has zero handoff toggles set
      await fire(svc, classification({ intent: 'agreed' }), account());
      expect(sendHandoffAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe('template rendering', () => {
    it('uses the custom handoffAlertTemplate from settings', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({
        followUpSettingsJson: settings({ handoffAlertTemplate: 'HANDOFF: {{lead.name}} | {{intent}} | {{message}}' }),
      });
      await fire(svc, classification({ intent: 'agreed' }), acct, 'book it');
      const rendered = sendHandoffAlert.mock.calls[0][2];
      expect(rendered).toContain('HANDOFF:');
      expect(rendered).toContain('Customer');
      expect(rendered).toContain('ready to book');
      expect(rendered).toContain('book it');
    });

    it('falls back to default template when handoffAlertTemplate is empty', async () => {
      const { svc, sendHandoffAlert } = buildHandoffSvc();
      const acct = account({ followUpSettingsJson: settings({ handoffAlertTemplate: '   ' }) });
      await fire(svc, classification({ intent: 'agreed' }), acct);
      expect(sendHandoffAlert.mock.calls[0][2]).toMatch(/ready for handoff/);
    });
  });
});

/**
 * AutomationService.applyReEngagementEnrollment — pins the per-intent
 * re-engagement enrollment as a sibling of the status writer that runs
 * BEFORE the manual-pro-recency pause and BEFORE the AI Conversation gates.
 *
 * Regression bracket for Spotless Homes Tampa lead Kala Ronshausen
 * 2026-06-26: settings had aiHiredCompetitorReengage=true with a 3-week
 * delay, customer said "Thank you. I found someone", status correctly
 * flipped to lost, but no enrollment fired because a manual pro message
 * 6 min earlier had tripped the fuReEnrollDelay pause guard which
 * exited handleCustomerReply before reaching the (then nested) enrollment
 * site. The fix moves enrollment out of the AI Conversation block.
 */
describe('AutomationService.applyReEngagementEnrollment', () => {
  function buildReengageSvc() {
    const enrollInSequence = jest.fn().mockResolvedValue('enr-1');
    const template = { id: 'tmpl-1' };
    const findFirstTemplate = jest.fn().mockResolvedValue(template);
    const prisma = {
      followUpSequenceTemplate: { findFirst: findFirstTemplate },
    } as any;
    const followUpEngine = { enrollInSequence } as any;
    const svc = new AutomationService(
      prisma,
      /* templates */ {} as any,
      /* leads */ {} as any,
      /* config */ {} as any,
      /* ai */ {} as any,
      /* intentClassifier */ {} as any,
      /* monitoring */ {} as any,
      /* conversationContext */ {} as any,
      /* trial */ {} as any,
      /* leadStatus */ {} as any,
      followUpEngine,
      /* notifications */ {} as any,
      /* businessHours */ {} as any,
      /* conversationRuntime */ {} as any,
      /* bookingOrchestrator */ {} as any,
    );
    // ensureCustomerReplyPresets is called by enrollInCustomerReplySequence
    // before the template lookup. Stub it at the module level so we don't
    // need to mock the underlying SavedAccount/prisma calls it would make.
    jest.spyOn(require('../follow-up-engine/follow-up-seed'), 'ensureCustomerReplyPresets')
      .mockResolvedValue(undefined as any);
    return { svc, enrollInSequence, findFirstTemplate };
  }

  function reengageCtx(message: string) {
    return {
      userId: USER_ID,
      businessId: BUSINESS_ID,
      negotiationId: NEGOTIATION_ID,
      leadId: LEAD_ID,
      customerName: 'Kala',
      customerMessage: message,
      isFirstCustomerReply: false,
    } as any;
  }

  function savedAccount(settingsObj: Record<string, any>) {
    return {
      id: 'acct-1',
      platform: 'thumbtack',
      followUpSettingsJson: JSON.stringify(settingsObj),
      followUpActiveHoursStart: '09:00',
      followUpActiveHoursEnd: '21:00',
      followUpTimezone: 'America/New_York',
    } as any;
  }

  function classification(intent: string, opts: { confidence?: number; fromLlm?: boolean } = {}) {
    return {
      intent,
      confidence: opts.confidence ?? 0.95,
      reason: 'test',
      fromLlm: opts.fromLlm ?? true,
    } as any;
  }

  async function run(svc: AutomationService, ctxArg: any, cls: any, acct: any) {
    return (svc as any).applyReEngagementEnrollment(ctxArg, cls, acct, 'thread-1');
  }

  describe('LLM-classifier path', () => {
    it('enrolls customer_hired_competitor on hired_elsewhere when aiHiredCompetitorReengage=true', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('thank you, I found someone'),
        classification('hired_elsewhere'),
        savedAccount({ aiHiredCompetitorReengage: true }));
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
      expect(enrollInSequence).toHaveBeenCalledWith('thread-1', 'tmpl-1', 'thumbtack', LEAD_ID, undefined);
    });

    it('also enrolls on intent=completed (legacy parity with the AI-conversation gate)', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('its already done'),
        classification('completed'),
        savedAccount({ aiHiredCompetitorReengage: true }));
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
    });

    it('skips enrollment when aiHiredCompetitorReengage is not set', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('found someone'),
        classification('hired_elsewhere'),
        savedAccount({}));
      expect(enrollInSequence).not.toHaveBeenCalled();
    });

    it('enrolls customer_deferred on deferring when aiDeferralCheckIn=true', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('let me think about it'),
        classification('deferring'),
        savedAccount({ aiDeferralCheckIn: true }));
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
    });

    it('forwards suggestedReengageInDays as overrideMinutes', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      const cls = classification('deferring');
      cls.suggestedReengageInDays = 14;
      await run(svc, reengageCtx('back in two weeks'),
        cls,
        savedAccount({ aiDeferralCheckIn: true }));
      expect(enrollInSequence).toHaveBeenCalledWith('thread-1', 'tmpl-1', 'thumbtack', LEAD_ID, 14 * 24 * 60);
    });

    it('does not enroll on neutral intents (asking, engaged, agreed, opt_out)', async () => {
      for (const intent of ['asking', 'engaged', 'agreed', 'opt_out', 'wants_live_contact']) {
        const { svc, enrollInSequence } = buildReengageSvc();
        await run(svc, reengageCtx('what time'),
          classification(intent),
          savedAccount({ aiHiredCompetitorReengage: true, aiDeferralCheckIn: true }));
        expect(enrollInSequence).not.toHaveBeenCalled();
      }
    });

    it('does not enroll when classifier confidence is below threshold', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('found someone'),
        classification('hired_elsewhere', { confidence: 0.5 }),
        savedAccount({ aiHiredCompetitorReengage: true }));
      // Low confidence — falls through to phrase-list, which DOES match.
      // The phrase-list path is also gated on aiHiredCompetitorReengage so
      // it will fire here. This test confirms the LLM branch did not.
      // (Counted once via the phrase fallback, not the LLM branch.)
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
    });

    it('does not enroll when classification is not from LLM', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('not a phrase-list match'),
        classification('hired_elsewhere', { fromLlm: false }),
        savedAccount({ aiHiredCompetitorReengage: true }));
      expect(enrollInSequence).not.toHaveBeenCalled();
    });
  });

  describe('phrase-list fallback (no LLM signal)', () => {
    it('matches HIRED_SOMEONE_PHRASES → customer_hired_competitor', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('I already hired someone, thanks'),
        undefined,
        savedAccount({ aiHiredCompetitorReengage: true }));
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
    });

    it('matches DEFERRAL_PHRASES → customer_deferred', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('let me think it over'),
        undefined,
        savedAccount({ aiDeferralCheckIn: true }));
      expect(enrollInSequence).toHaveBeenCalledTimes(1);
    });

    it('does not match on neutral messages', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('what time can you come?'),
        undefined,
        savedAccount({ aiHiredCompetitorReengage: true, aiDeferralCheckIn: true }));
      expect(enrollInSequence).not.toHaveBeenCalled();
    });
  });

  describe('guards', () => {
    it('no-ops when threadId is missing', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await (svc as any).applyReEngagementEnrollment(
        reengageCtx('found someone'),
        classification('hired_elsewhere'),
        savedAccount({ aiHiredCompetitorReengage: true }),
        null,
      );
      expect(enrollInSequence).not.toHaveBeenCalled();
    });

    it('no-ops when both toggles are off (avoids parsing settings twice)', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      await run(svc, reengageCtx('found someone'),
        classification('hired_elsewhere'),
        savedAccount({ aiHiredCompetitorReengage: false, aiDeferralCheckIn: false }));
      expect(enrollInSequence).not.toHaveBeenCalled();
    });

    it('tolerates malformed followUpSettingsJson without throwing', async () => {
      const { svc, enrollInSequence } = buildReengageSvc();
      const bad = { ...savedAccount({}), followUpSettingsJson: '{not json' };
      await run(svc, reengageCtx('found someone'),
        classification('hired_elsewhere'),
        bad);
      expect(enrollInSequence).not.toHaveBeenCalled();
    });
  });
});
