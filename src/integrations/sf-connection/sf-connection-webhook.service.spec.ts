import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';

const ENC_KEY = 'webhook-spec-key-32-bytes-long-good';
const SUB_SECRET_PLAIN = 'sub-secret-shared-with-sf';

const CONN = {
  id: 'c1',
  userId: 'u1',
  sfTenantId: '99999',
  inboundSubscriptionId: 'sub-1',
  signatureKeyId: null as string | null,
};

const SUB = {
  id: 'sub-1',
  userId: 'u1',
  direction: 'inbound',
  isActive: true,
  secret: EncryptionUtil.encrypt(SUB_SECRET_PLAIN, ENC_KEY),
};

function buildDeps(opts: {
  conn?: any | null;
  sub?: any | null;
  existingEvent?: any | null;
  lead?: any | null;
  lifecycleThrows?: boolean;
  orchestratorThrows?: boolean;
} = {}) {
  const calls: any = { event_create: [] };
  const prisma: any = {
    sfConnection: { findFirst: jest.fn(async () => opts.conn === undefined ? CONN : opts.conn) },
    crmWebhookSubscription: { findUnique: jest.fn(async () => opts.sub === undefined ? SUB : opts.sub) },
    lead: { findFirst: jest.fn(async () => opts.lead === undefined ? null : opts.lead) },
    sfInboundEvent: {
      findUnique: jest.fn(async () => opts.existingEvent ?? null),
      create: jest.fn(async (a: any) => { calls.event_create.push(a); return a.data; }),
    },
  };
  const cfg = { get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any } as ConfigService;
  const lifecycle: any = {
    applyConnectionConnected: jest.fn(async () => { if (opts.lifecycleThrows) throw new Error('boom'); return { ok: true }; }),
    applyCredentialRotated: jest.fn(async () => ({ ok: true })),
    applyConnectionRevoked: jest.fn(async () => ({ ok: true })),
  };
  const orchestrator: any = {
    handleServiceOutcomeEvent: jest.fn(async () => { if (opts.orchestratorThrows) throw new Error('boom'); }),
  };
  return {
    svc: new SfConnectionWebhookService(prisma, cfg, lifecycle, orchestrator),
    prisma, calls, lifecycle, orchestrator,
  };
}

function sign(payload: any, opts: {
  ts?: number; sigOverride?: string; secret?: string;
  eventId?: string; eventType?: string; tenantId?: string; kid?: string;
} = {}) {
  const body = JSON.stringify(payload);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? SUB_SECRET_PLAIN;
  const sig = opts.sigOverride ?? crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return {
    rawBody: body,
    headers: {
      signature: sig,
      timestamp: ts,
      eventId: opts.eventId ?? payload.event_id,
      eventType: opts.eventType ?? payload.event_type,
      tenantId: opts.tenantId ?? String(payload.sf_tenant_id),
      kid: opts.kid,
    },
  };
}

const envelope = (over: any = {}) => ({
  event_id: 'evt-1',
  event_type: 'connection.connected',
  occurred_at: new Date().toISOString(),
  sf_tenant_id: 99999,
  payload: {
    provisioning: {
      version: '1',
      tenant: { sf_tenant_id: 99999, sf_workspace_id: 88888, sf_base_url: 'https://sf', source_instance: 'staging', api_region: null, sf_tenant_name: 'T' },
      endpoints: { availability: '/a', booking_request: '/b', booking_cancel: '/c', handoff: '/h', disconnect: '/d' },
      credential: { token: 'sfo_v1_secret', token_prefix: 'sfo_v1.eyJ2Ij', kid: 'k1', scope: 'lb_orchestration', issued_at: 't1', expires_at: 't2' },
      event_types: ['connection.connected'],
      signature_metadata: { algorithm: 'hmac-sha256-hex', max_clock_skew_seconds: 300, headers: { signature: 'X-SF-Signature', timestamp: 'X-SF-Timestamp', event_id: 'X-SF-Event-Id', event_type: 'X-SF-Event-Type', tenant_id: 'X-SF-Tenant-Id', kid: 'X-SF-Kid' } },
      webhook: { url: 'https://lb/x', set_at: 't', secret_set: true, subscription_id: 'lb_sub', state_ref: 'lb_conn' },
    },
  },
  ...over,
});

