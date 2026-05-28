import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SfConnectionWebhookService } from './sf-connection-webhook.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';

const ENC_KEY = 'webhook-spec-key-32-bytes-long-good';

function buildDeps(opts: {
  subscription?: any | null;
  connection?: any | null;
  existingEvent?: any | null;
  lifecycleResult?: any;
  lifecycleThrows?: boolean;
} = {}) {
  const calls: any = { event_create: [] };
  const prisma: any = {
    crmWebhookSubscription: {
      findUnique: jest.fn(async () => opts.subscription ?? null),
    },
    sfConnection: {
      findUnique: jest.fn(async () => opts.connection ?? null),
    },
    sfInboundEvent: {
      findUnique: jest.fn(async () => opts.existingEvent ?? null),
      create: jest.fn(async (args: any) => { calls.event_create.push(args); return args.data; }),
    },
  };
  const cfg = {
    get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any,
  } as ConfigService;
  const lifecycle: any = {
    applyConnectionConnected: jest.fn(async () => {
      if (opts.lifecycleThrows) throw new Error('lifecycle boom');
      return opts.lifecycleResult ?? { ok: true };
    }),
    applyCredentialRotated: jest.fn(async () => opts.lifecycleResult ?? { ok: true }),
    applyConnectionRevoked: jest.fn(async () => opts.lifecycleResult ?? { ok: true }),
  };
  return { svc: new SfConnectionWebhookService(prisma, cfg, lifecycle), prisma, calls, lifecycle };
}

const SUB_SECRET_PLAIN = 'sub-secret-shared-with-sf';
const SUB = (() => ({
  id: 'sub-1',
  userId: 'u1',
  direction: 'inbound',
  isActive: true,
  // Encrypt the secret as the service will store it
  secret: EncryptionUtil.encrypt(SUB_SECRET_PLAIN, ENC_KEY),
}))();

const CONN = {
  id: 'c1',
  userId: 'u1',
  sfTenantId: 'sf-T1',
  signatureKeyId: null,
};

function makeSignedRequest(
  payload: any,
  opts: { tsSec?: number; sigOverride?: string; secret?: string; eventIdHeader?: string; sigKidHeader?: string } = {},
) {
  const body = JSON.stringify(payload);
  const ts = String(opts.tsSec ?? Math.floor(Date.now() / 1000));
  const secret = opts.secret ?? SUB_SECRET_PLAIN;
  const sig =
    opts.sigOverride ?? crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return {
    rawBody: body,
    headers: {
      signature: sig,
      timestamp: ts,
      subscriptionId: 'sub-1',
      eventId: opts.eventIdHeader ?? payload.event_id,
      signatureKid: opts.sigKidHeader,
    },
  };
}

const validEnvelope = (over: any = {}) => ({
  event_id: 'evt-abc',
  event_type: 'connection.connected',
  occurred_at: new Date().toISOString(),
  sf_tenant_id: 'sf-T1',
  payload: {
    provisioning: {
      sf_tenant_id: 'sf-T1',
      sf_base_url: 'https://sf.example.com',
      orchestration_token: 'sfo_v1_payload_token',
      webhook_subscription_id: 'sf-sub-A',
      webhook_signing_secret: 'secret',
      token_issued_at: new Date().toISOString(),
      webhook_events: ['connection.connected'],
    },
  },
  ...over,
});

describe('SfConnectionWebhookService — headers / HMAC', () => {
  it('rejects when required headers are missing', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const r = await svc.ingest('{}', {});
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
  });

  it('rejects on timestamp drift > 300s', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const old = Math.floor(Date.now() / 1000) - 400;
    const req = makeSignedRequest(validEnvelope(), { tsSec: old });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('replay_rejected');
  });

  it('rejects when subscription not found', async () => {
    const { svc } = buildDeps({ subscription: null });
    const req = makeSignedRequest(validEnvelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(404);
    expect(r.result).toBe('noop');
  });

  it('rejects on signature mismatch', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const req = makeSignedRequest(validEnvelope(), { sigOverride: 'a'.repeat(64) });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
  });

  it('accepts sha256= prefixed signature', async () => {
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: CONN });
    const body = JSON.stringify(validEnvelope());
    const ts = String(Math.floor(Date.now() / 1000));
    const sig =
      'sha256=' + crypto.createHmac('sha256', SUB_SECRET_PLAIN).update(`${ts}.${body}`).digest('hex');
    const r = await svc.ingest(body, {
      signature: sig, timestamp: ts, subscriptionId: 'sub-1', eventId: 'evt-abc',
    });
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalled();
  });
});

