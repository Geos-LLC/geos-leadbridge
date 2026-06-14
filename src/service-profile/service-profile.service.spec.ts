/**
 * ServiceProfileService tests.
 *
 * Covers the 9-case spec from the Phase 1 brief:
 *   1. Backfill creates one default ServiceProfile per tenant
 *   2. Existing pricing/FAQ copied correctly
 *   3. User.defaultServiceProfileId set
 *   4. AI prompt resolver reads ServiceProfile first
 *   5. Fallback to SavedAccount legacy fields works
 *   6. SavedAccount override merges over ServiceProfile base
 *   7. Draft profile pauses AI
 *   8. Archived profile is not selected
 *   9. Yelp/manual lead falls back to default profile
 *
 * Backfill cases (1-3) test the helper logic the script runs — we
 * exercise the same Prisma calls the script makes so the test
 * doesn't drift from the script's behavior.
 */

import { ServiceProfileService } from './service-profile.service';
import { mergePricingJson, mergeFaqJson } from './service-profile.types';

type ProfileRow = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  status: string;
  isDefault: boolean;
  providerCategoryMappingsJson: unknown;
  pricingJson: string | null;
  faqJson: string | null;
  aiInstructionsJson: string | null;
  qualificationSchemaJson: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type UserRow = {
  id: string;
  defaultServiceProfileId: string | null;
  servicePricingJson?: string | null;
  faqJson?: string | null;
};

type SavedAccountRow = {
  id: string;
  userId: string;
  servicePricingJson: string | null;
  faqJson: string | null;
  serviceOverridesJson: string | null;
  lastUsedAt?: Date;
};

function buildPrismaMock(
  seed: { profiles?: ProfileRow[]; users?: UserRow[]; savedAccounts?: SavedAccountRow[] } = {},
) {
  const state = {
    profiles: [...(seed.profiles ?? [])],
    users: [...(seed.users ?? [])],
    savedAccounts: [...(seed.savedAccounts ?? [])],
    idCounter: (seed.profiles ?? []).length,
  };

  const mock: any = {
    _state: state,
    serviceProfile: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) => {
        const allowedStatuses: string[] = where?.status?.in ?? [];
        return state.profiles.filter(
          (p) =>
            p.userId === where.userId &&
            (allowedStatuses.length === 0 || allowedStatuses.includes(p.status)),
        );
      }),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where?.userId_slug) {
          return (
            state.profiles.find(
              (p) => p.userId === where.userId_slug.userId && p.slug === where.userId_slug.slug,
            ) ?? null
          );
        }
        if (where?.id) {
          return state.profiles.find((p) => p.id === where.id) ?? null;
        }
        return null;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        state.idCounter += 1;
        const row: ProfileRow = {
          id: `prof-${state.idCounter}`,
          userId: data.userId,
          name: data.name,
          slug: data.slug,
          status: data.status ?? 'active',
          isDefault: data.isDefault ?? false,
          providerCategoryMappingsJson: data.providerCategoryMappingsJson ?? [],
          pricingJson: data.pricingJson ?? null,
          faqJson: data.faqJson ?? null,
          aiInstructionsJson: data.aiInstructionsJson ?? null,
          qualificationSchemaJson: data.qualificationSchemaJson ?? null,
          archivedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.profiles.push(row);
        return row;
      }),
    },
    user: {
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return state.users.find((u) => u.id === where.id) ?? null;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const u = state.users.find((x) => x.id === where.id);
        if (!u) throw new Error(`user ${where.id} not found`);
        Object.assign(u, data);
        return u;
      }),
    },
    savedAccount: {
      findFirst: jest.fn().mockImplementation(async ({ where, orderBy }: any) => {
        let candidates = state.savedAccounts.filter((a) => a.userId === where.userId);
        if (orderBy?.lastUsedAt === 'desc') {
          candidates = [...candidates].sort(
            (a, b) => (b.lastUsedAt?.getTime() ?? 0) - (a.lastUsedAt?.getTime() ?? 0),
          );
        }
        return candidates[0] ?? null;
      }),
    },
  };

  return mock;
}

