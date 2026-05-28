import { ConfigService } from '@nestjs/config';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import type { SfProvisioningPayload } from './sf-connection.contracts';

const ENC_KEY = 'lifecycle-spec-key-32-bytes-long-okay';

function makeProvisioning(over: Partial<SfProvisioningPayload> = {}): SfProvisioningPayload {
  return {
    sf_tenant_id: 'sf-T1',
    sf_tenant_name: 'Tenant One',
    sf_base_url: 'https://sf.example.com',
    source_instance: 'sf-staging-us',
    api_region: 'us-east-1',
    orchestration_token: 'sfo_v1_secret_token_xxx',
    orchestration_token_kid: 'k1',
    orchestration_token_scope: 'orchestration',
    token_issued_at: new Date('2026-05-28T10:00:00Z').toISOString(),
    token_expires_at: new Date('2026-05-29T10:00:00Z').toISOString(),
    webhook_subscription_id: 'sf-sub-A',
    webhook_signing_secret: 'webhook-secret-shh',
    webhook_signature_key_id: 'sigk-1',
    webhook_events: ['connection.connected', 'credential.rotated', 'connection.revoked'],
    ...over,
  };
}

function buildDeps(opts: { existing?: any | null; subscription?: any } = {}) {
  const calls: any = { conn: [], sub: [] };
  const txFns = {
    sfConnection: {
      update: jest.fn(async (args: any) => { calls.conn.push({ op: 'update', args }); return { ...(args.data) }; }),
      create: jest.fn(async (args: any) => { calls.conn.push({ op: 'create', args }); return { ...(args.data) }; }),
    },
    crmWebhookSubscription: {
      upsert: jest.fn(async (args: any) => { calls.sub.push({ op: 'upsert', args }); return opts.subscription ?? { id: 'sub-1' }; }),
      update: jest.fn(async (args: any) => { calls.sub.push({ op: 'update', args }); return { id: args.where.id }; }),
    },
  };
  const prisma: any = {
    sfConnection: {
      findUnique: jest.fn(async () => opts.existing ?? null),
      update: jest.fn(async (args: any) => { calls.conn.push({ op: 'top.update', args }); return { ...args.data }; }),
    },
    crmWebhookSubscription: txFns.crmWebhookSubscription,
    $transaction: jest.fn(async (fn: any) => fn(txFns)),
  };
  const cfg = { get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any } as ConfigService;
  return { svc: new SfConnectionLifecycleService(prisma, cfg), prisma, calls, txFns };
}

