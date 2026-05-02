/**
 * Pipeline Health checks (Phase 2).
 *
 * Covers the spec scenarios:
 *   1. sf_inbound_events.processingError → captureError fires
 *   2. crm_webhook_deliveries.lastStatusCode>=500 → captureError fires
 *   3. crm_webhook_deliveries.state='failed' → captureError fires
 *   4. No active subscription → no stale-traffic alert
 *   5. Active subscription with old lastEventAt → stale alert
 *
 * Health: zero rows everywhere → no captureError calls.
 */

import { MonitoringService } from './monitoring.service';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type InboundEventFixture = {
  sfSubscriptionId?: string | null;
  userId?: string | null;
  receivedAt: Date;
  processingError?: string | null;
};

function buildPrismaMock(state: {
  inboundErrors?: any[];
  failedDeliveries?: any[];
  fivexxDeliveries?: any[];
  subscriptions?: any[];
  inboundLast?: Record<string, Date>; // subscriptionId → last receivedAt
  inboundEvents?: InboundEventFixture[]; // backing rows for the health-gate query
  outboundLastSent?: Record<string, Date | null>; // subscriptionId → last deliveredAt
} = {}) {
  const events: InboundEventFixture[] = state.inboundEvents ?? [];
  return {
    sfInboundEvent: {
      findMany: jest.fn().mockResolvedValue(state.inboundErrors ?? []),
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        // Health-gate query shape: OR + receivedAt.gte + processingError filter.
        if (Array.isArray(w.OR)) {
          const subId = w.OR[0]?.sfSubscriptionId;
          const userId = w.OR[1]?.userId;
          const sinceTs = w.receivedAt?.gte instanceof Date ? w.receivedAt.gte.getTime() : 0;
          const wantNullErr = w.processingError === null;
          const match = events.find(e => {
            if (subId && e.sfSubscriptionId !== subId && (!userId || e.userId !== userId)) return false;
            if (sinceTs && e.receivedAt.getTime() < sinceTs) return false;
            if (wantNullErr && e.processingError != null) return false;
            return true;
          });
          return match ? { receivedAt: match.receivedAt } : null;
        }
        // Legacy "last received" lookup keyed solely on subscriptionId.
        const subId = w.sfSubscriptionId;
        if (!subId) return null;
        const ts = state.inboundLast?.[subId];
        return ts ? { receivedAt: ts } : null;
      }),
    },
    crmWebhookDelivery: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        if (where.state === 'failed') return state.failedDeliveries ?? [];
        if (where.lastStatusCode?.gte === 500) return state.fivexxDeliveries ?? [];
        return [];
      }),
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        const subId = args?.where?.subscriptionId;
        if (!subId) return null;
        const ts = state.outboundLastSent?.[subId] ?? null;
        return ts ? { deliveredAt: ts } : null;
      }),
    },
    crmWebhookSubscription: {
      findMany: jest.fn().mockImplementation(async (args: any) => {
        const where = args?.where ?? {};
        const subs = state.subscriptions ?? [];
        if (where.id?.in) {
          return subs.filter((s: any) => where.id.in.includes(s.id));
        }
        if (where.isActive === true) {
          return subs.filter((s: any) => s.isActive !== false);
        }
        return subs;
      }),
    },
    systemErrorLog: {
      findFirst: jest.fn().mockResolvedValue(null), // no dedup hits — every captureError creates a new row
      create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'err-' + Math.random(), ...data })),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
}

function buildConfig() {
  return { get: jest.fn().mockReturnValue('') } as any;
}

function buildSvc(prisma: any): MonitoringService {
  // The service has many other dependencies but runPipelineHealthChecks only
  // touches prisma. We avoid the cron path entirely here.
  const svc = new MonitoringService(prisma, buildConfig());
  return svc;
}