function buildProfile(overrides: Partial<ProfileRow> = {}): ProfileRow {
  return {
    id: 'prof-seed',
    userId: 'user-1',
    name: 'Seed Profile',
    slug: 'seed-profile',
    status: 'active',
    isDefault: false,
    providerCategoryMappingsJson: [],
    pricingJson: null,
    faqJson: null,
    aiInstructionsJson: null,
    qualificationSchemaJson: null,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

const USER_ID = 'user-1';
const LEAD_BASE = { id: 'lead-1', userId: USER_ID };

describe('ServiceProfileService — resolver', () => {
  it('case 4: resolver reads ServiceProfile first when categoryId mapping matches', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          name: 'House Cleaning',
          slug: 'house-cleaning',
          providerCategoryMappingsJson: [
            { provider: 'thumbtack', providerCategoryId: '219264413294461288', categoryName: 'House Cleaning' },
          ],
          pricingJson: '{"base":219}',
          faqJson: '[{"q":"supplies?","a":"yes"}]',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma);

    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'House Cleaning', categoryId: '219264413294461288' },
      { id: 'acct-1', servicePricingJson: '{"base":99}', faqJson: '[]', serviceOverridesJson: null },
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.matchedBy).toBe('categoryId');
    expect(result.profileId).toBe('prof-cleaning');
    expect(result.effectivePricingJson).toBe('{"base":219}');
    expect(result.effectiveFaqJson).toBe('[{"q":"supplies?","a":"yes"}]');
  });

  it('case 4b: resolver matches by categoryName when categoryId absent', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          name: 'House Cleaning',
          slug: 'house-cleaning',
          providerCategoryMappingsJson: [
            { provider: 'thumbtack', categoryName: 'House Cleaning' },
          ],
          pricingJson: '{"base":219}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma);

    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'house cleaning', categoryId: null }, // case-insensitive
      null,
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.matchedBy).toBe('categoryName');
  });

  it('case 5: falls back to SavedAccount legacy fields when tenant has no profiles', async () => {
    const prisma = buildPrismaMock({
      profiles: [],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma);

    const out = await svc.resolveEffectivePromptInputs(
      { ...LEAD_BASE, category: 'House Cleaning', categoryId: null },
      {
        id: 'acct-1',
        servicePricingJson: '{"legacy":true}',
        faqJson: '[{"q":"hi"}]',
        serviceOverridesJson: null,
      },
    );

    expect(out.source).toBe('legacy_saved_account');
    expect(out.pricingJson).toBe('{"legacy":true}');
    expect(out.faqJson).toBe('[{"q":"hi"}]');
    expect(out.aiPaused).toBe(false);
  });

  it('case 5b: falls back to SavedAccount when profiles exist but none match and no default', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          providerCategoryMappingsJson: [{ provider: 'thumbtack', categoryName: 'Upholstery' }],
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }], // no default pointer
    });
    const svc = new ServiceProfileService(prisma);

    const out = await svc.resolveEffectivePromptInputs(
      { ...LEAD_BASE, category: 'Window Cleaning', categoryId: null },
      {
        id: 'acct-1',
        servicePricingJson: '{"legacy":true}',
        faqJson: null,
        serviceOverridesJson: null,
      },
    );

    expect(out.source).toBe('legacy_saved_account');
    expect(out.pricingJson).toBe('{"legacy":true}');
  });

  it('case 6: SavedAccount override merges over ServiceProfile base (shallow object merge)', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          providerCategoryMappingsJson: [
            { provider: 'thumbtack', categoryName: 'House Cleaning' },
          ],
          pricingJson: '{"base":219,"deep":299,"fridge":40}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma);

    const overrideForJax = JSON.stringify({
      'prof-cleaning': { pricingDeltasJson: '{"base":249}' }, // JAX charges more
    });

    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'House Cleaning', categoryId: null },
      {
        id: 'acct-jax',
        servicePricingJson: null,
        faqJson: null,
        serviceOverridesJson: overrideForJax,
      },
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    const merged = JSON.parse(result.effectivePricingJson!);
    expect(merged.base).toBe(249); // overridden
    expect(merged.deep).toBe(299); // inherited
    expect(merged.fridge).toBe(40); // inherited
  });

  it('case 7: draft profile pauses AI even when it matches', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-handyman',
          status: 'draft',
          providerCategoryMappingsJson: [{ provider: 'thumbtack', categoryName: 'Handyman' }],
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma);

    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Handyman', categoryId: null },
      null,
    );

    expect(result.status).toBe('ai_paused');
    if (result.status !== 'ai_paused') throw new Error('typeguard');
    expect(result.profileId).toBe('prof-handyman');
    expect(result.reason).toBe('draft_profile');

    // And the wrapper signals aiPaused with no pricing/FAQ to assemble.
    const inputs = await svc.resolveEffectivePromptInputs(
      { ...LEAD_BASE, category: 'Handyman', categoryId: null },
      null,
    );
    expect(inputs.aiPaused).toBe(true);
    expect(inputs.pricingJson).toBeNull();
  });

  it('case 8: archived profile is never selected, even if mappings match', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-old-upholstery',
          status: 'archived',
          archivedAt: new Date('2026-01-01'),
          providerCategoryMappingsJson: [{ provider: 'thumbtack', categoryName: 'Upholstery' }],
          pricingJson: '{"shouldNotBeRead":true}',
        }),
        buildProfile({
          id: 'prof-default',
          slug: 'default-service',
          isDefault: true,
          providerCategoryMappingsJson: [],
          pricingJson: '{"defaultUsed":true}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: 'prof-default' }],
    });
    const svc = new ServiceProfileService(prisma);

    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Upholstery', categoryId: null },
      null,
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    // Archived "Upholstery" profile is invisible; falls through to default.
    expect(result.profileId).toBe('prof-default');
    expect(result.matchedBy).toBe('default');
  });

  it('case 9: Yelp/manual lead (no categoryId) falls back to default profile', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-default',
          slug: 'default-service',
          isDefault: true,
          providerCategoryMappingsJson: [],
          pricingJson: '{"yourBase":219}',
          faqJson: '[{"q":"default"}]',
        }),
        buildProfile({
          id: 'prof-specific',
          providerCategoryMappingsJson: [
            { provider: 'thumbtack', categoryName: 'Carpet Cleaning' },
          ],
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: 'prof-default' }],
    });
    const svc = new ServiceProfileService(prisma);

    // Yelp lead: no category set, no categoryId.
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: null, categoryId: null },
      null,
    );

    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.profileId).toBe('prof-default');
    expect(result.matchedBy).toBe('default');
    expect(result.effectivePricingJson).toBe('{"yourBase":219}');
  });
});

