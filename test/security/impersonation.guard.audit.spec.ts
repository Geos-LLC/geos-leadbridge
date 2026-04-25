/**
 * Impersonation guard × Audit service — Phase 2 wiring spec.
 *
 * Covers required behaviours #1, #2, #3:
 *   #1 impersonated GET read creates an audit log row
 *   #2 impersonated write creates an audit log row
 *   #3 normal tenant read does NOT create an audit log row
 */

import { ExecutionContext } from '@nestjs/common';
import { ImpersonationGuard } from '../../src/common/guards/impersonation.guard';
import { AuditService } from '../../src/common/audit/audit.service';

function buildContext(opts: {
  method: string;
  url?: string;
  headers?: Record<string, any>;
  user: any;
}): ExecutionContext {
  const request = {
    method: opts.method,
    url: opts.url ?? '/v1/leads/lead-1',
    headers: opts.headers ?? {},
    ip: '203.0.113.10',
    user: opts.user,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as any;
}

function makeGuard(targetUser: any | null) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(targetUser) } } as any;
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
  // Real AuditService with a stubbed prisma so we can assert what would be persisted.
  const auditPrisma = {
    dataAccessLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
  } as any;
  const auditService = new AuditService(auditPrisma);
  // Silence the application logger so test output stays clean.
  jest.spyOn((auditService as any).logger, 'warn').mockImplementation(() => undefined);
  const guard = new ImpersonationGuard(prisma, reflector, auditService);
  jest.spyOn((guard as any).logger, 'log').mockImplementation(() => undefined);
  return { guard, auditPrisma };
}

describe('ImpersonationGuard × AuditService', () => {
  const ADMIN = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
  const TARGET = {
    id: 'user-target',
    email: 'target@example.com',
    name: 'Target',
    role: 'USER',
    subscriptionTier: null,
    subscriptionStatus: null,
    subscriptionPeriodEnd: null,
    hasOwnNumber: false,
  };

  it('logs an impersonated GET as accessType=impersonation_read', async () => {
    const { guard, auditPrisma } = makeGuard(TARGET);
    const ctx = buildContext({
      method: 'GET',
      url: '/v1/leads/lead-1',
      headers: { 'x-impersonate-user': TARGET.id, 'user-agent': 'jest-cli/1.0' },
      user: ADMIN,
    });

    const ok = await guard.canActivate(ctx);
    expect(ok).toBe(true);

    // Audit insert is fire-and-forget; await microtask flush.
    await new Promise(setImmediate);

    expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(1);
    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      actorUserId: ADMIN.id,
      actorRole: 'ADMIN',
      tenantId: TARGET.id,
      action: 'read',
      accessType: 'impersonation_read',
      method: 'GET',
      route: '/v1/leads/lead-1',
      userAgent: 'jest-cli/1.0',
    });
  });

  it('logs an impersonated POST as accessType=impersonation_write', async () => {
    const { guard, auditPrisma } = makeGuard(TARGET);
    const ctx = buildContext({
      method: 'POST',
      url: '/v1/leads/lead-1/message',
      headers: { 'x-impersonate-user': TARGET.id },
      user: ADMIN,
    });

    await guard.canActivate(ctx);
    await new Promise(setImmediate);

    expect(auditPrisma.dataAccessLog.create).toHaveBeenCalledTimes(1);
    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      actorUserId: ADMIN.id,
      tenantId: TARGET.id,
      action: 'create',
      accessType: 'impersonation_write',
      method: 'POST',
    });
  });

  it('does NOT log when there is no impersonation header (normal tenant read)', async () => {
    const { guard, auditPrisma } = makeGuard(TARGET);
    const NORMAL_USER = { id: 'user-x', email: 'user@example.com', role: 'USER' };
    const ctx = buildContext({
      method: 'GET',
      url: '/v1/leads/lead-1',
      headers: {}, // no x-impersonate-user
      user: NORMAL_USER,
    });

    await guard.canActivate(ctx);
    await new Promise(setImmediate);

    expect(auditPrisma.dataAccessLog.create).not.toHaveBeenCalled();
  });

  it('does NOT log when an admin requests without the impersonate header', async () => {
    const { guard, auditPrisma } = makeGuard(TARGET);
    const ctx = buildContext({
      method: 'GET',
      url: '/v1/admin/users',
      headers: {}, // admin acting as themselves — no impersonation
      user: ADMIN,
    });

    await guard.canActivate(ctx);
    await new Promise(setImmediate);

    expect(auditPrisma.dataAccessLog.create).not.toHaveBeenCalled();
  });

  it('strips query strings from the route before persisting', async () => {
    const { guard, auditPrisma } = makeGuard(TARGET);
    const ctx = buildContext({
      method: 'GET',
      url: '/v1/leads/lead-1?token=secret&email=alice@example.com',
      headers: { 'x-impersonate-user': TARGET.id },
      user: ADMIN,
    });

    await guard.canActivate(ctx);
    await new Promise(setImmediate);

    const persisted = auditPrisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.route).toBe('/v1/leads/lead-1');
    expect(persisted.route).not.toContain('token=');
    expect(persisted.route).not.toContain('alice@example.com');
  });
});
