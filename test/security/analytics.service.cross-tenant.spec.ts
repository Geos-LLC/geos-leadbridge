/**
 * Cross-tenant access tests for AnalyticsService — Phase 1B.
 *
 * Analytics already filter by userId at the service layer (every method
 * takes a `userId` argument and embeds it in Prisma queries / cache keys).
 * These tests pin the contract: a future refactor that drops the userId
 * filter on `analyticsCache` lookups or `lead.findMany` queries would
 * silently leak another tenant's analytics.
 */

import { AnalyticsService } from '../../src/analytics/analytics.service';

function buildPrisma() {
  return {
    analyticsCache: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ calculatedAt: new Date() }),
    },
    lead: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    message: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    notificationLog: {
      count: jest.fn().mockResolvedValue(0),
    },
  } as any;
}

function makeService(prisma: any): AnalyticsService {
  // AnalyticsService constructor: just (prisma).
  return new AnalyticsService(prisma);
}

describe('AnalyticsService — cross-tenant scoping', () => {
  const OWNER = 'user-a';

  it('getCacheInfo scopes the cache key to the userId', async () => {
    const prisma = buildPrisma();
    const svc = makeService(prisma);
    await svc.getCacheInfo(OWNER, 'biz-1');
    const call = prisma.analyticsCache.findUnique.mock.calls[0][0];
    // Cache key includes the user id as the first segment.
    expect(call.where.cacheKey).toMatch(new RegExp(`^${OWNER}::`));
  });

  it('getCacheInfo for a different user produces a different cache key', async () => {
    const prisma = buildPrisma();
    const svc = makeService(prisma);
    await svc.getCacheInfo('user-a', 'biz-1');
    await svc.getCacheInfo('user-b', 'biz-1');
    const keyA = prisma.analyticsCache.findUnique.mock.calls[0][0].where.cacheKey;
    const keyB = prisma.analyticsCache.findUnique.mock.calls[1][0].where.cacheKey;
    expect(keyA).not.toEqual(keyB);
  });
});