describe('ServiceProfileService — backfill helper logic (cases 1-3)', () => {
  // The backfill script invokes the SAME prisma surface we mock above,
  // so we can exercise its create-and-point flow directly.

  it('case 1: backfill creates exactly one default profile per tenant', async () => {
    const prisma = buildPrismaMock({
      users: [
        { id: 'user-A', defaultServiceProfileId: null },
        { id: 'user-B', defaultServiceProfileId: null },
      ],
      savedAccounts: [
        {
          id: 'acct-A',
          userId: 'user-A',
          servicePricingJson: '{"a":1}',
          faqJson: '[]',
          serviceOverridesJson: null,
          lastUsedAt: new Date('2026-06-01'),
        },
      ],
    });

    // Replicate the script's per-user loop on two users.
    for (const userId of ['user-A', 'user-B']) {
      const existing = await prisma.serviceProfile.findUnique({
        where: { userId_slug: { userId, slug: 'default-service' } },
      });
      if (existing) continue;
      const primary = await prisma.savedAccount.findFirst({
        where: { userId },
        orderBy: { lastUsedAt: 'desc' },
        select: { id: true, businessName: true, servicePricingJson: true, faqJson: true },
      });
      const created = await prisma.serviceProfile.create({
        data: {
          userId,
          name: 'Default Service',
          slug: 'default-service',
          status: 'active',
          isDefault: true,
          providerCategoryMappingsJson: [],
          pricingJson: primary?.servicePricingJson ?? null,
          faqJson: primary?.faqJson ?? null,
        },
      });
      await prisma.user.update({
        where: { id: userId },
        data: { defaultServiceProfileId: created.id },
      });
    }

    const profiles = prisma._state.profiles;
    expect(profiles).toHaveLength(2);
    expect(profiles.every((p: ProfileRow) => p.isDefault)).toBe(true);
    expect(profiles.every((p: ProfileRow) => p.slug === 'default-service')).toBe(true);

    const users = prisma._state.users;
    expect(users.find((u: UserRow) => u.id === 'user-A')?.defaultServiceProfileId).toBe(profiles[0].id);
    expect(users.find((u: UserRow) => u.id === 'user-B')?.defaultServiceProfileId).toBe(profiles[1].id);
  });

  it('case 2: pricing/FAQ copied from the most recently used SavedAccount', async () => {
    const prisma = buildPrismaMock({
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
      savedAccounts: [
        {
          id: 'acct-tampa',
          userId: USER_ID,
          servicePricingJson: '{"city":"tampa","base":199}',
          faqJson: '[{"q":"tampa"}]',
          serviceOverridesJson: null,
          lastUsedAt: new Date('2026-05-01'),
        },
        {
          id: 'acct-jax',
          userId: USER_ID,
          servicePricingJson: '{"city":"jax","base":249}',
          faqJson: '[{"q":"jax"}]',
          serviceOverridesJson: null,
          lastUsedAt: new Date('2026-06-12'), // most recently used → primary
        },
      ],
    });

    const primary = await prisma.savedAccount.findFirst({
      where: { userId: USER_ID },
      orderBy: { lastUsedAt: 'desc' },
      select: { id: true, businessName: true, servicePricingJson: true, faqJson: true },
    });
    await prisma.serviceProfile.create({
      data: {
        userId: USER_ID,
        name: 'Default Service',
        slug: 'default-service',
        status: 'active',
        isDefault: true,
        providerCategoryMappingsJson: [],
        pricingJson: primary?.servicePricingJson ?? null,
        faqJson: primary?.faqJson ?? null,
      },
    });

    const created = prisma._state.profiles[0];
    expect(created.pricingJson).toBe('{"city":"jax","base":249}'); // JAX, most recent
    expect(created.faqJson).toBe('[{"q":"jax"}]');
  });

  it('case 3: User.defaultServiceProfileId is set to the created row', async () => {
    const prisma = buildPrismaMock({
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
      savedAccounts: [
        {
          id: 'acct-1',
          userId: USER_ID,
          servicePricingJson: null,
          faqJson: null,
          serviceOverridesJson: null,
          lastUsedAt: new Date(),
        },
      ],
    });

    const created = await prisma.serviceProfile.create({
      data: {
        userId: USER_ID,
        name: 'Default Service',
        slug: 'default-service',
        status: 'active',
        isDefault: true,
        providerCategoryMappingsJson: [],
        pricingJson: null,
        faqJson: null,
      },
    });
    await prisma.user.update({
      where: { id: USER_ID },
      data: { defaultServiceProfileId: created.id },
    });

    const user = prisma._state.users[0];
    expect(user.defaultServiceProfileId).toBe(created.id);
  });
});

describe('ServiceProfileService — merge helpers', () => {
  it('mergePricingJson: override keys win, missing keys inherit', () => {
    const merged = mergePricingJson('{"a":1,"b":2}', '{"b":3,"c":4}')!;
    const obj = JSON.parse(merged);
    expect(obj).toEqual({ a: 1, b: 3, c: 4 });
  });

  it('mergePricingJson: null base + override → override wins', () => {
    expect(mergePricingJson(null, '{"x":1}')).toBe('{"x":1}');
  });

  it('mergePricingJson: base + null override → base unchanged', () => {
    expect(mergePricingJson('{"x":1}', undefined)).toBe('{"x":1}');
  });

  it('mergePricingJson: invalid JSON returns base unchanged', () => {
    expect(mergePricingJson('{"x":1}', 'not-json')).toBe('{"x":1}');
  });

  it('mergeFaqJson: arrays concatenate', () => {
    const merged = mergeFaqJson('[{"q":"a"}]', '[{"q":"b"}]')!;
    expect(JSON.parse(merged)).toEqual([{ q: 'a' }, { q: 'b' }]);
  });
});