describe('SfConnectionWebhookService — headers / HMAC / replay', () => {
  it('rejects when required headers missing', async () => {
    const { svc } = buildDeps();
    const r = await svc.ingest('{}', {});
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
  });

  it('rejects timestamp drift > 300s', async () => {
    const { svc } = buildDeps();
    const old = Math.floor(Date.now() / 1000) - 400;
    const req = sign(envelope(), { ts: old });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('replay_rejected');
    // Diagnostic surfacing — header-derived fields must propagate so SF
    // can correlate the rejection with the in-flight event.
    expect(r.eventType).toBe('connection.connected');
    expect(r.sfTenantId).toBe(99999);
  });

  it('drift validation uses X-SF-Timestamp (not body occurred_at)', async () => {
    // Header timestamp is fresh; body occurred_at is 1h stale. If LB ever
    // mistakenly used body for the freshness check, drift would be 3600s
    // and the request would 401. Correct behavior: accept past the drift
    // gate and reach later validation (here: tenant_not_found because
    // we override conn to null to keep the test minimal).
    const { svc } = buildDeps({ conn: null });
    const env = envelope({ occurred_at: new Date(Date.now() - 3600 * 1000).toISOString() });
    const req = sign(env); // header ts defaults to now
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(404);
    expect(r.result).toBe('tenant_not_found'); // NOT replay_rejected
  });

  it('missing-headers rejection still surfaces any header that WAS provided', async () => {
    const { svc } = buildDeps();
    // No signature/timestamp/eventId/tenantId — but event_type IS present.
    const r = await svc.ingest('{}', { eventType: 'connection.connected' });
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
    expect(r.eventType).toBe('connection.connected');
    expect(r.sfTenantId).toBeUndefined();
  });

  it('signature mismatch rejection surfaces event_type + sf_tenant_id', async () => {
    const { svc } = buildDeps();
    const req = sign(envelope(), { sigOverride: 'a'.repeat(64) });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
    expect(r.error).toBe('signature mismatch');
    expect(r.eventType).toBe('connection.connected');
    expect(r.sfTenantId).toBe(99999);
  });

  it('rejects when tenant not found', async () => {
    const { svc } = buildDeps({ conn: null });
    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(404);
    expect(r.result).toBe('tenant_not_found');
  });

  it('rejects when subscription inactive', async () => {
    const { svc } = buildDeps({ sub: { ...SUB, isActive: false } });
    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(404);
    expect(r.result).toBe('noop');
  });

  it('rejects on signature mismatch', async () => {
    const { svc } = buildDeps();
    const req = sign(envelope(), { sigOverride: 'a'.repeat(64) });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
  });

  it('accepts sha256= prefix', async () => {
    const { svc, lifecycle } = buildDeps();
    const body = JSON.stringify(envelope());
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = 'sha256=' + crypto.createHmac('sha256', SUB_SECRET_PLAIN).update(`${ts}.${body}`).digest('hex');
    const r = await svc.ingest(body, {
      signature: sig, timestamp: ts, eventId: 'evt-1', eventType: 'connection.connected', tenantId: '99999',
    });
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalled();
  });

  it('rejects X-SF-Kid mismatch when stored signatureKeyId is set', async () => {
    const conn = { ...CONN, signatureKeyId: 'kid-A' };
    const { svc } = buildDeps({ conn });
    const req = sign(envelope(), { kid: 'kid-B' });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
    expect(r.error).toBe('kid mismatch');
  });

  it('rejects body tenant_id != X-SF-Tenant-Id (security)', async () => {
    const { svc } = buildDeps();
    const env = envelope({ sf_tenant_id: 12345 });
    const req = sign(env, { tenantId: '99999' });  // header says one, body says another
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(403);
    expect(r.result).toBe('unauthorized');
  });
});

describe('SfConnectionWebhookService — body validation', () => {
  it('rejects invalid json', async () => {
    const { svc } = buildDeps();
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', SUB_SECRET_PLAIN).update(`${ts}.not-json`).digest('hex');
    const r = await svc.ingest('not-json', {
      signature: sig, timestamp: ts, eventId: 'e', tenantId: '99999',
    });
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });

  it('rejects unknown event_type', async () => {
    const { svc } = buildDeps();
    const req = sign(envelope({ event_type: 'foo.bar' }), { eventType: 'foo.bar' });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
    expect(r.error).toBe('unknown event_type');
  });

  it('rejects non-numeric body sf_tenant_id', async () => {
    const { svc } = buildDeps();
    const env = envelope({ sf_tenant_id: 'oops' as any });
    const req = sign(env, { tenantId: '99999' });  // header still numeric string
    // The header→tenant lookup will succeed, then body validation will trip on non-numeric
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });
});

