import { ConfigService } from '@nestjs/config';
import { SfConnectionLifecycleService } from './sf-connection-lifecycle.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';
import type { SfProvisioningPayload } from './sf-connection.contracts';

const ENC_KEY = 'lifecycle-spec-key-32-bytes-long-okay';

function makeProvisioning(over: Partial<SfProvisioningPayload> = {}): SfProvisioningPayload {
  return {
    version: '1',
    tenant: {
      sf_tenant_id: 99999,
      sf_tenant_name: 'Test Tenant',
      sf_workspace_id: 88888,
      sf_base_url: 'https://service-flow-backend-staging-303f.up.railway.app',
      source_instance: 'sf-staging',
      api_region: null,
    },
    endpoints: {
      availability: '/api/integrations/leadbridge/orchestration/availability',
      booking_request: '/api/integrations/leadbridge/orchestration/booking-request',
      booking_cancel: '/api/integrations/leadbridge/orchestration/booking-cancel',
      handoff: '/api/integrations/leadbridge/orchestration/handoff',
      disconnect: '/api/integrations/leadbridge/disconnect',
    },
    credential: {
      token: 'sfo_v1.eyJ2IjoiMSJ9.abcdefghijklmnopqrstuvwxyz0123456789',
      token_prefix: 'sfo_v1.eyJ2Ij',
      kid: 'sf_orch_2026_05',
      scope: 'lb_orchestration',
      issued_at: '2026-05-28T16:55:39.040Z',
      expires_at: '2026-08-26T16:55:39.040Z',
    },
    event_types: [
      'service_scheduled', 'service_rescheduled', 'service_cancelled', 'service_completed',
      'connection.connected', 'credential.rotated', 'connection.revoked',
    ],
    signature_metadata: {
      algorithm: 'hmac-sha256-hex',
      body_canonical_form: 'raw_utf8_request_body',
      headers: {
        signature: 'X-SF-Signature', timestamp: 'X-SF-Timestamp', event_id: 'X-SF-Event-Id',
        event_type: 'X-SF-Event-Type', tenant_id: 'X-SF-Tenant-Id', kid: 'X-SF-Kid',
      },
      max_clock_skew_seconds: 300,
    },
    webhook: {
      url: 'https://thumbtack-bridge-staging.up.railway.app/api/v1/integrations/sf/orchestration-webhook',
      set_at: '2026-05-28T16:55:39.103Z',
      secret_set: true,
      subscription_id: 'lb_sub_conn1',
      state_ref: 'lb_conn_conn1',
    },
    ...over,
  };
}

function buildDeps(opts: { existing?: any | null; existingSubSecret?: string } = {}) {
  const calls: any = { conn: [], sub: [] };
  const txFns = {
    sfConnection: {
      update: jest.fn(async (a: any) => { calls.conn.push({ op: 'update', args: a }); return a.data; }),
      create: jest.fn(async (a: any) => { calls.conn.push({ op: 'create', args: a }); return a.data; }),
    },
    crmWebhookSubscription: {
      upsert: jest.fn(async (a: any) => { calls.sub.push({ op: 'upsert', args: a }); return { id: 'sub-1' }; }),
      update: jest.fn(async (a: any) => { calls.sub.push({ op: 'update', args: a }); return a.data; }),
    },
  };
  const prisma: any = {
    sfConnection: { findUnique: jest.fn(async () => opts.existing ?? null) },
    crmWebhookSubscription: {
      findUnique: jest.fn(async () =>
        opts.existingSubSecret ? { secret: opts.existingSubSecret } : null,
      ),
      update: txFns.crmWebhookSubscription.update,
    },
    $transaction: jest.fn(async (fn: any) => fn(txFns)),
  };
  const cfg = { get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any } as ConfigService;
  return { svc: new SfConnectionLifecycleService(prisma, cfg), prisma, calls, txFns };
}

