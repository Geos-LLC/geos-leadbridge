import { ConfigService } from '@nestjs/config';
import { ConversationRuntimeController } from './conversation-runtime.controller';
import { OrchestrationFeatureFlag } from '../sf-orchestration/orchestration-feature-flag';
import { OrchestrationMetricsService } from '../sf-orchestration/orchestration-metrics.service';
import type { SfConnectionResolver, ResolvedSfCredentials } from '../sf-orchestration/sf-connection-resolver.service';

const USER_A = { id: 'user-A' };
const USER_B = { id: 'user-B' };

/**
 * PR-C1: Flag now consults SfConnectionResolver async. The controller's
 * summary endpoint awaits flag.isEnabledForUser, so the test deps need
 * a resolver stub. Default stub: env-CSV-only (matches the PR-B1 spec
 * baseline behavior — userId in CSV → enabled).
 */
function buildOrchestrationDeps(envCsv = ''): {
  flag: OrchestrationFeatureFlag;
  metrics: OrchestrationMetricsService;
} {
  const config = {
    get: ((key: string, def?: any) => {
      if (key === 'BOOKING_ORCHESTRATION_ENABLED_USER_IDS') return envCsv ?? def;
      return def;
    }) as any,
  } as ConfigService;
  const enabledUserIds = envCsv.split(',').map((s) => s.trim()).filter(Boolean);
  const resolver: Partial<SfConnectionResolver> = {
    isEnabledForUser: jest.fn(async (uid: string | null | undefined) =>
      !!uid && enabledUserIds.includes(uid),
    ),
    resolveForUser: jest.fn(
      async (uid: string | null | undefined): Promise<ResolvedSfCredentials> =>
        !!uid && enabledUserIds.includes(uid)
          ? { enabled: true, source: 'env_canary', baseUrl: 'x', orchestrationToken: 'y' }
          : { enabled: false, source: 'none' },
    ),
  };
  return {
    flag: new OrchestrationFeatureFlag(config, resolver as SfConnectionResolver),
    metrics: new OrchestrationMetricsService(),
  };
}

/** Convenience: build controller with stub orchestration deps. */
function buildController(prisma: any, envCsv = ''): ConversationRuntimeController {
  const deps = buildOrchestrationDeps(envCsv);
  return new ConversationRuntimeController(prisma, deps.flag, deps.metrics);
}

/**
 * Lightweight Prisma fake. Records every where clause we received so we
 * can assert tenant scoping. count() / findMany() / groupBy() return
 * pre-canned data that the per-test bodies set up.
 */
function buildPrismaMock() {
  const state: any = {
    threadContextCalls: [] as Array<{ method: string; args: any }>,
    leadCalls: [] as Array<{ method: string; args: any }>,
    countReturns: { threadContext: 0, lead: 0, sfInboundEvent: 0 },
    sfInboundEventCalls: [] as Array<{ method: string; args: any }>,
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
    sfInboundEvent: {
      count: jest.fn(async (args: any) => {
        state.sfInboundEventCalls.push({ method: 'count', args });
        return state.countReturns.sfInboundEvent;
      }),
    },
  };
  return mock;
}

