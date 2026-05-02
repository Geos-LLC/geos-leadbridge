/**
 * Weekly pipeline integrity check tests (Phase 5).
 *
 * Covers the spec scenarios:
 *   1. clean run produces no incident
 *   2. failed run creates one incident
 *   3. duplicate failure dedupes correctly (re-run touches the same row)
 *
 * Plus a tight unit test of the runChecks() shape so SQL changes don't
 * silently regress the contract MonitoringService relies on.
 */

import { MonitoringService } from './monitoring.service';
import { PipelineIntegrityService } from './pipeline-integrity.service';

function buildPrismaMock(state: {
  // Per-check raw-row counts the queries should pretend to find
  nonCanonical?: Array<{ status: string; n: number }>;
  driftLegacy?: Array<{ platform: string; status: string; platformStatus: string; n: number }>;
  sfLinkedDrift?: Array<{ statusSource: string; status: string; n: number }>;
  inboundErrors?: Array<{ processingError: string; status: string; n: number }>;
  outboundFailures?: Array<{ reason: string; lastStatusCode: number | null; lastError: string | null; n: number }>;
  // Coverage check #6 — service issues a coverage query first and, only if
  // missing>0, a follow-up breakdown query. Tests opt into the breakdown.
  sfLinkCoverage?: Array<{ missing: number; eligible: number }>;
  sfLinkBreakdown?: Array<{ userId: string; platform: string; n: number }>;
} = {}) {
  // $queryRawUnsafe returns whatever we want based on which check is running.
  // Match in declaration order so the simple call signature is preserved.
  const queries: any[] = [
    state.nonCanonical ?? [],
    state.driftLegacy ?? [],
    state.sfLinkedDrift ?? [],
    state.inboundErrors ?? [],
    state.outboundFailures ?? [],
    state.sfLinkCoverage ?? [{ missing: 0, eligible: 0 }],
  ];
  // The breakdown query only fires when missing>0. Only enqueue it when
  // coverage indicates missing>0, so the index alignment stays predictable.
  if ((state.sfLinkCoverage?.[0]?.missing ?? 0) > 0) {
    queries.push(state.sfLinkBreakdown ?? []);
  }
  let queryIndex = 0;

  const errorRows: any[] = [];

  const mock: any = {
    $queryRawUnsafe: jest.fn().mockImplementation(async () => {
      const result = queries[queryIndex] ?? [];
      queryIndex++;
      if (queryIndex >= queries.length) queryIndex = 0; // reset for re-run scenarios
      return result;
    }),
    systemErrorLog: {
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        return errorRows.find((r) =>
          r.category === w.category &&
          r.code === w.code &&
          r.userId == null &&
          r.accountId == null &&
          r.resolved === false,
        ) ?? null;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row = { id: 'err-' + errorRows.length, resolved: false, ...data };
        errorRows.push(row);
        return row;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const r = errorRows.find((x) => x.id === where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
    },
    _errorRows: errorRows,
  };

  return mock;
}

function buildConfig(overrides: Record<string, any> = {}) {
  return {
    get: (k: string, def?: any) => (k in overrides ? overrides[k] : def),
  } as any;
}

function buildSvc(prisma: any, configOverrides: Record<string, any> = {}) {
  const config = buildConfig(configOverrides);
  // PipelineIntegrityService now reads SIGCORE_API_KEY for the webhook health
  // check. The test config returns undefined for it, so the check skips
  // silently (no Sigcore call, severity='ok'). That keeps existing tests
  // independent of network state.
  const integrity = new PipelineIntegrityService(prisma, config);
  const svc = new MonitoringService(prisma, config, integrity);
  return { svc, integrity };
}

describe('PipelineIntegrityService.runChecks', () => {
  it('returns ok=true and zero failed checks when all queries return empty', async () => {
    const prisma = buildPrismaMock();
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.results).toHaveLength(7);
    expect(result.results.every((r) => r.severity === 'ok')).toBe(true);
    expect(result.summary).toMatch(/All 7 integrity checks passed/);
  });

  it('returns ok=false with failed-check breakdown when drift exists', async () => {
    const prisma = buildPrismaMock({
      nonCanonical: [{ status: 'Open', n: 100 }],
      inboundErrors: [{ processingError: 'unmapped_status:foo', status: 'unmapped_status', n: 3 }],
    });
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(2);
    const failed = result.results.filter((r) => r.severity === 'fail').map((r) => r.check);
    expect(failed.sort()).toEqual(['lead_status_not_canonical', 'sf_inbound_processing_error_24h'].sort());
    expect(result.summary).toMatch(/lead_status_not_canonical=100/);
    expect(result.summary).toMatch(/sf_inbound_processing_error_24h=3/);
  });

  it('flags sf_link_missing as fail when missing >= floor AND ratio >= threshold', async () => {
    // 12 missing out of 20 eligible → 60% miss rate, exceeds floor=10 + ratio=0.5
    const prisma = buildPrismaMock({
      sfLinkCoverage: [{ missing: 12, eligible: 20 }],
      sfLinkBreakdown: [{ userId: 'user-aaaa', platform: 'thumbtack', n: 8 }],
    });
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(false);
    expect(result.failedCount).toBe(1);
    const linkCheck = result.results.find((r) => r.check === 'sf_link_missing');
    expect(linkCheck?.severity).toBe('fail');
    expect(linkCheck?.count).toBe(12);
    // Sample carries the denominator + per-user breakdown so alert consumers
    // can read what eligible/ratio was without re-running the query.
    expect(linkCheck?.sample?.[0]).toMatchObject({ eligible: 20, missing: 12, ratio: 0.6 });
    expect(linkCheck?.sample?.[1]).toMatchObject({ userId: 'user-aaaa', n: 8 });
    expect(result.summary).toMatch(/sf_link_missing=12/);
  });

  it('does not flag sf_link_missing when missing is below floor', async () => {
    // 5 missing — under floor of 10, even though ratio is high.
    const prisma = buildPrismaMock({
      sfLinkCoverage: [{ missing: 5, eligible: 6 }],
      sfLinkBreakdown: [{ userId: 'user-bbbb', platform: 'yelp', n: 5 }],
    });
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(true);
    const linkCheck = result.results.find((r) => r.check === 'sf_link_missing');
    expect(linkCheck?.severity).toBe('ok');
    expect(linkCheck?.count).toBe(5); // count is still surfaced for visibility
  });

  it('does not flag sf_link_missing when ratio is below threshold', async () => {
    // 15 missing of 100 eligible → 15%, under ratio threshold of 50%.
    const prisma = buildPrismaMock({
      sfLinkCoverage: [{ missing: 15, eligible: 100 }],
      sfLinkBreakdown: [{ userId: 'user-cccc', platform: 'thumbtack', n: 15 }],
    });
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(true);
    const linkCheck = result.results.find((r) => r.check === 'sf_link_missing');
    expect(linkCheck?.severity).toBe('ok');
  });

  it('skips sigcore_webhook_health when SIGCORE_WEBHOOK_HEALTH_OWNER does not match this host', async () => {
    // Gate use case: staging Sigcore subscription points at the production LB
    // host. Setting SIGCORE_WEBHOOK_HEALTH_OWNER to that production host on
    // every LB instance means staging skips the check (its expected URL host
    // is the staging host) while production runs it.
    const prisma = buildPrismaMock();
    const { integrity } = buildSvc(prisma, {
      // SIGCORE_API_KEY must be set so we get past the early-return guard and
      // reach the owner gate.
      SIGCORE_API_KEY: 'sc_test',
      // This instance resolves to staging:
      APP_BASE_URL: 'https://thumbtack-bridge-staging.up.railway.app',
      // …but the owner is the production host.
      SIGCORE_WEBHOOK_HEALTH_OWNER: 'thumbtack-bridge-production.up.railway.app',
    });

    const result = await integrity.runChecks();

    expect(result.ok).toBe(true);
    const wh = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(wh?.severity).toBe('ok');
    expect(wh?.count).toBe(0);
    // Skip path returns empty problems — we did not reach the Sigcore HTTP call.
    expect(wh?.sample).toEqual([]);
  });

  it('runs sigcore_webhook_health when SIGCORE_WEBHOOK_HEALTH_OWNER matches this host (reaches Sigcore call)', async () => {
    // When the owner matches, the gate falls through and we reach the Sigcore
    // HTTP call. Test asserts the gate doesn't short-circuit by stubbing fetch
    // to return an empty subscription list — which makes the check fail with
    // workspace_delivery_sub_missing, proving the call was attempted.
    const prisma = buildPrismaMock();
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    }) as any;

    try {
      const { integrity } = buildSvc(prisma, {
        SIGCORE_API_KEY: 'sc_test',
        APP_BASE_URL: 'https://thumbtack-bridge-production.up.railway.app',
        SIGCORE_WEBHOOK_HEALTH_OWNER: 'thumbtack-bridge-production.up.railway.app',
      });

      const result = await integrity.runChecks();

      const wh = result.results.find((r) => r.check === 'sigcore_webhook_health');
      expect(wh?.severity).toBe('fail');
      expect(wh?.count).toBe(1);
      expect(wh?.sample?.[0]).toMatchObject({ problem: 'workspace_delivery_sub_missing' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe('MonitoringService.weeklyPipelineIntegrityCheck', () => {
  it('clean run produces no SystemErrorLog incident', async () => {
    const prisma = buildPrismaMock(); // all empty → ok=true
    const { svc } = buildSvc(prisma);

    await svc.runPipelineIntegrityCheck();

    expect(prisma.systemErrorLog.create).not.toHaveBeenCalled();
    expect(prisma.systemErrorLog.update).not.toHaveBeenCalled();
    expect(prisma._errorRows).toHaveLength(0);
  });

  it('failed run creates exactly one SystemErrorLog incident with code=pipeline_integrity_failed', async () => {
    const prisma = buildPrismaMock({
      nonCanonical: [{ status: 'Open', n: 50 }],
    });
    const { svc } = buildSvc(prisma);

    await svc.runPipelineIntegrityCheck();

    expect(prisma.systemErrorLog.create).toHaveBeenCalledTimes(1);
    expect(prisma._errorRows).toHaveLength(1);
    const row = prisma._errorRows[0];
    expect(row.category).toBe('webhook');
    expect(row.code).toBe('pipeline_integrity_failed');
    expect(row.severity).toBe('error');
    expect(row.userId).toBeUndefined();
    expect(row.accountId).toBeUndefined();
    expect(row.message).toMatch(/lead_status_not_canonical=50/);
    expect(row.context).toBeTruthy();
    const ctx = JSON.parse(row.context);
    expect(ctx.failedCount).toBe(1);
    expect(ctx.results).toHaveLength(7);
    expect(ctx.trigger).toBe('manual');
  });

  it('duplicate failure dedupes — re-running while the same condition holds touches the existing row, not a new one', async () => {
    const prisma = buildPrismaMock({
      nonCanonical: [{ status: 'Open', n: 25 }],
    });
    const { svc } = buildSvc(prisma);

    await svc.runPipelineIntegrityCheck();
    await svc.runPipelineIntegrityCheck();

    // After two runs of the same failing condition: still ONE row.
    expect(prisma._errorRows).toHaveLength(1);
    expect(prisma.systemErrorLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.systemErrorLog.update).toHaveBeenCalledTimes(1);
    expect(prisma._errorRows[0].code).toBe('pipeline_integrity_failed');
  });
});

// ===========================================================================
// Sigcore webhook health check (added 2026-05-01 after the leadbridge360.com
// URL misconfiguration left every outbound SMS stuck at 'pending'). This is
// check #7 — it talks to Sigcore to verify the workspace delivery-status sub
// is configured correctly. Tests inject SIGCORE_API_KEY + BACKEND_PUBLIC_URL
// and stub fetch so we don't hit the network.
// ===========================================================================

describe('PipelineIntegrityService.runChecks — sigcore_webhook_health', () => {
  const HEALTHY_SUB = {
    id: 'sub-ws-1',
    tenantId: null,
    name: 'LeadBridge Delivery Notifications',
    webhookUrl: 'https://api.example.com/api/webhooks/sigcore/delivery-status',
    events: ['message.sent', 'message.delivered', 'message.failed'],
    status: 'active',
  };

  function configWithSigcore(overrides: Record<string, string> = {}): any {
    const env: Record<string, string> = {
      SIGCORE_API_KEY: 'sc_workspace_test',
      SIGCORE_API_URL: 'https://sigcore-test/api',
      BACKEND_PUBLIC_URL: 'https://api.example.com',
      ...overrides,
    };
    return { get: (k: string, def?: any) => env[k] ?? def };
  }

  function jsonResponse(body: any, status = 200): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('healthy sub → check passes', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [HEALTHY_SUB] }));

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
  });

  it('detects missing workspace delivery-status sub', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(jsonResponse({ data: [] })); // no subs

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    expect(check?.sample).toEqual(
      expect.arrayContaining([expect.objectContaining({ problem: 'workspace_delivery_sub_missing' })]),
    );
  });

  it('detects URL drift on the workspace delivery-status sub (the original bug)', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            ...HEALTHY_SUB,
            webhookUrl: 'https://www.leadbridge360.com/api/webhooks/sigcore/delivery-status',
          },
        ],
      }),
    );

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    const drift = check?.sample?.find((p: any) => p.problem === 'workspace_delivery_url_drift');
    expect(drift).toBeTruthy();
    expect(drift).toMatchObject({
      expected: 'https://api.example.com/api/webhooks/sigcore/delivery-status',
      actual: 'https://www.leadbridge360.com/api/webhooks/sigcore/delivery-status',
    });
  });

  it('detects events drift (missing delivered)', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ ...HEALTHY_SUB, events: ['message.sent'] }],
      }),
    );

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    const drift = check?.sample?.find((p: any) => p.problem === 'workspace_delivery_events_drift');
    expect(drift?.missingEvents).toEqual(expect.arrayContaining(['message.delivered', 'message.failed']));
  });

  it('detects status=paused on the workspace delivery-status sub', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [{ ...HEALTHY_SUB, status: 'paused' }],
      }),
    );

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    expect(check?.sample).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ problem: 'workspace_delivery_status_not_active', status: 'paused' }),
      ]),
    );
  });

  it('detects an LB-host sub registered for delivery events on the wrong endpoint', async () => {
    // The exact tenant ee06c09a misconfiguration we cleaned up on 2026-05-01.
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, configWithSigcore());
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          HEALTHY_SUB,
          {
            id: 'sub-bad-tenant',
            tenantId: 'tenant-mistake',
            name: 'LeadBridge Inbound SMS',
            webhookUrl: 'https://thumbtack-bridge-production.up.railway.app/api/webhooks/sigcore/inbound-sms',
            events: ['message.inbound', 'message.delivered', 'message.failed'],
            status: 'active',
          },
        ],
      }),
    );

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    const wrongEndpoint = check?.sample?.find((p: any) => p.problem === 'delivery_events_on_wrong_endpoint');
    expect(wrongEndpoint).toMatchObject({
      subId: 'sub-bad-tenant',
      tenantId: 'tenant-mistake',
    });
  });

  it('skips silently (severity=ok) when SIGCORE_API_KEY is not configured', async () => {
    // Dev/test environments without a workspace key shouldn't fail this check.
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, {
      get: (k: string, def?: any) => (k === 'BACKEND_PUBLIC_URL' ? 'https://api.example.com' : def),
    } as any);

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('ok');
    expect(check?.count).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('flags backend_url_unresolvable when only frontend hosts are configured', async () => {
    const prisma = buildPrismaMock();
    const integrity = new PipelineIntegrityService(prisma, {
      get: (k: string, def?: any) => {
        if (k === 'SIGCORE_API_KEY') return 'sc_test';
        if (k === 'APP_BASE_URL') return 'https://www.leadbridge360.com';
        return def;
      },
    } as any);

    const result = await integrity.runChecks();

    const check = result.results.find((r) => r.check === 'sigcore_webhook_health');
    expect(check?.severity).toBe('fail');
    expect(check?.sample).toEqual(
      expect.arrayContaining([expect.objectContaining({ problem: 'backend_url_unresolvable' })]),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Stale-pending NotificationLog resolver
//
// Background: the resolver bumps rows that have been status='pending' for
// longer than STALE_PENDING_HOURS to status='unknown', so the UI can render a
// honest "Sent (delivery not confirmed)" instead of leaving the row labelled
// "⌛ Pending" forever.
// ===========================================================================

describe('MonitoringService.resolveStalePendingNotificationLogs', () => {
  // Build a Prisma mock that replays the new xact-lock pattern:
  //   prisma.$transaction(async tx => {
  //     const rows = await tx.$queryRaw`SELECT pg_try_advisory_xact_lock(7005) AS locked`;
  //     ...
  //   })
  function buildSvcForResolver(opts: {
    updateCount?: number;
    lockHeldByOther?: boolean;
    updateThrows?: boolean;
  }) {
    let updateSql = '';
    const lockQueries: string[] = [];
    const unlockQueries: string[] = [];

    const prisma: any = {};
    prisma.$queryRaw = jest.fn().mockImplementation(async (strings: TemplateStringsArray, ..._values: any[]) => {
      const sql = strings.join(' ');
      if (/pg_try_advisory_xact_lock/.test(sql)) {
        lockQueries.push(sql);
        return [{ locked: !opts.lockHeldByOther }];
      }
      if (/pg_advisory_unlock/.test(sql)) {
        unlockQueries.push(sql);
      }
      return [];
    });
    prisma.$queryRawUnsafe = jest.fn().mockImplementation(async (sql: string) => {
      if (/pg_advisory_unlock/.test(sql)) {
        unlockQueries.push(sql);
        return [];
      }
      if (sql.includes('UPDATE notification_logs')) {
        if (opts.updateThrows) throw new Error('simulated DB outage');
        updateSql = sql;
        return [{ count: opts.updateCount ?? 0 }];
      }
      return [];
    });
    // $transaction passes the same mock as `tx`; if the callback throws we
    // surface the throw so the cron's outer try/catch is exercised — that's
    // the rollback path. The xact lock would auto-release at rollback in the
    // real DB; here we just verify no manual unlock query was issued.
    prisma.$transaction = jest.fn().mockImplementation(async (fn: any, _opts?: any) => fn(prisma));

    const config = { get: (_k: string, def?: any) => def } as any;
    const integrity = new PipelineIntegrityService(prisma, config);
    const svc = new MonitoringService(prisma, config, integrity);
    return {
      svc,
      prisma,
      getUpdateSql: () => updateSql,
      getLockQueries: () => lockQueries,
      getUnlockQueries: () => unlockQueries,
    };
  }

  it('acquires the xact lock and runs the UPDATE when no other instance holds it', async () => {
    const { svc, prisma, getUpdateSql, getLockQueries, getUnlockQueries } = buildSvcForResolver({
      updateCount: 327,
    });

    await svc.resolveStalePendingNotificationLogs();

    // 1. Transaction was opened and the lock acquired via the xact-scoped form.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const lockQueries = getLockQueries();
    expect(lockQueries).toHaveLength(1);
    expect(lockQueries[0]).toMatch(/pg_try_advisory_xact_lock/);

    // 2. UPDATE actually ran with the documented soft-resolution rule.
    const sql = getUpdateSql();
    expect(sql).toContain("status = 'unknown'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toMatch(/INTERVAL '6 hours'/);

    // 3. No manual unlock — the lock auto-releases at transaction commit.
    expect(getUnlockQueries()).toHaveLength(0);
  });

  it('rolls the transaction back when the update throws — no manual unlock needed', async () => {
    const { svc, prisma, getUnlockQueries } = buildSvcForResolver({ updateThrows: true });

    // Cron methods log-and-swallow errors so the harness never crashes.
    await expect(svc.resolveStalePendingNotificationLogs()).resolves.toBeUndefined();

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Auto-release on rollback: no explicit pg_advisory_unlock query was ever issued.
    expect(getUnlockQueries()).toHaveLength(0);
  });

  it('skips when another instance holds the xact lock', async () => {
    const { svc, prisma, getUpdateSql, getUnlockQueries } = buildSvcForResolver({ lockHeldByOther: true });

    await svc.resolveStalePendingNotificationLogs();

    // The transaction is opened (to attempt the lock) but the work callback
    // never runs and no UPDATE is issued.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(getUpdateSql()).toBe('');
    // And of course no unlock — there's nothing to unlock manually anyway.
    expect(getUnlockQueries()).toHaveLength(0);
  });
});

// ===========================================================================
// Cron lock contract — the new pattern is uniform across systemHealthCheck (7003),
// resolveStalePendingNotificationLogs (7005), and weeklyPipelineIntegrityCheck
// (7004). Verify the four invariants the spec calls out:
//   1. lock acquired → callback runs
//   2. lock not acquired → callback is skipped
//   3. callback throws → transaction rolls back; no manual unlock needed
//   4. no `pg_advisory_unlock` call exists anywhere in the service source
// ===========================================================================

describe('MonitoringService cron-lock contract', () => {
  function buildHarness(opts: { lockHeldByOther?: boolean; workThrows?: boolean }) {
    const calls = {
      lockQueries: [] as string[],
      unlockQueries: [] as string[],
      transactionCalls: 0,
      updateRan: false,
    };
    const prisma: any = {};
    prisma.$queryRaw = jest.fn().mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = strings.join(' ');
      if (/pg_try_advisory_xact_lock/.test(sql)) {
        calls.lockQueries.push(sql);
        return [{ locked: !opts.lockHeldByOther }];
      }
      if (/pg_advisory_unlock/.test(sql)) calls.unlockQueries.push(sql);
      return [];
    });
    prisma.$queryRawUnsafe = jest.fn().mockImplementation(async (sql: string) => {
      if (/pg_advisory_unlock/.test(sql)) {
        calls.unlockQueries.push(sql);
        return [];
      }
      if (sql.includes('UPDATE notification_logs')) {
        if (opts.workThrows) throw new Error('boom');
        calls.updateRan = true;
        return [{ count: 5 }];
      }
      return [];
    });
    prisma.$transaction = jest.fn().mockImplementation(async (fn: any) => {
      calls.transactionCalls++;
      return fn(prisma);
    });
    const config = { get: (_k: string, def?: any) => def } as any;
    const integrity = new PipelineIntegrityService(prisma, config);
    const svc = new MonitoringService(prisma, config, integrity);
    return { svc, prisma, calls };
  }

  it('1. lock acquired → checks run', async () => {
    const { svc, calls } = buildHarness({});
    await svc.resolveStalePendingNotificationLogs();
    expect(calls.transactionCalls).toBe(1);
    expect(calls.lockQueries[0]).toMatch(/pg_try_advisory_xact_lock\([\s\S]*?\) AS locked/);
    expect(calls.updateRan).toBe(true);
  });

  it('2. lock not acquired → skips without doing the work', async () => {
    const { svc, calls } = buildHarness({ lockHeldByOther: true });
    await svc.resolveStalePendingNotificationLogs();
    expect(calls.transactionCalls).toBe(1);
    expect(calls.lockQueries).toHaveLength(1);
    expect(calls.updateRan).toBe(false);
  });

  it('3. work throws → transaction rolls back / lock auto-releases (no manual unlock)', async () => {
    const { svc, calls } = buildHarness({ workThrows: true });
    // Cron swallows the error.
    await expect(svc.resolveStalePendingNotificationLogs()).resolves.toBeUndefined();
    expect(calls.transactionCalls).toBe(1);
    // The work attempt happened (we entered the callback) but the explicit
    // unlock path is never traversed — Postgres auto-releases on rollback.
    expect(calls.unlockQueries).toHaveLength(0);
  });

  it('4. no explicit pg_advisory_unlock call remains in monitoring.service.ts source', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, 'monitoring.service.ts'),
      'utf8',
    );
    // Strip block + line comments so we only inspect executable code. The
    // comment block on the helper deliberately mentions the old function name
    // to explain why we replaced it.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/pg_advisory_unlock/);
    // The session-scoped form should also be gone — only the xact-scoped
    // variant survives.
    expect(code).not.toMatch(/pg_try_advisory_lock\b/);
    expect(code).toMatch(/pg_try_advisory_xact_lock/);
  });
});
