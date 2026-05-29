import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import { SfRotationRefreshService } from './sf-rotation-refresh.service';

const ENC_KEY = 'rot-refresh-test-key-32-bytes-long-ok';
const CURRENT_PLAINTEXT_TOKEN = 'sfo_v1.CURRENT_BEARER_VALUE';

// Capture all log output across log/warn/error so the no-plaintext-token
// test can scan the full surface in one place.
class CapturingLogger extends Logger {
  public lines: string[] = [];
  log(m: any) { this.lines.push(String(m)); }
  warn(m: any) { this.lines.push(String(m)); }
  error(m: any) { this.lines.push(String(m)); }
  debug(m: any) { this.lines.push(String(m)); }
  verbose(m: any) { this.lines.push(String(m)); }
}

function activeRotationPendingRow(over: any = {}) {
  return {
    id: 'conn-1',
    userId: 'u1',
    sfTenantId: '99999',
    baseUrl: 'https://sf.example.com',
    endpointsJson: JSON.stringify({
      availability: '/a', booking_request: '/b', booking_cancel: '/c',
      handoff: '/h', disconnect: '/d',
      credentials_refresh: '/api/integrations/leadbridge/orchestration/credentials/refresh',
    }),
    orchestrationToken: EncryptionUtil.encrypt(CURRENT_PLAINTEXT_TOKEN, ENC_KEY),
    orchestrationTokenKid: 'sf_orch_2026_05',
    tokenPrefix: 'sfo_v1.CURREN',
    tokenIssuedAt: new Date('2026-05-28T20:00:00Z'),
    isActive: true,
    status: 'active',
    rotationPending: true,
    pendingRotationKid: 'sf_orch_2026_05',
    pendingRotationCredId: '12',
    pendingRotationGraceExpiresAt: new Date(Date.now() + 4 * 60 * 1000), // 4 min remaining
    ...over,
  };
}

function buildPrisma(opts: {
  row?: any;
  lockAcquired?: boolean;
  updateCapture?: { spy?: jest.Mock };
} = {}) {
  const updateSpy = opts.updateCapture?.spy ?? jest.fn(async (args: any) => args.data);
  // The service uses $transaction(callback, opts). We simulate by passing in a
  // tx-like object that proxies to the same mocked sfConnection methods plus a
  // $queryRaw that controls the advisory lock outcome.
  const tx: any = {
    $queryRaw: jest.fn(async () => [{ locked: opts.lockAcquired !== false }]),
    sfConnection: {
      findUnique: jest.fn(async () => opts.row ?? null),
      update: updateSpy,
    },
  };
  const prisma: any = {
    sfConnection: { findMany: jest.fn(async () => []) },
    $transaction: jest.fn(async (cb: any) => cb(tx)),
  };
  return { prisma, tx, updateSpy };
}

function buildSvc(opts: {
  fetchImpl?: jest.Mock;
  row?: any;
  lockAcquired?: boolean;
  lifecycleOverrides?: any;
} = {}) {
  const { prisma, tx, updateSpy } = buildPrisma({ row: opts.row, lockAcquired: opts.lockAcquired });
  const cfg = {
    get: jest.fn((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)),
  } as any as ConfigService;
  const lifecycle: any = {
    applyCredentialRefresh: jest.fn(async () => ({ ok: true, connectionId: 'conn-1' })),
    applyConnectionRevoked: jest.fn(async () => ({ ok: true })),
    ...opts.lifecycleOverrides,
  };
  const svc = new SfRotationRefreshService(prisma, cfg, lifecycle);
  const capturingLogger = new CapturingLogger();
  // @ts-expect-error — replace private logger for capture
  svc['logger'] = capturingLogger;

  const fetchOriginal = global.fetch;
  global.fetch = opts.fetchImpl ?? jest.fn() as any;

  return {
    svc, prisma, tx, lifecycle, capturingLogger, updateSpy,
    restore: () => { global.fetch = fetchOriginal; },
  };
}

