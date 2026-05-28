jest.mock('axios', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios');

import { ConfigService } from '@nestjs/config';
import { SfOAuthService } from './sf-oauth.service';
import { SfStateToken } from './sf-state-token.util';

const ENV = {
  SF_OAUTH_STATE_SECRET: 'state-secret-32-bytes-long-okay-shh',
  SF_OAUTH_CONNECT_URL: 'https://sf.example.com/oauth/authorize',
  SF_OAUTH_EXCHANGE_URL: 'https://sf.example.com/oauth/token',
  SF_OAUTH_CLIENT_ID: 'lb-client',
  SF_OAUTH_CLIENT_SECRET: 'lb-secret',
  SF_OAUTH_CALLBACK_URL: 'https://leadbridge.example.com/v1/integrations/sf/callback',
};

function buildSvc(opts: {
  existing?: any | null;
  updateThrows?: boolean;
  createReturns?: any;
  pendingFromCallback?: any | null;
  envOverrides?: Record<string, string | undefined>;
} = {}) {
  const calls: any = { findUnique: [], create: [], update: [], updateMany: [] };
  const prisma: any = {
    sfConnection: {
      findUnique: jest.fn(async (args: any) => {
        calls.findUnique.push(args);
        if (args.where?.userId) return opts.existing ?? null;
        if (args.where?.id) return opts.pendingFromCallback ?? null;
        return null;
      }),
      create: jest.fn(async (args: any) => {
        calls.create.push(args);
        return opts.createReturns ?? args.data;
      }),
      update: jest.fn(async (args: any) => {
        calls.update.push(args);
        if (opts.updateThrows) throw new Error('update boom');
        return args.data;
      }),
      updateMany: jest.fn(async (args: any) => {
        calls.updateMany.push(args);
        return { count: 1 };
      }),
    },
  };
  const env = { ...ENV, ...(opts.envOverrides ?? {}) };
  const cfg = {
    get: ((k: string) => env[k as keyof typeof env]) as any,
  } as ConfigService;
  const lifecycle: any = {
    applyConnectionConnected: jest.fn(async () => ({ ok: true, connectionId: 'c1' })),
  };
  return { svc: new SfOAuthService(prisma, cfg, lifecycle), prisma, lifecycle, calls };
}

describe('SfOAuthService — start', () => {
  beforeEach(() => axios.request.mockReset());

  it('creates a pending row + returns a redirect URL with state', async () => {
    const { svc, calls } = buildSvc();
    const r = await svc.start('u1');
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].data.status).toBe('pending');
    expect(calls.create[0].data.userId).toBe('u1');
    expect(calls.create[0].data.isActive).toBe(false);
    expect(r.redirectUrl.startsWith(ENV.SF_OAUTH_CONNECT_URL)).toBe(true);
    expect(r.redirectUrl).toContain('state=');
    expect(r.redirectUrl).toContain('client_id=lb-client');
    expect(r.redirectUrl).toContain('lb_user_id=u1');
    expect(typeof r.pendingConnectionId).toBe('string');
    // state token validates back to the same connection id + user id
    const v = SfStateToken.validate(r.state, ENV.SF_OAUTH_STATE_SECRET);
    expect(v.ok).toBe(true);
    expect(v.envelope?.uid).toBe('u1');
    expect(v.envelope?.cid).toBe(r.pendingConnectionId);
  });

  it('reuses existing row when prior status is pending/disconnected/revoked/error', async () => {
    for (const status of ['pending', 'disconnected', 'revoked', 'error']) {
      const { svc, calls } = buildSvc({
        existing: { id: 'existing-c1', userId: 'u1', status },
      });
      const r = await svc.start('u1');
      expect(r.pendingConnectionId).toBe('existing-c1');
      expect(calls.create).toHaveLength(0);
      expect(calls.update).toHaveLength(1);
      expect(calls.update[0].data.status).toBe('pending');
    }
  });

  it('refuses when an active or rotating row already exists', async () => {
    for (const status of ['active', 'rotating']) {
      const { svc } = buildSvc({ existing: { id: 'c1', userId: 'u1', status } });
      await expect(svc.start('u1')).rejects.toThrow('already_connected');
    }
  });

  it('throws on missing userId', async () => {
    const { svc } = buildSvc();
    await expect(svc.start('')).rejects.toThrow();
  });

  it('throws when SF_OAUTH_* env not configured', async () => {
    const { svc } = buildSvc({
      envOverrides: { SF_OAUTH_CONNECT_URL: undefined },
    });
    await expect(svc.start('u1')).rejects.toThrow(/SF OAuth not configured/);
  });
});

// ─── Callback flow ──────────────────────────────────────────────────

function freshState(userId = 'u1', connId = 'c1'): string {
  return SfStateToken.sign({ userId, pendingConnectionId: connId }, ENV.SF_OAUTH_STATE_SECRET);
}

const VALID_PROVISIONING = {
  sf_tenant_id: 'sf-T1',
  sf_tenant_name: 'Tenant',
  sf_base_url: 'https://sf.example.com',
  orchestration_token: 'sfo_v1_real_token',
  orchestration_token_kid: 'k1',
  token_issued_at: new Date().toISOString(),
  webhook_subscription_id: 'sf-sub-A',
  webhook_signing_secret: 'wh-secret',
  webhook_events: ['connection.connected'],
};

