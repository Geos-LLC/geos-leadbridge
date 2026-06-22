/**
 * AdminController × SupportGrant — Phase 3 integration spec.
 *
 * Covers required behaviour #5: when the guard passes and an admin reads a
 * customer-data endpoint, the audit log entry must include
 * `accessType=support_read` AND the grant's `reason`.
 *
 * The controller-level tests cover the wiring of the audit call inside each
 * of the four guarded endpoints. Per-route guard rejection (404 paths) is
 * already covered by `support-grant.guard.spec.ts`; here we only exercise
 * the success-path audit logging.
 */

import { AdminController } from '../../src/admin/admin.controller';
import { AuditService } from '../../src/common/audit/audit.service';

function buildAuditPrisma() {
  return {
    dataAccessLog: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'audit-1', ...data })),
    },
  } as any;
}

function makeController() {
  const auditPrisma = buildAuditPrisma();
  const auditService = new AuditService(auditPrisma);
  jest.spyOn((auditService as any).logger, 'warn').mockImplementation(() => undefined);

  const adminService: any = {
    getUserDetails: jest.fn().mockResolvedValue({ id: 'tenant-a' }),
    getNotificationLogs: jest.fn().mockResolvedValue({ logs: [], count: 0 }),
    getTenantNumbers: jest.fn().mockResolvedValue({ rows: [] }),
    getTenantErrorFeed: jest.fn().mockResolvedValue({ rows: [] }),
  };

  const controller = new AdminController(
    adminService,
    {} as any, // CacheService
    {} as any, // LeadCacheService
    {} as any, // PrismaService
    {} as any, // YelpBackfillService
    auditService,
    {} as any, // MonitoringService
  );
  return { controller, auditPrisma };
}

function adminReqWithGrant(opts: { url: string; method?: string; params?: any; reason: string }) {
  return {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    url: opts.url,
    method: opts.method ?? 'GET',
    params: opts.params ?? {},
    supportGrant: {
      id: 'sg-1',
      adminUserId: 'admin-1',
      tenantId: opts.url.includes('/users/') ? 'tenant-a' : '__platform__',
      scopes: ['user:read', 'notifications:read', 'phones:read', 'errors:read'],
      reason: opts.reason,
      expiresAt: new Date(Date.now() + 60 * 60_000),
      createdAt: new Date(),
    },
  } as any;
}

describe('AdminController — support_read audit on guarded endpoints', () => {
  it('getUserDetails writes accessType=support_read with grant.reason', async () => {
    const { controller, auditPrisma } = makeController();
    const reason = 'Customer reported missing leads, ticket #4521';
    const req = adminReqWithGrant({ url: '/v1/admin/users/tenant-a', reason });

    await controller.getUserDetails(req, 'tenant-a');

    expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(1);
    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: 'tenant-a',
      action: 'read',
      resourceType: 'User',
      resourceId: 'tenant-a',
      accessType: 'support_read',
      reason,
      method: 'GET',
      route: '/v1/admin/users/tenant-a',
    });
  });

  it('getNotificationLogs writes accessType=support_read with grant.reason and __platform__ tenantId', async () => {
    const { controller, auditPrisma } = makeController();
    const reason = 'Investigating failed alerts';
    const req = adminReqWithGrant({ url: '/v1/admin/notification-logs', reason });

    await controller.getNotificationLogs(req, {});

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      accessType: 'support_read',
      reason,
      tenantId: '__platform__',
      resourceType: 'NotificationLog',
      resourceId: 'bulk',
      action: 'list',
    });
  });

  it('getTenantNumbers writes accessType=support_read', async () => {
    const { controller, auditPrisma } = makeController();
    const reason = 'Tracking phone provisioning bug';
    const req = adminReqWithGrant({ url: '/v1/admin/tenant-numbers', reason });

    await controller.getTenantNumbers(req);

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      accessType: 'support_read',
      reason,
      tenantId: '__platform__',
      resourceType: 'TenantPhoneNumber',
      resourceId: 'bulk',
    });
  });

  it('getTenantErrorFeed writes accessType=support_read', async () => {
    const { controller, auditPrisma } = makeController();
    const reason = 'Triaging Yelp 401s';
    const req = adminReqWithGrant({ url: '/v1/admin/tenant-errors', reason });

    await controller.getTenantErrorFeed(req);

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      accessType: 'support_read',
      reason,
      tenantId: '__platform__',
      resourceType: 'SystemErrorLog',
      resourceId: 'bulk',
    });
  });

  it('grant.reason flows through AuditService sanitization (PII masking)', async () => {
    // Reason fields with PII should still be persisted, but masked. This pins
    // the integration with AuditService.sanitizeReason.
    const { controller, auditPrisma } = makeController();
    const reason = 'callback to alice@example.com about missing leads';
    const req = adminReqWithGrant({ url: '/v1/admin/users/tenant-a', reason });

    await controller.getUserDetails(req, 'tenant-a');

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.reason).toContain('a***@example.com');
    expect(persisted.reason).not.toContain('alice@example.com');
  });

  it('still writes the audit row when supportGrant is missing on the request (defensive)', async () => {
    // Belt-and-suspenders: in the unlikely case the guard didn't stash a grant
    // (e.g. someone bypasses the decorator in a future refactor), the controller
    // still logs the access — just with reason=null. Better to log without a
    // reason than to skip the audit row entirely.
    const { controller, auditPrisma } = makeController();
    const req = {
      user: { id: 'admin-1', role: 'ADMIN' },
      url: '/v1/admin/users/tenant-a',
      method: 'GET',
      params: {},
    } as any;

    await controller.getUserDetails(req, 'tenant-a');

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.accessType).toBe('support_read');
    expect(persisted.reason).toBeNull();
  });
});
