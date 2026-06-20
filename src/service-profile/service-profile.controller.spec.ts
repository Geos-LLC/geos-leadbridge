/**
 * Tests for ServiceProfileController — preset consumer.
 *
 * Covers:
 *   - GET /v1/service-profile-presets returns rows from
 *     AdminServiceTemplatesService.listPublished()
 *   - POST /v1/service-profiles/from-preset success path (templateId-only)
 *   - 400 on missing templateId / no auth
 *   - 404 when the templateId is unknown
 *   - 409 on (userId, slug) collision (P2002)
 */

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { ServiceProfileController } from './service-profile.controller';
import { ServiceProfileService } from './service-profile.service';

/** Stub for the AdminServiceTemplatesService dep. listPublished returns an
 *  empty array by default; individual tests pass an override stub when
 *  they need to assert merge behavior. */
const ADMIN_TEMPLATES_STUB: any = {
  listPublished: jest.fn(async () => []),
  getPublishedById: jest.fn(async () => null),
};

function buildSvcMock(opts: {
  createFromAdminTemplateReturn?: any;
  createFromAdminTemplateThrows?: any;
  createBlankReturn?: any;
  createBlankThrows?: any;
} = {}) {
  return {
    createFromAdminTemplate: jest.fn().mockImplementation(async () => {
      if (opts.createFromAdminTemplateThrows) throw opts.createFromAdminTemplateThrows;
      return (
        opts.createFromAdminTemplateReturn ?? {
          id: 'profile-1',
          name: 'Upholstery and Furniture Cleaning',
          slug: 'upholstery-furniture-cleaning',
          status: 'draft',
        }
      );
    }),
    createBlank: jest.fn().mockImplementation(async (args: { name: string }) => {
      if (opts.createBlankThrows) throw opts.createBlankThrows;
      return (
        opts.createBlankReturn ?? {
          id: 'profile-blank-1',
          name: args.name,
          slug: args.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
          status: 'draft',
        }
      );
    }),
  } as unknown as ServiceProfileService;
}

const USER_REQ = { user: { id: 'user-1' } } as any;

describe('ServiceProfileController.list', () => {
  it('returns the published admin templates verbatim', async () => {
    const adminStub: any = {
      listPublished: jest.fn(async () => [
        {
          source: 'admin_template' as const,
          templateId: 't-1',
          key: 'admin_template_key',
          label: 'Admin Template',
          provider: 'thumbtack',
          providerCategoryName: 'House Cleaning',
          providerCategoryId: null,
          description: null,
          serviceOptionsJson: { groups: [] },
          pricingJson: {
            pricingModel: 'custom',
            currency: 'USD',
            basePrices: [],
            addOns: [],
          },
          customerAnswersJson: { entries: [] },
          additionalInstructions: null,
          qualificationSchemaJson: null,
          faqJson: null,
          serviceRules: null,
          aliases: [],
        },
      ]),
      getPublishedById: jest.fn(),
    };
    const c = new ServiceProfileController(buildSvcMock(), adminStub);
    const out = await c.list();
    expect(Array.isArray(out.presets)).toBe(true);
    expect(out.presets).toHaveLength(1);
    const row = out.presets[0] as any;
    expect(row.source).toBe('admin_template');
    expect(row.templateId).toBe('t-1');
    expect(row.label).toBe('Admin Template');
  });

  it('returns an empty array when no templates are published', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    const out = await c.list();
    expect(out.presets).toEqual([]);
  });
});