describe('SfRotationRefreshService.refreshIfPending', () => {
  // ── 200 success ─────────────────────────────────────────────────
  it('200 success → applyCredentialRefresh + event=success log', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        credential: {
          token: 'sfo_v1.NEW_BEARER',
          token_prefix: 'sfo_v1.NEW_BE',
          kid: 'sf_orch_2026_05',
          scope: 'lb_orchestration',
          issued_at: '2026-05-29T01:00:00Z',
          expires_at: '2026-08-27T01:00:00Z',
          cred_id: 12,
        },
        signature_metadata: { algorithm: 'hmac-sha256-hex', max_clock_skew_seconds: 300 },
        previous_grace_remaining_seconds: 280,
      }),
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('refreshed');
      expect((r as any).newCredId).toBe('12');
      expect((r as any).newKid).toBe('sf_orch_2026_05');
      expect(ctx.lifecycle.applyCredentialRefresh).toHaveBeenCalledTimes(1);
      const arg = ctx.lifecycle.applyCredentialRefresh.mock.calls[0][0];
      expect(arg.userId).toBe('u1');
      expect(arg.newToken).toBe('sfo_v1.NEW_BEARER');
      expect(arg.newKid).toBe('sf_orch_2026_05');
      expect(arg.newCredId).toBe(12);
      expect(arg.previousGraceRemainingSeconds).toBe(280);
      expect(ctx.lifecycle.applyConnectionRevoked).not.toHaveBeenCalled();
      // Success log emitted
      expect(ctx.capturingLogger.lines.some(l => l.includes('event=success') && l.includes('new_cred_id=12'))).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── 409 no_pending_rotation ─────────────────────────────────────
  it('409 → clears local pending + event=refresh_acked_no_pending', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 409,
      text: async () => JSON.stringify({ error: 'no_pending_rotation', current_cred_id: 11 }),
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('no_pending');
      expect(ctx.tx.sfConnection.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'conn-1' },
        data: expect.objectContaining({
          rotationPending: false,
          pendingRotationKid: null,
          pendingRotationCredId: null,
          pendingRotationGraceExpiresAt: null,
          pendingRotationObservedAt: null,
        }),
      }));
      expect(ctx.lifecycle.applyCredentialRefresh).not.toHaveBeenCalled();
      expect(ctx.capturingLogger.lines.some(l => l.includes('refresh_acked_no_pending'))).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── 401 invalid credential ──────────────────────────────────────
  it('401 → status=error, lastErrorMessage set, no token mutation, ERROR log', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 401,
      text: async () => JSON.stringify({ error: 'current_credential_invalid', reason: 'expired' }),
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('invalid_credential');
      expect(ctx.tx.sfConnection.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: 'error',
          lastErrorMessage: 'refresh_failed_current_invalid',
        }),
      }));
      // No new token written
      const updateData = ctx.tx.sfConnection.update.mock.calls[0][0].data;
      expect(updateData.orchestrationToken).toBeUndefined();
      expect(ctx.capturingLogger.lines.some(l => l.includes('event=refresh_failed') && l.includes('status=401'))).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── 410 connection revoked ──────────────────────────────────────
  it('410 → mirrors connection.revoked path via applyConnectionRevoked', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 410,
      text: async () => JSON.stringify({ error: 'connection_revoked', actor: 'user' }),
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('revoked');
      expect(ctx.lifecycle.applyConnectionRevoked).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'u1',
        initiator: 'sf_authority',
      }));
      expect(ctx.capturingLogger.lines.some(l => l.includes('event=connection_revoked'))).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── 5xx transient ──────────────────────────────────────────────
  it('5xx → transient_failure (retryable), NO state mutation', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 503,
      text: async () => 'Service Unavailable',
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('transient_failure');
      expect((r as any).status).toBe(503);
      expect((r as any).retryable).toBe(true);
      expect(ctx.tx.sfConnection.update).not.toHaveBeenCalled();
      expect(ctx.lifecycle.applyCredentialRefresh).not.toHaveBeenCalled();
      expect(ctx.lifecycle.applyConnectionRevoked).not.toHaveBeenCalled();
    } finally { ctx.restore(); }
  });

  it('network error / abort → transient_failure', async () => {
    const fetchMock = jest.fn(async () => { throw new Error('ECONNRESET'); });
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(r.kind).toBe('transient_failure');
      expect((r as any).retryable).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── advisory lock contention ────────────────────────────────────
  it('lock contention → skipped (locked_by_peer), no SF call', async () => {
    const fetchMock = jest.fn();
    const ctx = buildSvc({
      fetchImpl: fetchMock as any,
      row: activeRotationPendingRow(),
      lockAcquired: false,
    });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'worker_scan');
      expect(r.kind).toBe('skipped');
      expect((r as any).reason).toBe('locked_by_peer');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ctx.lifecycle.applyCredentialRefresh).not.toHaveBeenCalled();
    } finally { ctx.restore(); }
  });

  // ── skip cases (no_connection / not pending / status not active) ─
  it('row missing → skipped (no_connection)', async () => {
    const ctx = buildSvc({ row: null });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'worker_scan');
      expect(r.kind).toBe('skipped');
      expect((r as any).reason).toBe('no_connection');
    } finally { ctx.restore(); }
  });

  it('rotationPending=false → skipped (no_rotation_pending)', async () => {
    const ctx = buildSvc({ row: activeRotationPendingRow({ rotationPending: false }) });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'worker_scan');
      expect(r.kind).toBe('skipped');
      expect((r as any).reason).toBe('no_rotation_pending');
    } finally { ctx.restore(); }
  });

  it('status not active → skipped', async () => {
    const ctx = buildSvc({ row: activeRotationPendingRow({ status: 'rotating' }) });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'worker_scan');
      expect(r.kind).toBe('skipped');
      expect((r as any).reason).toBe('status_rotating');
    } finally { ctx.restore(); }
  });

  it('grace too close → skipped + ERROR log', async () => {
    const fetchMock = jest.fn();
    const ctx = buildSvc({
      fetchImpl: fetchMock as any,
      row: activeRotationPendingRow({
        pendingRotationGraceExpiresAt: new Date(Date.now() + 30_000), // 30s remaining < 60s threshold
      }),
    });
    try {
      const r = await ctx.svc.refreshIfPending('conn-1', 'worker_scan');
      expect(r.kind).toBe('skipped');
      expect((r as any).reason).toBe('grace_too_close');
      expect(fetchMock).not.toHaveBeenCalled();
      expect(ctx.capturingLogger.lines.some(l => l.includes('grace_too_close'))).toBe(true);
    } finally { ctx.restore(); }
  });

  // ── endpoint URL: prefers endpointsJson, falls back ─────────────
  it('uses endpoints.credentials_refresh from endpointsJson when present', async () => {
    const fetchMock = jest.fn(async () => ({ status: 503, text: async () => '' } as any));
    const customPath = '/sf/custom/refresh/path';
    const ctx = buildSvc({
      fetchImpl: fetchMock as any,
      row: activeRotationPendingRow({
        endpointsJson: JSON.stringify({ credentials_refresh: customPath }),
      }),
    });
    try {
      await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const url = (fetchMock.mock.calls[0] as any)[0];
      expect(url).toBe('https://sf.example.com' + customPath);
    } finally { ctx.restore(); }
  });

  it('falls back to /api/integrations/leadbridge/orchestration/credentials/refresh when endpointsJson missing the key', async () => {
    const fetchMock = jest.fn(async () => ({ status: 503, text: async () => '' } as any));
    const ctx = buildSvc({
      fetchImpl: fetchMock as any,
      row: activeRotationPendingRow({
        endpointsJson: JSON.stringify({ availability: '/a' }), // no credentials_refresh
      }),
    });
    try {
      await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      const url = (fetchMock.mock.calls[0] as any)[0];
      expect(url).toBe('https://sf.example.com/api/integrations/leadbridge/orchestration/credentials/refresh');
    } finally { ctx.restore(); }
  });

  it('falls back when endpointsJson is null entirely', async () => {
    const fetchMock = jest.fn(async () => ({ status: 503, text: async () => '' } as any));
    const ctx = buildSvc({
      fetchImpl: fetchMock as any,
      row: activeRotationPendingRow({ endpointsJson: null }),
    });
    try {
      await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      const url = (fetchMock.mock.calls[0] as any)[0];
      expect(url).toBe('https://sf.example.com/api/integrations/leadbridge/orchestration/credentials/refresh');
    } finally { ctx.restore(); }
  });

  // ── request shape ───────────────────────────────────────────────
  it('sends current bearer as Authorization + correct request body', async () => {
    const fetchMock = jest.fn(async () => ({ status: 503, text: async () => '' } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      const init = (fetchMock.mock.calls[0] as any)[1];
      expect(init.method).toBe('POST');
      expect(init.headers['Authorization']).toBe('Bearer ' + CURRENT_PLAINTEXT_TOKEN);
      expect(init.headers['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body);
      expect(body.pending_cred_id).toBe('12');
      expect(body.tenant_id).toBe('99999');
    } finally { ctx.restore(); }
  });

  // ── plaintext token never logged ────────────────────────────────
  it('NEVER logs the plaintext bearer (current or new)', async () => {
    const fetchMock = jest.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({
        credential: {
          token: 'sfo_v1.SUPER_SECRET_NEW_TOKEN_DO_NOT_LEAK',
          token_prefix: 'sfo_v1.SUPER_',
          kid: 'sf_orch_2026_05', scope: 'lb_orchestration',
          issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
          cred_id: 99,
        },
        previous_grace_remaining_seconds: 280,
      }),
    } as any));
    const ctx = buildSvc({ fetchImpl: fetchMock as any, row: activeRotationPendingRow() });
    try {
      await ctx.svc.refreshIfPending('conn-1', 'webhook_immediate');
      const allLogs = ctx.capturingLogger.lines.join('\n');
      // Neither the current bearer plaintext NOR the new one may appear
      expect(allLogs).not.toContain(CURRENT_PLAINTEXT_TOKEN);
      expect(allLogs).not.toContain('SUPER_SECRET_NEW_TOKEN_DO_NOT_LEAK');
      // Token prefix is OK (designed-safe 13 chars)
      expect(allLogs).toMatch(/event=success/);
    } finally { ctx.restore(); }
  });
});

