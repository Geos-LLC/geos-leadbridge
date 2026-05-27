import { ConversationRuntimeController } from './conversation-runtime.controller';

const USER_A = { id: 'user-A' };
const USER_B = { id: 'user-B' };

/**
 * Lightweight Prisma fake. Records every where clause we received so we
 * can assert tenant scoping. count() / findMany() / groupBy() return
 * pre-canned data that the per-test bodies set up.
 */
function buildPrismaMock() {
  const state: any = {
    threadContextCalls: [] as Array<{ method: string; args: any }>,
    leadCalls: [] as Array<{ method: string; args: any }>,
    countReturns: { threadContext: 0, lead: 0 },
    findManyReturns: { threadContext: [] as any[], lead: [] as any[] },
    groupByReturns: { threadContext: [] as any[], lead: [] as any[] },
  };
  const mock: any = {
    _state: state,
    threadContext: {
      count: jest.fn(async (args: any) => {
        state.threadContextCalls.push({ method: 'count', args });
        return state.countReturns.threadContext;
      }),
      findMany: jest.fn(async (args: any) => {
        state.threadContextCalls.push({ method: 'findMany', args });
        return state.findManyReturns.threadContext;
      }),
      groupBy: jest.fn(async (args: any) => {
        state.threadContextCalls.push({ method: 'groupBy', args });
        return state.groupByReturns.threadContext;
      }),
    },
    lead: {
      count: jest.fn(async (args: any) => {
        state.leadCalls.push({ method: 'count', args });
        return state.countReturns.lead;
      }),
      findMany: jest.fn(async (args: any) => {
        state.leadCalls.push({ method: 'findMany', args });
        return state.findManyReturns.lead;
      }),
      groupBy: jest.fn(async (args: any) => {
        state.leadCalls.push({ method: 'groupBy', args });
        return state.groupByReturns.lead;
      }),
    },
  };
  return mock;
}