describe('ServiceProfileController.createFromPreset', () => {
  it('creates a draft profile from a templateId and returns the slim record', async () => {
    const svc = buildSvcMock();
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    const out = await c.createFromPreset(USER_REQ, { templateId: 't-1' });
    expect(out).toEqual({
      profileId: 'profile-1',
      slug: 'upholstery-furniture-cleaning',
      status: 'draft',
      name: 'Upholstery and Furniture Cleaning',
    });
    expect(svc.createFromAdminTemplate).toHaveBeenCalledTimes(1);
    const call = (svc.createFromAdminTemplate as jest.Mock).mock.calls[0][0];
    expect(call.userId).toBe('user-1');
    expect(call.templateId).toBe('t-1');
  });

  it('throws 400 when templateId is missing', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    await expect(c.createFromPreset(USER_REQ, {} as any)).rejects.toThrow(BadRequestException);
  });

  it('throws 400 when templateId is empty', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    await expect(c.createFromPreset(USER_REQ, { templateId: '' })).rejects.toThrow(BadRequestException);
  });

  it('throws 400 when no authenticated user', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    await expect(
      c.createFromPreset({ user: null } as any, { templateId: 't-1' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws 404 when the service surfaces NOT_FOUND', async () => {
    const svc = buildSvcMock({
      createFromAdminTemplateThrows: Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' }),
    });
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await expect(
      c.createFromPreset(USER_REQ, { templateId: 'missing' }),
    ).rejects.toThrow(NotFoundException);
  });

  it('converts Prisma P2002 into a 409 ConflictException', async () => {
    const svc = buildSvcMock({
      createFromAdminTemplateThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await expect(
      c.createFromPreset(USER_REQ, { templateId: 't-1' }),
    ).rejects.toThrow(ConflictException);
  });

  it('propagates non-P2002 errors unchanged', async () => {
    const svc = buildSvcMock({ createFromAdminTemplateThrows: new Error('db down') });
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await expect(
      c.createFromPreset(USER_REQ, { templateId: 't-1' }),
    ).rejects.toThrow(/db down/);
  });
});

describe('ServiceProfileController.createBlankService', () => {
  it('creates a draft custom service and returns the slim record', async () => {
    const svc = buildSvcMock();
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    const out = await c.createBlankService(USER_REQ, { name: 'Roof inspection' });
    expect(out).toEqual({
      profileId: 'profile-blank-1',
      slug: 'roof-inspection',
      status: 'draft',
      name: 'Roof inspection',
    });
    expect(svc.createBlank).toHaveBeenCalledTimes(1);
    const call = (svc.createBlank as jest.Mock).mock.calls[0][0];
    expect(call.userId).toBe('user-1');
    expect(call.name).toBe('Roof inspection');
  });

  it('trims surrounding whitespace before passing to the service', async () => {
    const svc = buildSvcMock();
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await c.createBlankService(USER_REQ, { name: '   Mobile mechanic   ' });
    const call = (svc.createBlank as jest.Mock).mock.calls[0][0];
    expect(call.name).toBe('Mobile mechanic');
  });

  it('throws 400 when name is missing or empty', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    await expect(c.createBlankService(USER_REQ, {})).rejects.toThrow(BadRequestException);
    await expect(c.createBlankService(USER_REQ, { name: '' })).rejects.toThrow(BadRequestException);
    await expect(c.createBlankService(USER_REQ, { name: '   ' })).rejects.toThrow(BadRequestException);
  });

  it('throws 400 when name is longer than 80 characters', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    const longName = 'x'.repeat(81);
    await expect(c.createBlankService(USER_REQ, { name: longName })).rejects.toThrow(/80/);
  });

  it('accepts exactly 80 characters', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    const exactName = 'x'.repeat(80);
    await expect(c.createBlankService(USER_REQ, { name: exactName })).resolves.toBeDefined();
  });

  it('throws 400 when no authenticated user', async () => {
    const c = new ServiceProfileController(buildSvcMock(), ADMIN_TEMPLATES_STUB);
    await expect(
      c.createBlankService({ user: null } as any, { name: 'Roof inspection' }),
    ).rejects.toThrow(BadRequestException);
  });

  it('converts Prisma P2002 into a 409 ConflictException', async () => {
    const svc = buildSvcMock({
      createBlankThrows: Object.assign(new Error('unique'), { code: 'P2002' }),
    });
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await expect(
      c.createBlankService(USER_REQ, { name: 'Roof inspection' }),
    ).rejects.toThrow(ConflictException);
  });

  it('propagates non-P2002 errors unchanged', async () => {
    const svc = buildSvcMock({ createBlankThrows: new Error('db down') });
    const c = new ServiceProfileController(svc, ADMIN_TEMPLATES_STUB);
    await expect(
      c.createBlankService(USER_REQ, { name: 'Roof inspection' }),
    ).rejects.toThrow(/db down/);
  });
});

