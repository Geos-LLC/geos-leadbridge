import { CallConnectService, SaveCallConnectSettingsDto } from './call-connect.service';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Helpers: build mock dependencies
// ---------------------------------------------------------------------------
function buildPrismaMock() {
  return {
    callConnectSettings: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    savedAccount: {
      findUnique: jest.fn(),
    },
    tenantPhoneNumber: {
      findFirst: jest.fn(),
    },
    notificationSettings: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    user: {
      update: jest.fn(),
    },
  } as any;
}

function buildConfigMock() {
  return {
    get: jest.fn().mockImplementation((key: string, defaultVal?: any) => {
      if (key === 'SIGCORE_API_URL') return 'http://localhost:3002/api';
      // CallConnectService now resolves its public callback URL via
      // resolveSigcoreCallbackBaseUrl(), which throws if no valid backend URL
      // is configured. Tests inject a backend host so the constructor passes.
      if (key === 'BACKEND_PUBLIC_URL') return 'http://localhost:3000';
      return defaultVal ?? '';
    }),
  } as any as ConfigService;
}

function buildHttpMock() {
  return {
    post: jest.fn().mockReturnValue({ pipe: jest.fn().mockReturnThis(), toPromise: jest.fn() }),
    get: jest.fn().mockReturnValue({ pipe: jest.fn().mockReturnThis(), toPromise: jest.fn() }),
  } as any;
}

