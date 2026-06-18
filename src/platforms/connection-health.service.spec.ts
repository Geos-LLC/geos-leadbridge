import { ConnectionHealthService } from './connection-health.service';
import { ConnectionHealth, deriveOverall } from './connection-health.types';

function buildPrismaMock() {
  return {
    savedAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  } as any;
}

const ACCOUNT_ID = 'acc-1';

describe('ConnectionHealthService', () => {
  let prisma: ReturnType<typeof buildPrismaMock>;
  let service: ConnectionHealthService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new ConnectionHealthService(prisma);
  });

  describe('getHealth', () => {
    it('returns null when savedAccount is missing', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue(null);
      expect(await service.getHealth(ACCOUNT_ID)).toBeNull();
    });

    it('returns null when followUpSettingsJson is empty', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: null });
      expect(await service.getHealth(ACCOUNT_ID)).toBeNull();
    });

    it('returns null when followUpSettingsJson is unparseable', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: 'not-json' });
      expect(await service.getHealth(ACCOUNT_ID)).toBeNull();
    });

    it('returns null when followUpSettingsJson has no connectionHealth key', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({ additionalAssociatePhones: [] }),
      });
      expect(await service.getHealth(ACCOUNT_ID)).toBeNull();
    });

    it('returns the parsed connectionHealth blob', async () => {
      const blob: ConnectionHealth = {
        lastCheckedAt: '2026-06-18T00:00:00.000Z',
        signals: { webhook: { status: 'registered', webhookId: 'wh-1' } },
      };
      prisma.savedAccount.findUnique.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({ connectionHealth: blob }),
      });
      const result = await service.getHealth(ACCOUNT_ID);
      expect(result).toEqual(blob);
    });
  });

  describe('updateAssociatePhones', () => {
    it('creates a fresh blob when none exists', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: null });
      prisma.savedAccount.update.mockResolvedValue({});

      await service.updateAssociatePhones(ACCOUNT_ID, {
        status: 'ok',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
        owner: 'registered',
      });

      expect(prisma.savedAccount.update).toHaveBeenCalledTimes(1);
      const callArgs = prisma.savedAccount.update.mock.calls[0][0];
      expect(callArgs.where).toEqual({ id: ACCOUNT_ID });
      const written = JSON.parse(callArgs.data.followUpSettingsJson);
      expect(written.connectionHealth.signals.associatePhones).toMatchObject({
        status: 'ok',
        owner: 'registered',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
      });
      expect(written.connectionHealth.lastCheckedAt).toEqual(expect.any(String));
    });

    it('merges into existing connectionHealth blob without dropping other signals', async () => {
      const existingHealth: ConnectionHealth = {
        lastCheckedAt: '2026-06-17T00:00:00.000Z',
        signals: {
          oauthToken: { status: 'ok', scopes: 'a b c' },
          webhook: { status: 'registered', webhookId: 'wh-1' },
        },
      };
      prisma.savedAccount.findUnique.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({
          additionalAssociatePhones: [{ phoneNumber: '+15551234567' }],
          connectionHealth: existingHealth,
        }),
      });
      prisma.savedAccount.update.mockResolvedValue({});

      await service.updateAssociatePhones(ACCOUNT_ID, {
        status: 'ok',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
        owner: 'already_present',
      });

      const written = JSON.parse(prisma.savedAccount.update.mock.calls[0][0].data.followUpSettingsJson);
      // Other top-level keys preserved
      expect(written.additionalAssociatePhones).toEqual([{ phoneNumber: '+15551234567' }]);
      // Sibling signals preserved
      expect(written.connectionHealth.signals.oauthToken).toEqual({ status: 'ok', scopes: 'a b c' });
      expect(written.connectionHealth.signals.webhook).toEqual({ status: 'registered', webhookId: 'wh-1' });
      // New signal merged
      expect(written.connectionHealth.signals.associatePhones).toMatchObject({
        status: 'ok',
        owner: 'already_present',
      });
      // lastCheckedAt advanced past the prior value
      expect(written.connectionHealth.lastCheckedAt).not.toBe(existingHealth.lastCheckedAt);
    });

    it('shallow-merges patches into the existing same-signal payload', async () => {
      const existingHealth: ConnectionHealth = {
        lastCheckedAt: '2026-06-17T00:00:00.000Z',
        signals: {
          associatePhones: {
            status: 'ok',
            lastSyncedAt: '2026-06-17T00:00:00.000Z',
            owner: 'registered',
            lb: 'registered',
          },
        },
      };
      prisma.savedAccount.findUnique.mockResolvedValue({
        followUpSettingsJson: JSON.stringify({ connectionHealth: existingHealth }),
      });
      prisma.savedAccount.update.mockResolvedValue({});

      // Patch only owner — lb should survive, status + lastSyncedAt overwrite
      await service.updateAssociatePhones(ACCOUNT_ID, {
        status: 'warn',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
        owner: 'failed',
      });

      const written = JSON.parse(prisma.savedAccount.update.mock.calls[0][0].data.followUpSettingsJson);
      expect(written.connectionHealth.signals.associatePhones).toEqual({
        status: 'warn',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
        owner: 'failed',
        lb: 'registered', // survived
      });
    });

    it('skips silently when savedAccount is missing', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue(null);
      await service.updateAssociatePhones(ACCOUNT_ID, {
        status: 'ok',
        lastSyncedAt: '2026-06-18T00:00:00.000Z',
      });
      expect(prisma.savedAccount.update).not.toHaveBeenCalled();
    });

    it('swallows DB write failures without throwing', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: null });
      prisma.savedAccount.update.mockRejectedValue(new Error('DB down'));
      // Should not throw — health writes never block their caller's primary work
      await expect(
        service.updateAssociatePhones(ACCOUNT_ID, {
          status: 'ok',
          lastSyncedAt: '2026-06-18T00:00:00.000Z',
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('updateOAuthToken / updateWebhook', () => {
    it('writes oauthToken signal under the right key', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: null });
      prisma.savedAccount.update.mockResolvedValue({});

      await service.updateOAuthToken(ACCOUNT_ID, {
        status: 'ok',
        expiresAt: '2026-06-25T00:00:00.000Z',
        scopes: 'openid email profile',
      });

      const written = JSON.parse(prisma.savedAccount.update.mock.calls[0][0].data.followUpSettingsJson);
      expect(written.connectionHealth.signals.oauthToken).toMatchObject({
        status: 'ok',
        scopes: 'openid email profile',
      });
    });

    it('writes webhook signal under the right key', async () => {
      prisma.savedAccount.findUnique.mockResolvedValue({ followUpSettingsJson: null });
      prisma.savedAccount.update.mockResolvedValue({});

      await service.updateWebhook(ACCOUNT_ID, {
        status: 'registered',
        webhookId: 'wh-abc',
      });

      const written = JSON.parse(prisma.savedAccount.update.mock.calls[0][0].data.followUpSettingsJson);
      expect(written.connectionHealth.signals.webhook).toMatchObject({
        status: 'registered',
        webhookId: 'wh-abc',
      });
    });
  });
});