describe('ConversationRuntimeController', () => {
  describe('GET /v1/conversation-runtime/summary', () => {
    it('scopes every query to the calling user', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);
      const result = await ctrl.summary(USER_A);

      expect(result.tenantUserId).toBe(USER_A.id);
      expect(result.totals.threadContexts).toBe(0);
      expect(result.byConversationState._null).toBe(0);
      expect(result.byAiStatus._null).toBe(0);
      expect(result.byBookingState._null).toBe(0);
      expect(result.byLastClassifiedIntent).toEqual({});
      expect(result.sfJobOutcomeCounts).toEqual({});
      expect(result.sfOutcomeCoverage.ratio).toBeNull();
      expect(result.handoffOpen).toBe(0);
      expect(result.staleWaiting).toBe(0);
      expect(result.updatedLast24h.conversationState).toBe(0);
    });

    it('returns byBookingState with one entry per Phase 2A vocabulary state plus _null', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
      const result = await ctrl.summary(USER_A);

      // Lock the expected keys. Add/remove only via a deliberate vocab
      // change in src/conversation-context/booking-runtime.ts.
      const expectedStates = [
        'idle',
        'gathering_preferences',
        'awaiting_availability',
        'offering_slots',
        'awaiting_slot_selection',
        'booking_requested',
        'service_scheduled',
        'service_rescheduled',
        'service_cancelled',
        'service_completed',
        'booking_failed',
      ];
      for (const s of expectedStates) {
        expect(result.byBookingState).toHaveProperty(s);
        expect(typeof (result.byBookingState as any)[s]).toBe('number');
      }
      expect(result.byBookingState).toHaveProperty('_null');
    });

    it('scopes every bookingState count query to the calling user', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
      await ctrl.summary(USER_A);

      const bookingCountCalls = prisma._state.threadContextCalls.filter(
        (c: any) =>
          c.method === 'count' &&
          c.args?.where &&
          // Either a known state OR the explicit null filter
          ('bookingState' in c.args.where),
      );
      expect(bookingCountCalls.length).toBeGreaterThan(0);
      for (const c of bookingCountCalls) {
        expect(c.args.where.lead?.userId).toBe(USER_A.id);
      }
    });

    it('Phase 2B PR-B1: returns orchestrationFlag block — false on fresh deploy', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma /* envCsv = '' */);
      const result = await ctrl.summary(USER_A);
      expect(result.orchestrationFlag).toEqual({
        flagEnabledForTenant: false,
        enabledTenantCount: 0,
      });
    });

    it('Phase 2B PR-B1: flag flips to true when tenant is in CSV', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma, 'user-A,user-B');
      const result = await ctrl.summary(USER_A);
      expect(result.orchestrationFlag.flagEnabledForTenant).toBe(true);
      expect(result.orchestrationFlag.enabledTenantCount).toBe(2);
    });

    it('Phase 2B PR-B1: orchestrationMetrics is an all-zero snapshot for a fresh tenant', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
      const result = await ctrl.summary(USER_A);
      const m = result.orchestrationMetrics;
      for (const ep of ['availability', 'booking_request', 'booking_cancel', 'handoff'] as const) {
        expect(m.attempts[ep]).toBe(0);
        expect(m.successes[ep]).toBe(0);
        expect(m.failures[ep]).toBe(0);
        expect(m.retries[ep]).toBe(0);
        expect(m.lastLatencyMs[ep]).toBeNull();
      }
      for (const code of [
        'slot_taken',
        'slot_token_expired',
        'validation_failed',
        'orchestration_disabled',
        'not_found',
        'timeout',
        'network_error',
        'server_error',
        'unknown',
      ] as const) {
        expect(m.failuresByCode[code]).toBe(0);
      }
    });

    it('Phase 2B PR-B2: returns serviceEventCounts with all 4 service_* keys at zero on fresh tenant', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
      const result = await ctrl.summary(USER_A);
      expect(result.serviceEventCounts).toEqual({
        service_scheduled: 0,
        service_rescheduled: 0,
        service_cancelled: 0,
        service_completed: 0,
      });
    });

    it('Phase 2B PR-B2: serviceEventCounts queries scope to the calling user', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
      await ctrl.summary(USER_A);
      const sfCalls = prisma._state.sfInboundEventCalls;
      expect(sfCalls.length).toBe(4); // one per event type
      for (const c of sfCalls) {
        expect(c.args.where.userId).toBe(USER_A.id);
        // Only the 4 service_* event types — no fishing for other event_types
        expect([
          'service_scheduled',
          'service_rescheduled',
          'service_cancelled',
          'service_completed',
        ]).toContain(c.args.where.eventType);
      }
    });

    it('Phase 2B PR-B1: orchestrationMetrics is tenant-scoped', async () => {
      // Two controllers with independent metrics services; writes for
      // tenant A must not appear in tenant B's snapshot.
      const prisma = buildPrismaMock();
      const depsA = buildOrchestrationDeps('user-A');
      const ctrlA = new ConversationRuntimeController(prisma, depsA.flag, depsA.metrics);
      depsA.metrics.recordSuccess('user-A', 'availability', 99);
      depsA.metrics.recordFailure('user-A', 'booking_request', 'slot_taken', 11);
      const resA = await ctrlA.summary(USER_A);
      const resB = await ctrlA.summary(USER_B);

      expect(resA.orchestrationMetrics.successes.availability).toBe(1);
      expect(resA.orchestrationMetrics.failures.booking_request).toBe(1);
      expect(resB.orchestrationMetrics.successes.availability).toBe(0);
      expect(resB.orchestrationMetrics.failures.booking_request).toBe(0);
    });

    it('aggregates byLastClassifiedIntent from groupBy rows', async () => {
      const prisma = buildPrismaMock();
      prisma._state.groupByReturns.threadContext = [
        { lastClassifiedIntent: 'agreed', _count: { _all: 7 } },
        { lastClassifiedIntent: 'wants_live_contact', _count: { _all: 3 } },
        { lastClassifiedIntent: 'engaged', _count: { _all: 42 } },
      ];
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);
      const result = await ctrl.summary(USER_A);
      expect(result.sfOutcomeCoverage.populated).toBe(50);
      expect(result.sfOutcomeCoverage.sfLinkedTotal).toBe(50);
      expect(result.sfOutcomeCoverage.ratio).toBe(1);
    });

    it('does NOT mutate state (count + findMany + groupBy only)', async () => {
      const prisma = buildPrismaMock();
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);

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
      const ctrl = buildController(prisma);
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
      const ctrl = buildController(prisma);
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
