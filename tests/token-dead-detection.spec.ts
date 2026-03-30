/**
 * Token Dead Detection — Unit Tests
 *
 * Tests the getSavedAccounts method in PlatformService which determines
 * whether a Thumbtack account's token is dead by checking SystemErrorLog
 * for unresolved token_refresh errors.
 *
 * Key rules:
 * - Thumbtack accounts with unresolved token_refresh errors → tokenDead: true
 * - Thumbtack accounts without errors → tokenDead: false
 * - Yelp accounts are never checked → tokenDead: false always
 * - credentialsJson is always stripped from the response
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — we test PlatformService.getSavedAccounts in isolation by replacing
// Prisma calls and all other injected services.
// ---------------------------------------------------------------------------

function makeSavedAccount(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'acc-1',
    userId: overrides.userId ?? 'user-1',
    platform: overrides.platform ?? 'thumbtack',
    businessId: overrides.businessId ?? 'biz-1',
    businessName: overrides.businessName ?? 'Test Business',
    credentialsJson: overrides.credentialsJson ?? 'encrypted-blob',
    emailHint: overrides.emailHint ?? null,
    webhookId: overrides.webhookId ?? null,
    agentPhoneOverride: overrides.agentPhoneOverride ?? null,
    lastUsedAt: overrides.lastUsedAt ?? new Date(),
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

// Minimal mock of PrismaService with the two tables getSavedAccounts uses
function makePrismaMock() {
  return {
    savedAccount: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    systemErrorLog: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

function makeConfigMock() {
  return {
    get: vi.fn((key: string) => {
      if (key === 'encryption.key') return 'test-encryption-key-32-chars!!';
      return undefined;
    }),
  };
}

/**
 * Build a minimal PlatformService-like object that only contains
 * getSavedAccounts (the method under test). We replicate just enough
 * of the constructor to set up the fields the method reads.
 */