describe('SfRotationRefreshService.triggerImmediate (webhook fire-and-forget)', () => {
  it('triggers refresh asynchronously without awaiting (fire-and-forget)', async () => {
    const ctx = buildSvc({
      fetchImpl: jest.fn(async () => ({ status: 503, text: async () => '' } as any)) as any,
      row: activeRotationPendingRow(),
    });
    try {
      // Call returns void synchronously
      const r = ctx.svc.triggerImmediate('conn-1');
      expect(r).toBeUndefined();
      // Wait for the setImmediate-scheduled work
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      expect((global.fetch as jest.Mock)).toHaveBeenCalled();
    } finally { ctx.restore(); }
  });

  it('refreshIfPending error path: tx rejection converted to transient_failure + WARN log; triggerImmediate never throws', async () => {
    // Force a throw by making prisma.$transaction reject. The service's
    // outer catch converts this to a transient_failure outcome + WARN log.
    // triggerImmediate's own catch is a defensive last-resort safety net
    // that only fires if refreshIfPending itself somehow throws unhandled
    // (it doesn't in normal operation).
    const ctx = buildSvc({ row: activeRotationPendingRow() });
    (ctx.prisma.$transaction as jest.Mock).mockRejectedValueOnce(new Error('db down'));
    try {
      // triggerImmediate returns void synchronously and must never throw
      expect(() => ctx.svc.triggerImmediate('conn-1')).not.toThrow();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
      // The WARN-level refresh_failed log fires for the tx error
      expect(ctx.capturingLogger.lines.some(l =>
        l.includes('event=refresh_failed') && l.includes('db down')
      )).toBe(true);
    } finally { ctx.restore(); }
  });
});

