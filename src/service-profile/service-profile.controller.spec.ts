/**
 * Tests for ServiceProfileController — preset consumer v1.
 *
 * Covers:
 *   - GET /v1/service-profile-presets shape
 *   - POST /v1/service-profiles/from-preset success path
 *   - 400 on missing presetKey
 *   - 400 on unknown presetKey
 *   - 400 on invalid status
 *   - 409 on (userId, slug) collision (P2002)
 */

import { BadRequestException, ConflictException } from '@nestjs/common';
import { ServiceProfileController } from './service-profile.controller';
import { ServiceProfileService } from './service-profile.service';

function buildSvcMock(opts: { createReturn?: any; createThrows?: any } = {}) {
  return {
    createFromPreset: jest.fn().mockImplementation(async () => {
      if (opts.createThrows) throw opts.createThrows;
      return (
        opts.createReturn ?? {
          id: 'profile-1',
          name: 'Upholstery and Furniture Cleaning',
          slug: 'upholstery-furniture-cleaning',
          status: 'draft',
        }
      );
    }),
  } as unknown as ServiceProfileService;
}

const USER_REQ = { user: { id: 'user-1' } } as any;

describe('ServiceProfileController.list', () => {
  it('returns the curated registry with full preset shape', () => {
    const c = new ServiceProfileController(buildSvcMock());
    const out = c.list();
    expect(Array.isArray(out.presets)).toBe(true);
    expect(out.presets.length).toBeGreaterThan(0);
    const upholstery = out.presets.find((p: any) => p.key === 'upholstery_furniture_cleaning');
    expect(upholstery).toBeDefined();
    expect(upholstery!.label).toBe('Upholstery and Furniture Cleaning');
    expect(upholstery!.providerCategoryName).toBe('Upholstery and Furniture Cleaning');
    expect(upholstery!.aliases).toContain('furniture cleaning');
    expect(upholstery!.pricingJson.pricingModel).toBe('item_quantity');
    expect(upholstery!.qualificationSchemaJson.questions).toHaveLength(4);
    expect(upholstery!.faqJson.customQA).toHaveLength(4);
  });
});