describe('SfConnectionLifecycleService — applyConnectionConnected (canonical nested payload)', () => {
  it('creates fresh row with LB-supplied webhook secret + encrypted token + endpoints stored', async () => {
    const { svc, txFns } = buildDeps();
    const p = makeProvisioning();
    const r = await svc.applyConnectionConnected({
      userId: 'u1',
      connectionId: 'c1',
      provisioning: p,
      webhookSecretPlaintext: 'lb-generated-secret-44chars-base64-zzzz',
      webhookUrl: p.webhook.url,
      webhookSubscriptionId: p.webhook.subscription_id,
      webhookStateRef: p.webhook.state_ref,
      source: 'oauth_exchange',
    });
    expect(r.ok).toBe(true);
    expect(txFns.sfConnection.create).toHaveBeenCalledTimes(1);
    const data = txFns.sfConnection.create.mock.calls[0][0].data;

    // sf_tenant_id arrives as number, stored as string
    expect(data.sfTenantId).toBe('99999');
    expect(data.sfWorkspaceId).toBe('88888');
    expect(data.baseUrl).toBe(p.tenant.sf_base_url);
    expect(data.sourceInstance).toBe('sf-staging');
    expect(data.signatureKeyId).toBe(p.credential.kid);
    expect(data.signatureAlgorithm).toBe('hmac-sha256-hex');
    expect(data.maxClockSkewSeconds).toBe(300);
    expect(data.tokenPrefix).toBe('sfo_v1.eyJ2Ij');
    expect(data.tokenLastRotationSource).toBe('handshake');
    expect(data.status).toBe('active');
    expect(data.isActive).toBe(true);

    // Token encrypted, not plaintext
    expect(data.orchestrationToken).not.toBe(p.credential.token);
    expect(EncryptionUtil.decrypt(data.orchestrationToken, ENC_KEY)).toBe(p.credential.token);

    // Endpoints persisted as JSON
    expect(typeof data.endpointsJson).toBe('string');
    expect(JSON.parse(data.endpointsJson).disconnect).toBe('/api/integrations/leadbridge/disconnect');

    // Webhook subscription upserted with the LB-supplied secret (encrypted)
    const subData = txFns.crmWebhookSubscription.upsert.mock.calls[0][0];
    const subSecret = subData.create.secret;
    expect(subSecret).not.toBe('lb-generated-secret-44chars-base64-zzzz');
    expect(EncryptionUtil.decrypt(subSecret, ENC_KEY)).toBe('lb-generated-secret-44chars-base64-zzzz');
  });

  it('idempotent re-delivery: existing active + same sfTenantId + same issued_at → noop', async () => {
    const existing = {
      id: 'c1', userId: 'u1', sfTenantId: '99999', status: 'active',
      tokenIssuedAt: new Date('2026-05-28T16:55:39.040Z'),
      inboundSubscriptionId: 'sub-1',
    };
    const { svc, txFns } = buildDeps({ existing, existingSubSecret: 'enc' });
    const r = await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1', provisioning: makeProvisioning(),
      source: 'sf_push',
    });
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
    expect(txFns.sfConnection.create).not.toHaveBeenCalled();
    expect(txFns.sfConnection.update).not.toHaveBeenCalled();
  });

  it('reconnect (status=disconnected) updates existing row + clears terminal markers', async () => {
    const existing = {
      id: 'c1', userId: 'u1', sfTenantId: '99999', status: 'disconnected',
      tokenIssuedAt: new Date('2026-01-01'), inboundSubscriptionId: 'sub-1',
    };
    const { svc, txFns } = buildDeps({ existing, existingSubSecret: EncryptionUtil.encrypt('old', ENC_KEY) });
    await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1',
      provisioning: makeProvisioning({ credential: { ...makeProvisioning().credential, issued_at: '2026-05-28T16:55:39.040Z' } }),
      webhookSecretPlaintext: 'fresh-secret', webhookUrl: 'https://x/y',
      source: 'oauth_exchange',
    });
    expect(txFns.sfConnection.update).toHaveBeenCalledTimes(1);
    const data = txFns.sfConnection.update.mock.calls[0][0].data;
    expect(data.status).toBe('active');
    expect(data.isActive).toBe(true);
    expect(data.disconnectedAt).toBeNull();
    expect(data.disconnectInitiator).toBeNull();
    expect(data.lastErrorAt).toBeNull();
    expect(data.previousOrchestrationToken).toBeNull();
  });

  it('sf_push without webhook secret + no existing subscription → rejected', async () => {
    const { svc } = buildDeps();
    const r = await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1', provisioning: makeProvisioning(),
      source: 'sf_push',
      // no webhookSecretPlaintext, no existing connection
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('cold_sf_push_without_secret');
  });

  it('sf_push re-delivery preserves existing subscription secret', async () => {
    const existing = {
      id: 'c1', userId: 'u1', sfTenantId: '99999', status: 'active',
      tokenIssuedAt: new Date('2026-01-01'), inboundSubscriptionId: 'sub-1',
    };
    const storedSecret = EncryptionUtil.encrypt('original-secret', ENC_KEY);
    const { svc, txFns } = buildDeps({ existing, existingSubSecret: storedSecret });
    await svc.applyConnectionConnected({
      userId: 'u1', connectionId: 'c1',
      provisioning: makeProvisioning({ credential: { ...makeProvisioning().credential, issued_at: '2026-06-01T10:00:00Z' } }),
      source: 'sf_push',
    });
    // upsert should be called with the preserved secret (same encrypted value)
    const subData = txFns.crmWebhookSubscription.upsert.mock.calls[0][0];
    expect(subData.update.secret).toBe(storedSecret);
  });
});

