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
    applyCredentialRotationNotification: jest.fn(async () => ({ ok: true })),
    applyCredentialRotationPending: jest.fn(async () => ({ ok: true })),
    applyConnectionRevoked: jest.fn(async () => ({ ok: true })),
  };
  const orchestrator: any = {
    handleServiceOutcomeEvent: jest.fn(async () => { if (opts.orchestratorThrows) throw new Error('boom'); }),
  };
  const rotationRefresh: any = {
    triggerImmediate: jest.fn(),
  };
  return {
    svc: new SfConnectionWebhookService(prisma, cfg, lifecycle, orchestrator, rotationRefresh),
    prisma, calls, lifecycle, orchestrator, rotationRefresh,
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

  // Regression: an SF tenant id can legitimately map to multiple
  // sf_connection rows over time (prior disconnected row + a freshly
  // re-provisioned active row under a different LB user). A naive
  // findFirst() with no orderBy lands non-deterministically on the
  // disconnected row → spurious "subscription inactive" 404 even
  // though a healthy row exists. The resolver must prefer the active
  // row deterministically.
  it('prefers active sf_connection row when an inactive duplicate exists for same tenant', async () => {
    const inactiveConn = {
      ...CONN, id: 'c-stale', userId: 'u-stale',
      isActive: false, status: 'disconnected',
      inboundSubscriptionId: 'sub-stale',
    };
    const activeConn = { ...CONN, id: 'c-live', userId: 'u-live', isActive: true, status: 'active' };
    const calls: any = { findFirst: [] };
    const prisma: any = {
      sfConnection: {
        findFirst: jest.fn(async (args: any) => {
          calls.findFirst.push(args);
          // Active-preferred query (where.isActive === true) returns active.
          if (args?.where?.isActive === true) return activeConn;
          // Fallback (no isActive filter) returns the stale row first
          // (mimics the bug condition).
          return inactiveConn;
        }),
      },
      crmWebhookSubscription: { findUnique: jest.fn(async () => SUB) },
      lead: { findFirst: jest.fn(async () => null) },
      sfInboundEvent: {
        findUnique: jest.fn(async () => null),
        create: jest.fn(async (a: any) => a.data),
      },
    };
    const cfg = { get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any } as ConfigService;
    const lifecycle: any = {
      applyConnectionConnected: jest.fn(async () => ({ ok: true })),
      applyCredentialRotated: jest.fn(async () => ({ ok: true })),
      applyCredentialRotationNotification: jest.fn(async () => ({ ok: true })),
      applyCredentialRotationPending: jest.fn(async () => ({ ok: true })),
      applyConnectionRevoked: jest.fn(async () => ({ ok: true })),
    };
    const orchestrator: any = { handleServiceOutcomeEvent: jest.fn(async () => {}) };
    const rotationRefresh: any = { triggerImmediate: jest.fn() };
    const svc = new SfConnectionWebhookService(prisma, cfg, lifecycle, orchestrator, rotationRefresh);

    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);

    // Active query returned a row → fallback should NOT have been issued.
    expect(calls.findFirst.length).toBe(1);
    expect(calls.findFirst[0].where.isActive).toBe(true);
    expect(calls.findFirst[0].orderBy).toEqual({ updatedAt: 'desc' });

    // Behavior assertion: accepted, NOT subscription inactive.
    expect(r.httpStatus).toBe(200);
    expect(r.result).not.toBe('noop');
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
  it('returns 200 idempotent_replay when X-SF-Event-Id already in sfInboundEvent', async () => {
    // Duplicate delivery must look like success to SF so the retry loop
    // breaks. 4xx (including 409) would keep SF retrying and grow the DLQ.
    const { svc, lifecycle } = buildDeps({
      existingEvent: {
        id: 'row-1',
        eventId: 'evt-1',
        eventType: 'connection.connected',
        result: 'accepted',
        status: 'applied',
        receivedAt: new Date('2026-05-28T20:00:00Z'),
      },
    });
    const req = sign(envelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(r.result).toBe('idempotent_replay');
    expect(r.eventId).toBe('evt-1');
    expect(r.eventType).toBe('connection.connected');
    expect(r.sfTenantId).toBe(99999);
    // Critical safety: side effects NOT re-applied on duplicate.
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  // ─── Envelope aliasing + confirmation-shape (Option A) ────────────
  // SF S4 wire format uses `data` for the event body; the LB-original
  // contract draft used `payload`. Both must work; `data` wins when both
  // are present. The OAuth exchange remains the authoritative provisioning
  // channel — webhooks are operational events / confirmations.

  it('connection.connected envelope.data confirmation shape → applied_confirmation, no reprovisioning', async () => {
    const activeConn = { ...CONN, signatureKeyId: 'k1', isActive: true, status: 'active' };
    const { svc, lifecycle, calls } = buildDeps({ conn: activeConn });
    const confirmation = {
      event_id: 'evt-confirm-1',
      event_type: 'connection.connected',
      occurred_at: new Date().toISOString(),
      sf_tenant_id: 99999,
      data: {
        credential: { kid: 'k1', cred_id: 10, token_prefix: 'sfo_v1.eyJ2Ij', expires_at: '2026-08-27T00:00:00.000Z' },
        connected_at: '2026-05-29T00:19:30.990Z',
        webhook_set_at: '2026-05-29T00:19:30.990Z',
      },
    };
    const r = await svc.ingest(JSON.stringify(confirmation), sign(confirmation, { kid: 'k1' }).headers);
    expect(r.httpStatus).toBe(200);
    expect(r.result).toBe('accepted'); // top-level result; resultTag goes into the log + audit row
    // Critical: the lifecycle was NOT called — confirmation must not
    // re-encrypt tokens / rewrite subscription secret / mutate provisioning.
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
    // Audit row written so the heartbeat is observable.
    expect(calls.event_create.length).toBe(1);
    expect(calls.event_create[0].data.result).toBe('applied_confirmation');
    expect(calls.event_create[0].data.status).toBe('applied');
  });

  it('connection.connected envelope.payload.provisioning re-establishment shape → calls lifecycle', async () => {
    // Backward-compat: full provisioning still triggers the lifecycle path.
    const { svc, lifecycle } = buildDeps();
    const req = sign(envelope()); // default fixture has payload.provisioning
    await svc.ingest(req.rawBody, req.headers);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalledTimes(1);
  });

  it('confirmation rejected when connection is not already active', async () => {
    // No provisioning AND connection not active = cold sf_push, not supported.
    const { svc, lifecycle, calls } = buildDeps({ conn: { ...CONN, signatureKeyId: 'k1' } });
    // Override conn to mark it inactive via the buildDeps prisma mock —
    // simpler approach: simulate by passing a conn override the service
    // will read. Use the lifecycle service to keep the existing-conn check.
    const confirmation = {
      event_id: 'evt-confirm-cold',
      event_type: 'connection.connected',
      occurred_at: new Date().toISOString(),
      sf_tenant_id: 99999,
      data: { credential: { kid: 'k1' }, connected_at: 't', webhook_set_at: 't' },
    };
    // CONN fixture doesn't expose isActive/status — buildDeps's CONN sets
    // signatureKeyId via opt, isActive/status are absent → falsy. So the
    // handler's `if (!conn.isActive || conn.status !== 'active')` fires.
    const r = await svc.ingest(JSON.stringify(confirmation), sign(confirmation, { kid: 'k1' }).headers);
    expect(r.httpStatus).toBe(500);
    expect(r.result).toBe('exception');
    expect(r.error).toMatch(/confirmation without active connection/);
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('credential.rotated reads envelope.data (SF wire) AND envelope.payload (legacy)', async () => {
    const { svc, lifecycle } = buildDeps();
    // SF wire shape (data)
    const sfShape = {
      event_id: 'evt-rot-data', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        new_credential: { token: 'newtok', kid: 'k2', token_prefix: 'sfo_v1.aa', issued_at: 't1', expires_at: 't2' },
        grace_period_seconds: 300,
      },
    };
    await svc.ingest(JSON.stringify(sfShape), sign(sfShape).headers);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(1);

    // Legacy shape (payload) — both must work
    const legacyShape = { ...sfShape, event_id: 'evt-rot-legacy', data: undefined, payload: sfShape.data };
    delete (legacyShape as any).data;
    await svc.ingest(JSON.stringify(legacyShape), sign(legacyShape).headers);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(2);
  });

  it('data wins over payload when both present (defensive)', async () => {
    // If a buggy sender includes both, SF wire format (data) takes precedence.
    const { svc, lifecycle } = buildDeps();
    const env = {
      event_id: 'evt-both', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: { new_credential: { token: 'from_data', kid: 'k2', token_prefix: 'sfo_v1.aa', issued_at: 't1', expires_at: 't2' } },
      payload: { new_credential: { token: 'from_payload', kid: 'k3', token_prefix: 'sfo_v1.bb', issued_at: 't1', expires_at: 't2' } },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    const arg = lifecycle.applyCredentialRotated.mock.calls[0][0];
    expect(arg.payload.new_credential.token).toBe('from_data');
    expect(arg.payload.new_credential.kid).toBe('k2');
  });

  it('credential.rotated NOTIFICATION shape (no token) → applyCredentialRotationNotification, NOT full rotation', async () => {
    const { svc, lifecycle } = buildDeps();
    // SF wire shape: no token, just cred_id + grace + metadata
    const env = {
      event_id: 'evt-rot-notif', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        new_credential: { cred_id: 12, kid: 'sf_orch_2026_05', token_prefix: 'sfo_v1.eyJ2Ij', expires_at: '2026-08-27T00:55:28.992Z' },
        previous_cred_id: 11,
        previous_grace_expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
        reason: 'lifecycle_verify_v2',
      },
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(200);
    expect(r.result).toBe('accepted');
    // Critical: full-rotation handler MUST NOT be called for notification shape
    expect(lifecycle.applyCredentialRotated).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotationNotification).toHaveBeenCalledTimes(1);
    const arg = lifecycle.applyCredentialRotationNotification.mock.calls[0][0];
    expect(arg.newCredId).toBe(12);
    expect(arg.newKid).toBe('sf_orch_2026_05');
    expect(arg.previousCredId).toBe(11);
    expect(arg.reason).toBe('lifecycle_verify_v2');
  });

  it('credential.rotated payload with neither token NOR notification fields → exception', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = {
      event_id: 'evt-rot-empty', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: { new_credential: { kid: 'k1' } }, // no token, no cred_id, no grace
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(500);
    expect(r.result).toBe('exception');
    expect(r.error).toContain('unsupported_variant');
    expect(lifecycle.applyCredentialRotated).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotationNotification).not.toHaveBeenCalled();
  });

  it('credential.rotated full-token shape (legacy) → applyCredentialRotated, NOT notification path', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = {
      event_id: 'evt-rot-full', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        new_credential: { token: 'sfo_v1_NEW', kid: 'k2', token_prefix: 'sfo_v1.aa', issued_at: 't', expires_at: 't' },
        grace_period_seconds: 300,
      },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyCredentialRotationNotification).not.toHaveBeenCalled();
  });

  // ── R1B refresh_required branch (regression tests per user spec) ─────

  it('R1B: refresh_required=true with NO new_credential block → applyCredentialRotationPending + triggerImmediate', async () => {
    // This is the canonical R1B wire format SF actually sends.
    const { svc, lifecycle, rotationRefresh } = buildDeps();
    const env = {
      event_id: 'evt-r1b-bare', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        reason: 'r1b_lifecycle_verify',
        previous_cred_id: 18,
        refresh_endpoint: '/api/integrations/leadbridge/orchestration/credentials/refresh',
        refresh_required: true,
        previous_grace_expires_at: null,
      },
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(200);
    expect(r.result).toBe('accepted');
    // R1B lean persist path engaged
    expect(lifecycle.applyCredentialRotationPending).toHaveBeenCalledTimes(1);
    const arg = lifecycle.applyCredentialRotationPending.mock.calls[0][0];
    expect(arg.userId).toBe('u1');
    expect(arg.previousCredId).toBe(18);
    expect(arg.previousGraceExpiresAt).toBeNull(); // SF sent null; LB tolerates
    expect(arg.reason).toBe('r1b_lifecycle_verify');
    // NOT the full-info path (no new_credential block to require)
    expect(lifecycle.applyCredentialRotationNotification).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotated).not.toHaveBeenCalled();
    // Immediate refresh trigger fires
    expect(rotationRefresh.triggerImmediate).toHaveBeenCalledTimes(1);
    expect(rotationRefresh.triggerImmediate).toHaveBeenCalledWith('c1');
  });

  it('R1B: refresh_required=true AND refresh_endpoint present → still uses connection.endpoints (refresh_endpoint is hint only)', async () => {
    // SF may include refresh_endpoint in the webhook data as a hint, but
    // LB authoritatively uses the credentials_refresh URL stored on the
    // connection (from OAuth exchange). Test that the webhook handler
    // doesn't crash when refresh_endpoint is present and that the
    // immediate trigger fires correctly regardless.
    const { svc, lifecycle, rotationRefresh } = buildDeps();
    const env = {
      event_id: 'evt-r1b-with-endpoint', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        refresh_required: true,
        refresh_endpoint: '/some/other/path/from/webhook',
        previous_cred_id: 18,
      },
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyCredentialRotationPending).toHaveBeenCalledTimes(1);
    expect(rotationRefresh.triggerImmediate).toHaveBeenCalledTimes(1);
  });

  it('R1B: refresh_required=true and refresh_endpoint absent → still works (URL comes from connection)', async () => {
    const { svc, lifecycle, rotationRefresh } = buildDeps();
    const env = {
      event_id: 'evt-r1b-no-endpoint', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        refresh_required: true,
        previous_cred_id: 18,
        // No refresh_endpoint field
      },
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyCredentialRotationPending).toHaveBeenCalledTimes(1);
    expect(rotationRefresh.triggerImmediate).toHaveBeenCalledTimes(1);
  });

  it('R1B: refresh_required=true with previous_grace_expires_at as real ISO → forwards to lifecycle', async () => {
    const { svc, lifecycle } = buildDeps();
    const graceIso = new Date(Date.now() + 5 * 60_000).toISOString();
    const env = {
      event_id: 'evt-r1b-with-grace', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        refresh_required: true,
        previous_cred_id: 18,
        previous_grace_expires_at: graceIso,
      },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    const arg = lifecycle.applyCredentialRotationPending.mock.calls[0][0];
    expect(arg.previousGraceExpiresAt).toBe(graceIso);
  });

  it('legacy force-rotate variant: new_credential.token present → applyCredentialRotated (NOT pending path)', async () => {
    const { svc, lifecycle, rotationRefresh } = buildDeps();
    const env = {
      event_id: 'evt-legacy-rotate', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        // No refresh_required → legacy path
        new_credential: { token: 'sfo_v1.PLAINTEXT_TOKEN', kid: 'k2', token_prefix: 'sfo_v1.PL', issued_at: 't', expires_at: 't' },
        grace_period_seconds: 300,
      },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyCredentialRotationPending).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotationNotification).not.toHaveBeenCalled();
    // Legacy path does NOT fire immediate trigger
    expect(rotationRefresh.triggerImmediate).not.toHaveBeenCalled();
  });

  it('R1 full-info notification (no refresh_required): new_credential.cred_id + previous_grace_expires_at → applyCredentialRotationNotification', async () => {
    const { svc, lifecycle, rotationRefresh } = buildDeps();
    const env = {
      event_id: 'evt-r1-fullinfo', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: {
        new_credential: { cred_id: 12, kid: 'sf_orch_2026_05', token_prefix: 'sfo_v1.aa', expires_at: '2026-08-27T00:00:00Z' },
        previous_cred_id: 11,
        previous_grace_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        // refresh_required absent
      },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(lifecycle.applyCredentialRotationNotification).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyCredentialRotationPending).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotated).not.toHaveBeenCalled();
    expect(rotationRefresh.triggerImmediate).not.toHaveBeenCalled();
  });

  it('unsupported variant: no refresh_required AND no new_credential → 500 exception result=unsupported_variant', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = {
      event_id: 'evt-unsupported', event_type: 'credential.rotated',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: { reason: 'mystery_variant' },
    };
    const r = await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(r.httpStatus).toBe(500);
    expect(r.result).toBe('exception');
    expect(r.error).toContain('unsupported_variant');
    expect(lifecycle.applyCredentialRotationPending).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotationNotification).not.toHaveBeenCalled();
    expect(lifecycle.applyCredentialRotated).not.toHaveBeenCalled();
  });

  it('connection.revoked accepts envelope.data shape', async () => {
    const { svc, lifecycle } = buildDeps();
    const env = {
      event_id: 'evt-rev-data', event_type: 'connection.revoked',
      occurred_at: new Date().toISOString(), sf_tenant_id: 99999,
      data: { reason: 'user_requested' },
    };
    await svc.ingest(JSON.stringify(env), sign(env).headers);
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalledTimes(1);
  });

  it('duplicate response carries original event_type even if body claims different type', async () => {
    // Defensive: SF should never send a different event_type for the same
    // event_id, but if they did, our response reflects what was originally
    // applied — that's the authoritative record.
    const { svc } = buildDeps({
      existingEvent: {
        id: 'row-1',
        eventId: 'evt-1',
        eventType: 'connection.connected',
        result: 'accepted',
        status: 'applied',
        receivedAt: new Date(),
      },
    });
    const req = sign(envelope({ event_type: 'credential.rotated', payload: { new_credential: { token: 'x' } } }));
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(r.eventType).toBe('connection.connected'); // from the stored row, not the new body
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