describe('ServiceProfileController.createFromPreset', () => {
  it('creates a draft profile by default and returns the slim record', async () => {
    const svc = buildSvcMock();
    const c = new ServiceProfileController(svc);
    const out = await c.createFromPreset(USER_REQ, { presetKey: 'upholstery_furniture_cleaning' });
    expect(out).toEqual({
      profileId: 'profile-1',
      slug: 'upholstery-furniture-cleaning',
      status: 'draft',
      name: 'Upholstery and Furniture Cleaning',
    });
    expect(svc.createFromPreset).toHaveBeenCalledTimes(1);
    const call = (svc.createFromPreset as jest.Mock).mock.calls[0][0];
    expect(call.userId).toBe('user-1');
    expect(call.preset.key).toBe('upholstery_furniture_cleaning');
    expect(call.status).toBe('draft');
  });

  it('honors explicit status="active" override', async () => {
    const svc = buildSvcMock({
      createReturn: { id: 'p', name: 'X', slug: 'x', status: 'active' },
    });
    const c = new ServiceProfileController(svc);
    const out = await c.createFromPreset(USER_REQ, {
      presetKey: 'upholstery_furniture_cleaning',
      status: 'active',
    });
    expect(out.status).toBe('active');
    expect((svc.createFromPreset as jest.Mock).mock.calls[0][0].status).toBe('active');
  });

  it('throws 400 when presetKey is missing', async () => {
    const c = new ServiceProfileController(buildSvcMock());
    await expect(c.createFromPreset(USER_REQ, {} as any)).rejects.toThrow(BadRequestException);
  });

  it('throws 400 when presetKey is unknown', async () => {
    const c = new ServiceProfileController(buildSvcMock());
    await expect(
      c.createFromPreset(USER_REQ, { presetKey: 'does_not_exist' }),
    ).rejects.toThrow(/Unknown preset key/);
  });

  it('throws 400 when status is invalid', async () => {
    const c = new ServiceProfileController(buildSvcMock());
    await expect(
      c.createFromPreset(USER_REQ, {
        presetKey: 'upholstery_furniture_cleaning',
        status: 'archived' as any,
      }),
    ).rejects.toThrow(/Invalid status/);
  });

  it('throws 400 when no authenticated user', async () => {
    const c = new ServiceProfileController(buildSvcMock());
    await expect(
      c.createFromPreset({ user: null } as any, {
        presetKey: 'upholstery_furniture_cleaning',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('converts Prisma P2002 into a 409 ConflictException', async () => {
    const svc = buildSvcMock({ createThrows: Object.assign(new Error('unique'), { code: 'P2002' }) });
    const c = new ServiceProfileController(svc);
    await expect(
      c.createFromPreset(USER_REQ, { presetKey: 'upholstery_furniture_cleaning' }),
    ).rejects.toThrow(ConflictException);
  });

  it('propagates non-P2002 errors unchanged', async () => {
    const svc = buildSvcMock({ createThrows: new Error('db down') });
    const c = new ServiceProfileController(svc);
    await expect(
      c.createFromPreset(USER_REQ, { presetKey: 'upholstery_furniture_cleaning' }),
    ).rejects.toThrow(/db down/);
  });
});

describe('ServiceProfileService.createFromPreset — integration with build helper', () => {
  // This block uses a minimal prisma stub that captures the create
  // payload — that's enough to verify what would land in the DB
  // without spinning up Prisma. The buildServiceProfileFromPreset
  // helper is already covered exhaustively in
  // src/service-profile/presets/service-presets.spec.ts.

  it('passes a payload with status="draft" + isDefault=false + the preset slug', async () => {
    const { ServiceProfileService } = await import('./service-profile.service');
    const { UPHOLSTERY_FURNITURE_CLEANING_PRESET } = await import('./presets/service-presets');
    let captured: any = null;
    const prisma: any = {
      serviceProfile: {
        create: jest.fn().mockImplementation(async ({ data }: any) => {
          captured = data;
          return { id: 'p-1', name: data.name, slug: data.slug, status: data.status };
        }),
      },
    };
    const svc = new ServiceProfileService(prisma);
    const out = await svc.createFromPreset({
      userId: 'user-1',
      preset: UPHOLSTERY_FURNITURE_CLEANING_PRESET,
    });
    expect(out).toEqual({
      id: 'p-1',
      name: 'Upholstery and Furniture Cleaning',
      slug: 'upholstery-furniture-cleaning',
      status: 'draft',
    });
    expect(captured.status).toBe('draft');
    expect(captured.isDefault).toBe(false);
    expect(captured.userId).toBe('user-1');
    expect(captured.slug).toBe('upholstery-furniture-cleaning');
    // mappings should be the parsed array (Prisma JSON field accepts arrays directly)
    expect(Array.isArray(captured.providerCategoryMappingsJson)).toBe(true);
    expect(captured.providerCategoryMappingsJson[0].provider).toBe('thumbtack');
    // JSON fields stored as strings on the model (db.Text)
    const pricing = JSON.parse(captured.pricingJson);
    expect(pricing.pricingModel).toBe('item_quantity');
    expect(pricing.items).toHaveLength(7);
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    const out = await ctrl.listProfiles(REQ);
    expect(out.profiles.map((p: any) => p.id)).toEqual(['p-draft', 'p-active', 'p-arch']);
  });

  it('case 2: activates a draft profile when it has at least one config field', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'draft', pricingJson: '{"x":1}' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    const updated = await ctrl.transitionStatus(REQ, 'p-1', { status: 'active' });
    expect((updated as any).status).toBe('active');
  });

  it('case 2b: rejects activation when ALL config fields are empty', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [
        mkProfile({ id: 'p-1', status: 'draft', pricingJson: null, faqJson: null, qualificationSchemaJson: null }),
      ],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    await expect(
      ctrl.transitionStatus(REQ, 'p-1', { status: 'active' }),
    ).rejects.toThrow(/Cannot activate/);
  });

  it('case 3: archives an active non-default profile', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', status: 'active', isDefault: false })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const svc = new ServiceProfileService(prisma);
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    const out = await ctrl.listOverrides(REQ, 'p-1');
    expect(out.overrides.find((o: any) => o.savedAccountId === 'acct-tampa')!.hasOverride).toBe(true);
    expect(out.overrides.find((o: any) => o.savedAccountId === 'acct-jax')!.hasOverride).toBe(false);
  });

  it('case 7: duplicate returns a draft copy under <slug>-copy', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-1', name: 'Upholstery', slug: 'upholstery', status: 'active' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
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
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    const dup = await ctrl.duplicateProfile(REQ, 'p-1');
    expect((dup as any).slug).toBe('upholstery-copy-2');
  });

  it('cross-tenant: returns 404 when profile belongs to another user', async () => {
    const prisma = buildMgmtPrismaMock({
      profiles: [mkProfile({ id: 'p-other', userId: 'user-other' })],
    });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    await expect(ctrl.getProfile(REQ, 'p-other')).rejects.toThrow(/not found/);
  });

  it('updateProfile rejects empty name', async () => {
    const prisma = buildMgmtPrismaMock({ profiles: [mkProfile()] });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    await expect(
      ctrl.updateProfile(REQ, 'p-1', { name: '   ' }),
    ).rejects.toThrow(/Name cannot be empty/);
  });

  it('updateProfile rejects mappings that are not an array', async () => {
    const prisma = buildMgmtPrismaMock({ profiles: [mkProfile()] });
    const ctrl = new ServiceProfileController(new ServiceProfileService(prisma));
    await expect(
      ctrl.updateProfile(REQ, 'p-1', { providerCategoryMappingsJson: { not: 'an array' } as any }),
    ).rejects.toThrow(/must be an array/);
  });
});
