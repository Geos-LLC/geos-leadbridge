/**
 * AdminServiceTemplatesService tests.
 *
 * Covers spec cases:
 *   #1 Generate template from text inputs
 *   #2 Save draft
 *   #3 Publish template
 *   #4 Draft hidden from customers (listPublished)
 *   #5 Published template visible (listPublished)
 *
 * Cases #6 (Create Service Profile from template) and #7 (existing code
 * presets still work) live in ../../service-profile/service-profile.service.spec.ts
 * since they cross the module boundary.
 *
 * Bypasses NestJS DI with Object.create + prototype injection so we
 * don't have to stand up the full app graph.
 */

import { Logger } from '@nestjs/common';
import { AdminServiceTemplatesService } from './admin-service-templates.service';

function buildPrismaStub() {
  const rows: any[] = [];
  let nextId = 1;
  return {
    rows,
    serviceTemplatePreset: {
      create: jest.fn(async ({ data }: any) => {
        // Simulate the unique key constraint.
        if (rows.find((r) => r.key === data.key)) {
          const err: any = new Error('Unique constraint failed on the fields: (`key`)');
          err.code = 'P2002';
          throw err;
        }
        const row = {
          id: String(nextId++),
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        rows.push(row);
        return row;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        return rows.find((r) => r.id === where.id) ?? null;
      }),
      findMany: jest.fn(async ({ where, orderBy: _orderBy }: any = {}) => {
        let out = [...rows];
        if (where?.status) out = out.filter((r) => r.status === where.status);
        return out;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
  };
}

function buildService(): { svc: AdminServiceTemplatesService; prisma: ReturnType<typeof buildPrismaStub> } {
  const svc: any = Object.create(AdminServiceTemplatesService.prototype);
  svc.logger = new Logger('AdminServiceTemplatesTest');
  const prisma = buildPrismaStub();
  svc.prisma = prisma;
  return { svc, prisma };
}

describe('AdminServiceTemplatesService', () => {
  describe('generate (spec #1)', () => {
    it('produces a fully-formed GeneratedTemplate from two text blocks', () => {
      const { svc } = buildService();
      const result = svc.generate({
        serviceName: 'Carpet Cleaning',
        provider: 'thumbtack',
        providerCategoryName: 'Carpet Cleaning',
        rawOptionsText: `
          Which types of stains do you clean?
          - Pet stains
          - Food stains
        `,
        rawPricingText: `
          1 room $79
          2 rooms $103
        `,
      });

      expect(result.label).toBe('Carpet Cleaning');
      expect(result.provider).toBe('thumbtack');
      expect(result.key).toMatch(/^thumbtack_/);
      expect(result.serviceOptionsJson.groups).toHaveLength(1);
      expect(result.pricingJson.pricingModel).toBe('room_quantity');
      expect(result.customerAnswersJson.entries.length).toBeGreaterThan(0);
      expect(result.sourceJson.kind).toBe('admin_generated');
      expect(result.sourceJson.rawOptionsText).toContain('Pet stains');
      expect(result.sourceJson.generatorVersion).toBe(1);
    });
  });

  describe('create — save draft (spec #2)', () => {
    it('persists as draft regardless of caller hint', async () => {
      const { svc, prisma } = buildService();
      const generated = svc.generate({
        serviceName: 'Test',
        provider: 'thumbtack',
        providerCategoryName: 'Test',
        rawOptionsText: '',
        rawPricingText: '',
      });

      const row = await svc.create({ adminUserId: 'admin-1', input: generated });
      expect(row.status).toBe('draft');
      expect(row.createdByUserId).toBe('admin-1');
      expect(prisma.rows).toHaveLength(1);
      expect(prisma.rows[0].status).toBe('draft');
    });

    it('rejects duplicate keys with P2002', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'Same',
        provider: 'thumbtack',
        providerCategoryName: 'Same',
        rawOptionsText: '',
        rawPricingText: '',
      });
      await svc.create({ adminUserId: 'a', input: g });
      await expect(svc.create({ adminUserId: 'a', input: g })).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('setStatus — publish + archive + idempotent (spec #3)', () => {
    it('transitions draft to published', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'Test',
        provider: 'thumbtack',
        providerCategoryName: 'Test',
        rawOptionsText: '',
        rawPricingText: '',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });

      const updated = await svc.setStatus({
        templateId: created.id,
        nextStatus: 'published',
      });
      expect(updated.status).toBe('published');
    });

    it('is idempotent on no-op transitions', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'Test',
        provider: 'thumbtack',
        providerCategoryName: 'Test',
        rawOptionsText: '',
        rawPricingText: '',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });
      const a = await svc.setStatus({ templateId: created.id, nextStatus: 'draft' });
      const b = await svc.setStatus({ templateId: created.id, nextStatus: 'draft' });
      expect(a.id).toBe(b.id);
      expect(b.status).toBe('draft');
    });

    it('throws NOT_FOUND for unknown id', async () => {
      const { svc } = buildService();
      await expect(svc.setStatus({ templateId: 'nope', nextStatus: 'published' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
    });
  });

  describe('listPublished — public visibility (spec #4, #5)', () => {
    it('hides drafts and archived rows from the public list', async () => {
      const { svc } = buildService();
      for (const name of ['Draft', 'Published', 'Archived']) {
        const g = svc.generate({
          serviceName: name,
          provider: 'thumbtack',
          providerCategoryName: name,
          rawOptionsText: 'Q?\n- A',
          rawPricingText: '1 room $79',
        });
        await svc.create({ adminUserId: 'a', input: g });
      }
      // First row stays draft. Promote second to published; archive the third.
      const all = await svc.listAll();
      await svc.setStatus({ templateId: all[1].id, nextStatus: 'published' });
      await svc.setStatus({ templateId: all[2].id, nextStatus: 'archived' });

      const published = await svc.listPublished();
      expect(published).toHaveLength(1);
      expect(published[0].source).toBe('admin_template');
      expect(published[0].label).toBe(all[1].label);
    });

    it('returns parsed JSON in the public shape, not strings', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'X',
        provider: 'thumbtack',
        providerCategoryName: 'X',
        rawOptionsText: 'Q?\n- A',
        rawPricingText: '1 room $79',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });
      await svc.setStatus({ templateId: created.id, nextStatus: 'published' });

      const [pub] = await svc.listPublished();
      // Both shapes must come back as parsed objects, not stringified blobs.
      expect(typeof pub.serviceOptionsJson).toBe('object');
      expect(Array.isArray(pub.serviceOptionsJson.groups)).toBe(true);
      expect(typeof pub.pricingJson).toBe('object');
      expect(typeof pub.customerAnswersJson).toBe('object');
    });
  });

  describe('getPublishedById — single-row read for from-template flow', () => {
    it('returns published rows', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'X',
        provider: 'thumbtack',
        providerCategoryName: 'X',
        rawOptionsText: '',
        rawPricingText: '',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });
      await svc.setStatus({ templateId: created.id, nextStatus: 'published' });
      const row = await svc.getPublishedById(created.id);
      expect(row).not.toBeNull();
      expect(row?.id).toBe(created.id);
    });

    it('returns null for draft rows (never leaks a draft into a tenant)', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'X',
        provider: 'thumbtack',
        providerCategoryName: 'X',
        rawOptionsText: '',
        rawPricingText: '',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });
      const row = await svc.getPublishedById(created.id);
      expect(row).toBeNull();
    });

    it('returns null for archived rows', async () => {
      const { svc } = buildService();
      const g = svc.generate({
        serviceName: 'X',
        provider: 'thumbtack',
        providerCategoryName: 'X',
        rawOptionsText: '',
        rawPricingText: '',
      });
      const created = await svc.create({ adminUserId: 'a', input: g });
      await svc.setStatus({ templateId: created.id, nextStatus: 'archived' });
      const row = await svc.getPublishedById(created.id);
      expect(row).toBeNull();
    });
  });
});