describe('SfConnectionLifecycleService — applyConnectionConnected', () => {
  it('creates fresh row + upserts inbound subscription, encrypting token + webhook secret', async () => {
    const { svc, prisma, calls, txFns } = buildDeps();
    const p = makeProvisioning();
    const r = await svc.applyConnectionConnected({
      userId: 'u1',
      connectionId: 'c1',
      provisioning: p,
      source: 'oauth_exchange',
    });
    expect(r.ok).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(txFns.sfConnection.create).toHaveBeenCalledTimes(1);
    const data = txFns.sfConnection.create.mock.calls[0][0].data;
    expect(data.sfTenantId).toBe('sf-T1');
    expect(data.baseUrl).toBe('https://sf.example.com');
    expect(data.sourceInstance).toBe('sf-staging-us');
    expect(data.apiRegion).toBe('us-east-1');
    expect(data.signatureKeyId).toBe('sigk-1');
    expect(data.status).toBe('active');
    expect(data.isActive).toBe(true);
    expect(data.events).toEqual(p.webhook_events);
    // Token must be encrypted, not plaintext
    expect(data.orchestrationToken).not.toBe(p.orchestration_token);
    expect(typeof data.orchestrationToken).toBe('string');
    expect(EncryptionUtil.decrypt(data.orchestrationToken, ENC_KEY)).toBe(p.orchestration_token);
    expect(data.tokenLastRotationSource).toBe('handshake');
    // Subscription secret also encrypted
    const subData = txFns.crmWebhookSubscription.upsert.mock.calls[0][0];
    expect(subData.create.secret).not.toBe(p.webhook_signing_secret);
    expect(EncryptionUtil.decrypt(subData.create.secret, ENC_KEY)).toBe(p.webhook_signing_secret);
  });

  it('updates existing row on reconnect — preserves no original-connectedAt explicitly, but clears terminal fields', async () => {
    const existing = {
      id: 'c1', userId: 'u1', sfTenantId: 'sf-T1', baseUrl: 'old-url', status: 'disconnected',
      tokenIssuedAt: new Date('2026-01-01T00:00:00Z'), orchestrationToken: 'old-enc',
    };
    const { svc, txFns } = buildDeps({ existing });
    const p = makeProvisioning({ token_issued_at: new Date('2026-05-28T10:00:00Z').toISOString() });
    const r = await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1', provisioning: p, source: 'oauth_exchange',
    });
    expect(r.ok).toBe(true);
    expect(txFns.sfConnection.create).not.toHaveBeenCalled();
    expect(txFns.sfConnection.update).toHaveBeenCalledTimes(1);
    const data = txFns.sfConnection.update.mock.calls[0][0].data;
    expect(data.status).toBe('active');
    expect(data.isActive).toBe(true);
    expect(data.disconnectInitiator).toBeNull();
    expect(data.disconnectedAt).toBeNull();
    expect(data.lastErrorAt).toBeNull();
    expect(data.previousOrchestrationToken).toBeNull();
  });

  it('idempotent re-delivery: same sfTenantId + same tokenIssuedAt → noop', async () => {
    const existing = {
      id: 'c1', userId: 'u1', sfTenantId: 'sf-T1', status: 'active',
      tokenIssuedAt: new Date('2026-05-28T10:00:00Z'),
    };
    const { svc, txFns } = buildDeps({ existing });
    const r = await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1', provisioning: makeProvisioning(), source: 'sf_push',
    });
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
    expect(txFns.sfConnection.create).not.toHaveBeenCalled();
    expect(txFns.sfConnection.update).not.toHaveBeenCalled();
  });

  it('sf_push source tags rotation source correctly', async () => {
    const { svc, txFns } = buildDeps();
    await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1', provisioning: makeProvisioning(), source: 'sf_push',
    });
    expect(txFns.sfConnection.create.mock.calls[0][0].data.tokenLastRotationSource).toBe('sf_push');
  });
});