describe('SfConnectionLifecycleService — applyCredentialRotated', () => {
  function activeRow(over: any = {}) {
    return {
      id: 'c1', userId: 'u1', sfTenantId: '99999',
      tokenIssuedAt: new Date('2026-05-28T16:55:39.040Z'),
      orchestrationToken: 'current-enc', isActive: true, status: 'active',
      ...over,
    };
  }

  it('demotes current to previous + stores new + status=rotating + grace window', async () => {
    const conn = activeRow();
    const updates: any[] = [];
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async () => conn),
        update: jest.fn(async (a: any) => { updates.push(a); return a.data; }),
      },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const before = Date.now();
    const r = await svc.applyCredentialRotated({
      userId: 'u1',
      payload: {
        new_credential: {
          token: 'sfo_v1_new', token_prefix: 'sfo_v1.eyJ2Ij',
          kid: 'kid-2', issued_at: '2026-06-01T10:00:00Z',
          expires_at: '2026-09-01T10:00:00Z',
        },
        grace_period_seconds: 300,
      },
    });
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
    const data = updates[0].data;
    expect(data.status).toBe('rotating');
    expect(data.previousOrchestrationToken).toBe('current-enc');
    expect(data.orchestrationTokenKid).toBe('kid-2');
    expect(data.signatureKeyId).toBe('kid-2');
    expect(data.tokenPrefix).toBe('sfo_v1.eyJ2Ij');
    expect(EncryptionUtil.decrypt(data.orchestrationToken, ENC_KEY)).toBe('sfo_v1_new');
    const graceMs = (data.previousTokenExpiresAt as Date).getTime() - before;
    expect(graceMs).toBeGreaterThanOrEqual(295_000);
    expect(graceMs).toBeLessThanOrEqual(305_000);
  });

  it('stale issued_at → noop', async () => {
    const conn = activeRow();
    const prisma: any = {
      sfConnection: { findUnique: jest.fn(async () => conn), update: jest.fn() },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotated({
      userId: 'u1',
      payload: {
        new_credential: {
          token: 'should_not_apply', token_prefix: 'p', kid: 'k',
          issued_at: conn.tokenIssuedAt.toISOString(), expires_at: '2099-01-01',
        },
        grace_period_seconds: 300,
      },
    });
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
    expect(prisma.sfConnection.update).not.toHaveBeenCalled();
  });
});