function buildService(overrides: { prisma?: any; config?: any; http?: any } = {}) {
  const prisma = overrides.prisma ?? buildPrismaMock();
  const config = overrides.config ?? buildConfigMock();
  const http = overrides.http ?? buildHttpMock();
  const service = new CallConnectService(prisma, config, http, {} as any, {
    canProcessLead: jest.fn().mockResolvedValue({ allowed: true, via: 'paid' }),
  } as any);
  return { service, prisma, config, http };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acct-tampa';
const ACCOUNT_ID_JAX = 'acct-jacksonville';
const ACCOUNT_ID_STP = 'acct-stpete';
const BOT_NUMBER = '+19045778584';
const OLD_NUMBER = '+16562231592';
const AGENT_PHONE = '+18139212100';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('CallConnectService – saveSettings bot number resolution', () => {
  let service: CallConnectService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    const built = buildService();
    service = built.service;
    prisma = built.prisma;

    // Stub out external calls that saveSettings makes after bot resolution
    jest.spyOn(service as any, 'ensureSigcoreProvisioned').mockResolvedValue(false);
    jest.spyOn(service as any, 'pushSettingsToSigcore').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'syncCallForwardingAfterProvision').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureWebhookSubscription').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'ensureInboundSmsWebhook').mockResolvedValue(undefined);

    prisma.notificationSettings.updateMany.mockResolvedValue({ count: 0 });
    prisma.user.update.mockResolvedValue({});
  });

  afterEach(() => jest.clearAllMocks());

  // =========================================================================
  // Account-scoped TPN found → use it directly
  // =========================================================================
  it('uses account-scoped TPN when available', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-1',
      savedAccountId: ACCOUNT_ID,
      botNumberE164: null,
      enabled: true,
    });
    prisma.savedAccount.findUnique.mockResolvedValue({ userId: USER_ID });
    prisma.tenantPhoneNumber.findFirst.mockResolvedValueOnce({
      phoneNumber: BOT_NUMBER,
    });
    prisma.callConnectSettings.update.mockResolvedValue({
      id: 'cc-1',
      botNumberE164: BOT_NUMBER,
    });

    const result = await service.saveSettings(USER_ID, ACCOUNT_ID, { enabled: true });

    // Should have resolved to +19045778584
    expect(prisma.callConnectSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { botNumberE164: BOT_NUMBER },
      }),
    );
    // pushSettingsToSigcore should receive the resolved bot number
    expect((service as any).pushSettingsToSigcore).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({ botNumberE164: BOT_NUMBER }),
    );
  });

  // =========================================================================
  // No account-scoped TPN → falls back to user-level TPN
  // =========================================================================
  it('falls back to user-level TPN when no account-scoped TPN exists (Jacksonville scenario)', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-jax',
      savedAccountId: ACCOUNT_ID_JAX,
      botNumberE164: null,
      enabled: true,
    });
    prisma.savedAccount.findUnique.mockResolvedValue({ userId: USER_ID });

    // First call (account-scoped) → null
    // Second call (user-level fallback) → Tampa's TPN
    prisma.tenantPhoneNumber.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ phoneNumber: BOT_NUMBER });

    prisma.callConnectSettings.update.mockResolvedValue({
      id: 'cc-jax',
      botNumberE164: BOT_NUMBER,
    });

    await service.saveSettings(USER_ID, ACCOUNT_ID_JAX, { enabled: true });

    // First query: account-scoped
    expect(prisma.tenantPhoneNumber.findFirst.mock.calls[0][0].where).toMatchObject({
      userId: USER_ID,
      savedAccountId: ACCOUNT_ID_JAX,
      status: 'ACTIVE',
    });
    // Second query: user-level (no savedAccountId filter)
    expect(prisma.tenantPhoneNumber.findFirst.mock.calls[1][0].where).toMatchObject({
      userId: USER_ID,
      status: 'ACTIVE',
    });
    expect(prisma.tenantPhoneNumber.findFirst.mock.calls[1][0].where).not.toHaveProperty('savedAccountId');

    // Should resolve to Tampa's TPN
    expect(prisma.callConnectSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { botNumberE164: BOT_NUMBER },
      }),
    );
  });

  // =========================================================================
  // No TPN at all → botNumberE164 stays null, pushed as-is
  // =========================================================================
  it('leaves botNumberE164 null when user has no TPNs', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-new',
      savedAccountId: 'acct-new',
      botNumberE164: null,
      enabled: true,
    });
    prisma.savedAccount.findUnique.mockResolvedValue({ userId: 'user-new' });
    prisma.tenantPhoneNumber.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    await service.saveSettings('user-new', 'acct-new', { enabled: true });

    // Should NOT call update (no number to set)
    expect(prisma.callConnectSettings.update).not.toHaveBeenCalled();
    // Should still push (with null bot number)
    expect((service as any).pushSettingsToSigcore).toHaveBeenCalledWith(
      'acct-new',
      expect.objectContaining({ botNumberE164: null }),
    );
  });

  // =========================================================================
  // Explicit botNumberE164 in DTO → skip auto-resolution
  // =========================================================================
  it('skips auto-resolution when botNumberE164 is explicitly provided', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-1',
      savedAccountId: ACCOUNT_ID,
      botNumberE164: BOT_NUMBER,
      enabled: true,
    });

    await service.saveSettings(USER_ID, ACCOUNT_ID, {
      enabled: true,
      botNumberE164: BOT_NUMBER,
    });

    // Should NOT query TenantPhoneNumber at all — bot number already set
    expect(prisma.tenantPhoneNumber.findFirst).not.toHaveBeenCalled();
    expect(prisma.callConnectSettings.update).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Multiple accounts share same TPN (Tampa, Jacksonville, StPete)
  // =========================================================================
  it('resolves same bot number for multiple accounts sharing one TPN', async () => {
    const accounts = [
      { accountId: ACCOUNT_ID, hasOwnTPN: true },
      { accountId: ACCOUNT_ID_JAX, hasOwnTPN: false },
      { accountId: ACCOUNT_ID_STP, hasOwnTPN: false },
    ];

    for (const { accountId, hasOwnTPN } of accounts) {
      jest.clearAllMocks();
      const built = buildService();
      const svc = built.service;
      const p = built.prisma;

      jest.spyOn(svc as any, 'ensureSigcoreProvisioned').mockResolvedValue(false);
      jest.spyOn(svc as any, 'pushSettingsToSigcore').mockResolvedValue(undefined);
      jest.spyOn(svc as any, 'syncCallForwardingAfterProvision').mockResolvedValue(undefined);
      jest.spyOn(svc as any, 'ensureWebhookSubscription').mockResolvedValue(undefined);
      jest.spyOn(svc as any, 'ensureInboundSmsWebhook').mockResolvedValue(undefined);
      p.notificationSettings.updateMany.mockResolvedValue({ count: 0 });
      p.user.update.mockResolvedValue({});

      p.callConnectSettings.upsert.mockResolvedValue({
        id: `cc-${accountId}`,
        savedAccountId: accountId,
        botNumberE164: null,
        enabled: true,
      });
      p.savedAccount.findUnique.mockResolvedValue({ userId: USER_ID });
      p.callConnectSettings.update.mockResolvedValue({});

      if (hasOwnTPN) {
        // Tampa has account-scoped TPN
        p.tenantPhoneNumber.findFirst.mockResolvedValueOnce({ phoneNumber: BOT_NUMBER });
      } else {
        // Jax/StPete: no account-scoped TPN, falls back to user-level
        p.tenantPhoneNumber.findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ phoneNumber: BOT_NUMBER });
      }

      await svc.saveSettings(USER_ID, accountId, { enabled: true });

      // All accounts should resolve to the same bot number
      expect(p.callConnectSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { botNumberE164: BOT_NUMBER },
        }),
      );
      expect((svc as any).pushSettingsToSigcore).toHaveBeenCalledWith(
        accountId,
        expect.objectContaining({ botNumberE164: BOT_NUMBER }),
      );
    }
  });

  // =========================================================================
  // Stale/wrong bot number gets overridden by explicit DTO
  // =========================================================================
  it('overrides stale bot number when DTO provides correct one', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-jax',
      savedAccountId: ACCOUNT_ID_JAX,
      botNumberE164: BOT_NUMBER, // already set via DTO override
      enabled: true,
    });

    await service.saveSettings(USER_ID, ACCOUNT_ID_JAX, {
      enabled: true,
      botNumberE164: BOT_NUMBER,
    });

    // Should push the correct number to Sigcore
    expect((service as any).pushSettingsToSigcore).toHaveBeenCalledWith(
      ACCOUNT_ID_JAX,
      expect.objectContaining({ botNumberE164: BOT_NUMBER }),
    );
  });

  // =========================================================================
  // pushSettingsToSigcore receives correct payload structure
  // =========================================================================
  it('pushes businessId (savedAccountId) to Sigcore for per-account isolation', async () => {
    prisma.callConnectSettings.upsert.mockResolvedValue({
      id: 'cc-1',
      savedAccountId: ACCOUNT_ID,
      botNumberE164: BOT_NUMBER,
      agentPhoneE164: AGENT_PHONE,
      enabled: true,
      mode: 'AGENT_FIRST',
      maxAgentAttempts: 2,
    });

    await service.saveSettings(USER_ID, ACCOUNT_ID, {
      enabled: true,
      botNumberE164: BOT_NUMBER,
      agentPhoneE164: AGENT_PHONE,
    });

    expect((service as any).pushSettingsToSigcore).toHaveBeenCalledWith(
      ACCOUNT_ID,
      expect.objectContaining({
        savedAccountId: ACCOUNT_ID,
        botNumberE164: BOT_NUMBER,
        agentPhoneE164: AGENT_PHONE,
        enabled: true,
      }),
    );
  });
});