describe('SfConnectionLifecycleService — applyCredentialRotated', () => {
  function activeRow(over: any = {}) {
    return {
      id: 'c1', userId: 'u1', sfTenantId: 'sf-T1',
      tokenIssuedAt: new Date('2026-05-28T10:00:00Z'),
      orchestrationToken: 'current-enc',
      isActive: true, status: 'active',
      ...over,
    };
  }

  it('demotes current to previous + stores new + status=rotating + 5-min grace', async () => {
    const conn = activeRow();
    const calls: any[] = [];
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async () => conn),
        update: jest.fn(async (args: any) => { calls.push(args); return { ...args.data }; }),
      },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const beforeUpdate = Date.now();
    const r = await svc.applyCredentialRotated({
      userId: 'u1',
      payload: {
        new_orchestration_token: 'sfo_v1_new_yyy',
        new_orchestration_token_kid: 'k2',
        new_token_issued_at: new Date('2026-05-28T12:00:00Z').toISOString(),
        new_token_expires_at: new Date('2026-05-29T12:00:00Z').toISOString(),
        grace_period_seconds: 300,
      },
    });
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    const data = calls[0].data;
    expect(data.status).toBe('rotating');
    expect(data.previousOrchestrationToken).toBe('current-enc');
    expect(data.previousTokenExpiresAt).toBeInstanceOf(Date);
    // grace ~5 min from now
    const graceMs = (data.previousTokenExpiresAt as Date).getTime() - beforeUpdate;
    expect(graceMs).toBeGreaterThanOrEqual(295_000);
    expect(graceMs).toBeLessThanOrEqual(305_000);
    // new token encrypted
    expect(EncryptionUtil.decrypt(data.orchestrationToken, ENC_KEY)).toBe('sfo_v1_new_yyy');
    expect(data.orchestrationTokenKid).toBe('k2');
    expect(data.tokenLastRotationSource).toBe('sf_push');
  });

  it('idempotent: stale or equal issued_at → noop', async () => {
    const conn = activeRow();
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async () => conn),
        update: jest.fn(),
      },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotated({
      userId: 'u1',
      payload: {
        new_orchestration_token: 'sfo_v1_should_not_apply',
        new_token_issued_at: conn.tokenIssuedAt.toISOString(),
        grace_period_seconds: 300,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
    expect(prisma.sfConnection.update).not.toHaveBeenCalled();
  });

  it('rejects rotation when status is not active or rotating', async () => {
    for (const status of ['pending', 'disconnected', 'revoked', 'error']) {
      const prisma: any = {
        sfConnection: {
          findUnique: jest.fn(async () => activeRow({ status, isActive: false })),
          update: jest.fn(),
        },
      };
      const cfg = { get: () => ENC_KEY } as any as ConfigService;
      const svc = new SfConnectionLifecycleService(prisma, cfg);
      const r = await svc.applyCredentialRotated({
        userId: 'u1',
        payload: {
          new_orchestration_token: 'x',
          new_token_issued_at: new Date('2099-01-01').toISOString(),
          grace_period_seconds: 300,
        },
      });
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(`status_${status}`);
      expect(prisma.sfConnection.update).not.toHaveBeenCalled();
    }
  });

  it('reports no_connection when row missing', async () => {
    const prisma: any = { sfConnection: { findUnique: jest.fn(async () => null), update: jest.fn() } };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotated({
      userId: 'u1',
      payload: {
        new_orchestration_token: 'x',
        new_token_issued_at: new Date().toISOString(),
        grace_period_seconds: 300,
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_connection');
  });
});

describe('SfConnectionLifecycleService — applyConnectionRevoked', () => {
  function activeRow(over: any = {}) {
    return {
      id: 'c1', userId: 'u1', sfTenantId: 'sf-T1', status: 'active', isActive: true,
      inboundSubscriptionId: 'sub-1', disconnectedAt: null,
      lastErrorMessage: null, lastErrorAt: null,
      ...over,
    };
  }

  it('sf_authority initiator → status=revoked, token wiped, subscription deactivated', async () => {
    const conn = activeRow();
    const calls: any = { conn: [], sub: [] };
    const txFns = {
      sfConnection: {
        update: jest.fn(async (args: any) => { calls.conn.push(args); return args.data; }),
      },
      crmWebhookSubscription: {
        update: jest.fn(async (args: any) => { calls.sub.push(args); return args.data; }),
      },
    };
    const prisma: any = {
      sfConnection: { findUnique: jest.fn(async () => conn) },
      $transaction: jest.fn(async (fn: any) => fn(txFns)),
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyConnectionRevoked({
      userId: 'u1',
      initiator: 'sf_authority',
      payload: { reason: 'admin_revoke', detail: 'customer churn' },
    });
    expect(r.ok).toBe(true);
    expect(calls.conn[0].data.status).toBe('revoked');
    expect(calls.conn[0].data.isActive).toBe(false);
    expect(calls.conn[0].data.orchestrationToken).toBe('');
    expect(calls.conn[0].data.previousOrchestrationToken).toBeNull();
    expect(calls.conn[0].data.disconnectInitiator).toBe('sf_authority');
    expect(calls.conn[0].data.disconnectedAt).toBeInstanceOf(Date);
    expect(calls.sub[0].data.isActive).toBe(false);
  });

  it('lb_user initiator → status=disconnected', async () => {
    const conn = activeRow();
    const txFns = {
      sfConnection: { update: jest.fn(async (a: any) => a.data) },
      crmWebhookSubscription: { update: jest.fn() },
    };
    const prisma: any = {
      sfConnection: { findUnique: jest.fn(async () => conn) },
      $transaction: jest.fn(async (fn: any) => fn(txFns)),
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    await svc.applyConnectionRevoked({
      userId: 'u1',
      initiator: 'lb_user',
      payload: { reason: 'lb_initiated', detail: null },
    });
    expect(txFns.sfConnection.update.mock.calls[0][0].data.status).toBe('disconnected');
  });

  it('idempotent re-revoke: already-terminal row preserves original disconnectedAt', async () => {
    const original = new Date('2026-05-01T00:00:00Z');
    const conn = { ...activeRow(), status: 'disconnected', isActive: false, disconnectedAt: original };
    const txFns = {
      sfConnection: { update: jest.fn(async (a: any) => a.data) },
      crmWebhookSubscription: { update: jest.fn() },
    };
    const prisma: any = {
      sfConnection: { findUnique: jest.fn(async () => conn) },
      $transaction: jest.fn(async (fn: any) => fn(txFns)),
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    await svc.applyConnectionRevoked({
      userId: 'u1', initiator: 'lb_user', payload: { reason: 'second_attempt' },
    });
    const data = txFns.sfConnection.update.mock.calls[0][0].data;
    // disconnectedAt preserved from the original disconnect
    expect(data.disconnectedAt).toBe(original);
  });
});
