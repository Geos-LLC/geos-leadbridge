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

function buildSvc() {
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
  // transition path so we pass through trivial mocks.
  const svc = new AutomationService(
    /* prisma */ {} as any,
    /* templates */ {} as any,
    /* leads */ {} as any,
    /* config */ {} as any,
    /* ai */ {} as any,
    /* monitoring */ {} as any,
    /* conversationContext */ {} as any,
    /* trial */ {} as any,
    leadStatusService,
  );

  return { svc, writeStatus };
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
function runTransition(svc: AutomationService, message: string, overrides: Record<string, any> = {}) {
  return (svc as any).applyCustomerReplyStatusTransition(ctx(message, overrides));
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
    it('writes lost + lostReason=hired_someone + reengageAt ~75 days out', async () => {
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
      const expectedMin = before + 75 * 24 * 60 * 60 * 1000;
      const expectedMax = after + 75 * 24 * 60 * 60 * 1000;
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
});