describe('SfRotationRefreshService.scanForPendingRefresh (worker safety net)', () => {
  it('queries only rows in (now+60s, now+4min) grace window + calls refreshIfPending per row', async () => {
    const row = activeRotationPendingRow();
    const tx: any = {
      $queryRaw: jest.fn(async () => [{ locked: true }]),
      sfConnection: { findUnique: jest.fn(async () => row), update: jest.fn() },
    };
    const prisma: any = {
      sfConnection: { findMany: jest.fn(async () => [{ id: 'conn-1', userId: 'u1', pendingRotationCredId: '12' }]) },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
    };
    const cfg = { get: jest.fn(() => ENC_KEY) } as any as ConfigService;
    const lifecycle: any = { applyCredentialRefresh: jest.fn(), applyConnectionRevoked: jest.fn() };
    const svc = new SfRotationRefreshService(prisma, cfg, lifecycle);
    const fetchOriginal = global.fetch;
    global.fetch = jest.fn(async () => ({ status: 503, text: async () => '' } as any)) as any;
    try {
      await svc.scanForPendingRefresh();
      const where = prisma.sfConnection.findMany.mock.calls[0][0].where;
      expect(where.rotationPending).toBe(true);
      expect(where.isActive).toBe(true);
      expect(where.status).toBe('active');
      expect(where.pendingRotationGraceExpiresAt).toBeDefined();
      expect(where.pendingRotationGraceExpiresAt.gt).toBeInstanceOf(Date);
      expect(where.pendingRotationGraceExpiresAt.lt).toBeInstanceOf(Date);
      const upperBound = where.pendingRotationGraceExpiresAt.lt as Date;
      const lowerBound = where.pendingRotationGraceExpiresAt.gt as Date;
      expect(upperBound.getTime() - lowerBound.getTime()).toBe((4 * 60 - 60) * 1000); // 180s window
      // refreshIfPending invoked once per row
      expect(prisma.$transaction).toHaveBeenCalled();
    } finally {
      global.fetch = fetchOriginal;
    }
  });

  it('no-ops when no rows pending', async () => {
    const prisma: any = {
      sfConnection: { findMany: jest.fn(async () => []) },
      $transaction: jest.fn(),
    };
    const cfg = { get: jest.fn(() => ENC_KEY) } as any as ConfigService;
    const lifecycle: any = { applyCredentialRefresh: jest.fn(), applyConnectionRevoked: jest.fn() };
    const svc = new SfRotationRefreshService(prisma, cfg, lifecycle);
    await svc.scanForPendingRefresh();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('does NOT re-enter while a prior scan is in flight (self-throttle)', async () => {
    let resolveScan: (rows: any[]) => void = () => {};
    const findManyPromise = new Promise<any[]>(resolve => { resolveScan = resolve; });
    const prisma: any = {
      sfConnection: { findMany: jest.fn(() => findManyPromise) },
      $transaction: jest.fn(),
    };
    const cfg = { get: jest.fn(() => ENC_KEY) } as any as ConfigService;
    const lifecycle: any = { applyCredentialRefresh: jest.fn(), applyConnectionRevoked: jest.fn() };
    const svc = new SfRotationRefreshService(prisma, cfg, lifecycle);
    const first = svc.scanForPendingRefresh();
    const second = svc.scanForPendingRefresh(); // re-entry while first is in flight
    resolveScan([]);
    await Promise.all([first, second]);
    // findMany should only have been called once (second was self-throttled)
    expect(prisma.sfConnection.findMany).toHaveBeenCalledTimes(1);
  });
});