// ─── Phase 1-4 management endpoints ─────────────────────────────────

type SP = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  status: string;
  isDefault: boolean;
  providerCategoryMappingsJson: unknown;
  pricingJson: string | null;
  faqJson: string | null;
  qualificationSchemaJson: string | null;
  aiInstructionsJson: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function mkProfile(overrides: Partial<SP> = {}): SP {
  return {
    id: 'p-1',
    userId: 'user-1',
    name: 'Upholstery',
    slug: 'upholstery',
    status: 'draft',
    isDefault: false,
    providerCategoryMappingsJson: [{ provider: 'thumbtack', categoryName: 'Upholstery' }],
    pricingJson: '{"a":1}',
    faqJson: null,
    qualificationSchemaJson: null,
    aiInstructionsJson: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function buildMgmtPrismaMock(
  seed: {
    profiles?: SP[];
    user?: { defaultServiceProfileId?: string | null };
    accounts?: Array<{ id: string; userId: string; businessName: string; platform: string; serviceOverridesJson: string | null }>;
  } = {},
) {
  const state = {
    profiles: [...(seed.profiles ?? [])],
    user: seed.user ?? { defaultServiceProfileId: null },
    accounts: [...(seed.accounts ?? [])],
  };
  return {
    _state: state,
    serviceProfile: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        state.profiles.filter((p) => p.userId === where.userId),
      ),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.id) return state.profiles.find((p) => p.id === where.id) ?? null;
        if (where?.userId_slug) {
          return state.profiles.find(
            (p) => p.userId === where.userId_slug.userId && p.slug === where.userId_slug.slug,
          ) ?? null;
        }
        return null;
      }),
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        return (
          state.profiles.find((p) => {
            if (p.userId !== where.userId) return false;
            if (where.isDefault !== undefined && p.isDefault !== where.isDefault) return false;
            if (where.status !== undefined && p.status !== where.status) return false;
            if (where.NOT?.id && p.id === where.NOT.id) return false;
            return true;
          }) ?? null
        );
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const p = state.profiles.find((x) => x.id === where.id);
        if (!p) throw new Error('not found');
        Object.assign(p, data, { updatedAt: new Date() });
        return p;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const row: SP = {
          id: `p-${state.profiles.length + 1}`,
          userId: data.userId,
          name: data.name,
          slug: data.slug,
          status: data.status ?? 'draft',
          isDefault: data.isDefault ?? false,
          providerCategoryMappingsJson: data.providerCategoryMappingsJson ?? [],
          pricingJson: data.pricingJson ?? null,
          faqJson: data.faqJson ?? null,
          qualificationSchemaJson: data.qualificationSchemaJson ?? null,
          aiInstructionsJson: data.aiInstructionsJson ?? null,
          archivedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.profiles.push(row);
        return row;
      }),
      delete: jest.fn().mockImplementation(async ({ where }: any) => {
        const idx = state.profiles.findIndex((p) => p.id === where.id);
        if (idx === -1) {
          const e: any = new Error('Record not found');
          e.code = 'P2025';
          throw e;
        }
        const [removed] = state.profiles.splice(idx, 1);
        return removed;
      }),
    },
    user: { findUnique: jest.fn().mockResolvedValue(state.user) },
    savedAccount: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        state.accounts.filter((a) => a.userId === where.userId),
      ),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) =>
        state.accounts.find((a) => a.id === where.id) ?? null,
      ),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const a = state.accounts.find((x) => x.id === where.id);
        if (!a) throw new Error('not found');
        Object.assign(a, data);
        return a;
      }),
    },
  } as any;
}

