jest.mock('axios', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios');

import { ConfigService } from '@nestjs/config';
import { SfOAuthService } from './sf-oauth.service';
import { SfStateToken } from './sf-state-token.util';

const ENV = {
  SF_OAUTH_STATE_SECRET: 'state-secret-32-bytes-long-okay-shh',
  SF_OAUTH_CONNECT_URL: 'https://sf-staging/authorize',
  SF_OAUTH_EXCHANGE_URL: 'https://sf-staging/oauth/exchange',
  SF_OAUTH_CLIENT_ID: 'leadbridge_staging',
  SF_OAUTH_CLIENT_SECRET: 'lb-client-secret',
  SF_OAUTH_CALLBACK_URL: 'https://lb-staging/api/v1/integrations/sf/callback',
};

const VALID_PROVISIONING = {
  version: '1',
  tenant: {
    sf_tenant_id: 99999,
    sf_tenant_name: 'T',
    sf_workspace_id: 88888,
    sf_base_url: 'https://sf-staging',
    source_instance: 'sf-staging',
    api_region: null,
  },
  endpoints: {
    availability: '/a', booking_request: '/b', booking_cancel: '/c', handoff: '/h', disconnect: '/d',
  },
  credential: {
    token: 'sfo_v1.eyJ2IjoiMSJ9.real_token_xyz',
    token_prefix: 'sfo_v1.eyJ2Ij',
    kid: 'sf_orch_2026_05',
    scope: 'lb_orchestration',
    issued_at: '2026-05-28T16:55:39.040Z',
    expires_at: '2026-08-26T16:55:39.040Z',
  },
  event_types: ['connection.connected'],
  signature_metadata: {
    algorithm: 'hmac-sha256-hex',
    max_clock_skew_seconds: 300,
    headers: { signature: 'X-SF-Signature', timestamp: 'X-SF-Timestamp', event_id: 'X-SF-Event-Id', event_type: 'X-SF-Event-Type', tenant_id: 'X-SF-Tenant-Id', kid: 'X-SF-Kid' },
  },
  webhook: { url: 'https://lb', set_at: 't', secret_set: true, subscription_id: 'lb_sub', state_ref: 'lb_conn' },
};

const VALID_EXCHANGE_RESPONSE = { connected: true, provisioning: VALID_PROVISIONING };

function buildSvc(opts: {
  existing?: any | null;
  pendingFromCallback?: any | null;
  envOverrides?: Record<string, string | undefined>;
  lifecycleThrows?: boolean;
} = {}) {
  const calls: any = { create: [], update: [], updateMany: [] };
  const prisma: any = {
    sfConnection: {
      findUnique: jest.fn(async (args: any) => {
        if (args.where?.userId) return opts.existing ?? null;
        if (args.where?.id) return opts.pendingFromCallback ?? null;
        return null;
      }),
      create: jest.fn(async (a: any) => { calls.create.push(a); return a.data; }),
      update: jest.fn(async (a: any) => { calls.update.push(a); return a.data; }),
      updateMany: jest.fn(async (a: any) => { calls.updateMany.push(a); return { count: 1 }; }),
    },
  };
  const env = { ...ENV, ...(opts.envOverrides ?? {}) };
  const cfg = { get: ((k: string) => env[k as keyof typeof env]) as any } as ConfigService;
  const lifecycle: any = {
    applyConnectionConnected: jest.fn(async () => {
      if (opts.lifecycleThrows) throw new Error('db error');
      return { ok: true, connectionId: 'c1' };
    }),
  };
  return { svc: new SfOAuthService(prisma, cfg, lifecycle), prisma, calls, lifecycle };
}

const freshState = (uid = 'u1', cid = 'c1') =>
  SfStateToken.sign({ userId: uid, pendingConnectionId: cid }, ENV.SF_OAUTH_STATE_SECRET);

describe('SfOAuthService — start', () => {
  beforeEach(() => axios.request.mockReset());

  it('creates pending row + returns SF authorize URL with state, client_id, scope=lb_orchestration', async () => {
    const { svc, calls } = buildSvc();
    const r = await svc.start('u1');
    expect(calls.create).toHaveLength(1);
    const url = new URL(r.redirectUrl);
    expect(url.origin + url.pathname).toBe(ENV.SF_OAUTH_CONNECT_URL);
    expect(url.searchParams.get('client_id')).toBe('leadbridge_staging');
    expect(url.searchParams.get('scope')).toBe('lb_orchestration');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe(r.state);
  });

  it('refuses when active or rotating row exists', async () => {
    for (const status of ['active', 'rotating']) {
      const { svc } = buildSvc({ existing: { id: 'c1', userId: 'u1', status } });
      await expect(svc.start('u1')).rejects.toThrow('already_connected');
    }
  });

  it('reuses existing row when prior status is terminal/pending', async () => {
    for (const status of ['pending', 'disconnected', 'revoked', 'error']) {
      const { svc, calls } = buildSvc({ existing: { id: 'existing-c1', userId: 'u1', status } });
      const r = await svc.start('u1');
      expect(r.pendingConnectionId).toBe('existing-c1');
      expect(calls.update[0].data.status).toBe('pending');
    }
  });

  it('throws when SF_OAUTH env missing', async () => {
    const { svc } = buildSvc({ envOverrides: { SF_OAUTH_CONNECT_URL: undefined } });
    await expect(svc.start('u1')).rejects.toThrow(/SF OAuth not configured/);
  });
});

describe('SfOAuthService — handleCallback happy path (canonical flow)', () => {
  beforeEach(() => axios.request.mockReset());

  it('validates state, generates webhook secret, POSTs to /oauth/exchange with LB-authored webhook block, persists', async () => {
    const { svc, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_EXCHANGE_RESPONSE });
    const r = await svc.handleCallback({ code: 'sfauth_v1.code', state: freshState() });
    expect(r.ok).toBe(true);
    expect(r.connectionId).toBe('c1');

    // Exchange request shape — LB authors the webhook block
    const call = axios.request.mock.calls[0][0];
    expect(call.url).toBe(ENV.SF_OAUTH_EXCHANGE_URL);
    expect(call.method).toBe('POST');
    expect(call.data.grant_type).toBeUndefined(); // canonical: no grant_type in S4 spec; LB sends client creds + code only
    expect(call.data.client_id).toBe(ENV.SF_OAUTH_CLIENT_ID);
    expect(call.data.client_secret).toBe(ENV.SF_OAUTH_CLIENT_SECRET);
    expect(call.data.code).toBe('sfauth_v1.code');
    expect(call.data.redirect_uri).toBe(ENV.SF_OAUTH_CALLBACK_URL);
    expect(call.data.webhook.url).toMatch(/\/orchestration-webhook$/);
    expect(typeof call.data.webhook.secret).toBe('string');
    expect(call.data.webhook.secret.length).toBeGreaterThanOrEqual(40);
    expect(call.data.webhook.subscription_id).toMatch(/^lb_sub_/);

    // Lifecycle receives the LB-generated secret separately
    const passed = lifecycle.applyConnectionConnected.mock.calls[0][0];
    expect(passed.source).toBe('oauth_exchange');
    expect(typeof passed.webhookSecretPlaintext).toBe('string');
    expect(passed.webhookSecretPlaintext.length).toBeGreaterThanOrEqual(40);
    expect(passed.provisioning).toBe(VALID_PROVISIONING);
  });
});