describe('SfConnectionWebhookService — body validation', () => {
  it('rejects invalid JSON', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = crypto.createHmac('sha256', SUB_SECRET_PLAIN).update(`${ts}.not-json`).digest('hex');
    const r = await svc.ingest('not-json', {
      signature: sig, timestamp: ts, subscriptionId: 'sub-1', eventId: 'evt-x',
    });
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });

  it('rejects unknown event_type', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const req = makeSignedRequest(validEnvelope({ event_type: 'foo.bar' }));
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });

  it('rejects missing event_id', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const env = validEnvelope({ event_id: '' });
    // Header still has eventId but body doesn't
    const req = makeSignedRequest(env, { eventIdHeader: 'hdr-eid' });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });

  it('rejects missing sf_tenant_id', async () => {
    const { svc } = buildDeps({ subscription: SUB });
    const req = makeSignedRequest(validEnvelope({ sf_tenant_id: '' }));
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(400);
    expect(r.result).toBe('validation_failed');
  });
});

describe('SfConnectionWebhookService — idempotency', () => {
  it('returns 409 duplicate when X-SF-Event-Id already in sfInboundEvent', async () => {
    const { svc, lifecycle } = buildDeps({
      subscription: SUB, connection: CONN,
      existingEvent: { id: 'row-1', eventId: 'evt-abc' },
    });
    const req = makeSignedRequest(validEnvelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(409);
    expect(r.result).toBe('duplicate');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });
});

describe('SfConnectionWebhookService — cross-tenant safety', () => {
  it('rejects when body sf_tenant_id mismatches stored sfTenantId', async () => {
    const conn = { ...CONN, sfTenantId: 'sf-T2' };
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: conn });
    const req = makeSignedRequest(validEnvelope({ sf_tenant_id: 'sf-T1' }));
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(403);
    expect(r.result).toBe('unauthorized');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('rejects when signature_kid header mismatches stored signatureKeyId', async () => {
    const conn = { ...CONN, signatureKeyId: 'kid-A' };
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: conn });
    const req = makeSignedRequest(validEnvelope(), { sigKidHeader: 'kid-B' });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(401);
    expect(r.result).toBe('unauthorized');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('accepts when stored signatureKeyId is null (no constraint to enforce yet)', async () => {
    const conn = { ...CONN, signatureKeyId: null };
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: conn });
    const req = makeSignedRequest(validEnvelope(), { sigKidHeader: 'kid-any' });
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalled();
  });

  it('allows first-time connection.connected when conn.sfTenantId="pending"', async () => {
    const conn = { ...CONN, sfTenantId: 'pending' };
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: conn });
    const req = makeSignedRequest(validEnvelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalled();
  });
});

describe('SfConnectionWebhookService — dispatch by event_type', () => {
  it('connection.connected → applyConnectionConnected', async () => {
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: CONN });
    const req = makeSignedRequest(validEnvelope());
    await svc.ingest(req.rawBody, req.headers);
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalledTimes(1);
    const passed = lifecycle.applyConnectionConnected.mock.calls[0][0];
    expect(passed.userId).toBe('u1');
    expect(passed.source).toBe('sf_push');
    expect(passed.provisioning.sf_tenant_id).toBe('sf-T1');
  });

  it('credential.rotated → applyCredentialRotated', async () => {
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: CONN });
    const env = validEnvelope({
      event_id: 'evt-rot',
      event_type: 'credential.rotated',
      payload: {
        new_orchestration_token: 'sfo_v1_new',
        new_token_issued_at: new Date().toISOString(),
        grace_period_seconds: 300,
      },
    });
    const req = makeSignedRequest(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyCredentialRotated).toHaveBeenCalledTimes(1);
  });

  it('connection.revoked → applyConnectionRevoked with sf_authority initiator', async () => {
    const { svc, lifecycle } = buildDeps({ subscription: SUB, connection: CONN });
    const env = validEnvelope({
      event_id: 'evt-rev',
      event_type: 'connection.revoked',
      payload: { reason: 'admin_revoke', detail: 'churn' },
    });
    const req = makeSignedRequest(env);
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(200);
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalledTimes(1);
    expect(lifecycle.applyConnectionRevoked.mock.calls[0][0].initiator).toBe('sf_authority');
  });
});

describe('SfConnectionWebhookService — audit + safety', () => {
  it('scrubs secrets out of the persisted audit row', async () => {
    const { svc, calls } = buildDeps({ subscription: SUB, connection: CONN });
    const req = makeSignedRequest(validEnvelope());
    await svc.ingest(req.rawBody, req.headers);
    expect(calls.event_create).toHaveLength(1);
    const stored = calls.event_create[0].data.payloadJson;
    const json = JSON.stringify(stored);
    expect(json).not.toContain('sfo_v1_payload_token');
    expect(json).not.toContain('"webhook_signing_secret"');
    // length is preserved as metadata
    expect(json).toContain('orchestration_token_len');
  });

  it('on lifecycle exception → returns 500, persists status=noop audit row', async () => {
    const { svc, calls } = buildDeps({ subscription: SUB, connection: CONN, lifecycleThrows: true });
    const req = makeSignedRequest(validEnvelope());
    const r = await svc.ingest(req.rawBody, req.headers);
    expect(r.httpStatus).toBe(500);
    expect(r.result).toBe('exception');
    expect(calls.event_create[0].data.status).toBe('noop');
    expect(calls.event_create[0].data.result).toBe('exception');
  });
});
