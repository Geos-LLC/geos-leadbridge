jest.mock('axios', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const axios = require('axios');

import { ConfigService } from '@nestjs/config';
import { SfDisconnectService } from './sf-disconnect.service';
import { EncryptionUtil } from '../../common/utils/encryption.util';

const ENC_KEY = 'disconnect-spec-key-32-bytes-len-yes';

function buildSvc(opts: { connection?: any | null; lifecycleResult?: any } = {}) {
  const calls: any = { lifecycle: [] };
  const prisma: any = {
    sfConnection: { findUnique: jest.fn(async () => opts.connection ?? null) },
  };
  const cfg = {
    get: ((k: string) => (k === 'encryption.key' ? ENC_KEY : undefined)) as any,
  } as ConfigService;
  const lifecycle: any = {
    applyConnectionRevoked: jest.fn(async (args: any) => {
      calls.lifecycle.push(args);
      return opts.lifecycleResult ?? { ok: true };
    }),
  };
  return { svc: new SfDisconnectService(prisma, cfg, lifecycle), prisma, lifecycle, calls };
}

function activeRow(over: any = {}) {
  return {
    id: 'c1',
    userId: 'u1',
    sfTenantId: 'sf-T1',
    baseUrl: 'https://sf.example.com',
    orchestrationToken: EncryptionUtil.encrypt('sfo_v1_active', ENC_KEY),
    orchestrationTokenKid: 'k1',
    status: 'active',
    isActive: true,
    ...over,
  };
}

describe('SfDisconnectService — happy path', () => {
  beforeEach(() => axios.request.mockReset());

  it('active row + 2xx SF revoke → remote_revoked=true + lifecycle disconnected', async () => {
    const { svc, lifecycle } = buildSvc({ connection: activeRow() });
    axios.request.mockResolvedValue({ status: 200, data: { ok: true } });
    const r = await svc.disconnect({
      userId: 'u1',
      request: { initiator: 'lb_user', reason: 'user_click' },
    });
    expect(r.success).toBe(true);
    expect(r.remote_revoked).toBe(true);
    expect(r.status).toBe('disconnected');
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalledTimes(1);
    const passed = lifecycle.applyConnectionRevoked.mock.calls[0][0];
    expect(passed.userId).toBe('u1');
    expect(passed.initiator).toBe('lb_user');
    // Outbound call: bearer was set, body contains sf_tenant_id
    const call = axios.request.mock.calls[0][0];
    expect(call.headers.Authorization).toBe('Bearer sfo_v1_active');
    expect(call.data.sf_tenant_id).toBe('sf-T1');
    expect(call.data.initiator).toBe('lb_user');
  });

  it('lb_admin initiator is honored', async () => {
    const { svc, lifecycle } = buildSvc({ connection: activeRow() });
    axios.request.mockResolvedValue({ status: 200, data: {} });
    await svc.disconnect({
      userId: 'u1',
      request: { initiator: 'lb_admin', reason: 'admin' },
    });
    expect(lifecycle.applyConnectionRevoked.mock.calls[0][0].initiator).toBe('lb_admin');
  });
});

describe('SfDisconnectService — remote failure paths (local must still succeed)', () => {
  beforeEach(() => axios.request.mockReset());

  it('SF returns 5xx → remote_revoked=false, local still disconnected', async () => {
    const { svc, lifecycle } = buildSvc({ connection: activeRow() });
    axios.request.mockResolvedValue({ status: 500, data: { error: 'boom' } });
    const r = await svc.disconnect({
      userId: 'u1',
      request: { initiator: 'lb_user' },
    });
    expect(r.success).toBe(true);
    expect(r.remote_revoked).toBe(false);
    expect(r.status).toBe('disconnected');
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalled();
  });

  it('SF network error → remote_revoked=false, local still disconnected', async () => {
    const { svc, lifecycle } = buildSvc({ connection: activeRow() });
    axios.request.mockRejectedValue(new Error('socket hang up'));
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.remote_revoked).toBe(false);
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalled();
  });

  it('token decrypt fails → remote skipped, local still disconnected', async () => {
    const broken = activeRow({ orchestrationToken: 'not-encrypted-garbage' });
    const { svc, lifecycle } = buildSvc({ connection: broken });
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.remote_revoked).toBe(false);
    expect(axios.request).not.toHaveBeenCalled();
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalled();
  });
});

describe('SfDisconnectService — idempotency', () => {
  beforeEach(() => axios.request.mockReset());

  it('no row → success noop, no SF call, no lifecycle call', async () => {
    const { svc, lifecycle } = buildSvc({ connection: null });
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.remote_revoked).toBe(false);
    expect(r.status).toBe('disconnected');
    expect(axios.request).not.toHaveBeenCalled();
    expect(lifecycle.applyConnectionRevoked).not.toHaveBeenCalled();
  });

  it('already disconnected → success noop, returns disconnected status', async () => {
    const { svc, lifecycle } = buildSvc({
      connection: activeRow({ status: 'disconnected', isActive: false }),
    });
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.status).toBe('disconnected');
    expect(r.remote_revoked).toBe(false);
    expect(axios.request).not.toHaveBeenCalled();
    expect(lifecycle.applyConnectionRevoked).not.toHaveBeenCalled();
  });

  it('already revoked (SF event arrived first) → success noop, returns revoked status', async () => {
    const { svc, lifecycle } = buildSvc({
      connection: activeRow({ status: 'revoked', isActive: false }),
    });
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.status).toBe('revoked');
    expect(r.remote_revoked).toBe(true);
    expect(axios.request).not.toHaveBeenCalled();
    expect(lifecycle.applyConnectionRevoked).not.toHaveBeenCalled();
  });

  it('pending row → fully disconnected (handshake abandoned)', async () => {
    const { svc, lifecycle } = buildSvc({
      connection: activeRow({ status: 'pending', isActive: false }),
    });
    axios.request.mockResolvedValue({ status: 200, data: {} });
    const r = await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    expect(r.success).toBe(true);
    expect(r.status).toBe('disconnected');
    expect(lifecycle.applyConnectionRevoked).toHaveBeenCalled();
  });
});

describe('SfDisconnectService — log safety', () => {
  beforeEach(() => axios.request.mockReset());

  it('never logs the plaintext bearer token', async () => {
    const { svc } = buildSvc({ connection: activeRow() });
    axios.request.mockResolvedValue({ status: 200, data: {} });
    const logSpy = jest.spyOn((svc as any).logger, 'log');
    await svc.disconnect({ userId: 'u1', request: { initiator: 'lb_user' } });
    const allLogs = logSpy.mock.calls.flat().map(String).join('\n');
    expect(allLogs).not.toContain('sfo_v1_active');
    // We DO log token_kid + token_len
    expect(allLogs).toMatch(/token_kid=k1/);
    expect(allLogs).toMatch(/token_len=\d+/);
  });
});
