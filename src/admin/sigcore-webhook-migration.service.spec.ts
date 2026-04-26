/**
 * SigcoreWebhookMigrationService — admin-triggered Twilio webhook migration.
 *
 * Covers:
 *  - URL construction for v1 (legacy) and v2 (tenant-scoped) routes
 *  - dryRun never calls Sigcore (network)
 *  - single-tenant filter narrows to one row
 *  - batch continues across per-tenant 5xx and per-tenant network errors
 *  - exact payload shape sent to Sigcore (`{ smsUrl, smsMethod: 'POST' }`,
 *    `x-api-key` header)
 *  - skip reasons surface for missing tenantId / phone
 */

import { SigcoreWebhookMigrationService } from './sigcore-webhook-migration.service';

const TENANT_A = '6a4eeca9-7620-4a1c-bb9b-14401c126563';
const TENANT_B = '38380c75-1876-4984-b194-5fda7529835c';

function buildPrismaMock(rows: Array<{
  savedAccountId: string;
  sigcoreTenantId: string | null;
  phones: Array<{ phoneNumber: string; status: string; purchasedAt: Date }>;
}>) {
  const ns = rows.map((r) => ({
    savedAccountId: r.savedAccountId,
    sigcoreTenantId: r.sigcoreTenantId,
  }));
  const allPhones = rows.flatMap((r) =>
    r.phones.map((p) => ({
      savedAccountId: r.savedAccountId,
      phoneNumber: p.phoneNumber,
      status: p.status,
      purchasedAt: p.purchasedAt,
    })),
  );
  return {
    notificationSettings: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        if (where?.sigcoreTenantId) {
          return Promise.resolve(ns.filter((n) => n.sigcoreTenantId === where.sigcoreTenantId));
        }
        return Promise.resolve(ns);
      }),
    },
    tenantPhoneNumber: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const ids: string[] = where?.savedAccountId?.in ?? [];
        const status = where?.status ?? 'ACTIVE';
        const filtered = allPhones.filter((p) => ids.includes(p.savedAccountId) && p.status === status);
        // Mimic orderBy purchasedAt: 'desc'
        filtered.sort((a, b) => b.purchasedAt.getTime() - a.purchasedAt.getTime());
        return Promise.resolve(filtered);
      }),
    },
  } as any;
}

function buildConfig(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((k: string, fallback?: string) => values[k] ?? fallback),
  } as any;
}

describe('SigcoreWebhookMigrationService.buildTargetUrl', () => {
  it('strips trailing /api from SIGCORE_API_URL when constructing both versions', () => {
    const cfg = buildConfig({ SIGCORE_API_URL: 'https://sigcore-production.up.railway.app/api' });
    const svc = new SigcoreWebhookMigrationService({} as any, cfg);

    expect(svc.buildTargetUrl('v2', TENANT_A)).toBe(
      `https://sigcore-production.up.railway.app/api/webhooks/twilio/sms/lb/${TENANT_A}`,
    );
    expect(svc.buildTargetUrl('v1', TENANT_A)).toBe(
      'https://sigcore-production.up.railway.app/api/webhooks/twilio/sms',
    );
  });

  it('handles SIGCORE_API_URL that already lacks /api suffix', () => {
    const cfg = buildConfig({ SIGCORE_API_URL: 'https://sigcore-production.up.railway.app' });
    const svc = new SigcoreWebhookMigrationService({} as any, cfg);

    expect(svc.buildTargetUrl('v2', TENANT_A)).toBe(
      `https://sigcore-production.up.railway.app/api/webhooks/twilio/sms/lb/${TENANT_A}`,
    );
  });

  it('prefers SIGCORE_CALL_CONNECT_URL over SIGCORE_API_URL when both set', () => {
    const cfg = buildConfig({
      SIGCORE_CALL_CONNECT_URL: 'https://sigcore-cc.up.railway.app/api',
      SIGCORE_API_URL: 'https://sigcore-other.up.railway.app/api',
    });
    const svc = new SigcoreWebhookMigrationService({} as any, cfg);

    expect(svc.buildTargetUrl('v2', TENANT_A)).toBe(
      `https://sigcore-cc.up.railway.app/api/webhooks/twilio/sms/lb/${TENANT_A}`,
    );
  });
});

describe('SigcoreWebhookMigrationService.migrate — dry run', () => {
  beforeEach(() => {
    // Hard guard: dry run must never reach the network
    (global as any).fetch = jest.fn(() => {
      throw new Error('dry-run reached fetch — bug');
    });
  });
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('emits per-tenant target URLs without calling Sigcore', async () => {
    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
      {
        savedAccountId: 'acct-B',
        sigcoreTenantId: TENANT_B,
        phones: [{ phoneNumber: '+16193303608', status: 'ACTIVE', purchasedAt: new Date('2026-02-01') }],
      },
    ]);
    const cfg = buildConfig({
      SIGCORE_API_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_API_KEY: 'platform-key',
    });
    const svc = new SigcoreWebhookMigrationService(prisma, cfg);

    const result = await svc.migrate({ dryRun: true, targetVersion: 'v2' });

    expect(result.dryRun).toBe(true);
    expect(result.targetVersion).toBe('v2');
    expect(result.summary.total).toBe(2);
    expect(result.summary.wouldMigrate).toBe(2);
    expect(result.tenants).toHaveLength(2);
    expect(result.tenants[0].result).toBe('dry_run');
    expect(result.tenants[0].targetUrl).toBe(
      `https://sigcore-production.up.railway.app/api/webhooks/twilio/sms/lb/${TENANT_A}`,
    );
    expect(result.tenants[0].wouldCall).toBe(
      `POST https://sigcore-production.up.railway.app/api/tenants/${TENANT_A}/phone-numbers/set-webhook-url`,
    );
  });

  it('marks rows with missing sigcoreTenantId as skipped', async () => {
    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-X',
        sigcoreTenantId: null,
        phones: [{ phoneNumber: '+15015015015', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api', SIGCORE_API_KEY: 'k' }),
    );

    const result = await svc.migrate({ dryRun: true });

    expect(result.tenants[0].result).toBe('skipped');
    expect(result.tenants[0].skipReason).toBe('missing_sigcore_tenant_id');
    expect(result.summary.wouldSkip).toBe(1);
    expect(result.summary.wouldMigrate).toBe(0);
  });

  it('marks rows with no ACTIVE phone as skipped', async () => {
    const prisma = buildPrismaMock([
      { savedAccountId: 'acct-X', sigcoreTenantId: TENANT_A, phones: [] },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api', SIGCORE_API_KEY: 'k' }),
    );

    const result = await svc.migrate({ dryRun: true });

    expect(result.tenants[0].result).toBe('skipped');
    expect(result.tenants[0].skipReason).toBe('no_active_phone_number');
  });
});