describe('SfConnectionWebhookService — idempotency', () => {
  it('returns 409 duplicate when X-SF-Event-Id already in sfInboundEvent', async () => {
    const { svc, lifecycle } = buildDeps({ existingEvent: { id: 'row-1', eventId: 'evt-1' } });
    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(409);
    expect(r.result).toBe('duplicate');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });
});

describe('SfConnectionWebhookService — dispatch by event_type (all 7 types)', () => {
  it('connection.connected → applyConnectionConnected (sf_push source, no secret)', async () => {
    const { svc, lifecycle } = buildDeps();
    const req = sign(envelope());
    await svc.ingest(req.rawBody, req.headers);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalledTimes(1);
    const passed = lifecycle.applyConnectionConnected.mock.calls[0][0];
    expect(passed.source).toBe('sf_push');
    expect(passed.webhookSecretPlaintext).toBeNull();
  });

  it('credential.rotated → applyCredentialRotated', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = envelope({
      event_id: 'evt-rot',
      event_type: 'credential.rotated',
      payload: {
        new_credential: { token: 'sfo_v1_new', token_prefix: 'sfo_v1.eyJ2Ij', kid: 'k2', issued_at: 't', expires_at: 't' },
        grace_period_seconds: 300,
      },
    });
    const req = sign(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(1);
  });

  it('connection.revoked → applyConnectionRevoked with sf_authority', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = envelope({
      event_id: 'evt-rev', event_type: 'connection.revoked',
      payload: { reason: 'admin_revoke', detail: 'churn' },
    });
    const req = sign(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyConnectionRevoked.mock.calls[0][0].initiator).toBe('sf_authority');
  });

  it.each([
    'service_scheduled', 'service_rescheduled', 'service_cancelled', 'service_completed',
  ])('%s → BookingOrchestrator.handleServiceOutcomeEvent', async (eventType) => {
    const lead = { id: 'lead-1', threadId: 'thread-1', userId: 'u1' };
    const { svc, orchestrator } = buildDeps({ lead });
    const env = envelope({
      event_id: 'evt-' + eventType,
      event_type: eventType,
      payload: { sf_job_id: 'sf-job-1', scheduled_for: '2026-06-01T10:00:00Z' },
    });
    const req = sign(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(orchestrator.handleServiceOutcomeEvent).toHaveBeenCalledTimes(1);
    const passed = orchestrator.handleServiceOutcomeEvent.mock.calls[0][0];
    expect(passed.eventType).toBe(eventType);
    expect(passed.sfJobId).toBe('sf-job-1');
    expect(passed.leadId).toBe('lead-1');
  });

  it('service_* with no matching lead → deferred, no orchestrator call, 200 OK', async () => {
    const { svc, orchestrator, calls } = buildDeps({ lead: null });
    const env = envelope({
      event_id: 'evt-deferred', event_type: 'service_scheduled',
      payload: { sf_job_id: 'sf-job-unknown' },
    });
    const req = sign(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(orchestrator.handleServiceOutcomeEvent).not.toHaveBeenCalled();
    expect(calls.event_create[0].data.result).toBe('deferred_lead_not_found');
  });
});

describe('SfConnectionWebhookService — audit + safety', () => {
  it('scrubs secrets out of the persisted audit row', async () => {
    const { svc, calls } = buildDeps();
    const req = sign(envelope());
    await svc.ingest(req.rawBody, req.headers);
    const stored = JSON.stringify(calls.event_create[0].data.payloadJson);
    expect(stored).not.toContain('sfo_v1_secret');
    expect(stored).toContain('token_len');
  });

  it('scrubs new_credential.token from credential.rotated audit', async () => {
    const { svc, calls } = buildDeps();
    const env = envelope({
      event_id: 'evt-rot', event_type: 'credential.rotated',
      payload: { new_credential: { token: 'super_secret_new_token', token_prefix: 'sfo_v1.eyJ2Ij', kid: 'k', issued_at: 't', expires_at: 't' }, grace_period_seconds: 300 },
    });
    const req = sign(env);
    await svc.ingest(req.rawBody, req.headers);
    const stored = JSON.stringify(calls.event_create[0].data.payloadJson);
    expect(stored).not.toContain('super_secret_new_token');
    expect(stored).toContain('token_len');
  });

  it('on lifecycle exception → 500 + status=noop audit row', async () => {
    const { svc, calls } = buildDeps({ lifecycleThrows: true });
    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(500);
    expect(r.result).toBe('exception');
    expect(calls.event_create[0].data.status).toBe('noop');
    expect(calls.event_create[0].data.result).toBe('exception');
  });
});
