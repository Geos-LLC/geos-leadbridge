/**
 * AdminController — Phase 4 endpoint split.
 *
 * Phase 4 splits admin endpoints into two buckets:
 *   - platform_metadata  → AdminGuard-only, no SupportGrant required
 *   - customer_data      → AdminGuard + RequiresSupportGrant(scope)
 *
 * This spec asserts the wiring contract directly:
 *   1. Every customer_data endpoint carries the SUPPORT_GRANT_SCOPE_KEY
 *      metadata with the expected scope string. (Decorator placed correctly.)
 *   2. Every platform_metadata endpoint has NO SUPPORT_GRANT_SCOPE_KEY
 *      metadata. (Decorator NOT applied.)
 *   3. listUsers — the only newly-gated READ endpoint in Phase 4 — writes a
 *      `support_read` audit row when called via a request that already passed
 *      the guard (i.e. has a stashed supportGrant on the request).
 *
 * Per-route guard 404 behaviours (no grant / wrong scope / expired) are covered
 * exhaustively in `support-grant.guard.spec.ts` and don't need to be repeated
 * per endpoint here. This spec is about *which* endpoints are wired up.
 */

import { AdminController } from '../../src/admin/admin.controller';
import { AuditService } from '../../src/common/audit/audit.service';
import { SUPPORT_GRANT_SCOPE_KEY } from '../../src/admin/support-grants/guards/support-grant.guard';

// ---------------------------------------------------------------------------
// Wiring assertions — metadata reflection on the controller prototype.
// ---------------------------------------------------------------------------

function scopeFor(method: keyof AdminController): string | undefined {
  return Reflect.getMetadata(
    SUPPORT_GRANT_SCOPE_KEY,
    AdminController.prototype[method] as any,
  );
}

describe('AdminController endpoint-split — customer_data endpoints carry @RequiresSupportGrant', () => {
  it.each([
    // method                          expected scope
    ['listUsers',                       'user:list'],
    ['getUserDetails',                  'user:read'],
    ['updateUserSubscription',          'user:write'],
    ['cancelUserSubscription',          'user:write'],
    ['updateTrialLeads',                'user:write'],
    ['resetAllTrials',                  'trials:reset'],
    ['deleteUser',                      'user:delete'],
    ['getNotificationLogs',             'notifications:read'],
    ['getTenantNumbers',                'phones:read'],
    ['getTenantErrorFeed',              'errors:read'],
    ['invalidateUserCache',             'cache:invalidate'],
    ['invalidateLeadCache',             'cache:invalidate'],
    ['backfillYelp',                    'backfill:yelp'],
  ])('%s requires SupportGrant scope %s', (method, expectedScope) => {
    expect(scopeFor(method as keyof AdminController)).toBe(expectedScope);
  });
});

describe('AdminController endpoint-split — platform_metadata endpoints are NOT gated', () => {
  it.each([
    ['getStats'],
    ['getAdminLogs'],
    ['getCacheStatus'],
  ])('%s carries no SupportGrant metadata', (method) => {
    expect(scopeFor(method as keyof AdminController)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listUsers — the only newly-gated read endpoint in Phase 4 — must write a
// support_read audit row when called with a valid grant on the request.
// ---------------------------------------------------------------------------

function buildAuditPrisma() {
  return {
    dataAccessLog: {
      create: jest
        .fn()
        .mockImplementation(({ data }: any) => Promise.resolve({ id: 'audit-1', ...data })),
    },
  } as any;
}

function makeController() {
  const auditPrisma = buildAuditPrisma();
  const auditService = new AuditService(auditPrisma);
  jest.spyOn((auditService as any).logger, 'warn').mockImplementation(() => undefined);

  const adminService: any = {
    listUsers: jest
      .fn()
      .mockResolvedValue({ users: [], total: 0, offset: 0, limit: 50 }),
  };

  const controller = new AdminController(
    adminService,
    {} as any, // CacheService
    {} as any, // LeadCacheService
    {} as any, // PrismaService
    {} as any, // YelpBackfillService
    auditService,
  );
  return { controller, auditPrisma, adminService };
}

function adminReqWithGrant(reason: string) {
  return {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    url: '/v1/admin/users?limit=50',
    method: 'GET',
    params: {},
    supportGrant: {
      id: 'sg-list-1',
      adminUserId: 'admin-1',
      tenantId: '__platform__',
      scopes: ['user:list'],
      reason,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      createdAt: new Date(),
    },
  } as any;
}

describe('AdminController.listUsers — Phase 4 audit wiring', () => {
  it('writes accessType=support_read with grant.reason and __platform__ tenantId', async () => {
    const { controller, auditPrisma, adminService } = makeController();
    const reason = 'Fleet-wide search for billing investigation #5512';
    const req = adminReqWithGrant(reason);

    await controller.listUsers(req, {} as any);

    expect(adminService.listUsers).toHaveBeenCalledTimes(1);
    expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(1);

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: '__platform__',
      action: 'list',
      resourceType: 'User',
      resourceId: 'bulk',
      accessType: 'support_read',
      reason,
      method: 'GET',
      // route is sanitized to drop the query string
      route: '/v1/admin/users',
    });
  });

  it('still writes the audit row when supportGrant is missing on the request (defensive)', async () => {
    // Mirrors the Phase 3 belt-and-suspenders check on getUserDetails. If the
    // guard ever ships a code path that doesn't stash a grant, we still want
    // the access logged — just with reason=null.
    const { controller, auditPrisma } = makeController();
    const req = {
      user: { id: 'admin-1', role: 'ADMIN' },
      url: '/v1/admin/users',
      method: 'GET',
      params: {},
    } as any;

    await controller.listUsers(req, {} as any);

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.accessType).toBe('support_read');
    expect(persisted.reason).toBeNull();
  });
});
