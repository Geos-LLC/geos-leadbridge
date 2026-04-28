/**
 * Admin read audit logging — extends Phase 2.
 *
 * Before this PR, only impersonated admin requests landed in DataAccessLog.
 * Direct admin reads of customer-touching endpoints (`/v1/admin/users/:id`,
 * `/notification-logs`, `/tenant-numbers`, `/tenant-errors`) were silent.
 *
 * Required behaviours:
 *   1. Admin hitting a customer-data endpoint creates an audit row with
 *      accessType=admin_read.
 *   2. A non-admin caller doesn't trigger an admin_read log (defense in depth
 *      — AdminGuard already 403s, but the controller's role check is the
 *      second line).
 *   3. The persisted row carries the right shape (admin_read, route, method,
 *      tenantId).
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

function makeController(opts?: { adminServiceOverrides?: any }) {
  const auditPrisma = buildAuditPrisma();
  const auditService = new AuditService(auditPrisma);
  // Silence audit-side warnings so the test output stays clean.
  jest.spyOn((auditService as any).logger, 'warn').mockImplementation(() => undefined);

  const adminService: any = {
    getUserDetails: jest.fn().mockResolvedValue({ id: 'tenant-a', email: 't@example.com', leads: [], conversations: [], leadsCount: 0, conversationsCount: 0 }),
    getNotificationLogs: jest.fn().mockResolvedValue({ logs: [], count: 0 }),
    getTenantNumbers: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    getTenantErrorFeed: jest.fn().mockResolvedValue({ rows: [], total: 0 }),
    ...(opts?.adminServiceOverrides ?? {}),
  };

  const cache: any = { getStats: jest.fn(), del: jest.fn(), delPattern: jest.fn() };
  const leadCache: any = { invalidateLeadList: jest.fn() };
  const prisma: any = {};
  const yelpBackfill: any = {};

  const controller = new AdminController(
    adminService,
    cache,
    leadCache,
    prisma,
    yelpBackfill,
    auditService,
  );

  return { controller, auditPrisma, adminService };
}

function adminReq(url: string, method = 'GET') {
  return {
    user: { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' },
    url,
    method,
  } as any;
}

describe('AdminController — admin read audit logging', () => {
  describe('1. Admin hitting customer-data endpoint creates audit row', () => {
    it('getUserDetails (/users/:userId) — single-tenant scope', async () => {
      const { controller, auditPrisma } = makeController();
      await controller.getUserDetails(adminReq('/v1/admin/users/tenant-a'), 'tenant-a');

      expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(1);
      const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
      expect(persisted).toMatchObject({
        actorUserId: 'admin-1',
        actorRole: 'ADMIN',
        tenantId: 'tenant-a',
        action: 'read',
        resourceType: 'User',
        resourceId: 'tenant-a',
        accessType: 'admin_read',
        method: 'GET',
        route: '/v1/admin/users/tenant-a',
      });
    });

    it('getNotificationLogs (/notification-logs) — bulk', async () => {
      const { controller, auditPrisma } = makeController();
      await controller.getNotificationLogs(adminReq('/v1/admin/notification-logs?limit=10'), {});

      const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
      expect(persisted).toMatchObject({
        accessType: 'admin_read',
        action: 'list',
        resourceType: 'NotificationLog',
        resourceId: 'bulk',
        tenantId: '__platform__',
      });
      // route is captured before the audit service strips the query string
      // (sanitization happens in AuditService); the persisted route should
      // therefore have NO query string.
      expect(persisted.route).toBe('/v1/admin/notification-logs');
    });

    it('getTenantNumbers (/tenant-numbers)', async () => {
      const { controller, auditPrisma } = makeController();
      await controller.getTenantNumbers(adminReq('/v1/admin/tenant-numbers'));

      const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
      expect(persisted).toMatchObject({
        accessType: 'admin_read',
        resourceType: 'TenantPhoneNumber',
        resourceId: 'bulk',
        tenantId: '__platform__',
      });
    });

    it('getTenantErrorFeed (/tenant-errors)', async () => {
      const { controller, auditPrisma } = makeController();
      await controller.getTenantErrorFeed(adminReq('/v1/admin/tenant-errors'));

      const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
      expect(persisted).toMatchObject({
        accessType: 'admin_read',
        resourceType: 'SystemErrorLog',
        resourceId: 'bulk',
        tenantId: '__platform__',
      });
    });
  });

  describe('2. Non-admin caller does NOT trigger admin_read log', () => {
    // AdminGuard already 403s, but the controller's `if (user?.role === 'ADMIN')`
    // is the belt-and-suspenders check inside the handler. If somehow a non-admin
    // request reaches the handler (guard misconfigured, internal call), the log
    // must NOT fire with the wrong actorRole.
    it.each([
      ['getUserDetails', (c: AdminController, req: any) => c.getUserDetails(req, 'tenant-a')],
      ['getNotificationLogs', (c: AdminController, req: any) => c.getNotificationLogs(req, {})],
      ['getTenantNumbers', (c: AdminController, req: any) => c.getTenantNumbers(req)],
      ['getTenantErrorFeed', (c: AdminController, req: any) => c.getTenantErrorFeed(req)],
    ])('%s — role=USER produces no audit row', async (_label, invoke) => {
      const { controller, auditPrisma } = makeController();
      const userReq = {
        user: { id: 'user-x', email: 'u@example.com', role: 'USER' },
        url: '/v1/admin/whatever',
        method: 'GET',
      } as any;
      await invoke(controller, userReq);
      expect(auditPrisma.dataAccessLog.create).not.toHaveBeenCalled();
    });

    it('also produces no row when req.user is missing entirely', async () => {
      const { controller, auditPrisma } = makeController();
      const noUserReq = { url: '/v1/admin/users/tenant-a', method: 'GET' } as any;
      await controller.getUserDetails(noUserReq, 'tenant-a');
      expect(auditPrisma.dataAccessLog.create).not.toHaveBeenCalled();
    });
  });

  describe('3. Logged row uses accessType=admin_read', () => {
    it('every audit row written by these handlers carries admin_read', async () => {
      const { controller, auditPrisma } = makeController();
      await controller.getUserDetails(adminReq('/v1/admin/users/tenant-a'), 'tenant-a');
      await controller.getNotificationLogs(adminReq('/v1/admin/notification-logs'), {});
      await controller.getTenantNumbers(adminReq('/v1/admin/tenant-numbers'));
      await controller.getTenantErrorFeed(adminReq('/v1/admin/tenant-errors'));

      expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(4);
      for (const call of auditPrisma.dataAccessLog.create.mock.calls) {
        expect(call[0].data.accessType).toBe('admin_read');
      }
    });
  });
});
