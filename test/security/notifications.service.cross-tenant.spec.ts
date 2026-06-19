/**
 * Cross-tenant access tests for NotificationsService — Phase 1A.
 *
 * Two methods previously ignored userId:
 *   - searchSigcoreAvailableNumbers
 *   - purchaseSigcorePhoneNumber
 *
 * Both took a savedAccountId and looked up the Sigcore tenant directly,
 * letting User A query/buy on User B's Sigcore tenant. They now verify the
 * saved account belongs to the caller and throw NotFoundException on mismatch.
 *
 * Other notifications methods were already tenant-scoped via savedAccount.findFirst —
 * we don't re-test the whole surface here, just the previously vulnerable ones.
 */

import { NotFoundException } from '@nestjs/common';
import { NotificationsService } from '../../src/notifications/notifications.service';

function buildPrisma(ownerUserId: string) {
  return {
    savedAccount: {
      findFirst: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.userId === ownerUserId) {
          return Promise.resolve({ id: where.id });
        }
        return Promise.resolve(null);
      }),
    },
    // Should never be reached when ownership check fails — so a bare stub is fine.
    notificationSettings: {
      findUnique: jest.fn().mockResolvedValue({ sigcoreTenantId: 'tenant-x' }),
    },
  } as any;
}

function makeService(prisma: any): NotificationsService {
  // ConfigService stub returning the minimum the tested paths need.
  const configService = { get: jest.fn().mockReturnValue('') } as any;
  // Cache stub — no-op getOrSet (delegates to loader) + no-op del.
  // The cross-tenant tests don't exercise cached paths; this just satisfies DI.
  const cache = {
    getOrSet: jest.fn(async (_k: string, _ttl: number, loader: () => Promise<any>) => loader()),
    del: jest.fn().mockResolvedValue(undefined),
  } as any;
  // The cross-tenant ownership guard runs BEFORE any of the other deps are
  // touched (savedAccount.findFirst is the first thing the patched methods
  // do). So `{} as any` stubs for trial / businessHours / conversationContext
  // / instantTextAi / platformService satisfy DI without needing real
  // behavior. Six new args were added to NotificationsService between
  // 2026-04 and 2026-06 — see constructor at notifications.service.ts:195.
  return new NotificationsService(
    prisma,
    configService,
    cache,
    {} as any, // trialService
    {} as any, // businessHours
    {} as any, // conversationContext
    {} as any, // instantTextAi
    {} as any, // platformService (forwardRef)
    {} as any, // callConnectService (CC botNumber back-fill on phone purchase)
  );
}

describe('NotificationsService — cross-tenant Sigcore access', () => {
  const OWNER = 'user-a';
  const INTRUDER = 'user-b';
  const SAVED_ACCOUNT_ID = 'acct-owned-by-a';

  describe('searchSigcoreAvailableNumbers', () => {
    it('throws NotFoundException when caller does not own the account', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(
        svc.searchSigcoreAvailableNumbers(INTRUDER, SAVED_ACCOUNT_ID, 'US'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does NOT touch notificationSettings when ownership fails', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(
        svc.searchSigcoreAvailableNumbers(INTRUDER, SAVED_ACCOUNT_ID, 'US'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.notificationSettings.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('purchaseSigcorePhoneNumber', () => {
    it('throws NotFoundException when caller does not own the account', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      await expect(
        svc.purchaseSigcorePhoneNumber(INTRUDER, SAVED_ACCOUNT_ID, '+15551234567'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('does NOT initiate the Sigcore purchase when ownership fails', async () => {
      const prisma = buildPrisma(OWNER);
      const svc = makeService(prisma);
      // Spy on global fetch — the patched method calls fetch only AFTER the ownership check passes.
      const fetchSpy = jest.spyOn(global, 'fetch' as any).mockResolvedValue({ ok: true, json: () => ({}) } as any);
      try {
        await expect(
          svc.purchaseSigcorePhoneNumber(INTRUDER, SAVED_ACCOUNT_ID, '+15551234567'),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });
  });
});
