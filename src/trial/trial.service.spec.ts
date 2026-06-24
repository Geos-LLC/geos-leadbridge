/**
 * TrialService.consumeLead — meter inbound leads against the trial counter.
 *
 * Covers the contract documented in the method JSDoc:
 *  - paid users / no-trial users / ended-trial users are skipped (counted=false)
 *  - the CAS flip on Lead.trialCounted is single-shot per lead
 *  - increment happens only when the flip succeeded
 *  - second call for the same lead is a no-op (idempotent)
 *  - NO trial type auto-ends via lead count — trials are time-only (7 days)
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import { TrialService } from './trial.service';
import { TrialType, SubscriptionStatus } from '../../generated/prisma';

type UserSnapshot = {
  subscriptionTier: string | null;
  subscriptionStatus: SubscriptionStatus | null;
  trialType: TrialType | null;
  trialEndedAt: Date | null;
  trialEndDate: Date | null;
  trialLeadsHandled: number;
  trialLeadsLimit: number;
};

type LeadSnapshot = {
  id: string;
  userId: string;
  trialCounted: boolean;
};

const USER_ID = 'user-123';
const LEAD_ID = 'lead-abc';

function buildHarness(
  initialUser: Partial<UserSnapshot> = {},
  initialLead: Partial<LeadSnapshot> = {},
) {
  const user: UserSnapshot = {
    subscriptionTier: null,
    subscriptionStatus: null,
    trialType: TrialType.LEAD_BASED,
    trialEndedAt: null,
    trialEndDate: null,
    trialLeadsHandled: 0,
    trialLeadsLimit: 10,
    ...initialUser,
  };
  const lead: LeadSnapshot = {
    id: LEAD_ID,
    userId: USER_ID,
    trialCounted: false,
    ...initialLead,
  };

  // tx and prisma share the same in-memory state — the only thing the impl
  // distinguishes is which object exposes the methods. The single-shot CAS
  // is enforced here just like in Postgres: matching rows × predicate.
  const ops = {
    user: {
      findUnique: jest.fn(async () => ({ ...user })),
      update: jest.fn(async ({ data, select: _select }: any) => {
        if (data.trialLeadsHandled?.increment) {
          user.trialLeadsHandled += data.trialLeadsHandled.increment;
        }
        return {
          trialType: user.trialType,
          trialEndedAt: user.trialEndedAt,
          trialLeadsHandled: user.trialLeadsHandled,
          trialLeadsLimit: user.trialLeadsLimit,
        };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.id !== USER_ID) return { count: 0 };
        if (where.trialEndedAt === null && user.trialEndedAt !== null) {
          return { count: 0 };
        }
        if (data.trialEndedAt) {
          user.trialEndedAt = data.trialEndedAt;
        }
        return { count: 1 };
      }),
    },
    lead: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const idMatch = where.id === lead.id;
        const userMatch = where.userId === lead.userId;
        const countedMatch = where.trialCounted === false ? !lead.trialCounted : true;
        if (idMatch && userMatch && countedMatch) {
          if (data.trialCounted !== undefined) lead.trialCounted = data.trialCounted;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
  };

  const prisma: any = {
    ...ops,
    $transaction: jest.fn(async (cb: (tx: any) => Promise<unknown>) => cb(ops)),
  };

  const emitter = { emit: jest.fn() } as unknown as EventEmitter2;
  const svc = new TrialService(prisma, emitter);

  return { svc, prisma, emitter, getUser: () => ({ ...user }), getLead: () => ({ ...lead }) };
}

describe('TrialService.consumeLead', () => {
  it('counts a single delivery and increments the user counter', async () => {
    const h = buildHarness();
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result).toEqual({ justExhausted: false, nowEnded: false, counted: true });
    expect(h.getLead().trialCounted).toBe(true);
    expect(h.getUser().trialLeadsHandled).toBe(1);
  });

  it('is idempotent — second call for the same lead is a no-op', async () => {
    const h = buildHarness();
    await h.svc.consumeLead(USER_ID, LEAD_ID);
    const second = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(second).toEqual({ justExhausted: false, nowEnded: false, counted: false });
    expect(h.getUser().trialLeadsHandled).toBe(1);
  });

  it('skips paid users entirely — flag stays false, counter unchanged', async () => {
    const h = buildHarness({
      subscriptionTier: 'STARTER',
      subscriptionStatus: SubscriptionStatus.ACTIVE,
    });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result.counted).toBe(false);
    expect(h.getLead().trialCounted).toBe(false);
    expect(h.getUser().trialLeadsHandled).toBe(0);
  });

  it('skips users with no trial configured', async () => {
    const h = buildHarness({ trialType: null });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result.counted).toBe(false);
    expect(h.getLead().trialCounted).toBe(false);
  });

  it('skips users whose trial already ended', async () => {
    const h = buildHarness({ trialEndedAt: new Date('2026-05-20') });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result).toEqual({ justExhausted: false, nowEnded: true, counted: false });
    expect(h.getLead().trialCounted).toBe(false);
  });

  it('does NOT auto-end a LEAD_BASED trial — lead limits are removed', async () => {
    const h = buildHarness({
      trialType: TrialType.LEAD_BASED,
      trialLeadsHandled: 9,
      trialLeadsLimit: 10,
    });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result).toEqual({ justExhausted: false, nowEnded: false, counted: true });
    expect(h.getUser().trialEndedAt).toBeNull();
    expect(h.emitter.emit).not.toHaveBeenCalled();
  });

  it('does NOT auto-end a HYBRID trial — lead limits are removed', async () => {
    const h = buildHarness({
      trialType: TrialType.HYBRID,
      trialLeadsHandled: 14,
      trialLeadsLimit: 15,
    });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result).toEqual({ justExhausted: false, nowEnded: false, counted: true });
    expect(h.getUser().trialEndedAt).toBeNull();
    expect(h.emitter.emit).not.toHaveBeenCalled();
  });

  it('does NOT auto-end a TIME_BASED trial by lead count', async () => {
    const h = buildHarness({
      trialType: TrialType.TIME_BASED,
      trialLeadsHandled: 998,
      trialLeadsLimit: 999,
    });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result.justExhausted).toBe(false);
    expect(result.nowEnded).toBe(false);
    expect(result.counted).toBe(true);
    expect(h.getUser().trialEndedAt).toBeNull();
  });

  it('returns counted=false and never increments when the lead lookup misses', async () => {
    const h = buildHarness();
    const result = await h.svc.consumeLead(USER_ID, 'some-other-lead-id');

    expect(result.counted).toBe(false);
    expect(h.getUser().trialLeadsHandled).toBe(0);
    expect(h.getLead().trialCounted).toBe(false);
  });

  it('returns counted=false and never increments when the lead belongs to another user', async () => {
    const h = buildHarness({}, { userId: 'someone-else' });
    const result = await h.svc.consumeLead(USER_ID, LEAD_ID);

    expect(result.counted).toBe(false);
    expect(h.getUser().trialLeadsHandled).toBe(0);
  });
});
