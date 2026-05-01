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
} = {}) {
  // $queryRawUnsafe returns whatever we want based on which check is running.
  // Match in declaration order so the simple call signature is preserved.
  const queries = [
    state.nonCanonical ?? [],
    state.driftLegacy ?? [],
    state.sfLinkedDrift ?? [],
    state.inboundErrors ?? [],
    state.outboundFailures ?? [],
  ];
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
  const integrity = new PipelineIntegrityService(prisma);
  const svc = new MonitoringService(prisma, buildConfig(), integrity);
  return { svc, integrity };
}

describe('PipelineIntegrityService.runChecks', () => {
  it('returns ok=true and zero failed checks when all queries return empty', async () => {
    const prisma = buildPrismaMock();
    const { integrity } = buildSvc(prisma);

    const result = await integrity.runChecks();

    expect(result.ok).toBe(true);
    expect(result.failedCount).toBe(0);
    expect(result.results).toHaveLength(5);
    expect(result.results.every((r) => r.severity === 'ok')).toBe(true);
    expect(result.summary).toMatch(/All 5 integrity checks passed/);
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
    expect(ctx.results).toHaveLength(5);
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
