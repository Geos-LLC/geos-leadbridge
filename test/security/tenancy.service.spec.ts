/**
 * TenancyService — Phase 0 security hotfix
 *
 * Proves the helpers throw NotFoundException (NOT ForbiddenException)
 * on any ownership mismatch, so admins/attackers cannot distinguish "record
 * does not exist" from "record belongs to another tenant".
 */

import { NotFoundException } from '@nestjs/common';
import { TenancyService } from '../../src/common/tenancy/tenancy.service';

function buildPrisma() {
  return {
    conversation: { findFirst: jest.fn() },
    followUpEnrollment: { findFirst: jest.fn() },
    lead: { findFirst: jest.fn() },
    savedAccount: { findFirst: jest.fn() },
  } as any;
}

describe('TenancyService', () => {
  describe('requireConversationAccess', () => {
    it('resolves when the conversation belongs to the user', async () => {
      const prisma = buildPrisma();
      prisma.conversation.findFirst.mockResolvedValue({ id: 'c1' });
      const svc = new TenancyService(prisma);

      await expect(svc.requireConversationAccess('c1', 'user-a')).resolves.toBeUndefined();
      expect(prisma.conversation.findFirst).toHaveBeenCalledWith({
        where: { id: 'c1', userId: 'user-a' },
        select: { id: true },
      });
    });

    it('throws NotFoundException when the conversation belongs to a different user', async () => {
      const prisma = buildPrisma();
      prisma.conversation.findFirst.mockResolvedValue(null);
      const svc = new TenancyService(prisma);

      await expect(svc.requireConversationAccess('c1', 'user-b')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFoundException when the conversation does not exist', async () => {
      const prisma = buildPrisma();
      prisma.conversation.findFirst.mockResolvedValue(null);
      const svc = new TenancyService(prisma);

      await expect(svc.requireConversationAccess('missing', 'user-a')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('requireEnrollmentAccess', () => {
    it('resolves when the enrollment conversation belongs to the user', async () => {
      const prisma = buildPrisma();
      prisma.followUpEnrollment.findFirst.mockResolvedValue({ id: 'e1' });
      const svc = new TenancyService(prisma);

      await expect(svc.requireEnrollmentAccess('e1', 'user-a')).resolves.toBeUndefined();
      expect(prisma.followUpEnrollment.findFirst).toHaveBeenCalledWith({
        where: { id: 'e1', conversation: { userId: 'user-a' } },
        select: { id: true },
      });
    });

    it('throws NotFoundException for an enrollment owned by another tenant', async () => {
      const prisma = buildPrisma();
      prisma.followUpEnrollment.findFirst.mockResolvedValue(null);
      const svc = new TenancyService(prisma);

      await expect(svc.requireEnrollmentAccess('e1', 'user-b')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('requireTenantAccess (generic)', () => {
    it('validates userId on a top-level model', async () => {
      const prisma = buildPrisma();
      prisma.lead.findFirst.mockResolvedValue({ id: 'l1' });
      const svc = new TenancyService(prisma);

      await expect(svc.requireTenantAccess('lead', 'l1', 'user-a')).resolves.toBeUndefined();
      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { id: 'l1', userId: 'user-a' },
        select: { id: true },
      });
    });

    it('throws NotFoundException when the record is owned by another tenant', async () => {
      const prisma = buildPrisma();
      prisma.savedAccount.findFirst.mockResolvedValue(null);
      const svc = new TenancyService(prisma);

      await expect(svc.requireTenantAccess('savedAccount', 's1', 'user-b')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('scopeQueryToTenant', () => {
    it('merges userId into the where clause', () => {
      const svc = new TenancyService(buildPrisma());
      const out = svc.scopeQueryToTenant({ platform: 'yelp' }, 'user-a');
      expect(out).toEqual({ platform: 'yelp', userId: 'user-a' });
    });

    it('supports organizationId as an alternate scoping field', () => {
      const svc = new TenancyService(buildPrisma());
      const out = svc.scopeQueryToTenant({ status: 'active' }, 'org-1', 'organizationId');
      expect(out).toEqual({ status: 'active', organizationId: 'org-1' });
    });
  });

  describe('assertTenantOwnership', () => {
    it('passes through a matching entity', () => {
      const svc = new TenancyService(buildPrisma());
      expect(() => svc.assertTenantOwnership({ userId: 'user-a' }, 'user-a')).not.toThrow();
    });

    it('throws NotFoundException (not Forbidden) on mismatch', () => {
      const svc = new TenancyService(buildPrisma());
      expect(() => svc.assertTenantOwnership({ userId: 'user-b' }, 'user-a')).toThrow(NotFoundException);
    });

    it('throws NotFoundException for a null entity', () => {
      const svc = new TenancyService(buildPrisma());
      expect(() => svc.assertTenantOwnership(null, 'user-a')).toThrow(NotFoundException);
    });
  });
});
