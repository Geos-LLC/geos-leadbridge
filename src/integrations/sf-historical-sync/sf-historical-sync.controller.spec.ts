/**
 * SfHistoricalSyncController tests — focused on HMAC enforcement +
 * basic request validation on the public (SF-facing) endpoints.
 *
 * The admin endpoints are protected by JwtAuthGuard + AdminGuard +
 * @RequiresSupportGrant; routing/auth coverage for those lives in
 * end-to-end tests. Here we cover the HMAC-signed public surface
 * because that's where SF will integrate and where a bug is most
 * costly.
 */
import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SfHistoricalSyncController } from './sf-historical-sync.controller';

const SHARED = 'test-shared-secret-32-bytes-long-abcdef';

function buildController(syncOverrides: any = {}) {
  const sync: any = {
    candidates: jest.fn().mockResolvedValue([]),
    manualLink: jest.fn(),
    applyBulkLink: jest.fn(),
    dashboard: jest.fn(),
    enumerateOnTrigger: jest.fn(),
    ...syncOverrides,
  };
  const cfg = {
    get: jest.fn((k: string) => (k === 'SF_LB_PROVISIONING_SHARED_SECRET' ? SHARED : null)),
  } as unknown as ConfigService;
  const audit: any = { logAccess: jest.fn() };
  return { controller: new SfHistoricalSyncController(sync, cfg, audit), sync };
}

function sign(ts: string, body: string): string {
  return crypto.createHmac('sha256', SHARED).update(`${ts}.${body}`).digest('hex');
}

function buildReq(rawBody: string, headers: Record<string, string>) {
  return {
    rawBody: Buffer.from(rawBody, 'utf8'),
    body: JSON.parse(rawBody),
    headers,
  } as any;
}

describe('SfHistoricalSyncController — sfCandidates (SF pull endpoint)', () => {
  it('rejects missing HMAC headers', async () => {
    const { controller } = buildController();
    const body = JSON.stringify({ user_id: 'u1' });
    const r = await controller.sfCandidates(buildReq(body, {}), { user_id: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_headers');
  });

  it('rejects bad signature', async () => {
    const { controller } = buildController();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ user_id: 'u1' });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': 'a'.repeat(64),
    });
    const r = await controller.sfCandidates(req, { user_id: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('signature_mismatch');
  });

  it('rejects when user_id missing from body', async () => {
    const { controller } = buildController();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({});
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    const r = await controller.sfCandidates(req, {});
    expect(r.ok).toBe(false);
    expect(r.error).toBe('user_id_required');
  });

  it('happy path: returns candidates from service', async () => {
    const fakeRows = [
      { leadId: 'L1', customerName: 'Erin', syncStatus: 'pending' },
      { leadId: 'L2', customerName: 'Casey', syncStatus: 'pending' },
    ];
    const { controller, sync } = buildController({
      candidates: jest.fn().mockResolvedValue(fakeRows),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ user_id: 'U1' });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    const r = await controller.sfCandidates(req, { user_id: 'U1' });
    expect(r.ok).toBe(true);
    expect(r.user_id).toBe('U1');
    expect(r.count).toBe(2);
    expect(r.candidates).toEqual(fakeRows);
    expect(sync.candidates).toHaveBeenCalledWith('U1', { syncStatus: 'pending', limit: 500 });
  });

  it('supports explicit syncStatuses request', async () => {
    const { controller, sync } = buildController({
      candidates: jest.fn().mockResolvedValue([]),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ user_id: 'U1', sync_statuses: ['pending', 'needs_review'] });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    await controller.sfCandidates(req, { user_id: 'U1', sync_statuses: ['pending', 'needs_review'] });
    // Two calls — one per requested status.
    expect(sync.candidates).toHaveBeenCalledTimes(2);
    expect(sync.candidates).toHaveBeenNthCalledWith(1, 'U1', { syncStatus: 'pending', limit: 500 });
    expect(sync.candidates).toHaveBeenNthCalledWith(2, 'U1', { syncStatus: 'needs_review', limit: 500 });
  });

  it('respects custom limit (capped at 1000)', async () => {
    const { controller, sync } = buildController({
      candidates: jest.fn().mockResolvedValue([]),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ user_id: 'U1', limit: 5000 });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    await controller.sfCandidates(req, { user_id: 'U1', limit: 5000 });
    expect(sync.candidates).toHaveBeenCalledWith('U1', { syncStatus: 'pending', limit: 1000 });
  });
});

describe('SfHistoricalSyncController — bulkLink (SF receiver)', () => {
  it('rejects missing HMAC headers', async () => {
    const { controller } = buildController();
    const body = JSON.stringify({ rows: [] });
    const r = await controller.bulkLink(buildReq(body, {}), { rows: [] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('missing_headers');
  });

  it('rejects invalid body (rows missing)', async () => {
    const { controller } = buildController();
    const ts = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({ rows: null });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    const r = await controller.bulkLink(req, { rows: null as any });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_body');
  });

  it('delegates valid request to service', async () => {
    const summary = { total: 1, linked: 1, needs_review: 0, no_match: 0, conflict: 0, not_found: 0, failed: 0, status_updates_applied: 1 };
    const { controller, sync } = buildController({
      applyBulkLink: jest.fn().mockResolvedValue({ ok: true, summary, rows: [{ result: 'linked' }] }),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const rows = [{ lb_lead_id: 'L1', sf_job_id: 'SF-A', confidence: 'exact', match_basis: 'externalRequestId' }];
    const body = JSON.stringify({ rows });
    const req = buildReq(body, {
      'x-sf-lb-timestamp': ts,
      'x-sf-lb-signature': sign(ts, body),
    });
    const r = await controller.bulkLink(req, { rows } as any);
    expect(r.ok).toBe(true);
    expect(r.summary.linked).toBe(1);
    expect(sync.applyBulkLink).toHaveBeenCalledWith({ rows });
  });
});