describe('ServiceProfileController — management endpoints', () => {
  const REQ = { user: { id: 'user-1' } } as any;
  const { ServiceProfileService } = require('./service-profile.service');

  it('case 1: lists profiles for the user, drafts first, then active, then archived', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({ id: 'p-active', status: 'active', name: 'Alpha', isDefault: true }),
        mkProfile({ id: 'p-arch', status: 'archived', name: 'Beta' }),
        mkProfile({ id: 'p-draft', status: 'draft', name: 'Gamma' }),
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const out = await ctrl.listProfiles(REQ);
    expect(out.profiles.map((p: any) => p.id)).toEqual(['p-draft', 'p-active', 'p-arch']);
  });

  it('case 2: activates a draft profile when it has at least one config field', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'draft', pricingJson: '{"x":1}' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const updated = await ctrl.transitionStatus(REQ, 'p-1', { status: 'active' });
    expect((updated as any).status).toBe('active');
  });

  it('case 2b: rejects activation when ALL config fields are empty', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({ id: 'p-1', status: 'draft', pricingJson: null, faqJson: null, qualificationSchemaJson: null }),
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(
      ctrl.transitionStatus(REQ, 'p-1', { status: 'active' }),
    ).rejects.toThrow(/Cannot activate/);
  });

  it('case 3: archives an active non-default profile', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'active', isDefault: false })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const updated = await ctrl.transitionStatus(REQ, 'p-1', { status: 'archived' });
    expect((updated as any).status).toBe('archived');
    expect((updated as any).archivedAt).toBeInstanceOf(Date);
  });

  it('case 4: archived profile is excluded from the resolver match path', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({
          id: 'p-arch',
          status: 'archived',
          providerCategoryMappingsJson: [{ provider: 'thumbtack', categoryName: 'Cleaning' }],
        }),
      ],
      user: { defaultServiceProfileId: null },
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB);
    await svc.resolveForLead(
      { id: 'l', userId: 'user-1', category: 'Cleaning', categoryId: null },
      null,
    );
    expect(prisma.serviceProfile.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ['active', 'draft'] },
        }),
      }),
    );
  });

  it('case 5: cannot archive default profile without a replacement default', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-default', status: 'active', isDefault: true })],
      user: { defaultServiceProfileId: 'p-default' },
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(
      ctrl.transitionStatus(REQ, 'p-default', { status: 'archived' }),
    ).rejects.toThrow(/Cannot archive default/);
  });

  it('case 5b: can archive default profile when another active default exists', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({ id: 'p-old', status: 'active', isDefault: true }),
        mkProfile({ id: 'p-new', slug: 'new', status: 'active', isDefault: true }),
      ],
      user: { defaultServiceProfileId: 'p-old' },
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const updated = await ctrl.transitionStatus(REQ, 'p-old', { status: 'archived' });
    expect((updated as any).status).toBe('archived');
  });

  it('case 6: setOverride writes a per-profile entry into serviceOverridesJson', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'active' })],
      accounts: [
        { id: 'acct-tampa', userId: 'user-1', businessName: 'Tampa', platform: 'thumbtack', serviceOverridesJson: null },
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await ctrl.setOverride(REQ, 'p-1', 'acct-tampa', {
      pricingDeltasJson: '{"sofa":99}',
    });
    const persisted = JSON.parse(prisma._state.accounts[0].serviceOverridesJson);
    expect(persisted['p-1']).toEqual({ pricingDeltasJson: '{"sofa":99}' });
  });

  it('case 6b: clearOverride removes the profile entry; empty overrides become null', async () => {
    const seed = JSON.stringify({ 'p-1': { pricingDeltasJson: '{"sofa":99}' } });
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'active' })],
      accounts: [
        { id: 'acct-tampa', userId: 'user-1', businessName: 'Tampa', platform: 'thumbtack', serviceOverridesJson: seed },
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await ctrl.clearOverride(REQ, 'p-1', 'acct-tampa');
    expect(prisma._state.accounts[0].serviceOverridesJson).toBeNull();
  });

  it('case 6c: listOverrides returns one row per saved account with hasOverride flag', async () => {
    const tampaOverride = JSON.stringify({ 'p-1': { pricingDeltasJson: '{"sofa":99}' } });
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'active' })],
      accounts: [
        { id: 'acct-tampa', userId: 'user-1', businessName: 'Tampa', platform: 'thumbtack', serviceOverridesJson: tampaOverride },
        { id: 'acct-jax',   userId: 'user-1', businessName: 'JAX',   platform: 'thumbtack', serviceOverridesJson: null },
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const out = await ctrl.listOverrides(REQ, 'p-1');
    expect(out.overrides.find((o: any) => o.savedAccountId === 'acct-tampa')!.hasOverride).toBe(true);
    expect(out.overrides.find((o: any) => o.savedAccountId === 'acct-jax')!.hasOverride).toBe(false);
  });

  it('case 7: duplicate returns a draft copy under <slug>-copy', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', name: 'Upholstery', slug: 'upholstery', status: 'active' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const dup = await ctrl.duplicateProfile(REQ, 'p-1');
    expect((dup as any).slug).toBe('upholstery-copy');
    expect((dup as any).status).toBe('draft');
    expect((dup as any).name).toBe('Upholstery (copy)');
  });

  it('case 7b: duplicate auto-disambiguates when -copy is taken', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({ id: 'p-1', slug: 'upholstery', status: 'active' }),
        mkProfile({ id: 'p-2', slug: 'upholstery-copy', status: 'draft' }),
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const dup = await ctrl.duplicateProfile(REQ, 'p-1');
    expect((dup as any).slug).toBe('upholstery-copy-2');
  });

  it('cross-tenant: returns 404 when profile belongs to another user', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-other', userId: 'user-other' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.getProfile(REQ, 'p-other')).rejects.toThrow(/not found/);
  });

  it('updateProfile rejects empty name', async () => {
    const prisma = buildMgmtPrismaMock({ profiles: [mkProfile()] });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(
      ctrl.updateProfile(REQ, 'p-1', { name: '   ' }),
    ).rejects.toThrow(/Name cannot be empty/);
  });

  it('updateProfile rejects mappings that are not an array', async () => {
    const prisma = buildMgmtPrismaMock({ profiles: [mkProfile()] });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(
      ctrl.updateProfile(REQ, 'p-1', { providerCategoryMappingsJson: { not: 'an array' } as any }),
    ).rejects.toThrow(/must be an array/);
  });

  it('deleteProfile: removes a non-default profile and returns { deleted: true }', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'draft', isDefault: false })],
      user: { defaultServiceProfileId: null },
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    const out = await ctrl.deleteProfile(REQ, 'p-1');
    expect(out).toEqual({ id: 'p-1', deleted: true });
    expect(prisma._state.profiles).toHaveLength(0);
  });

  it('deleteProfile: throws NotFoundException for unknown id', async () => {
    const prisma = buildMgmtPrismaMock({ profiles: [] });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.deleteProfile(REQ, 'missing')).rejects.toThrow(/not found/i);
  });

  it('deleteProfile: throws NotFoundException for cross-user id', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-other', userId: 'user-other' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.deleteProfile(REQ, 'p-other')).rejects.toThrow(/not found/i);
    expect(prisma._state.profiles).toHaveLength(1);
  });

  it('deleteProfile: throws BadRequestException when isDefault=true', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-def', isDefault: true })],
      user: { defaultServiceProfileId: null },
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.deleteProfile(REQ, 'p-def')).rejects.toThrow(BadRequestException);
    expect(prisma._state.profiles).toHaveLength(1);
  });

  it('deleteProfile: throws BadRequestException when User.defaultServiceProfileId still points at it', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-pointed', isDefault: false })],
      user: { defaultServiceProfileId: 'p-pointed' },
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.deleteProfile(REQ, 'p-pointed')).rejects.toThrow(BadRequestException);
    expect(prisma._state.profiles).toHaveLength(1);
  });

  it('deleteProfile: 400 when no authenticated user', async () => {
    const prisma = buildMgmtPrismaMock();
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB), ADMIN_TEMPLATES_STUB);
    await expect(ctrl.deleteProfile({ user: null } as any, 'p-1')).rejects.toThrow(/Authenticated user required/);
  });
});
