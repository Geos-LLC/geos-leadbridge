/**
 * SseBusinessIdResolver + passesAccountFilter — unit tests.
 *
 * The SSE controller wires these together with rxjs; the rxjs stream itself
 * has separate integration coverage in leads-sse.controller.spec.ts. The
 * helper has no NestJS lifecycle / no rxjs / no http surface — it's the
 * load-bearing decision layer for "should this event reach this subscriber?"
 * so it gets focused unit coverage.
 */

import {
  SseBusinessIdResolver,
  passesAccountFilter,
  SseAccountScope,
  BusinessIdLookup,
} from './sse-account-filter';

const USER_ID = 'user-1';

function buildPrisma(opts: {
  leadsByPair?: Record<string, { businessId: string | null }>;
  trackCalls?: { calls: number };
} = {}): BusinessIdLookup {
  return {
    lead: {
      findFirst: async ({ where }: any) => {
        if (opts.trackCalls) opts.trackCalls.calls += 1;
        if (where.userId !== USER_ID) return null;
        return opts.leadsByPair?.[where.id] ?? null;
      },
    },
  };
}

describe('SseBusinessIdResolver.resolve', () => {
  describe('direct payload paths (no DB hit)', () => {
    it('payload.businessId → returns it immediately, no DB call', async () => {
      const tracker = { calls: 0 };
      const r = new SseBusinessIdResolver(
        buildPrisma({ trackCalls: tracker }),
        USER_ID,
      );

      const out = await r.resolve({ businessId: 'biz-A', leadId: 'lead-99' });

      expect(out).toBe('biz-A');
      expect(tracker.calls).toBe(0);
    });

    it('payload.lead.businessId (nested lead row) → returns it', async () => {
      const tracker = { calls: 0 };
      const r = new SseBusinessIdResolver(
        buildPrisma({ trackCalls: tracker }),
        USER_ID,
      );

      const out = await r.resolve({ lead: { id: 'lead-1', businessId: 'biz-X' } });

      expect(out).toBe('biz-X');
      expect(tracker.calls).toBe(0);
    });

    it("lead.created payload (the lead row itself) → returns row's businessId", async () => {
      // payload IS the Lead row: { id, businessId, userId, ... }
      const tracker = { calls: 0 };
      const r = new SseBusinessIdResolver(
        buildPrisma({ trackCalls: tracker }),
        USER_ID,
      );

      const out = await r.resolve({
        id: 'lead-1',
        userId: USER_ID,
        businessId: 'biz-A',
        platform: 'thumbtack',
      });

      expect(out).toBe('biz-A');
      expect(tracker.calls).toBe(0);
    });

    it('empty-string businessId is ignored (falls through to leadId path)', async () => {
      const r = new SseBusinessIdResolver(
        buildPrisma({ leadsByPair: { 'lead-1': { businessId: 'biz-A' } } }),
        USER_ID,
      );

      const out = await r.resolve({ businessId: '', leadId: 'lead-1' });

      expect(out).toBe('biz-A');
    });
  });

  describe('leadId resolution via Prisma', () => {
    it('payload.leadId → looks up Lead and returns businessId', async () => {
      const r = new SseBusinessIdResolver(
        buildPrisma({ leadsByPair: { 'lead-42': { businessId: 'biz-A' } } }),
        USER_ID,
      );

      const out = await r.resolve({ leadId: 'lead-42', message: { id: 'msg-1' } });

      expect(out).toBe('biz-A');
    });

    it('lookup that returns null businessId → resolves to null', async () => {
      const r = new SseBusinessIdResolver(
        buildPrisma({ leadsByPair: { 'lead-42': { businessId: null } } }),
        USER_ID,
      );

      const out = await r.resolve({ leadId: 'lead-42' });

      expect(out).toBeNull();
    });

    it('leadId not owned by user → resolves to null (cross-tenant guard via where.userId)', async () => {
      const r = new SseBusinessIdResolver(
        buildPrisma({ leadsByPair: { 'lead-other': { businessId: 'biz-Z' } } }),
        'different-user',
      );

      const out = await r.resolve({ leadId: 'lead-other' });

      expect(out).toBeNull();
    });

    it('caches: repeated lookups for the same leadId hit DB once', async () => {
      const tracker = { calls: 0 };
      const r = new SseBusinessIdResolver(
        buildPrisma({
          leadsByPair: { 'lead-1': { businessId: 'biz-A' } },
          trackCalls: tracker,
        }),
        USER_ID,
      );

      const a = await r.resolve({ leadId: 'lead-1' });
      const b = await r.resolve({ leadId: 'lead-1' });
      const c = await r.resolve({ leadId: 'lead-1' });

      expect(a).toBe('biz-A');
      expect(b).toBe('biz-A');
      expect(c).toBe('biz-A');
      expect(tracker.calls).toBe(1);
    });

    it('caches null results too — unknown lead does not re-query', async () => {
      const tracker = { calls: 0 };
      const r = new SseBusinessIdResolver(
        buildPrisma({ trackCalls: tracker }),
        USER_ID,
      );

      const a = await r.resolve({ leadId: 'unknown' });
      const b = await r.resolve({ leadId: 'unknown' });

      expect(a).toBeNull();
      expect(b).toBeNull();
      expect(tracker.calls).toBe(1);
    });
  });

  describe('payloads with no resolvable identity → null', () => {
    it('sms.status-shape payload (only messageId/logId) → null', async () => {
      const r = new SseBusinessIdResolver(buildPrisma(), USER_ID);

      const out = await r.resolve({
        messageId: 'msg-1',
        logId: 'log-1',
        status: 'delivered',
      });

      expect(out).toBeNull();
    });

    it('null payload → null', async () => {
      const r = new SseBusinessIdResolver(buildPrisma(), USER_ID);
      expect(await r.resolve(null)).toBeNull();
      expect(await r.resolve(undefined)).toBeNull();
      expect(await r.resolve('not an object' as any)).toBeNull();
    });

    it('payload with bare `id` but no businessId/userId markers → null (does not assume it is a leadId)', async () => {
      // A future event might carry a different `id` shape. We refuse to guess.
      const r = new SseBusinessIdResolver(buildPrisma(), USER_ID);

      const out = await r.resolve({ id: 'something', random: 'shape' });

      expect(out).toBeNull();
    });
  });
});

describe('passesAccountFilter', () => {
  const ACCOUNT_A: SseAccountScope = { kind: 'account', businessId: 'biz-A' };
  const ALL: SseAccountScope = { kind: 'all' };

  it("scope=all always passes, even when resolution failed", () => {
    expect(passesAccountFilter(ALL, 'biz-A')).toBe(true);
    expect(passesAccountFilter(ALL, 'biz-Z')).toBe(true);
    expect(passesAccountFilter(ALL, null)).toBe(true);
  });

  it('account scope: matching businessId passes', () => {
    expect(passesAccountFilter(ACCOUNT_A, 'biz-A')).toBe(true);
  });

  it('account scope: non-matching businessId is dropped', () => {
    expect(passesAccountFilter(ACCOUNT_A, 'biz-B')).toBe(false);
    expect(passesAccountFilter(ACCOUNT_A, '')).toBe(false);
  });

  it('account scope: unresolved (null) is dropped', () => {
    // The "if lookup fails, do not emit" rule.
    expect(passesAccountFilter(ACCOUNT_A, null)).toBe(false);
  });
});