describe('ConversationRuntimeController', () => {
  describe('GET /v1/conversation-runtime/summary', () => {
    it('scopes every query to the calling user', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      await ctrl.summary(USER_A);

      // Every threadContext query must filter on lead.userId
      for (const c of prisma._state.threadContextCalls) {
        const where = c.args?.where ?? {};
        // Either lead: { userId: USER_A.id, ... } OR an explicit lead.userId
        const userScoped =
          where.lead?.userId === USER_A.id ||
          (typeof where.lead === 'object' && 'userId' in (where.lead ?? {}));
        expect(userScoped).toBe(true);
      }
      // Every lead query filters on userId
      for (const c of prisma._state.leadCalls) {
        const where = c.args?.where ?? {};
        expect(where.userId).toBe(USER_A.id);
      }
    });

    it('returns null-safe structure when the tenant has no data', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      const result = await ctrl.summary(USER_A);

      expect(result.tenantUserId).toBe(USER_A.id);
      expect(result.totals.threadContexts).toBe(0);
      expect(result.byConversationState._null).toBe(0);
      expect(result.byAiStatus._null).toBe(0);
      expect(result.byLastClassifiedIntent).toEqual({});
      expect(result.sfJobOutcomeCounts).toEqual({});
      expect(result.sfOutcomeCoverage.ratio).toBeNull();
      expect(result.handoffOpen).toBe(0);
      expect(result.staleWaiting).toBe(0);
      expect(result.updatedLast24h.conversationState).toBe(0);
    });

    it('aggregates byLastClassifiedIntent from groupBy rows', async () => {
      const prisma = buildPrismaMock();
      prisma._state.groupByReturns.threadContext = [
        { lastClassifiedIntent: 'agreed', _count: { _all: 7 } },
        { lastClassifiedIntent: 'wants_live_contact', _count: { _all: 3 } },
        { lastClassifiedIntent: 'engaged', _count: { _all: 42 } },
      ];
      const ctrl = new ConversationRuntimeController(prisma);
      const result = await ctrl.summary(USER_A);
      expect(result.byLastClassifiedIntent).toEqual({
        agreed: 7,
        wants_live_contact: 3,
        engaged: 42,
      });
    });

    it('computes sfOutcomeCoverage.ratio when sfLinkedTotal > 0', async () => {
      const prisma = buildPrismaMock();
      // The summary calls lead.count many times in a row — they all return
      // the same value from this fake. We just need ratio = populated/total.
      prisma._state.countReturns.lead = 50;
      const ctrl = new ConversationRuntimeController(prisma);
      const result = await ctrl.summary(USER_A);
      expect(result.sfOutcomeCoverage.populated).toBe(50);
      expect(result.sfOutcomeCoverage.sfLinkedTotal).toBe(50);
      expect(result.sfOutcomeCoverage.ratio).toBe(1);
    });

    it('does NOT mutate state (count + findMany + groupBy only)', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      await ctrl.summary(USER_A);
      // Assert no write-shaped methods exist on the mock
      expect(prisma.threadContext.update).toBeUndefined();
      expect(prisma.threadContext.updateMany).toBeUndefined();
      expect(prisma.threadContext.create).toBeUndefined();
      expect(prisma.threadContext.delete).toBeUndefined();
      expect(prisma.lead.update).toBeUndefined();
      expect(prisma.lead.updateMany).toBeUndefined();
      // Calls that were made are all read-only
      const allMethods = [
        ...prisma._state.threadContextCalls.map((c: any) => c.method),
        ...prisma._state.leadCalls.map((c: any) => c.method),
      ];
      const readOnly = ['count', 'findMany', 'groupBy', 'findFirst', 'findUnique'];
      for (const m of allMethods) expect(readOnly).toContain(m);
    });
  });

  describe('GET /v1/conversation-runtime/legacy-comparison', () => {
    it('scopes every category query to the calling user', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      await ctrl.legacyComparison(USER_B);
      // Tenant-scoping check across both threadContext and lead queries
      for (const c of prisma._state.threadContextCalls) {
        const where = c.args?.where ?? {};
        const lead = where.lead ?? {};
        expect(lead.userId).toBe(USER_B.id);
      }
      for (const c of prisma._state.leadCalls) {
        const where = c.args?.where ?? {};
        expect(where.userId).toBe(USER_B.id);
      }
    });

    it('returns all 7 categories with count + examples shape', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      const result = await ctrl.legacyComparison(USER_A);
      const expectedCats = [
        'legacy_status_terminal_but_runtime_active',
        'runtime_terminal_but_legacy_active',
        'sf_outcome_present_but_lead_status_not_sf_owned',
        'ai_disabled_but_runtime_active',
        'waiting_customer_without_waitingSince',
        'handoff_requested_without_resolution',
        'classifier_intent_missing_recent_inbound',
      ];
      for (const k of expectedCats) {
        expect(result.categories).toHaveProperty(k);
        const cat = (result.categories as any)[k];
        expect(typeof cat.description).toBe('string');
        expect(typeof cat.count).toBe('number');
        expect(Array.isArray(cat.examples)).toBe(true);
      }
    });

    it('clamps examplesPerCategory to [1, 20]', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);

      const r1 = await ctrl.legacyComparison(USER_A, '0');
      expect(r1.examplesPerCategory).toBe(1);

      const r2 = await ctrl.legacyComparison(USER_A, '500');
      expect(r2.examplesPerCategory).toBe(20);

      const r3 = await ctrl.legacyComparison(USER_A, '5');
      expect(r3.examplesPerCategory).toBe(5);

      const r4 = await ctrl.legacyComparison(USER_A, 'not_a_number');
      // NaN → falls back to default 5
      expect(r4.examplesPerCategory).toBe(5);
    });

    it('examples never expose customer message bodies / phone / email', async () => {
      const prisma = buildPrismaMock();
      // Seed an example as if it came back from the DB
      prisma._state.findManyReturns.threadContext = [
        {
          leadId: 'lead-X',
          lead: { id: 'lead-X', status: 'engaged', platform: 'yelp' },
          conversationState: 'opted_out',
          conversationStateReason: 'classifier_opt_out',
          aiStatus: 'stopped_terminal',
          aiStatusReason: 'classifier_opt_out',
          waitingSince: null,
          handoffRequestedAt: null,
          handoffResolvedAt: null,
          lastCustomerMessageAt: new Date(),
          lastClassifiedAt: new Date(),
          updatedAt: new Date(),
        },
      ];
      const ctrl = new ConversationRuntimeController(prisma);
      const result = await ctrl.legacyComparison(USER_A);
      // Inspect first category's first example
      const ex = (Object.values(result.categories) as any[])[0].examples[0];
      if (ex) {
        // Negative assertions — these must NOT be present
        expect(ex).not.toHaveProperty('customerPhone');
        expect(ex).not.toHaveProperty('customerEmail');
        expect(ex).not.toHaveProperty('customerName');
        expect(ex).not.toHaveProperty('content');
        expect(ex).not.toHaveProperty('message');
        expect(ex).not.toHaveProperty('summary');
      }
    });

    it('does NOT mutate state', async () => {
      const prisma = buildPrismaMock();
      const ctrl = new ConversationRuntimeController(prisma);
      await ctrl.legacyComparison(USER_A);
      const allMethods = [
        ...prisma._state.threadContextCalls.map((c: any) => c.method),
        ...prisma._state.leadCalls.map((c: any) => c.method),
      ];
      const readOnly = ['count', 'findMany', 'groupBy', 'findFirst', 'findUnique'];
      for (const m of allMethods) expect(readOnly).toContain(m);
    });
  });
});
