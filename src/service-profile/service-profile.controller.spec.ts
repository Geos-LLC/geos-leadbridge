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
