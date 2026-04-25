/**
 * AuditService — Phase 2 behaviour spec.
 *
 * Covers required behaviours #4 and #5 from the spec:
 *   #4 sensitive write creates an audit log row
 *   #5 message body / token / secret are not stored in audit fields
 *
 * Behaviour #1, #2, #3 (impersonation read/write/no-log) live in
 * `impersonation.guard.audit.spec.ts` because they test the wiring
 * inside the guard, not the service.
 */

import { AuditService } from '../../src/common/audit/audit.service';

function buildPrisma() {
  return {
    dataAccessLog: {
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'audit-1', ...data })),
    },
  } as any;
}

describe('AuditService.logAccess — sensitive write creates an audit row', () => {
  it('persists a sensitive tenant write with the required fields', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);

    const id = await svc.logAccess({
      actorUserId: 'user-a',
      actorRole: 'USER',
      tenantId: 'user-a',
      action: 'update',
      accessType: 'tenant_self',
      resourceType: 'NotificationSettings',
      resourceId: 'ns-1',
      route: '/v1/notifications/settings/acct-1',
      method: 'PUT',
      ipAddress: '203.0.113.10',
      userAgent: 'jest',
    });

    expect(id).toBe('audit-1');
    expect(prisma.dataAccessLog.create).toHaveBeenCalledTimes(1);

    const persisted = prisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      actorUserId: 'user-a',
      actorRole: 'USER',
      tenantId: 'user-a',
      action: 'update',
      accessType: 'tenant_self',
      resourceType: 'NotificationSettings',
      resourceId: 'ns-1',
      method: 'PUT',
      ipAddress: '203.0.113.10',
      userAgent: 'jest',
    });
  });

  it('returns null and does not throw when the persist fails', async () => {
    const prisma = buildPrisma();
    prisma.dataAccessLog.create.mockRejectedValue(new Error('db down'));
    const svc = new AuditService(prisma);

    const id = await svc.logAccess({
      actorUserId: 'user-a',
      actorRole: 'USER',
      tenantId: 'user-a',
      action: 'delete',
      accessType: 'tenant_self',
    });

    expect(id).toBeNull();
  });
});

describe('AuditService — secrets/PII are never stored verbatim', () => {
  it('strips the query string from the route (could carry tokens or PII)', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);

    await svc.logAccess({
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: 'user-a',
      action: 'read',
      accessType: 'admin_read',
      route: '/v1/leads/abc?token=secret-bearer-token&email=alice@example.com',
      method: 'GET',
    });

    const persisted = prisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.route).toBe('/v1/leads/abc');
    expect(persisted.route).not.toContain('token=');
    expect(persisted.route).not.toContain('secret-bearer-token');
    expect(persisted.route).not.toContain('alice@example.com');
  });

  it('redacts a Bearer token if a caller passes it as the reason', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);

    await svc.logAccess({
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: 'user-a',
      action: 'read',
      accessType: 'admin_read',
      reason: 'Bearer eyJhbGciOiJIUzI1NiJ9.somepayload.sig',
    });

    const persisted = prisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.reason).toBe('[redacted-bearer]');
    expect(persisted.reason).not.toContain('eyJ');
  });

  it('masks PII (email + phone) inside the reason field', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);

    await svc.logAccess({
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: 'user-a',
      action: 'read',
      accessType: 'support_read',
      reason: 'follow up with alice@example.com at +1 (555) 123-4567',
    });

    const persisted = prisma.dataAccessLog.create.mock.calls[0][0].data;
    expect(persisted.reason).toContain('a***@example.com');
    expect(persisted.reason).toContain('***4567');
    expect(persisted.reason).not.toContain('alice@example.com');
    expect(persisted.reason).not.toContain('5551234567');
  });

  it('does not accept a body/payload field — schema has no metadata column', async () => {
    const prisma = buildPrisma();
    const svc = new AuditService(prisma);

    // Simulate a misuse: caller passes extra keys at runtime. The service only
    // spreads the documented LogAccessInput fields into `data`, so any extra
    // keys (messageBody, payload, secret) MUST NOT land in the persisted row.
    const badInput: any = {
      actorUserId: 'admin-1',
      actorRole: 'ADMIN',
      tenantId: 'user-a',
      action: 'update',
      accessType: 'impersonation_write',
      messageBody: 'customer said: my SSN is 555-12-3456',
      payload: { credentials: 'plaintext-token-here' },
      secret: 'super-secret-value',
    };
    await svc.logAccess(badInput);

    const persisted = prisma.dataAccessLog.create.mock.calls[0][0].data;
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain('SSN');
    expect(serialized).not.toContain('plaintext-token-here');
    expect(serialized).not.toContain('super-secret-value');
    expect(persisted).not.toHaveProperty('messageBody');
    expect(persisted).not.toHaveProperty('payload');
    expect(persisted).not.toHaveProperty('secret');
  });
});
