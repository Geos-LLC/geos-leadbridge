/**
 * Unit tests for MonitoringService.runArchiveOrphanedAccountsSweep.
 *
 * Covers the 30-day auto-archive rule:
 *   - Account with token_refresh error >= 30 days old → archived.
 *   - Account with same error < 30 days old → left alone.
 *   - Account whose oldest unresolved error is recent → left alone
 *     (most recent errors get more weight than the count).
 *   - Resolved errors don't count toward the threshold.
 *   - Already-archived accounts aren't double-counted.
 *   - DB/crypto-bucketed errors (post-PR #296 reclassifier) don't
 *     count because they're not category='token_refresh'.
 *
 * Bypasses NestJS DI with Object.create + a prisma stub.
 */

import { Logger } from '@nestjs/common';
import { MonitoringService } from './monitoring.service';

type ErrorRow = {
  id: string;
  category: string;
  resolved: boolean;
  createdAt: Date;
  accountId: string | null;
};

type AccountRow = {
  id: string;
  businessName: string | null;
  platform: string;
  userId: string;
  archivedAt: Date | null;
};

function buildPrismaStub(seed: { errors: ErrorRow[]; accounts: AccountRow[] }) {
  const errors = [...seed.errors];
  const accounts = [...seed.accounts];
  return {
    accounts,
    systemErrorLog: {
      findMany: jest.fn(async ({ where, select: _select }: any) => {
        return errors.filter((e) => {
          if (where.category && e.category !== where.category) return false;
          if (where.resolved !== undefined && e.resolved !== where.resolved) return false;
          if (where.accountId?.not === null && e.accountId === null) return false;
          if (where.createdAt?.lte && e.createdAt > where.createdAt.lte) return false;
          return true;
        });
      }),
    },
    savedAccount: {
      findMany: jest.fn(async ({ where, select: _select }: any) => {
        return accounts.filter((a) => {
          if (where.id?.in && !where.id.in.includes(a.id)) return false;
          if (where.archivedAt === null && a.archivedAt !== null) return false;
          return true;
        });
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const a of accounts) {
          if (where.id?.in && !where.id.in.includes(a.id)) continue;
          if (where.archivedAt === null && a.archivedAt !== null) continue;
          Object.assign(a, data);
          count += 1;
        }
        return { count };
      }),
    },
  };
}

function buildService(stub: any): MonitoringService {
  const svc: any = Object.create(MonitoringService.prototype);
  svc.logger = new Logger('ArchiveSweepTest');
  svc.prisma = stub;
  return svc;
}

const DAY = 24 * 60 * 60 * 1000;

describe('MonitoringService.runArchiveOrphanedAccountsSweep', () => {
  it('archives accounts whose oldest unresolved token_refresh error is >= 30d old', async () => {
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 31 * DAY), accountId: 'acc-stale' },
      ],
      accounts: [
        { id: 'acc-stale', businessName: 'Stale Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 1, archived: 1 });
    expect(stub.accounts[0].archivedAt).toBeInstanceOf(Date);
  });

  it('leaves accounts whose oldest unresolved error is < 30d old alone', async () => {
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 29 * DAY), accountId: 'acc-fresh' },
      ],
      accounts: [
        { id: 'acc-fresh', businessName: 'Fresh Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 0, archived: 0 });
    expect(stub.accounts[0].archivedAt).toBeNull();
  });

  it('ignores resolved errors (a healthy account stays unarchived)', async () => {
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'token_refresh', resolved: true, createdAt: new Date(Date.now() - 60 * DAY), accountId: 'acc-recovered' },
      ],
      accounts: [
        { id: 'acc-recovered', businessName: 'Recovered Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 0, archived: 0 });
    expect(stub.accounts[0].archivedAt).toBeNull();
  });

  it('does not double-archive already-archived accounts (idempotent)', async () => {
    const alreadyArchived = new Date(Date.now() - 5 * DAY);
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 60 * DAY), accountId: 'acc-arch' },
      ],
      accounts: [
        { id: 'acc-arch', businessName: 'Archived Co', platform: 'thumbtack', userId: 'u-1', archivedAt: alreadyArchived },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    // The stale error matches as a candidate, but the savedAccount
    // findMany filter (archivedAt:null) returns 0 rows → archived=0.
    expect(result).toEqual({ candidates: 1, archived: 0 });
    // archivedAt timestamp not bumped.
    expect(stub.accounts[0].archivedAt).toEqual(alreadyArchived);
  });

  it('ignores non-token_refresh categories (db_error / crypto_error from the reclassifier)', async () => {
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'other', resolved: false, createdAt: new Date(Date.now() - 60 * DAY), accountId: 'acc-db' },
        { id: 'e2', category: 'webhook', resolved: false, createdAt: new Date(Date.now() - 60 * DAY), accountId: 'acc-webhook' },
        { id: 'e3', category: 'automation', resolved: false, createdAt: new Date(Date.now() - 60 * DAY), accountId: 'acc-auto' },
      ],
      accounts: [
        { id: 'acc-db', businessName: 'DB Bug Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
        { id: 'acc-webhook', businessName: 'Webhook Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
        { id: 'acc-auto', businessName: 'Auto Co', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 0, archived: 0 });
  });

  it('archives multiple eligible accounts in one sweep', async () => {
    const stub = buildPrismaStub({
      errors: [
        { id: 'e1', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 31 * DAY), accountId: 'acc-1' },
        { id: 'e2', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 45 * DAY), accountId: 'acc-2' },
        { id: 'e3', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 90 * DAY), accountId: 'acc-3' },
        // Fresh — won't qualify.
        { id: 'e4', category: 'token_refresh', resolved: false, createdAt: new Date(Date.now() - 5 * DAY), accountId: 'acc-fresh' },
      ],
      accounts: [
        { id: 'acc-1', businessName: 'One', platform: 'thumbtack', userId: 'u-1', archivedAt: null },
        { id: 'acc-2', businessName: 'Two', platform: 'thumbtack', userId: 'u-2', archivedAt: null },
        { id: 'acc-3', businessName: 'Three', platform: 'yelp', userId: 'u-3', archivedAt: null },
        { id: 'acc-fresh', businessName: 'Fresh', platform: 'thumbtack', userId: 'u-4', archivedAt: null },
      ],
    });
    const svc = buildService(stub);

    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 3, archived: 3 });
    expect(stub.accounts.find((a: any) => a.id === 'acc-fresh')!.archivedAt).toBeNull();
    expect(stub.accounts.find((a: any) => a.id === 'acc-1')!.archivedAt).toBeInstanceOf(Date);
    expect(stub.accounts.find((a: any) => a.id === 'acc-3')!.archivedAt).toBeInstanceOf(Date);
  });

  it('handles empty inputs', async () => {
    const stub = buildPrismaStub({ errors: [], accounts: [] });
    const svc = buildService(stub);
    const result = await svc.runArchiveOrphanedAccountsSweep(stub as any);
    expect(result).toEqual({ candidates: 0, archived: 0 });
  });
});
