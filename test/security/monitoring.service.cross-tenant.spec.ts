/**
 * Cross-tenant access tests for MonitoringService — Phase 1A.
 *
 * Before this PR, every error endpoint queried SystemErrorLog with no userId
 * filter, so any authenticated user could read the entire platform's errors
 * (including other tenants' account names, lead IDs, and stack traces) and
 * mutate other tenants' rows via resolveError / resolveAllByCategory /
 * deduplicateErrors. The service signatures now require a userId and every
 * Prisma query filters on it.
 */

import { NotFoundException } from '@nestjs/common';
import { MonitoringService } from '../../src/monitoring/monitoring.service';

function buildPrisma() {
  return {
    systemErrorLog: {
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function makeService(prisma: any): MonitoringService {
  // Constructor: (prisma, configService).
  return new MonitoringService(prisma, { get: jest.fn().mockReturnValue('') } as any);
}

describe('MonitoringService — cross-tenant scoping', () => {
  const OWNER = 'user-a';

  describe('getRecentErrors', () => {
    it('always filters by userId', async () => {
      const prisma = buildPrisma();
      const svc = makeService(prisma);
      await svc.getRecentErrors(OWNER, { limit: 10, onlyUnresolved: true });
      expect(prisma.systemErrorLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER }),
        }),
      );
    });

    it('includes the category filter alongside the userId scope', async () => {
      const prisma = buildPrisma();
      const svc = makeService(prisma);
      await svc.getRecentErrors(OWNER, { category: 'automation' });
      const call = prisma.systemErrorLog.findMany.mock.calls[0][0];
      expect(call.where.userId).toBe(OWNER);
      expect(call.where.category).toBe('automation');
    });
  });

  describe('resolveError', () => {
    it('uses updateMany scoped by userId so cross-tenant ids no-op', async () => {
      const prisma = buildPrisma();
      prisma.systemErrorLog.updateMany.mockResolvedValue({ count: 1 });
      const svc = makeService(prisma);
      await svc.resolveError(OWNER, 'err-1');
      expect(prisma.systemErrorLog.updateMany).toHaveBeenCalledWith({
        where: { id: 'err-1', userId: OWNER },
        data: { resolved: true },
      });
    });

    it('throws NotFoundException when no row matches (cross-tenant id)', async () => {
      const prisma = buildPrisma();
      prisma.systemErrorLog.updateMany.mockResolvedValue({ count: 0 });
      const svc = makeService(prisma);
      await expect(svc.resolveError(OWNER, 'foreign-err')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('resolveAllByCategory', () => {
    it('scopes the bulk update by userId', async () => {
      const prisma = buildPrisma();
      prisma.systemErrorLog.updateMany.mockResolvedValue({ count: 3 });
      const svc = makeService(prisma);
      const count = await svc.resolveAllByCategory(OWNER, 'automation');
      expect(count).toBe(3);
      expect(prisma.systemErrorLog.updateMany).toHaveBeenCalledWith({
        where: { userId: OWNER, category: 'automation', resolved: false },
        data: { resolved: true },
      });
    });
  });

  describe('getErrorSummary', () => {
    it('aggregates only the caller\'s errors', async () => {
      const prisma = buildPrisma();
      const svc = makeService(prisma);
      await svc.getErrorSummary(OWNER);
      expect(prisma.systemErrorLog.groupBy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER, resolved: false }),
        }),
      );
      expect(prisma.systemErrorLog.count).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: OWNER }),
        }),
      );
    });
  });

  describe('deduplicateErrors', () => {
    it('only touches the caller\'s rows', async () => {
      const prisma = buildPrisma();
      prisma.systemErrorLog.groupBy.mockResolvedValue([]);
      const svc = makeService(prisma);
      await svc.deduplicateErrors(OWNER);
      const groupByCall = prisma.systemErrorLog.groupBy.mock.calls[0][0];
      expect(groupByCall.where.userId).toBe(OWNER);
    });
  });
});