describe('deriveOverall', () => {
  it('returns unknown for null input', () => {
    expect(deriveOverall(null)).toBe('unknown');
  });

  it('returns unknown when no signals are populated', () => {
    expect(deriveOverall({ lastCheckedAt: '2026-06-18', signals: {} })).toBe('unknown');
  });

  it('returns fail when oauthToken is revoked', () => {
    expect(
      deriveOverall({
        lastCheckedAt: '2026-06-18',
        signals: { oauthToken: { status: 'revoked' } },
      }),
    ).toBe('fail');
  });

  it('returns fail when webhook is failed even if other signals are ok', () => {
    expect(
      deriveOverall({
        lastCheckedAt: '2026-06-18',
        signals: {
          oauthToken: { status: 'ok' },
          webhook: { status: 'failed' },
          associatePhones: { status: 'ok', lastSyncedAt: '2026-06-18' },
        },
      }),
    ).toBe('fail');
  });

  it('returns warn when associatePhones is partial (warn) with no failures', () => {
    expect(
      deriveOverall({
        lastCheckedAt: '2026-06-18',
        signals: {
          oauthToken: { status: 'ok' },
          associatePhones: { status: 'warn', lastSyncedAt: '2026-06-18' },
        },
      }),
    ).toBe('warn');
  });

  it('returns warn when oauthToken is expired', () => {
    expect(
      deriveOverall({
        lastCheckedAt: '2026-06-18',
        signals: { oauthToken: { status: 'expired' } },
      }),
    ).toBe('warn');
  });

  it('returns ok when all populated signals are positive', () => {
    expect(
      deriveOverall({
        lastCheckedAt: '2026-06-18',
        signals: {
          oauthToken: { status: 'ok' },
          webhook: { status: 'registered' },
          associatePhones: { status: 'ok', lastSyncedAt: '2026-06-18' },
        },
      }),
    ).toBe('ok');
  });
});