describe('MonitoringService.runPipelineHealthChecks', () => {
  describe('processingError → alert', () => {
    it('creates a SystemErrorLog row when sf_inbound_events.processingError exists in last 1h', async () => {
      const prisma = buildPrismaMock({
        inboundErrors: [
          { userId: 'user-A', processingError: 'unmapped_status:foo', eventId: 'evt-1' },
          { userId: 'user-A', processingError: 'signature_mismatch', eventId: 'evt-2' },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.inboundErrors).toBe(2);
      expect(prisma.systemErrorLog.create).toHaveBeenCalledTimes(1);
      const call = prisma.systemErrorLog.create.mock.calls[0][0].data;
      expect(call.category).toBe('webhook');
      expect(call.code).toBe('sf_inbound_processing_error');
      expect(call.userId).toBe('user-A');
      expect(call.severity).toBe('error');
      expect(call.message).toMatch(/2 SF inbound processing error/);
    });

    it('groups errors by userId and emits one alert per user', async () => {
      const prisma = buildPrismaMock({
        inboundErrors: [
          { userId: 'user-A', processingError: 'x', eventId: 'evt-1' },
          { userId: 'user-B', processingError: 'y', eventId: 'evt-2' },
          { userId: 'user-A', processingError: 'z', eventId: 'evt-3' },
        ],
      });
      const svc = buildSvc(prisma);

      await svc.runPipelineHealthChecks();

      expect(prisma.systemErrorLog.create).toHaveBeenCalledTimes(2);
      const userIds = prisma.systemErrorLog.create.mock.calls.map((c: any) => c[0].data.userId);
      expect(userIds.sort()).toEqual(['user-A', 'user-B']);
    });
  });

  describe('CRM 5xx → alert', () => {
    it('creates SystemErrorLog when lastStatusCode>=500 deliveries exist', async () => {
      const prisma = buildPrismaMock({
        fivexxDeliveries: [
          { subscriptionId: 'sub-1', lastStatusCode: 502, eventId: 'evt-1' },
          { subscriptionId: 'sub-1', lastStatusCode: 503, eventId: 'evt-2' },
        ],
        subscriptions: [{ id: 'sub-1', userId: 'user-A', name: 'SF Webhook', direction: 'outbound', isActive: true }],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.crm5xx).toBe(2);
      const call = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'crm_outbound_5xx',
      );
      expect(call).toBeDefined();
      expect(call[0].data.userId).toBe('user-A');
      expect(call[0].data.message).toMatch(/SF Webhook/);
      expect(call[0].data.message).toMatch(/2 occurrence/);
    });
  });

  describe('failed delivery → alert', () => {
    it('creates SystemErrorLog when state=failed deliveries exist', async () => {
      const prisma = buildPrismaMock({
        failedDeliveries: [
          { subscriptionId: 'sub-1', lastError: 'ECONNREFUSED', eventId: 'evt-1' },
        ],
        subscriptions: [{ id: 'sub-1', userId: 'user-A', name: 'SF Webhook', direction: 'outbound', isActive: true }],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.outboundFailures).toBe(1);
      const call = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'crm_outbound_failed',
      );
      expect(call).toBeDefined();
      expect(call[0].data.userId).toBe('user-A');
      expect(call[0].data.message).toMatch(/ECONNREFUSED/);
    });
  });

  describe('stale traffic gating', () => {
    it('does NOT alert when there is no active subscription', async () => {
      const prisma = buildPrismaMock({ subscriptions: [] });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
      const staleCalls = prisma.systemErrorLog.create.mock.calls.filter(
        (c: any) => c[0].data.code === 'sf_inbound_stalled' || c[0].data.code === 'crm_outbound_stalled',
      );
      expect(staleCalls).toHaveLength(0);
    });

    it('does NOT alert on a fresh inbound subscription with no prior traffic', async () => {
      const prisma = buildPrismaMock({
        subscriptions: [
          { id: 'sub-1', userId: 'user-A', name: 'SF', direction: 'inbound', isActive: true, lastEventAt: null },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
    });

    it('alerts when an active inbound subscription with prior traffic has not seen events in >72h', async () => {
      const longAgo = new Date(Date.now() - 4 * DAY_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: longAgo,
          },
        ],
        inboundLast: { 'sub-1': longAgo },
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(1);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'sf_inbound_stalled',
      );
      expect(stale).toBeDefined();
      expect(stale[0].data.userId).toBe('user-A');
      expect(stale[0].data.severity).toBe('warning');
      expect(stale[0].data.message).toMatch(/SF Inbound/);
      expect(stale[0].data.message).toMatch(/>72h/);
    });

    it('does NOT alert when last lastEventAt is between 24h and 72h (inside extended threshold)', async () => {
      const fortyEightHoursAgo = new Date(Date.now() - 48 * HOUR_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: fortyEightHoursAgo,
          },
        ],
        inboundLast: { 'sub-1': fortyEightHoursAgo },
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
    });

    it('does NOT alert when a recent accepted noop event exists (processingError=NULL)', async () => {
      const longAgoLastEvent = new Date(Date.now() - 4 * DAY_MS);
      const recent = new Date(Date.now() - 2 * HOUR_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: longAgoLastEvent,
          },
        ],
        inboundLast: { 'sub-1': longAgoLastEvent },
        // Noop result — handler ran cleanly, no processingError.
        inboundEvents: [
          { sfSubscriptionId: 'sub-1', userId: 'user-A', receivedAt: recent, processingError: null },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'sf_inbound_stalled',
      );
      expect(stale).toBeUndefined();
      // And it auto-resolves any stuck row from a prior stall.
      expect(prisma.systemErrorLog.updateMany).toHaveBeenCalledWith({
        where: { userId: 'user-A', code: 'sf_inbound_stalled', resolved: false },
        data: { resolved: true },
      });
    });

    it('does NOT alert when a recent applied event exists (processingError=NULL)', async () => {
      const longAgoLastEvent = new Date(Date.now() - 5 * DAY_MS);
      const recent = new Date(Date.now() - 30 * 60 * 1000);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: longAgoLastEvent,
          },
        ],
        inboundLast: { 'sub-1': longAgoLastEvent },
        inboundEvents: [
          // applied = real status change written by handler; processingError still null.
          { sfSubscriptionId: 'sub-1', userId: 'user-A', receivedAt: recent, processingError: null },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
    });

    it('STILL alerts when only old events exist and none in the last 24h', async () => {
      const fourDaysAgo = new Date(Date.now() - 4 * DAY_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: fourDaysAgo,
          },
        ],
        inboundLast: { 'sub-1': fourDaysAgo },
        inboundEvents: [
          // Only an old healthy event — outside the 24h health window.
          { sfSubscriptionId: 'sub-1', userId: 'user-A', receivedAt: fourDaysAgo, processingError: null },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(1);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'sf_inbound_stalled',
      );
      expect(stale).toBeDefined();
      expect(stale[0].data.userId).toBe('user-A');
    });

    it('STILL alerts when the only recent event has processingError set (failure does not count as healthy)', async () => {
      const fourDaysAgo = new Date(Date.now() - 4 * DAY_MS);
      const recentBroken = new Date(Date.now() - 30 * 60 * 1000);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: fourDaysAgo,
          },
        ],
        inboundLast: { 'sub-1': fourDaysAgo },
        inboundEvents: [
          // Recent but failed — handler choked, processingError populated.
          { sfSubscriptionId: 'sub-1', userId: 'user-A', receivedAt: recentBroken, processingError: 'unmapped_status:foo' },
        ],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(1);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'sf_inbound_stalled',
      );
      expect(stale).toBeDefined();
    });

    it('STILL warns when there are zero inbound events but lastEventAt is older than 72h (active subscription with prior history)', async () => {
      const longAgo = new Date(Date.now() - 5 * DAY_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: longAgo,
          },
        ],
        // Note: legacy lookup keyed on subscriptionId still returns longAgo,
        // but inboundEvents (the health gate) is empty.
        inboundLast: { 'sub-1': longAgo },
        inboundEvents: [],
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(1);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'sf_inbound_stalled',
      );
      expect(stale).toBeDefined();
      expect(stale[0].data.severity).toBe('warning');
    });

    it('alerts when an active outbound subscription with prior traffic has not delivered in >24h', async () => {
      const longAgo = new Date(Date.now() - 2 * DAY_MS);
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'CRM Outbound',
            direction: 'outbound', isActive: true, lastEventAt: longAgo,
          },
        ],
        outboundLastSent: { 'sub-1': longAgo },
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(1);
      const stale = prisma.systemErrorLog.create.mock.calls.find(
        (c: any) => c[0].data.code === 'crm_outbound_stalled',
      );
      expect(stale).toBeDefined();
      expect(stale[0].data.userId).toBe('user-A');
    });

    it('does NOT alert when last event is recent (<24h)', async () => {
      const recent = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      const prisma = buildPrismaMock({
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF Inbound',
            direction: 'inbound', isActive: true, lastEventAt: recent,
          },
        ],
        inboundLast: { 'sub-1': recent },
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result.staleSubscriptions).toBe(0);
    });
  });

  describe('dedup (no accountId, userId+code path)', () => {
    it('updates the existing unresolved row instead of creating a new one on a second run', async () => {
      // Track rows in a tiny in-memory store so findFirst matches what create() emits.
      const rows: any[] = [];
      const prisma = buildPrismaMock({
        inboundErrors: [{ userId: 'user-A', processingError: 'oops', eventId: 'evt-1' }],
      });
      prisma.systemErrorLog.findFirst = jest.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return rows.find(r =>
          r.category === w.category &&
          r.userId === w.userId &&
          r.code === w.code &&
          r.accountId == null &&
          r.resolved === false,
        ) ?? null;
      });
      prisma.systemErrorLog.create = jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { id: 'err-' + rows.length, resolved: false, ...data };
        rows.push(row);
        return row;
      });
      prisma.systemErrorLog.update = jest.fn().mockImplementation(async (args: any) => {
        const r = rows.find(x => x.id === args.where.id);
        if (r) Object.assign(r, args.data);
        return r;
      });
      const svc = buildSvc(prisma);

      await svc.runPipelineHealthChecks();
      await svc.runPipelineHealthChecks();

      // After two cron runs with the same condition, only one row exists.
      expect(rows).toHaveLength(1);
      expect(prisma.systemErrorLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.systemErrorLog.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('healthy state', () => {
    it('produces zero captureError calls when everything is fine', async () => {
      const prisma = buildPrismaMock({
        inboundErrors: [],
        failedDeliveries: [],
        fivexxDeliveries: [],
        subscriptions: [
          {
            id: 'sub-1', userId: 'user-A', name: 'SF',
            direction: 'inbound', isActive: true,
            lastEventAt: new Date(Date.now() - 5 * 60 * 1000),
          },
        ],
        inboundLast: { 'sub-1': new Date(Date.now() - 5 * 60 * 1000) },
      });
      const svc = buildSvc(prisma);

      const result = await svc.runPipelineHealthChecks();

      expect(result).toEqual({
        inboundErrors: 0,
        outboundFailures: 0,
        crm5xx: 0,
        staleSubscriptions: 0,
      });
      expect(prisma.systemErrorLog.create).not.toHaveBeenCalled();
    });
  });
});