describe('SfConnectionLifecycleService — applyCredentialRotationNotification (R1)', () => {
  function activeRow(over: any = {}) {
    return {
      id: 'c1', userId: 'u1', sfTenantId: '99999',
      isActive: true, status: 'active',
      rotationPending: false,
      pendingRotationCredId: null,
      pendingRotationGraceExpiresAt: null,
      ...over,
    };
  }

  it('persists rotationPending + pending* fields + does NOT touch token/kid', async () => {
    const conn = activeRow();
    const updates: any[] = [];
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async () => conn),
        update: jest.fn(async (a: any) => { updates.push(a); return a.data; }),
      },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);

    const graceExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const r = await svc.applyCredentialRotationNotification({
      userId: 'u1',
      newCredId: 12,
      newKid: 'sf_orch_2026_05',
      newTokenPrefix: 'sfo_v1.eyJ2Ij',
      newExpiresAt: '2026-08-27T00:55:28.992Z',
      previousGraceExpiresAt: graceExp,
      previousCredId: 11,
      reason: 'lifecycle_verify_v2',
      eventId: 'evt-1',
    });
    expect(r.ok).toBe(true);
    expect(updates).toHaveLength(1);
    const data = updates[0].data;
    expect(data.rotationPending).toBe(true);
    expect(data.pendingRotationKid).toBe('sf_orch_2026_05');
    expect(data.pendingRotationCredId).toBe('12'); // coerced to string
    expect(data.pendingRotationGraceExpiresAt).toEqual(new Date(graceExp));
    expect(data.pendingRotationObservedAt).toBeInstanceOf(Date);
    // Critical: notification path MUST NOT mutate token/kid/signature fields.
    expect(data.orchestrationToken).toBeUndefined();
    expect(data.orchestrationTokenKid).toBeUndefined();
    expect(data.signatureKeyId).toBeUndefined();
    expect(data.tokenPrefix).toBeUndefined();
    expect(data.previousOrchestrationToken).toBeUndefined();
    expect(data.status).toBeUndefined(); // status stays 'active'
  });

  it('idempotent on same cred_id + same grace expiry', async () => {
    const graceExp = new Date(Date.now() + 5 * 60 * 1000);
    const conn = activeRow({
      rotationPending: true,
      pendingRotationCredId: '12',
      pendingRotationGraceExpiresAt: graceExp,
    });
    const prisma: any = {
      sfConnection: {
        findUnique: jest.fn(async () => conn),
        update: jest.fn(),
      },
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);

    const r = await svc.applyCredentialRotationNotification({
      userId: 'u1',
      newCredId: 12,
      previousGraceExpiresAt: graceExp.toISOString(),
    });
    expect(r.ok).toBe(true);
    expect(r.noop).toBe(true);
    expect(prisma.sfConnection.update).not.toHaveBeenCalled();
  });

  it('rejects when connection missing', async () => {
    const prisma: any = { sfConnection: { findUnique: jest.fn(async () => null), update: jest.fn() } };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotationNotification({
      userId: 'u-missing',
      newCredId: 12,
      previousGraceExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_connection');
    expect(prisma.sfConnection.update).not.toHaveBeenCalled();
  });

  it('rejects when connection inactive (revoked/disconnected)', async () => {
    const conn = activeRow({ status: 'revoked', isActive: false });
    const prisma: any = { sfConnection: { findUnique: jest.fn(async () => conn), update: jest.fn() } };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotationNotification({
      userId: 'u1',
      newCredId: 12,
      previousGraceExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('status_revoked');
  });

  it('rejects when previousGraceExpiresAt is unparseable', async () => {
    const conn = activeRow();
    const prisma: any = { sfConnection: { findUnique: jest.fn(async () => conn), update: jest.fn() } };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyCredentialRotationNotification({
      userId: 'u1', newCredId: 12, previousGraceExpiresAt: 'not-a-date',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('invalid_grace');
  });
});

describe('SfConnectionLifecycleService — applyConnectionRevoked', () => {
  function activeRow(over: any = {}) {
    return {
      id: 'c1', userId: 'u1', sfTenantId: '99999', status: 'active', isActive: true,
      inboundSubscriptionId: 'sub-1', disconnectedAt: null, lastErrorMessage: null, lastErrorAt: null,
      ...over,
    };
  }

  it('sf_authority → status=revoked, token wiped, subscription deactivated', async () => {
    const conn = activeRow();
    const txFns = {
      sfConnection: { update: jest.fn(async (a: any) => a.data) },
      crmWebhookSubscription: { update: jest.fn(async (a: any) => a.data) },
    };
    const prisma: any = {
      sfConnection: { findUnique: jest.fn(async () => conn) },
      $transaction: jest.fn(async (fn: any) => fn(txFns)),
    };
    const cfg = { get: () => ENC_KEY } as any as ConfigService;
    const svc = new SfConnectionLifecycleService(prisma, cfg);
    const r = await svc.applyConnectionRevoked({
      userId: 'u1', initiator: 'sf_authority',
      payload: { reason: 'admin_revoke', detail: 'churn' },
    });
    expect(r.ok).toBe(true);
    const data = txFns.sfConnection.update.mock.calls[0][0].data;
    expect(data.status).toBe('revoked');
    expect(data.isActive).toBe(false);
    expect(data.orchestrationToken).toBe('');
    expect(data.previousOrchestrationToken).toBeNull();
    expect(data.disconnectInitiator).toBe('sf_authority');
    expect(data.disconnectedAt).toBeInstanceOf(Date);
    expect(txFns.crmWebhookSubscription.update.mock.calls[0][0].data.isActive).toBe(false);
  });

  it('lb_user → status=disconnected', async () => {
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
    await svc.applyConnectionRevoked({ userId: 'u1', initiator: 'lb_user', payload: {} });
    expect(txFns.sfConnection.update.mock.calls[0][0].data.status).toBe('disconnected');
  });

  it('re-revoke preserves original disconnectedAt', async () => {
    const original = new Date('2026-05-01T00:00:00Z');
    const conn = activeRow({ status: 'disconnected', isActive: false, disconnectedAt: original });
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
    await svc.applyConnectionRevoked({ userId: 'u1', initiator: 'lb_user', payload: {} });
    expect(txFns.sfConnection.update.mock.calls[0][0].data.disconnectedAt).toBe(original);
  });
});