describe('SfOAuthService — handleCallback failure paths', () => {
  beforeEach(() => axios.request.mockReset());

  it('SF error redirect → marks pending errored, returns 400 sf_denied', async () => {
    const { svc, calls } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    const r = await svc.handleCallback({
      state: freshState(), error: 'access_denied', error_description: 'user_declined',
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('sf_denied');
    expect(axios.request).not.toHaveBeenCalled();
    expect(calls.updateMany.find((c: any) => c.data?.status === 'error')).toBeDefined();
  });

  it('missing state or code → invalid_state', async () => {
    const { svc } = buildSvc();
    expect((await svc.handleCallback({ code: 'x' })).errorCode).toBe('invalid_state');
    expect((await svc.handleCallback({ state: 'x' })).errorCode).toBe('invalid_state');
  });

  it('tampered state → invalid_state', async () => {
    const { svc } = buildSvc();
    const s = freshState();
    const tampered = s.slice(0, -1) + (s.slice(-1) === 'a' ? 'b' : 'a');
    const r = await svc.handleCallback({ code: 'x', state: tampered });
    expect(r.errorCode).toBe('invalid_state');
  });

  it('pending row not found → pending_not_found', async () => {
    const { svc } = buildSvc({ pendingFromCallback: null });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('pending_not_found');
  });

  it('cross-tenant state → 403 invalid_state tenant_mismatch', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'OTHER', status: 'pending' },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('invalid_state');
    expect(r.errorDetail).toBe('tenant_mismatch');
    expect(r.httpStatus).toBe(403);
  });

  it('pending row already active (replay) → already_active 409', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'active' },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('already_active');
    expect(r.httpStatus).toBe(409);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('SF 401 invalid_client → exchange_invalid_client', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 401, data: { error: 'invalid_client' } });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_invalid_client');
  });

  it('SF 400 invalid_code → exchange_invalid_code', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 400, data: { error: 'invalid_code' } });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_invalid_code');
  });

  it('SF 400 webhook_host_not_allowed → exchange_webhook_rejected', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 400, data: { error: 'webhook_host_not_allowed' } });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_webhook_rejected');
  });

  it('SF 503 service_unavailable → exchange_service_unavailable', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 503, data: { error: 'service_unavailable' } });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_service_unavailable');
  });

  it('malformed exchange response (missing required fields) → invalid_provisioning_payload', async () => {
    const { svc, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({
      status: 200,
      data: { connected: true, provisioning: { version: '1', tenant: {} } },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('invalid_provisioning_payload');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('exchange version mismatch (version=2) → invalid_provisioning_payload', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({
      status: 200,
      data: { connected: true, provisioning: { ...VALID_PROVISIONING, version: '2' } },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('invalid_provisioning_payload');
    expect(r.errorDetail).toMatch(/bad_version/);
  });

  it('persist failure → persist_failed + marks pending errored', async () => {
    const { svc, calls } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
      lifecycleThrows: true,
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_EXCHANGE_RESPONSE });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('persist_failed');
    expect(calls.updateMany.find((c: any) => c.data?.status === 'error')).toBeDefined();
  });
});

describe('SfOAuthService — 409 code_already_used handling (idempotent replay)', () => {
  beforeEach(() => axios.request.mockReset());

  it('SF 409 code_already_used + active existing row → idempotent success', async () => {
    const { svc, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
      existing: { id: 'c1', userId: 'u1', status: 'active' },
    });
    axios.request.mockResolvedValue({
      status: 409,
      data: { error: 'code_already_used', prior_credential_id: 42 },
    });
    const r = await svc.handleCallback({ code: 'replayed', state: freshState() });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.resolvedExistingConnectionId).toBe('c1');
    // No persist for idempotent path
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('SF 409 code_already_used + NO active existing → exchange_invalid_code', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
      existing: { id: 'c1', userId: 'u1', status: 'pending' },  // not active
    });
    axios.request.mockResolvedValue({
      status: 409,
      data: { error: 'code_already_used', prior_credential_id: null },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('exchange_invalid_code');
  });
});

describe('SfOAuthService — 409 already_connected handling', () => {
  beforeEach(() => axios.request.mockReset());

  it('SF 409 already_connected → exchange_already_connected + marks errored', async () => {
    const { svc, calls } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({
      status: 409,
      data: { error: 'already_connected', error_description: 'tenant has active credential' },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('exchange_already_connected');
    expect(r.httpStatus).toBe(409);
    expect(calls.updateMany.find((c: any) => c.data?.status === 'error')).toBeDefined();
  });
});

describe('SfOAuthService — log safety', () => {
  beforeEach(() => axios.request.mockReset());

  it('exchange success log does NOT include the orchestration token or webhook secret', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_EXCHANGE_RESPONSE });
    const logSpy = jest.spyOn((svc as any).logger, 'log');
    await svc.handleCallback({ code: 'x', state: freshState() });
    const allLogs = logSpy.mock.calls.flat().map(String).join('\n');
    expect(allLogs).not.toContain('sfo_v1.eyJ2IjoiMSJ9.real_token_xyz');
    // LB-generated webhook secret must not leak either
    const exchangeCall = axios.request.mock.calls[0][0];
    expect(allLogs).not.toContain(exchangeCall.data.webhook.secret);
    // We DO log token_prefix + token_len + webhook_secret_len
    expect(allLogs).toMatch(/token_prefix=sfo_v1.eyJ2Ij/);
    expect(allLogs).toMatch(/token_len=\d+/);
    expect(allLogs).toMatch(/webhook_secret_len=\d+/);
  });
});