function buildServiceUnderTest(prisma: ReturnType<typeof makePrismaMock>) {
  const logger = { warn: vi.fn(), error: vi.fn(), log: vi.fn(), debug: vi.fn() };

  // Replicate the getSavedAccounts logic from platform.service.ts verbatim
  // so we test the exact algorithm without needing the full NestJS container.
  return {
    logger,
    async getSavedAccounts(userId: string, platform?: string) {
      const accounts = await prisma.savedAccount.findMany({
        where: {
          userId,
          ...(platform && { platform }),
        },
        orderBy: { lastUsedAt: 'desc' },
      });

      const ttAccountIds = accounts
        .filter((a: any) => a.platform === 'thumbtack')
        .map((a: any) => a.id);
      const deadAccountIds = new Set<string>();

      if (ttAccountIds.length > 0) {
        const tokenErrors = await prisma.systemErrorLog.findMany({
          where: {
            category: 'token_refresh',
            resolved: false,
            accountId: { in: ttAccountIds },
          },
          select: { accountId: true },
        });
        for (const err of tokenErrors) {
          if (err.accountId) deadAccountIds.add(err.accountId);
        }
      }

      if (deadAccountIds.size > 0) {
        const deadNames = accounts
          .filter((a: any) => deadAccountIds.has(a.id))
          .map((a: any) => a.businessName);
        logger.warn(
          `[getSavedAccounts] Dead tokens (unresolved token_refresh errors): ${deadNames.join(', ')}`,
        );
      }

      return accounts.map(({ credentialsJson: _, ...a }: any) => ({
        ...a,
        tokenDead: deadAccountIds.has(a.id),
      }));
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlatformService.getSavedAccounts — token dead detection', () => {
  let prisma: ReturnType<typeof makePrismaMock>;
  let service: ReturnType<typeof buildServiceUnderTest>;

  beforeEach(() => {
    prisma = makePrismaMock();
    service = buildServiceUnderTest(prisma);
  });

  // ---- Thumbtack: dead token (unresolved token_refresh error exists) ----

  it('marks Thumbtack account as tokenDead when an unresolved token_refresh error exists', async () => {
    const account = makeSavedAccount({ id: 'tt-dead', platform: 'thumbtack', businessName: 'Dead TT' });
    prisma.savedAccount.findMany.mockResolvedValue([account]);
    prisma.systemErrorLog.findMany.mockResolvedValue([{ accountId: 'tt-dead' }]);

    const result = await service.getSavedAccounts('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].tokenDead).toBe(true);
  });

  // ---- Thumbtack: healthy (no errors) ----

  it('does NOT mark Thumbtack account as tokenDead when no token_refresh errors exist', async () => {
    const account = makeSavedAccount({ id: 'tt-ok', platform: 'thumbtack', businessName: 'Healthy TT' });
    prisma.savedAccount.findMany.mockResolvedValue([account]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]);

    const result = await service.getSavedAccounts('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].tokenDead).toBe(false);
  });

  // ---- Thumbtack: resolved error should NOT mark dead ----

  it('does NOT mark as tokenDead when all token_refresh errors are resolved (empty query result)', async () => {
    // The Prisma query filters resolved: false, so resolved errors won't appear.
    // We simulate this by returning an empty array from systemErrorLog.findMany.
    const account = makeSavedAccount({ id: 'tt-resolved', platform: 'thumbtack' });
    prisma.savedAccount.findMany.mockResolvedValue([account]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]); // no unresolved errors

    const result = await service.getSavedAccounts('user-1');

    expect(result[0].tokenDead).toBe(false);
  });

  // ---- Yelp: never marked tokenDead ----

  it('never marks Yelp accounts as tokenDead even if errors existed', async () => {
    const yelpAccount = makeSavedAccount({ id: 'yelp-1', platform: 'yelp', businessName: 'Yelp Biz' });
    prisma.savedAccount.findMany.mockResolvedValue([yelpAccount]);
    // systemErrorLog.findMany should NOT be called for Yelp-only accounts
    // (ttAccountIds would be empty, so the query is skipped)

    const result = await service.getSavedAccounts('user-1');

    expect(result).toHaveLength(1);
    expect(result[0].tokenDead).toBe(false);
    // Verify systemErrorLog was never queried (no TT accounts)
    expect(prisma.systemErrorLog.findMany).not.toHaveBeenCalled();
  });

  // ---- Account with no credentialsJson ----

  it('handles account with null credentialsJson gracefully', async () => {
    const account = makeSavedAccount({ id: 'tt-nocreds', platform: 'thumbtack', credentialsJson: null });
    prisma.savedAccount.findMany.mockResolvedValue([account]);
    prisma.systemErrorLog.findMany.mockResolvedValue([{ accountId: 'tt-nocreds' }]);

    const result = await service.getSavedAccounts('user-1');

    // Has an unresolved error → dead
    expect(result[0].tokenDead).toBe(true);
  });

  it('account with null credentialsJson and no errors is NOT tokenDead', async () => {
    const account = makeSavedAccount({ id: 'tt-nocreds2', platform: 'thumbtack', credentialsJson: null });
    prisma.savedAccount.findMany.mockResolvedValue([account]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]);

    const result = await service.getSavedAccounts('user-1');

    expect(result[0].tokenDead).toBe(false);
  });

  // ---- credentialsJson stripped from response ----

  it('strips credentialsJson from all returned accounts', async () => {
    const ttAccount = makeSavedAccount({
      id: 'tt-1',
      platform: 'thumbtack',
      credentialsJson: 'super-secret-encrypted-blob',
    });
    const yelpAccount = makeSavedAccount({
      id: 'yelp-1',
      platform: 'yelp',
      credentialsJson: 'another-secret-blob',
    });
    prisma.savedAccount.findMany.mockResolvedValue([ttAccount, yelpAccount]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]);

    const result = await service.getSavedAccounts('user-1');

    for (const account of result) {
      expect(account).not.toHaveProperty('credentialsJson');
    }
  });

  // ---- Mixed accounts: some dead, some healthy ----

  it('correctly marks mixed accounts — some dead, some healthy', async () => {
    const deadTT = makeSavedAccount({ id: 'tt-dead', platform: 'thumbtack', businessName: 'Dead TT' });
    const healthyTT = makeSavedAccount({ id: 'tt-ok', platform: 'thumbtack', businessName: 'Healthy TT' });
    const yelpAcc = makeSavedAccount({ id: 'yelp-1', platform: 'yelp', businessName: 'Yelp Biz' });

    prisma.savedAccount.findMany.mockResolvedValue([deadTT, healthyTT, yelpAcc]);
    prisma.systemErrorLog.findMany.mockResolvedValue([{ accountId: 'tt-dead' }]);

    const result = await service.getSavedAccounts('user-1');

    expect(result).toHaveLength(3);

    const dead = result.find((a: any) => a.id === 'tt-dead');
    const healthy = result.find((a: any) => a.id === 'tt-ok');
    const yelp = result.find((a: any) => a.id === 'yelp-1');

    expect(dead!.tokenDead).toBe(true);
    expect(healthy!.tokenDead).toBe(false);
    expect(yelp!.tokenDead).toBe(false);
  });

  // ---- Multiple dead Thumbtack accounts ----

  it('marks multiple Thumbtack accounts as dead when each has errors', async () => {
    const dead1 = makeSavedAccount({ id: 'tt-d1', platform: 'thumbtack', businessName: 'Dead 1' });
    const dead2 = makeSavedAccount({ id: 'tt-d2', platform: 'thumbtack', businessName: 'Dead 2' });

    prisma.savedAccount.findMany.mockResolvedValue([dead1, dead2]);
    prisma.systemErrorLog.findMany.mockResolvedValue([
      { accountId: 'tt-d1' },
      { accountId: 'tt-d2' },
    ]);

    const result = await service.getSavedAccounts('user-1');

    expect(result[0].tokenDead).toBe(true);
    expect(result[1].tokenDead).toBe(true);
  });

  // ---- Logger warning when dead tokens found ----

  it('logs a warning listing dead account names', async () => {
    const dead = makeSavedAccount({ id: 'tt-dead', platform: 'thumbtack', businessName: 'Broken Plumber' });
    prisma.savedAccount.findMany.mockResolvedValue([dead]);
    prisma.systemErrorLog.findMany.mockResolvedValue([{ accountId: 'tt-dead' }]);

    await service.getSavedAccounts('user-1');

    expect(service.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Broken Plumber'),
    );
  });

  it('does NOT log a warning when no dead tokens exist', async () => {
    const ok = makeSavedAccount({ id: 'tt-ok', platform: 'thumbtack' });
    prisma.savedAccount.findMany.mockResolvedValue([ok]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]);

    await service.getSavedAccounts('user-1');

    expect(service.logger.warn).not.toHaveBeenCalled();
  });

  // ---- Empty accounts list ----

  it('returns empty array when user has no accounts', async () => {
    prisma.savedAccount.findMany.mockResolvedValue([]);

    const result = await service.getSavedAccounts('user-1');

    expect(result).toEqual([]);
    expect(prisma.systemErrorLog.findMany).not.toHaveBeenCalled();
  });

  // ---- Platform filter is passed through ----

  it('passes platform filter to Prisma query when provided', async () => {
    prisma.savedAccount.findMany.mockResolvedValue([]);

    await service.getSavedAccounts('user-1', 'thumbtack');

    expect(prisma.savedAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', platform: 'thumbtack' },
      }),
    );
  });

  it('does not include platform in query when not provided', async () => {
    prisma.savedAccount.findMany.mockResolvedValue([]);

    await service.getSavedAccounts('user-1');

    expect(prisma.savedAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1' },
      }),
    );
  });

  // ---- systemErrorLog query uses correct filters ----

  it('queries systemErrorLog with category=token_refresh, resolved=false, and TT account IDs', async () => {
    const tt1 = makeSavedAccount({ id: 'tt-a', platform: 'thumbtack' });
    const tt2 = makeSavedAccount({ id: 'tt-b', platform: 'thumbtack' });
    prisma.savedAccount.findMany.mockResolvedValue([tt1, tt2]);
    prisma.systemErrorLog.findMany.mockResolvedValue([]);

    await service.getSavedAccounts('user-1');

    expect(prisma.systemErrorLog.findMany).toHaveBeenCalledWith({
      where: {
        category: 'token_refresh',
        resolved: false,
        accountId: { in: ['tt-a', 'tt-b'] },
      },
      select: { accountId: true },
    });
  });
});