describe('SfOAuthService — handleCallback happy path', () => {
  beforeEach(() => axios.request.mockReset());

  it('validates state, exchanges code, persists, returns success redirect', async () => {
    const { svc, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_PROVISIONING });
    const state = freshState('u1', 'c1');
    const r = await svc.handleCallback({ code: 'sf-auth-code', state });
    expect(r.ok).toBe(true);
    expect(r.httpStatus).toBe(200);
    expect(r.connectionId).toBe('c1');
    expect(lifecycle.applyConnectionConnected).toHaveBeenCalledTimes(1);
    const passed = lifecycle.applyConnectionConnected.mock.calls[0][0];
    expect(passed.userId).toBe('u1');
    expect(passed.connectionId).toBe('c1');
    expect(passed.source).toBe('oauth_exchange');
    expect(passed.provisioning.sf_tenant_id).toBe('sf-T1');
  });

  it('exchange request sends grant_type=authorization_code + lb_user_id', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_PROVISIONING });
    await svc.handleCallback({ code: 'sf-auth-code', state: freshState() });
    const call = axios.request.mock.calls[0][0];
    expect(call.url).toBe(ENV.SF_OAUTH_EXCHANGE_URL);
    expect(call.method).toBe('POST');
    expect(call.data.grant_type).toBe('authorization_code');
    expect(call.data.code).toBe('sf-auth-code');
    expect(call.data.client_id).toBe(ENV.SF_OAUTH_CLIENT_ID);
    expect(call.data.client_secret).toBe(ENV.SF_OAUTH_CLIENT_SECRET);
    expect(call.data.lb_user_id).toBe('u1');
  });
});

describe('SfOAuthService — handleCallback failure modes', () => {
  beforeEach(() => axios.request.mockReset());

  it('SF error in query → marks pending errored, returns 400 sf_denied', async () => {
    const { svc, calls } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    const r = await svc.handleCallback({
      state: freshState(),
      error: 'access_denied',
      error_description: 'user denied',
    });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('sf_denied');
    expect(r.httpStatus).toBe(400);
    expect(axios.request).not.toHaveBeenCalled();
    // pending marked errored (via updateMany)
    const um = calls.updateMany.find(
      (c: any) =>
        c.where?.id === 'c1' && c.data?.status === 'error',
    );
    expect(um).toBeDefined();
  });

  it('missing state or code → invalid_state', async () => {
    const { svc } = buildSvc();
    const r1 = await svc.handleCallback({ code: 'x' });
    expect(r1.errorCode).toBe('invalid_state');
    const r2 = await svc.handleCallback({ state: 'x' });
    expect(r2.errorCode).toBe('invalid_state');
  });

  it('tampered state token → invalid_state', async () => {
    const { svc } = buildSvc();
    const state = freshState();
    const tampered = state.slice(0, -1) + (state.slice(-1) === 'a' ? 'b' : 'a');
    const r = await svc.handleCallback({ code: 'x', state: tampered });
    expect(r.errorCode).toBe('invalid_state');
  });

  it('pending row not found → pending_not_found', async () => {
    const { svc } = buildSvc({ pendingFromCallback: null });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('pending_not_found');
    expect(r.httpStatus).toBe(404);
  });

  it('cross-tenant: state.uid != row.userId → invalid_state', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'OTHER_USER', status: 'pending' },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState('u1', 'c1') });
    expect(r.errorCode).toBe('invalid_state');
    expect(r.errorDetail).toBe('tenant_mismatch');
    expect(r.httpStatus).toBe(403);
  });

  it('replay (already-consumed pending → status=active) → already_active 409', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'active' },
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('already_active');
    expect(r.httpStatus).toBe(409);
    expect(axios.request).not.toHaveBeenCalled();
  });

  it('SF exchange 4xx → marks errored + exchange_failed', async () => {
    const { svc, calls, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 400, data: { error: 'invalid_code' } });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_failed');
    expect(r.httpStatus).toBe(502);
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
    const errMark = calls.updateMany.find(
      (c: any) => c.data?.status === 'error',
    );
    expect(errMark).toBeDefined();
  });

  it('SF exchange returns malformed payload → exchange_failed', async () => {
    const { svc, lifecycle } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({
      status: 200,
      data: { sf_tenant_id: '', orchestration_token: '' }, // missing required
    });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('exchange_failed');
    expect(lifecycle.applyConnectionConnected).not.toHaveBeenCalled();
  });

  it('lifecycle persist fails → persist_failed + marks errored', async () => {
    const { svc, calls } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_PROVISIONING });
    // Override the lifecycle stub to throw
    const lifecycle = (svc as any).lifecycle;
    lifecycle.applyConnectionConnected = jest.fn(async () => { throw new Error('db error'); });
    const r = await svc.handleCallback({ code: 'x', state: freshState() });
    expect(r.errorCode).toBe('persist_failed');
    expect(r.httpStatus).toBe(500);
    const errMark = calls.updateMany.find((c: any) => c.data?.status === 'error');
    expect(errMark).toBeDefined();
  });
});

describe('SfOAuthService — log safety', () => {
  beforeEach(() => axios.request.mockReset());

  it('exchange success log does NOT include the orchestration token', async () => {
    const { svc } = buildSvc({
      pendingFromCallback: { id: 'c1', userId: 'u1', status: 'pending' },
    });
    axios.request.mockResolvedValue({ status: 200, data: VALID_PROVISIONING });
    const logSpy = jest.spyOn((svc as any).logger, 'log');
    await svc.handleCallback({ code: 'sf-auth-code', state: freshState() });
    const allLogs = logSpy.mock.calls.flat().map(String).join('\n');
    expect(allLogs).not.toContain('sfo_v1_real_token');
    // We DO log token_kid + token_len
    expect(allLogs).toMatch(/token_kid=k1/);
    expect(allLogs).toMatch(/token_len=\d+/);
  });
});
