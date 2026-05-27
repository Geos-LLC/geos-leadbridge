import { ConfigService } from '@nestjs/config';
import { SfConnectionResolver } from './sf-connection-resolver.service';
import { EncryptionUtil } from '../common/utils/encryption.util';

const ENCRYPTION_KEY = 'test-encryption-key-32-bytes-long-okay';

function buildSvc(opts: {
  connectionRow?: any | null;
  envCsv?: string;
  envBaseUrl?: string;
  envApiKey?: string;
  encryptionKey?: string;
  updateThrows?: boolean;
} = {}) {
  const calls = { findUnique: [] as any[], update: [] as any[] };
  const prisma: any = {
    sfConnection: {
      findUnique: jest.fn(async (args: any) => {
        calls.findUnique.push(args);
        return opts.connectionRow === undefined ? null : opts.connectionRow;
      }),
      update: jest.fn(async (args: any) => {
        calls.update.push(args);
        if (opts.updateThrows) throw new Error('grace cleanup race');
        return { ...args.data };
      }),
    },
  };
  const cfg = {
    get: ((k: string, def?: any) => {
      if (k === 'encryption.key') return opts.encryptionKey ?? ENCRYPTION_KEY;
      if (k === 'BOOKING_ORCHESTRATION_ENABLED_USER_IDS') return opts.envCsv ?? def;
      if (k === 'SF_ORCHESTRATION_BASE_URL') return opts.envBaseUrl ?? def;
      if (k === 'SF_ORCHESTRATION_API_KEY') return opts.envApiKey ?? def;
      return def;
    }) as any,
  } as ConfigService;
  const svc = new SfConnectionResolver(prisma, cfg);
  return { svc, prisma, calls };
}

function makeActiveConnection(overrides: any = {}): any {
  // Build a realistic row whose stored token decrypts cleanly.
  return {
    id: 'conn-1',
    userId: 'u1',
    sfTenantId: 'sf-tenant-A',
    sfTenantName: 'Test Tenant',
    baseUrl: 'https://sf.example.com',
    orchestrationToken: EncryptionUtil.encrypt('LIVE-TOKEN-XYZ', ENCRYPTION_KEY),
    orchestrationTokenKid: 'k1',
    tokenIssuedAt: new Date(),
    tokenExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    tokenLastReceivedAt: new Date(),
    previousOrchestrationToken: null,
    previousTokenExpiresAt: null,
    isActive: true,
    status: 'active',
    ...overrides,
  };
}

describe('SfConnectionResolver — DB path (priority 1)', () => {
  it('returns enabled with decrypted token when row is active + decrypts', async () => {
    const { svc } = buildSvc({ connectionRow: makeActiveConnection() });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('connection');
    expect(r.baseUrl).toBe('https://sf.example.com');
    expect(r.orchestrationToken).toBe('LIVE-TOKEN-XYZ');
    expect(r.sfTenantId).toBe('sf-tenant-A');
    expect(r.usedPreviousToken).toBe(false);
  });

  it('returns disabled when row exists but isActive=false', async () => {
    const { svc } = buildSvc({ connectionRow: makeActiveConnection({ isActive: false }) });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('none');
    expect(r.disabledReason).toBe('connection_inactive');
  });

  it.each(['pending', 'disconnected', 'revoked', 'error'])(
    'returns disabled when status=%s',
    async (status) => {
      const { svc } = buildSvc({ connectionRow: makeActiveConnection({ status }) });
      const r = await svc.resolveForUser('u1');
      expect(r.enabled).toBe(false);
      expect(r.source).toBe('none');
    },
  );

  it('returns enabled when status=rotating + current token decrypts', async () => {
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'rotating',
        previousOrchestrationToken: EncryptionUtil.encrypt('OLD-TOKEN', ENCRYPTION_KEY),
        previousTokenExpiresAt: new Date(Date.now() + 3 * 60 * 1000), // 3 min remaining
      }),
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('connection');
    expect(r.orchestrationToken).toBe('LIVE-TOKEN-XYZ'); // current, not previous
    expect(r.usedPreviousToken).toBe(false);
  });
});

describe('SfConnectionResolver — grace window lazy cleanup', () => {
  it('expired grace window → wipes previous token + flips status to active', async () => {
    const { svc, prisma } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'rotating',
        previousOrchestrationToken: EncryptionUtil.encrypt('OLD-TOKEN', ENCRYPTION_KEY),
        previousTokenExpiresAt: new Date(Date.now() - 60 * 1000), // 1 min PAST grace
      }),
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(prisma.sfConnection.update).toHaveBeenCalledTimes(1);
    const upd = prisma.sfConnection.update.mock.calls[0][0];
    expect(upd.where.id).toBe('conn-1');
    expect(upd.data.previousOrchestrationToken).toBeNull();
    expect(upd.data.previousTokenExpiresAt).toBeNull();
    expect(upd.data.status).toBe('active');
  });

  it('grace cleanup race (update throws) does NOT fail the resolve call', async () => {
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'rotating',
        previousOrchestrationToken: EncryptionUtil.encrypt('OLD', ENCRYPTION_KEY),
        previousTokenExpiresAt: new Date(Date.now() - 60 * 1000),
      }),
      updateThrows: true,
    });
    const r = await svc.resolveForUser('u1');
    // Cleanup failed but call still returns enabled with current token —
    // next resolve will retry the cleanup.
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('connection');
  });

  it('does NOT clean up when grace window is still active', async () => {
    const { svc, prisma } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'rotating',
        previousOrchestrationToken: EncryptionUtil.encrypt('OLD', ENCRYPTION_KEY),
        previousTokenExpiresAt: new Date(Date.now() + 60 * 1000), // 1 min still left
      }),
    });
    await svc.resolveForUser('u1');
    expect(prisma.sfConnection.update).not.toHaveBeenCalled();
  });
});

