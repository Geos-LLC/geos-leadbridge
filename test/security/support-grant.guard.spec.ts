/**
 * SupportGrantGuard — single-admin bypass tests.
 *
 * The Phase 3 grant-enforcement behaviours (#1 admin without grant → 404,
 * #3 expired → 404, #4 wrong scope → 404) have been intentionally disabled
 * while there's a single operator admin. The guard now passes any ADMIN
 * caller through. AdminGuard already enforces ADMIN at the controller
 * level; this guard's remaining job is defense-in-depth + a hook to
 * reintroduce scoped grants later.
 *
 * Test #5 (audit log contains support_read + reason) lives in
 * `admin.controller.support-grant.spec.ts` and continues to exercise the
 * controller's audit-logging path independently of the guard.
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

  describe('admin caller — single-admin bypass', () => {
    it('passes any ADMIN through, regardless of whether a grant exists', async () => {
      const { guard, supportGrants } = makeGuard(null);
      const { ctx, request } = buildContext({ user: ADMIN, scope: 'user:read' });
      expect(await guard.canActivate(ctx)).toBe(true);
      // Guard short-circuits before reaching the grant service — no lookup.
      expect(supportGrants.findActiveGrant).not.toHaveBeenCalled();
      // Nothing stashed on the request; controllers read
      // `req.supportGrant?.reason ?? null` so audit reason becomes null.
      expect(request.supportGrant).toBeUndefined();
    });

    it('passes ADMIN through across every previously-gated scope', async () => {
      for (const scope of ['user:read', 'user:write', 'errors:read', 'sf:sync:write']) {
        const { guard } = makeGuard(null);
        const { ctx } = buildContext({ user: ADMIN, scope });
        expect(await guard.canActivate(ctx)).toBe(true);
      }
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
