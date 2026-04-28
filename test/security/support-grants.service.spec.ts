/**
 * SupportGrantsService — Phase 3 unit tests.
 *
 * Covers create-side validation and the hot-path active-grant lookup
 * used by SupportGrantGuard.
 */

import { BadRequestException } from '@nestjs/common';
import { SupportGrantsService } from '../../src/admin/support-grants/support-grants.service';

function buildPrisma() {
  return {
    supportGrant: {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'sg-1', createdAt: new Date(), ...data }),
      ),
      findFirst: jest.fn(),
    },
  } as any;
}

describe('SupportGrantsService.createGrant', () => {
  it('persists a valid grant with default 60-minute expiry', async () => {
    const prisma = buildPrisma();
    const svc = new SupportGrantsService(prisma);
    const before = Date.now();

    const grant = await svc.createGrant('admin-1', {
      tenantId: 'tenant-a',
      scopes: ['user:read'],
      reason: 'Customer reported missing leads',
    });

    expect(grant.id).toBe('sg-1');
    const persisted = prisma.supportGrant.create.mock.calls[0][0].data;
    expect(persisted).toMatchObject({
      adminUserId: 'admin-1',
      tenantId: 'tenant-a',
      scopes: ['user:read'],
      reason: 'Customer reported missing leads',
    });
    // Default expiry is 60 minutes from now, give or take a few seconds.
    const minutesAhead = (persisted.expiresAt.getTime() - before) / 60_000;
    expect(minutesAhead).toBeGreaterThan(59);
    expect(minutesAhead).toBeLessThan(61);
  });

  it('clamps durationMinutes to the 7-day maximum', async () => {
    const prisma = buildPrisma();
    const svc = new SupportGrantsService(prisma);
    const before = Date.now();

    await svc.createGrant('admin-1', {
      tenantId: 'tenant-a',
      scopes: ['user:read'],
      reason: 'long debug session',
      durationMinutes: 999_999, // way over 7 days
    });

    const persisted = prisma.supportGrant.create.mock.calls[0][0].data;
    const minutesAhead = (persisted.expiresAt.getTime() - before) / 60_000;
    expect(minutesAhead).toBeLessThanOrEqual(7 * 24 * 60 + 1);
    expect(minutesAhead).toBeGreaterThan(7 * 24 * 60 - 1);
  });

  it('rejects empty reason', async () => {
    const svc = new SupportGrantsService(buildPrisma());
    await expect(
      svc.createGrant('admin-1', { tenantId: 't', scopes: ['user:read'], reason: '   ' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects empty scopes array', async () => {
    const svc = new SupportGrantsService(buildPrisma());
    await expect(
      svc.createGrant('admin-1', { tenantId: 't', scopes: [], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-string scope entries', async () => {
    const svc = new SupportGrantsService(buildPrisma());
    await expect(
      svc.createGrant('admin-1', { tenantId: 't', scopes: ['ok', '' as any], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects missing tenantId', async () => {
    const svc = new SupportGrantsService(buildPrisma());
    await expect(
      svc.createGrant('admin-1', { tenantId: '', scopes: ['user:read'], reason: 'ok' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('truncates very long reason text', async () => {
    const prisma = buildPrisma();
    const svc = new SupportGrantsService(prisma);
    const longReason = 'x'.repeat(5000);
    await svc.createGrant('admin-1', {
      tenantId: 'tenant-a',
      scopes: ['user:read'],
      reason: longReason,
    });
    const persisted = prisma.supportGrant.create.mock.calls[0][0].data;
    expect(persisted.reason.length).toBeLessThanOrEqual(500);
  });
});

describe('SupportGrantsService.findActiveGrant', () => {
  it('queries by adminUserId, scope membership, future expiresAt, and tenantId match', async () => {
    const prisma = buildPrisma();
    prisma.supportGrant.findFirst.mockResolvedValue({ id: 'sg-1' });
    const svc = new SupportGrantsService(prisma);

    const result = await svc.findActiveGrant('admin-1', 'user:read', 'tenant-a');
    expect(result).toEqual({ id: 'sg-1' });

    const where = prisma.supportGrant.findFirst.mock.calls[0][0].where;
    expect(where.adminUserId).toBe('admin-1');
    expect(where.scopes).toEqual({ has: 'user:read' });
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
    expect(where.OR).toEqual([
      { tenantId: 'tenant-a' },
      { tenantId: '__platform__' },
    ]);
  });

  it('returns null when no matching grant exists', async () => {
    const prisma = buildPrisma();
    prisma.supportGrant.findFirst.mockResolvedValue(null);
    const svc = new SupportGrantsService(prisma);
    expect(await svc.findActiveGrant('admin-1', 'user:read', 'tenant-a')).toBeNull();
  });
});