describe('SfConnectionResolver — previous-token fallback (decrypt safety net)', () => {
  it('current decrypt fails + grace active + previous decrypts → uses previous', async () => {
    const garbageEncrypted = 'AAAA-not-actually-encrypted-payload-AAAA';
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'rotating',
        orchestrationToken: garbageEncrypted,
        previousOrchestrationToken: EncryptionUtil.encrypt('OLD-TOKEN', ENCRYPTION_KEY),
        previousTokenExpiresAt: new Date(Date.now() + 3 * 60 * 1000),
      }),
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('connection');
    expect(r.orchestrationToken).toBe('OLD-TOKEN');
    expect(r.usedPreviousToken).toBe(true);
  });

  it('current decrypt fails + grace expired → falls through to env canary', async () => {
    const garbage = 'still-garbage';
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection({
        status: 'active',
        orchestrationToken: garbage,
        previousOrchestrationToken: null,
        previousTokenExpiresAt: null,
      }),
      envCsv: 'u1',
      envBaseUrl: 'https://canary.sf',
      envApiKey: 'canary-key',
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('env_canary');
  });

  it('current decrypt fails + no canary → returns disabled (not stuck on dead previous)', async () => {
    const garbage = 'garbage';
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection({
        orchestrationToken: garbage,
        previousOrchestrationToken: null,
        previousTokenExpiresAt: null,
      }),
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('none');
  });

  it('missing encryption.key config → falls through to env canary', async () => {
    const { svc } = buildSvc({
      connectionRow: makeActiveConnection(),
      encryptionKey: '',
      envCsv: 'u1',
      envBaseUrl: 'https://canary.sf',
      envApiKey: 'canary-key',
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('env_canary');
  });
});

describe('SfConnectionResolver — env canary path (priority 2)', () => {
  it('no row + userId in CSV + env complete → env_canary enabled', async () => {
    const { svc } = buildSvc({
      connectionRow: null,
      envCsv: 'u1,u2',
      envBaseUrl: 'https://canary.sf',
      envApiKey: 'canary-key',
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(true);
    expect(r.source).toBe('env_canary');
    expect(r.baseUrl).toBe('https://canary.sf');
    expect(r.orchestrationToken).toBe('canary-key');
  });

  it('no row + userId NOT in CSV → disabled', async () => {
    const { svc } = buildSvc({
      connectionRow: null,
      envCsv: 'u2,u3',
      envBaseUrl: 'https://canary.sf',
      envApiKey: 'canary-key',
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(false);
  });

  it('no row + CSV match + env partial (base set, key missing) → disabled', async () => {
    const { svc } = buildSvc({
      connectionRow: null,
      envCsv: 'u1',
      envBaseUrl: 'https://canary.sf',
      envApiKey: '',
    });
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(false);
  });

  it('CSV tolerates whitespace + empty entries', async () => {
    const { svc } = buildSvc({
      connectionRow: null,
      envCsv: '  u1 , , u2 , ',
      envBaseUrl: 'https://canary.sf',
      envApiKey: 'canary-key',
    });
    expect((await svc.resolveForUser('u1')).enabled).toBe(true);
    expect((await svc.resolveForUser('u2')).enabled).toBe(true);
    expect((await svc.resolveForUser('u3')).enabled).toBe(false);
  });
});

describe('SfConnectionResolver — none / safety', () => {
  it('all unset (current prod state) → every user returns disabled', async () => {
    const { svc } = buildSvc({});
    const r = await svc.resolveForUser('u1');
    expect(r.enabled).toBe(false);
    expect(r.source).toBe('none');
    expect(r.disabledReason).toBe('no_connection_or_canary');
  });

  it.each([null, undefined, ''])('falsy userId %s returns disabled with reason', async (v) => {
    const { svc } = buildSvc({});
    const r = await svc.resolveForUser(v as any);
    expect(r.enabled).toBe(false);
    expect(r.disabledReason).toBe('no_userid');
  });
});

describe('SfConnectionResolver — tenant isolation', () => {
  it('findUnique is keyed on userId — never returns another tenant by accident', async () => {
    const { svc, prisma } = buildSvc({ connectionRow: makeActiveConnection() });
    await svc.resolveForUser('u1');
    const where = prisma.sfConnection.findUnique.mock.calls[0][0].where;
    expect(where).toEqual({ userId: 'u1' });
  });

  it('returns disabled for u2 even when u1 has an active connection — prisma keyed on userId', async () => {
    // Simulate: prisma returns the row only for u1's query
    const calls: any[] = [];
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async (args: any) => {
          calls.push(args.where.userId);
          if (args.where.userId === 'u1') return makeActiveConnection();
          return null;
        }),
        update: jest.fn(),
      },
    };
    const cfg = { get: () => ENCRYPTION_KEY } as any as ConfigService;
    const svc = new SfConnectionResolver(prisma, cfg);
    const r1 = await svc.resolveForUser('u1');
    const r2 = await svc.resolveForUser('u2');
    expect(r1.enabled).toBe(true);
    expect(r2.enabled).toBe(false);
    expect(calls).toEqual(['u1', 'u2']);
  });
});

describe('SfConnectionResolver — isEnabledForUser convenience', () => {
  it('returns true when resolveForUser is enabled', async () => {
    const { svc } = buildSvc({ connectionRow: makeActiveConnection() });
    expect(await svc.isEnabledForUser('u1')).toBe(true);
  });

  it('returns false when resolveForUser is disabled', async () => {
    const { svc } = buildSvc({});
    expect(await svc.isEnabledForUser('u1')).toBe(false);
  });
});
