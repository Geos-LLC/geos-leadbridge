/**
 * SupportGrantGuard — Phase 3 unit tests.
 *
 * Covers required behaviours #1, #2, #3, #4 from the spec:
 *   #1 admin without grant → 404
 *   #2 admin with valid grant → success
 *   #3 expired grant → 404
 *   #4 wrong scope → 404
 *
 * Test #5 (audit log contains support_read + reason) lives in
 * `admin.controller.support-grant.spec.ts` because it tests the
 * controller's audit call when the guard passes.
 */

import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { SupportGrantGuard, SUPPORT_GRANT_SCOPE_KEY } from '../../src/admin/support-grants/guards/support-grant.guard';

function buildContext(opts: {
  user?: any;
  scope?: string;
  url?: string;
  params?: Record<string, string>;
}): { ctx: ExecutionContext; request: any } {
  const request = {
    user: opts.user,
    url: opts.url ?? '/v1/admin/users/tenant-a',
    params: opts.params ?? { userId: 'tenant-a' },
  };
  const handler = function () {} as any;
  // attach metadata via Reflect so Reflector.get() finds it
  if (opts.scope) {
    Reflect.defineMetadata(SUPPORT_GRANT_SCOPE_KEY, opts.scope, handler);
  }
  const ctx = {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handler,
    getClass: () => ({}),
  } as any;
  return { ctx, request };
}

function makeGuard(activeGrant: any | null) {
  const reflector = {
    get: jest.fn().mockImplementation((_key: any, handler: any) =>
      Reflect.getMetadata(SUPPORT_GRANT_SCOPE_KEY, handler),
    ),
  } as any;
  const supportGrants = {
    findActiveGrant: jest.fn().mockResolvedValue(activeGrant),
  } as any;
  return {
    guard: new SupportGrantGuard(reflector, supportGrants),
    supportGrants,
  };
}

describe('SupportGrantGuard', () => {
  const ADMIN = { id: 'admin-1', role: 'ADMIN' };

  describe('handlers without @RequiresSupportGrant', () => {
    it('passes through when no scope metadata is set', async () => {
      const { guard } = makeGuard(null);
      const { ctx } = buildContext({ user: ADMIN }); // no scope arg → no metadata
      expect(await guard.canActivate(ctx)).toBe(true);
    });
  });

  describe('non-admin caller', () => {
    it('throws NotFoundException for role=USER', async () => {
      const { guard } = makeGuard({ id: 'sg-1' });
      const { ctx } = buildContext({
        user: { id: 'u', role: 'USER' },
        scope: 'user:read',
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when req.user is missing', async () => {
      const { guard } = makeGuard({ id: 'sg-1' });
      const { ctx } = buildContext({ user: undefined, scope: 'user:read' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('admin without grant — required behaviour #1', () => {
    it('throws NotFoundException when service finds no active grant', async () => {
      const { guard, supportGrants } = makeGuard(null);
      const { ctx } = buildContext({ user: ADMIN, scope: 'user:read' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
      expect(supportGrants.findActiveGrant).toHaveBeenCalledWith('admin-1', 'user:read', 'tenant-a');
    });
  });

  describe('admin with valid grant — required behaviour #2', () => {
    it('passes and stashes the grant on the request', async () => {
      const grant = { id: 'sg-1', reason: 'Debug missing leads' };
      const { guard } = makeGuard(grant);
      const { ctx, request } = buildContext({ user: ADMIN, scope: 'user:read' });

      expect(await guard.canActivate(ctx)).toBe(true);
      expect(request.supportGrant).toBe(grant);
    });
  });

  describe('expired grant — required behaviour #3', () => {
    // Expired grants are filtered out at the service layer (expiresAt > now).
    // From the guard's perspective, an expired grant looks identical to "no
    // grant" — service returns null, guard 404s. Asserting at the boundary.
    it('treats expired-grant scenario (service returns null) as 404', async () => {
      const { guard } = makeGuard(null);
      const { ctx } = buildContext({ user: ADMIN, scope: 'user:read' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('wrong scope — required behaviour #4', () => {
    // Wrong-scope path: service is queried with the required scope and returns
    // null because no grant has that scope. Guard 404s. Same code path as
    // "no grant" but the assertion is that the service was called with the
    // RIGHT required scope — guard doesn't substitute or weaken scope checks.
    it('queries the service with the exact required scope', async () => {
      const { guard, supportGrants } = makeGuard(null);
      const { ctx } = buildContext({ user: ADMIN, scope: 'errors:read' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(NotFoundException);
      expect(supportGrants.findActiveGrant).toHaveBeenCalledWith('admin-1', 'errors:read', 'tenant-a');
    });
  });

  describe('target tenant resolution', () => {
    it('uses params.userId for /admin/users/:userId routes', async () => {
      const { guard, supportGrants } = makeGuard({ id: 'sg-1' });
      const { ctx } = buildContext({
        user: ADMIN,
        scope: 'user:read',
        url: '/v1/admin/users/tenant-x',
        params: { userId: 'tenant-x' },
      });
      await guard.canActivate(ctx);
      expect(supportGrants.findActiveGrant).toHaveBeenCalledWith('admin-1', 'user:read', 'tenant-x');
    });

    it('falls back to __platform__ when no tenant param is in the route', async () => {
      const { guard, supportGrants } = makeGuard({ id: 'sg-1' });
      const { ctx } = buildContext({
        user: ADMIN,
        scope: 'notifications:read',
        url: '/v1/admin/notification-logs',
        params: {},
      });
      await guard.canActivate(ctx);
      expect(supportGrants.findActiveGrant).toHaveBeenCalledWith('admin-1', 'notifications:read', '__platform__');
    });
  });
});

describe('SupportGrantGuard.resolveTargetTenantId (static helper)', () => {
  it('prefers params.userId', () => {
    expect(SupportGrantGuard.resolveTargetTenantId({ params: { userId: 't1' } })).toBe('t1');
  });
  it('falls back to params.tenantId', () => {
    expect(SupportGrantGuard.resolveTargetTenantId({ params: { tenantId: 't2' } })).toBe('t2');
  });
  it('uses __platform__ sentinel when no tenant param exists', () => {
    expect(SupportGrantGuard.resolveTargetTenantId({ params: {} })).toBe('__platform__');
    expect(SupportGrantGuard.resolveTargetTenantId({})).toBe('__platform__');
  });
});
