/**
 * YelpBackfillService — dry-run only.
 *
 * Pins the contract that the dry-run report matches what the live writer
 * (handleYelpNewEventInner with FEATURE_YELP_WEBHOOK_PERSIST_FULL_THREAD=true)
 * would do — same filter, same projection, same diff math. No DB writes.
 *
 * Bypasses the constructor with Object.create(prototype) so we can swap in
 * minimal stubs without standing up the full DI graph.
 */

import { YelpBackfillService } from './yelp-backfill.service';
import { Logger, BadRequestException } from '@nestjs/common';

function buildService(overrides: {
  prisma?: any;
  yelpAdapter?: any;
  decryptObject?: jest.Mock;
} = {}) {
  const svc: any = Object.create(YelpBackfillService.prototype);
  svc.logger = new Logger('YelpBackfillTest');
  svc.prisma = overrides.prisma ?? {
    lead: { findMany: jest.fn().mockResolvedValue([]) },
    savedAccount: { findFirst: jest.fn().mockResolvedValue(null), updateMany: jest.fn().mockResolvedValue({}) },
    message: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const yelpAdapter = overrides.yelpAdapter ?? { getLeadEvents: jest.fn().mockResolvedValue([]) };
  svc.platformFactory = { getAdapter: jest.fn().mockReturnValue(yelpAdapter) };
  svc.configService = { get: jest.fn().mockReturnValue('test-encryption-key-32-chars-long.') };
  return { svc, yelpAdapter };
}

// Stub EncryptionUtil at the module level to avoid real crypto in tests.
jest.mock('../common/utils/encryption.util', () => ({
  EncryptionUtil: {
    decryptObject: jest.fn().mockReturnValue({ accessToken: 'tok-1', refreshToken: 'rfr-1' }),
    encryptObject: jest.fn().mockReturnValue('cipher'),
  },
}));

const baseLead = {
  id: 'lead-1',
  userId: 'user-1',
  platform: 'yelp',
  externalRequestId: 'yelp-req-1',
  businessId: 'biz-1',
  createdAt: new Date('2026-04-20T00:00:00Z'),
};

describe('YelpBackfillService.dryRun', () => {
  describe('guardrails', () => {
    it('throws 400 when dryRun=false', async () => {
      const { svc } = buildService();
      await expect(svc.dryRun({ dryRun: false })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('treats dryRun omitted as dry-run (no exception)', async () => {
      const { svc } = buildService();
      await expect(svc.dryRun({})).resolves.toBeDefined();
    });

    it('treats dryRun=true as dry-run (no exception)', async () => {
      const { svc } = buildService();
      await expect(svc.dryRun({ dryRun: true })).resolves.toBeDefined();
    });
  });

  describe('lead filtering', () => {
    it('returns empty result when no leads match', async () => {
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([]) },
        savedAccount: { findFirst: jest.fn() },
        message: { findMany: jest.fn() },
      };
      const { svc } = buildService({ prisma });
      const r = await svc.dryRun({ leadIds: ['nope'] });
      expect(r).toEqual({
        totalLeadsScanned: 0,
        totalEventsWouldPersist: 0,
        totalEventsAlreadyInDb: 0,
        results: [],
      });
    });

    it('caps limit at 50, defaults to 5', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = {
        lead: { findMany },
        savedAccount: { findFirst: jest.fn() },
        message: { findMany: jest.fn() },
      };
      const { svc } = buildService({ prisma });
      await svc.dryRun({});
      expect(findMany.mock.calls[0][0].take).toBe(5);

      await svc.dryRun({ limit: 1000 });
      expect(findMany.mock.calls[1][0].take).toBe(50);

      await svc.dryRun({ limit: 0 });
      expect(findMany.mock.calls[2][0].take).toBe(1); // floor at 1
    });

    it('scopes by userId / businessId / leadIds when provided', async () => {
      const findMany = jest.fn().mockResolvedValue([]);
      const prisma = {
        lead: { findMany },
        savedAccount: { findFirst: jest.fn() },
        message: { findMany: jest.fn() },
      };
      const { svc } = buildService({ prisma });

      await svc.dryRun({ leadIds: ['a', 'b'], userId: 'u-1', businessId: 'biz-1' });
      const where = findMany.mock.calls[0][0].where;
      expect(where.platform).toBe('yelp');
      expect(where.id).toEqual({ in: ['a', 'b'] });
      expect(where.userId).toBe('u-1');
      expect(where.businessId).toBe('biz-1');
    });
  });

  describe('event projection', () => {
    function buildLeadFixture(events: any[], existing: any[] = []) {
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: {
          findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }),
          updateMany: jest.fn(),
        },
        message: { findMany: jest.fn().mockResolvedValue(existing) },
      };
      const yelpAdapter = { getLeadEvents: jest.fn().mockResolvedValue(events) };
      return buildService({ prisma, yelpAdapter });
    }

    it('counts wouldPersist vs alreadyInDb correctly', async () => {
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'hi' }, time_created: '2026-04-20T10:00:00Z' },
        { id: 'e2', user_type: 'BIZ', event_type: 'TEXT', event_content: { text: 'reply' }, time_created: '2026-04-20T10:01:00Z' },
        { id: 'e3', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'follow' }, time_created: '2026-04-20T10:02:00Z' },
      ];
      const { svc } = buildLeadFixture(events, [{ externalMessageId: 'e2' }]);

      const r = await svc.dryRun({ leadIds: ['lead-1'] });

      expect(r.totalLeadsScanned).toBe(1);
      expect(r.results[0].eventsFromYelp).toBe(3);
      expect(r.results[0].displayableEvents).toBe(3);
      expect(r.results[0].wouldPersist).toBe(2); // e1, e3 are new
      expect(r.results[0].alreadyInDb).toBe(1); // e2 already in DB
    });

    it('skips RAQ_SUBMIT and CONSUMER_PHONE_NUMBER_OPT_*', async () => {
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'RAQ_SUBMIT', event_content: { text: 'should skip' } },
        { id: 'e2', user_type: 'CONSUMER', event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT' },
        { id: 'e3', user_type: 'CONSUMER', event_type: 'CONSUMER_PHONE_NUMBER_OPT_OUT_EVENT' },
        { id: 'e4', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'real msg' }, time_created: '2026-04-20T10:00:00Z' },
      ];
      const { svc } = buildLeadFixture(events);

      const r = await svc.dryRun({ leadIds: ['lead-1'] });

      expect(r.results[0].eventsFromYelp).toBe(4);
      expect(r.results[0].displayableEvents).toBe(1); // only e4
      expect(r.results[0].wouldPersist).toBe(1);
    });

    it('skips events with no id (cannot dedup without externalMessageId)', async () => {
      const events = [
        { user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'no id' } }, // skipped
        { id: 'e2', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'has id' }, time_created: '2026-04-20T10:00:00Z' },
      ];
      const { svc } = buildLeadFixture(events);

      const r = await svc.dryRun({ leadIds: ['lead-1'] });

      expect(r.results[0].displayableEvents).toBe(2); // both pass display filter
      expect(r.results[0].wouldPersist).toBe(1); // only the one with id
    });

    it('skips events with empty extracted content', async () => {
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: {}, time_created: '2026-04-20T10:00:00Z' },
      ];
      const { svc } = buildLeadFixture(events);

      const r = await svc.dryRun({ leadIds: ['lead-1'] });
      expect(r.results[0].wouldPersist).toBe(0);
    });
  });

  describe('sample shape', () => {
    function buildManyEvents(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        id: `e${i}`,
        user_type: i % 2 === 0 ? 'CONSUMER' : 'BIZ',
        event_type: 'TEXT',
        event_content: { text: `msg ${i}` },
        time_created: `2026-04-20T10:${String(i).padStart(2, '0')}:00Z`,
      }));
    }

    it('single-lead mode (leadIds.length === 1) returns ALL events in sample', async () => {
      const events = buildManyEvents(25);
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const { svc } = buildService({ prisma, yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue(events) } });

      const r = await svc.dryRun({ leadIds: ['lead-1'] });
      expect(r.results[0].sample).toHaveLength(25);
    });

    it('multi-lead mode caps sample at 10 per lead', async () => {
      const events = buildManyEvents(25);
      const leadA = { ...baseLead, id: 'lead-A' };
      const leadB = { ...baseLead, id: 'lead-B' };
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([leadA, leadB]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const { svc } = buildService({ prisma, yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue(events) } });

      const r = await svc.dryRun({}); // no leadIds → multi-lead mode by definition
      expect(r.results).toHaveLength(2);
      expect(r.results[0].sample).toHaveLength(10);
      expect(r.results[1].sample).toHaveLength(10);
    });

    it('truncates content to 200 chars + ellipsis marker', async () => {
      const longText = 'x'.repeat(500);
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: longText }, time_created: '2026-04-20T10:00:00Z' },
      ];
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };
      const { svc } = buildService({ prisma, yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue(events) } });

      const r = await svc.dryRun({ leadIds: ['lead-1'] });
      const sample = r.results[0].sample[0];
      expect(sample.content.length).toBe(200 + 3); // 200 + '...'
      expect(sample.content.endsWith('...')).toBe(true);
    });

    it('marks new vs existing correctly in sample', async () => {
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'a' }, time_created: '2026-04-20T10:00:00Z' },
        { id: 'e2', user_type: 'BIZ', event_type: 'TEXT', event_content: { text: 'b' }, time_created: '2026-04-20T10:01:00Z' },
      ];
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: { findMany: jest.fn().mockResolvedValue([{ externalMessageId: 'e2' }]) },
      };
      const { svc } = buildService({ prisma, yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue(events) } });

      const r = await svc.dryRun({ leadIds: ['lead-1'] });
      const byId = Object.fromEntries(r.results[0].sample.map((s: any) => [s.externalMessageId, s.newOrExisting]));
      expect(byId).toEqual({ e1: 'new', e2: 'existing' });
    });
  });

  describe('error isolation per lead', () => {
    it('a lead with no saved account becomes an error entry, others succeed', async () => {
      const leadOk = { ...baseLead, id: 'lead-ok' };
      const leadFail = { ...baseLead, id: 'lead-fail' };
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([leadOk, leadFail]) },
        savedAccount: {
          findFirst: jest.fn().mockImplementation((args: any) =>
            args.where.userId && leadFail.userId
              ? null // simulate missing account by always returning null for the second call
              : null,
          ),
        },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };
      // Mock to return account for first lead and null for second
      prisma.savedAccount.findFirst = jest
        .fn()
        .mockResolvedValueOnce({ credentialsJson: 'enc:' })
        .mockResolvedValueOnce(null);

      const { svc } = buildService({
        prisma,
        yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue([{ id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'hi' }, time_created: '2026-04-20T10:00:00Z' }]) },
      });

      const r = await svc.dryRun({});

      expect(r.results).toHaveLength(2);
      expect(r.results[0].error).toBeUndefined();
      expect(r.results[0].wouldPersist).toBe(1);
      expect(r.results[1].error).toBeDefined();
      expect(r.results[1].error).toMatch(/no saved Yelp account/);
    });
  });

  describe('token refresh path', () => {
    it('refreshes on 401 and retries getLeadEvents', async () => {
      const getLeadEvents = jest
        .fn()
        .mockRejectedValueOnce({ message: '401 Unauthorized', response: { status: 401 } })
        .mockResolvedValueOnce([
          { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'after refresh' }, time_created: '2026-04-20T10:00:00Z' },
        ]);
      const refreshAccessToken = jest.fn().mockResolvedValue({ accessToken: 'new-tok', refreshToken: 'new-rfr', expiresAt: Date.now() + 1000 });
      const yelpAdapter = { getLeadEvents, refreshAccessToken };

      const updateMany = jest.fn().mockResolvedValue({});
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }), updateMany },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };

      const { svc } = buildService({ prisma, yelpAdapter });
      const r = await svc.dryRun({ leadIds: ['lead-1'] });

      expect(refreshAccessToken).toHaveBeenCalledWith('rfr-1');
      expect(getLeadEvents).toHaveBeenCalledTimes(2);
      expect(updateMany).toHaveBeenCalled(); // sibling-account token sync
      expect(r.results[0].wouldPersist).toBe(1);
    });

    it('rethrows non-401 errors as a per-lead error entry', async () => {
      const yelpAdapter = {
        getLeadEvents: jest.fn().mockRejectedValue({ message: '500 boom', response: { status: 500 } }),
        refreshAccessToken: jest.fn(),
      };
      const prisma = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: { findMany: jest.fn().mockResolvedValue([]) },
      };

      const { svc } = buildService({ prisma, yelpAdapter });
      const r = await svc.dryRun({ leadIds: ['lead-1'] });

      expect(r.results[0].error).toBeDefined();
      expect(yelpAdapter.refreshAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('idempotency / read-only invariant', () => {
    it('never calls Message.create / update / upsert', async () => {
      const events = [
        { id: 'e1', user_type: 'CONSUMER', event_type: 'TEXT', event_content: { text: 'hi' }, time_created: '2026-04-20T10:00:00Z' },
      ];
      const prisma: any = {
        lead: { findMany: jest.fn().mockResolvedValue([baseLead]) },
        savedAccount: { findFirst: jest.fn().mockResolvedValue({ credentialsJson: 'enc:' }) },
        message: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn(),
          update: jest.fn(),
          upsert: jest.fn(),
        },
        conversation: {
          create: jest.fn(),
          update: jest.fn(),
          upsert: jest.fn(),
        },
      };
      const { svc } = buildService({ prisma, yelpAdapter: { getLeadEvents: jest.fn().mockResolvedValue(events) } });

      await svc.dryRun({ leadIds: ['lead-1'] });

      expect(prisma.message.create).not.toHaveBeenCalled();
      expect(prisma.message.update).not.toHaveBeenCalled();
      expect(prisma.message.upsert).not.toHaveBeenCalled();
      expect(prisma.conversation.create).not.toHaveBeenCalled();
      expect(prisma.conversation.update).not.toHaveBeenCalled();
      expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    });
  });
});