describe('SigcoreWebhookMigrationService.migrate — live runs', () => {
  let fetchMock: jest.Mock;
  beforeEach(() => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterEach(() => {
    delete (global as any).fetch;
  });

  it('sends correct URL, headers, and body to Sigcore for v2 migration', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('{"applied":true}'),
    });

    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
    ]);
    const cfg = buildConfig({
      SIGCORE_API_URL: 'https://sigcore-production.up.railway.app/api',
      SIGCORE_API_KEY: 'platform-key-xyz',
    });

    const svc = new SigcoreWebhookMigrationService(prisma, cfg);
    const result = await svc.migrate({ targetVersion: 'v2', delayMs: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `https://sigcore-production.up.railway.app/api/tenants/${TENANT_A}/phone-numbers/set-webhook-url`,
    );
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe('platform-key-xyz');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      smsUrl: `https://sigcore-production.up.railway.app/api/webhooks/twilio/sms/lb/${TENANT_A}`,
      smsMethod: 'POST',
    });
    expect(result.tenants[0].result).toBe('ok');
    expect(result.tenants[0].sigcoreStatus).toBe(200);
  });

  it('writes the v1 legacy URL when targetVersion=v1 (rollback)', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(''),
    });

    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({
        SIGCORE_API_URL: 'https://sigcore-production.up.railway.app/api',
        SIGCORE_API_KEY: 'k',
      }),
    );

    await svc.migrate({ targetVersion: 'v1', delayMs: 0 });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.smsUrl).toBe('https://sigcore-production.up.railway.app/api/webhooks/twilio/sms');
    expect(body.smsMethod).toBe('POST');
  });

  it('continues batch when one tenant returns 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 502, text: () => Promise.resolve('upstream timeout') })
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('{}') });

    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
      {
        savedAccountId: 'acct-B',
        sigcoreTenantId: TENANT_B,
        phones: [{ phoneNumber: '+16193303608', status: 'ACTIVE', purchasedAt: new Date('2026-02-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api', SIGCORE_API_KEY: 'k' }),
    );

    const result = await svc.migrate({ targetVersion: 'v2', delayMs: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.summary.succeeded).toBe(1);
    expect(result.summary.failed).toBe(1);
    expect(result.tenants[0].result).toBe('failed');
    expect(result.tenants[0].sigcoreStatus).toBe(502);
    expect(result.tenants[0].errorMessage).toContain('502');
    expect(result.tenants[1].result).toBe('ok');
  });

  it('continues batch when one tenant throws a network error', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ ok: true, status: 200, text: () => Promise.resolve('{}') });

    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
      {
        savedAccountId: 'acct-B',
        sigcoreTenantId: TENANT_B,
        phones: [{ phoneNumber: '+16193303608', status: 'ACTIVE', purchasedAt: new Date('2026-02-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api', SIGCORE_API_KEY: 'k' }),
    );

    const result = await svc.migrate({ targetVersion: 'v2', delayMs: 0 });

    expect(result.tenants[0].result).toBe('failed');
    expect(result.tenants[0].errorMessage).toBe('ECONNRESET');
    expect(result.tenants[0].sigcoreStatus).toBeUndefined();
    expect(result.tenants[1].result).toBe('ok');
  });

  it('single-tenant filter narrows the eligible set', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('{}') });

    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
      {
        savedAccountId: 'acct-B',
        sigcoreTenantId: TENANT_B,
        phones: [{ phoneNumber: '+16193303608', status: 'ACTIVE', purchasedAt: new Date('2026-02-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api', SIGCORE_API_KEY: 'k' }),
    );

    const result = await svc.migrate({ tenantId: TENANT_B, targetVersion: 'v2', delayMs: 0 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.tenants).toHaveLength(1);
    expect(result.tenants[0].sigcoreTenantId).toBe(TENANT_B);
  });

  it('throws if SIGCORE_API_KEY is missing on a live run', async () => {
    const prisma = buildPrismaMock([
      {
        savedAccountId: 'acct-A',
        sigcoreTenantId: TENANT_A,
        phones: [{ phoneNumber: '+19045778584', status: 'ACTIVE', purchasedAt: new Date('2026-01-01') }],
      },
    ]);
    const svc = new SigcoreWebhookMigrationService(
      prisma,
      buildConfig({ SIGCORE_API_URL: 'https://x/api' /* no API key */ }),
    );

    await expect(svc.migrate({ targetVersion: 'v2', delayMs: 0 })).rejects.toThrow(
      /SIGCORE_API_KEY is not configured/,
    );
  });
});
