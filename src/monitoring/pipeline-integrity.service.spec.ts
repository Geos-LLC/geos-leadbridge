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

function buildConfig() {
  return { get: (_k: string, def?: any) => def } as any;
}

function buildSvc(prisma: any) {
  const config = buildConfig();
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
  function buildSvcForResolver(updateCount: number) {
    let unlockCalls = 0;
    let updateSql = '';
    const prisma: any = {
      $queryRawUnsafe: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock(7005)')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock(7005)')) {
          unlockCalls++;
          return [];
        }
        if (sql.includes('UPDATE notification_logs')) {
          updateSql = sql;
          return [{ count: updateCount }];
        }
        return [];
      }),
    };
    const config = { get: (_k: string, def?: any) => def } as any;
    const integrity = new PipelineIntegrityService(prisma, config);
    const svc = new MonitoringService(prisma, config, integrity);
    return { svc, prisma, getUnlockCalls: () => unlockCalls, getUpdateSql: () => updateSql };
  }

  it('runs the UPDATE to mark stale-pending rows as unknown', async () => {
    const { svc, prisma, getUpdateSql } = buildSvcForResolver(327);

    await svc.resolveStalePendingNotificationLogs();

    // Asserts the SQL preserves the soft-resolution rule documented at the
    // method definition: pending → unknown, gated by createdAt + INTERVAL.
    const sql = getUpdateSql();
    expect(sql).toContain("status = 'unknown'");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toMatch(/INTERVAL '6 hours'/);
    expect(prisma.$queryRawUnsafe).toHaveBeenCalled();
  });

  it('always releases the advisory lock, even if the update query throws', async () => {
    let unlockCalls = 0;
    const prisma: any = {
      $queryRawUnsafe: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock(7005)')) return [{ locked: true }];
        if (sql.includes('pg_advisory_unlock(7005)')) {
          unlockCalls++;
          return [];
        }
        if (sql.includes('UPDATE notification_logs')) {
          throw new Error('simulated DB outage');
        }
        return [];
      }),
    };
    const config = { get: (_k: string, def?: any) => def } as any;
    const integrity = new PipelineIntegrityService(prisma, config);
    const svc = new MonitoringService(prisma, config, integrity);

    // Cron methods log-and-swallow errors so the harness never crashes.
    await expect(svc.resolveStalePendingNotificationLogs()).resolves.toBeUndefined();
    expect(unlockCalls).toBe(1);
  });

  it('skips when another instance holds the advisory lock', async () => {
    const prisma: any = {
      $queryRawUnsafe: jest.fn().mockImplementation(async (sql: string) => {
        if (sql.includes('pg_try_advisory_lock(7005)')) return [{ locked: false }];
        return [];
      }),
    };
    const config = { get: (_k: string, def?: any) => def } as any;
    const integrity = new PipelineIntegrityService(prisma, config);
    const svc = new MonitoringService(prisma, config, integrity);

    await svc.resolveStalePendingNotificationLogs();

    // No UPDATE issued, no unlock attempted.
    const calls = (prisma.$queryRawUnsafe as jest.Mock).mock.calls.map((c) => c[0] as string);
    expect(calls.find((s) => s.includes('UPDATE notification_logs'))).toBeUndefined();
    expect(calls.find((s) => s.includes('pg_advisory_unlock'))).toBeUndefined();
  });
});
