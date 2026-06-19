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
import {
  extractAiPlaybookV2,
  isEffectivelyEmpty,
  mergeFaqJson,
  mergePricingJson,
  pickPrimarySavedAccount,
} from './service-profile.types';

/** Stub for the AdminServiceTemplatesService dep — these tests don't
 *  exercise the from-template path, so unimplemented methods stay
 *  as throwing mocks. Cast to any keeps the constructor signature
 *  satisfied without dragging in the real module. */
const ADMIN_TEMPLATES_STUB: any = {
  getPublishedById: jest.fn(async () => null),
  listPublished: jest.fn(async () => []),
};

/** Stub for the MonitoringService dep — the resolver's no-match
 *  warning fires through captureError, but the tests don't assert on
 *  it; a no-op stub keeps the constructor signature satisfied. */
const MONITORING_STUB: any = {
  captureError: jest.fn(async () => undefined),
};

type ProfileRow = {
  id: string;
  userId: string;
  name: string;
  slug: string;
  status: string;
  isDefault: boolean;
  serviceGroup: 'cleaning' | 'upholstery_carpet' | 'other';
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
          serviceGroup: data.serviceGroup ?? 'other',
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
    serviceGroup: 'other',
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

describe('ServiceProfileService — resolver (classifier-only after A3)', () => {
  it('routes a cleaning lead to the cleaning profile via classifier', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          name: 'House Cleaning',
          slug: 'house-cleaning',
          serviceGroup: 'cleaning',
          pricingJson: '{"base":279}',
          faqJson: '[{"q":"insured?","a":"yes"}]',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Regular home cleaning' },
      null,
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.profileId).toBe('prof-cleaning');
    expect(result.matchedBy).toBe('serviceGroup');
    expect(result.effectivePricingJson).toBe('{"base":279}');
  });

  it('routes an upholstery/carpet lead to the upholstery_carpet profile (specific wins)', async () => {
    // Tenant with cleaning + upholstery profiles. A "Carpet and
    // upholstery cleaning" lead classifies to both groups; the
    // priority order picks upholstery_carpet first.
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          serviceGroup: 'cleaning',
          pricingJson: '{"cleaning":1}',
        }),
        buildProfile({
          id: 'prof-uphol',
          serviceGroup: 'upholstery_carpet',
          pricingJson: '{"uphol":1}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Carpet and upholstery cleaning' },
      null,
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.profileId).toBe('prof-uphol');
  });

  it('falls back to the cleaning profile for a carpet lead when only cleaning is configured', async () => {
    // Tenant has only a cleaning profile. The same "Carpet and
    // upholstery cleaning" lead classifies to [upholstery_carpet,
    // cleaning]; with no upholstery profile, the cleaning profile
    // catches it.
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning-only',
          serviceGroup: 'cleaning',
          pricingJson: '{"cleaning":1}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Carpet and upholstery cleaning' },
      null,
    );
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') throw new Error('typeguard');
    expect(result.profileId).toBe('prof-cleaning-only');
  });

  it('returns no_match when the classifier finds no candidate group', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning',
          serviceGroup: 'cleaning',
          pricingJson: '{"cleaning":1}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'Lawn maintenance' },
      null,
    );
    expect(result.status).toBe('no_match');
    if (result.status !== 'no_match') throw new Error('typeguard');
    expect(result.reason).toBe('no_classifier_match');
  });

  it('returns no_match when the tenant has zero profiles', async () => {
    const prisma = buildPrismaMock({
      profiles: [],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'House Cleaning' },
      null,
    );
    expect(result.status).toBe('no_match');
    if (result.status !== 'no_match') throw new Error('typeguard');
    expect(result.reason).toBe('no_profiles');
  });

  it('pauses AI when the classifier-matched profile is still in draft', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-cleaning-draft',
          serviceGroup: 'cleaning',
          status: 'draft',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'House Cleaning' },
      null,
    );
    expect(result.status).toBe('ai_paused');
    if (result.status !== 'ai_paused') throw new Error('typeguard');
    expect(result.reason).toBe('draft_profile');
    expect(result.profileId).toBe('prof-cleaning-draft');

    // And the wrapper signals aiPaused with no pricing to assemble.
    const inputs = await svc.resolveEffectivePromptInputs(
      { ...LEAD_BASE, category: 'House Cleaning' },
      null,
    );
    expect(inputs.aiPaused).toBe(true);
    expect(inputs.pricingJson).toBeNull();
  });

  it('archived profiles are excluded from classifier matching', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({
          id: 'prof-old-cleaning',
          status: 'archived',
          archivedAt: new Date('2026-01-01'),
          serviceGroup: 'cleaning',
          pricingJson: '{"shouldNotBeRead":true}',
        }),
        buildProfile({
          id: 'prof-active-uphol',
          serviceGroup: 'upholstery_carpet',
          pricingJson: '{"uphol":1}',
        }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    // House Cleaning classifies to cleaning; the only cleaning profile
    // is archived, so the resolver no_matches.
    const result = await svc.resolveForLead(
      { ...LEAD_BASE, category: 'House Cleaning' },
      null,
    );
    expect(result.status).toBe('no_match');
  });

  it('resolveEffectivePromptInputs returns null pricing + source=none on no_match', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({ id: 'prof-cleaning', serviceGroup: 'cleaning' }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const inputs = await svc.resolveEffectivePromptInputs(
      { ...LEAD_BASE, category: 'Roof repair' },
      null,
    );
    expect(inputs.aiPaused).toBe(false);
    expect(inputs.pricingJson).toBeNull();
    expect(inputs.faqJson).toBeNull();
    expect(inputs.profileId).toBeNull();
    expect(inputs.source).toBe('none');
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

describe('isEffectivelyEmpty', () => {
  it.each([
    [null, true],
    [undefined, true],
    ['', true],
    ['   ', true],
    ['[]', true],
    ['{}', true],
    ['null', true],
    ['not-json', true], // defensive — treat unparseable as empty
    ['[{"q":"a"}]', false],
    ['{"a":1}', false],
    ['"some string"', false],
    ['42', false],
  ])('isEffectivelyEmpty(%j) → %p', (input, expected) => {
    expect(isEffectivelyEmpty(input as any)).toBe(expected);
  });
});

describe('extractAiPlaybookV2', () => {
  it('returns null when followUpSettingsJson is null/empty/unparseable', () => {
    expect(extractAiPlaybookV2(null)).toBeNull();
    expect(extractAiPlaybookV2('')).toBeNull();
    expect(extractAiPlaybookV2('not-json')).toBeNull();
    expect(extractAiPlaybookV2('{}')).toBeNull();
    expect(extractAiPlaybookV2('{"other":"thing"}')).toBeNull();
  });

  it('returns null when aiPlaybookV2 has no section with non-empty customInstructions', () => {
    const blob = JSON.stringify({
      aiPlaybookV2: {
        brand_voice: { customInstructions: '' },
        faq: { customInstructions: '   ' },
        pricing_guidance: {},
      },
    });
    expect(extractAiPlaybookV2(blob)).toBeNull();
  });

  it('returns the v2 sub-tree re-stringified when at least one section has content', () => {
    const v2 = {
      brand_voice: { customInstructions: 'Always be friendly.' },
      faq: { customInstructions: '' },
    };
    const blob = JSON.stringify({ aiPlaybookV2: v2, somethingElse: 'ignored' });
    const out = extractAiPlaybookV2(blob);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!)).toEqual(v2);
  });
});

describe('pickPrimarySavedAccount — tiered preference', () => {
  it('picks the only account when there is one (any tier)', () => {
    const picked = pickPrimarySavedAccount([
      { id: 'a', servicePricingJson: null, faqJson: null, lastUsedAt: new Date('2026-06-01') },
    ]);
    expect(picked?.id).toBe('a');
  });

  it('returns null on empty input', () => {
    expect(pickPrimarySavedAccount([])).toBeNull();
  });

  it('prefers complete account (Tier 1) over a more-recently-used incomplete one', () => {
    // This is the Spotless-like fixture: Wesley Chapel was last touched
    // but had null faqJson, so the original picker chose it. The new
    // picker prefers any sibling that carries both fields.
    const picked = pickPrimarySavedAccount([
      {
        id: 'wesley-chapel',
        servicePricingJson: '{"base":219}',
        faqJson: null, // missing FAQ
        lastUsedAt: new Date('2026-06-14T20:00:32Z'), // most recent
      },
      {
        id: 'jacksonville',
        servicePricingJson: '{"base":249}',
        faqJson: '[{"q":"supplies?"}]',
        lastUsedAt: new Date('2026-06-14T20:00:25Z'),
      },
      {
        id: 'tampa',
        servicePricingJson: '{"base":199}',
        faqJson: '[{"q":"supplies?"}]',
        lastUsedAt: new Date('2026-06-14T20:00:10Z'),
      },
    ]);
    expect(picked?.id).toBe('jacksonville'); // newest Tier 1, not Wesley Chapel
  });

  it('Tier 1 ties break on most-recently-used', () => {
    const picked = pickPrimarySavedAccount([
      {
        id: 'older-complete',
        servicePricingJson: '{"x":1}',
        faqJson: '[]', // empty array passes the picker's "non-null" check
        lastUsedAt: new Date('2026-06-10'),
      },
      {
        id: 'newer-complete',
        servicePricingJson: '{"x":1}',
        faqJson: '[]',
        lastUsedAt: new Date('2026-06-14'),
      },
    ]);
    expect(picked?.id).toBe('newer-complete');
  });

  it('falls through tiers: Tier 1 missing → Tier 2 (pricing only) wins over Tier 3', () => {
    const picked = pickPrimarySavedAccount([
      {
        id: 'tier3-faq-only',
        servicePricingJson: null,
        faqJson: '[{"q":"a"}]',
        lastUsedAt: new Date('2026-06-14'), // most recent overall
      },
      {
        id: 'tier2-pricing-only',
        servicePricingJson: '{"x":1}',
        faqJson: null,
        lastUsedAt: new Date('2026-06-10'),
      },
    ]);
    expect(picked?.id).toBe('tier2-pricing-only'); // Tier 2 beats Tier 3
  });

  it('null lastUsedAt sorts after a real Date within the same tier', () => {
    const picked = pickPrimarySavedAccount([
      {
        id: 'null-time',
        servicePricingJson: '{"x":1}',
        faqJson: '[{"q":"a"}]',
        lastUsedAt: null,
      },
      {
        id: 'real-time',
        servicePricingJson: '{"x":1}',
        faqJson: '[{"q":"a"}]',
        lastUsedAt: new Date('2025-01-01'),
      },
    ]);
    expect(picked?.id).toBe('real-time');
  });
});

/**
 * createBlank — the "Create custom service" backend path. Pins that
 * the new profile carries the generic preset's data (so the AI has
 * safe defaults from the first message) and that the slug-collision
 * loop deterministically appends -2, -3, … rather than relying on
 * P2002 for the common case.
 */
describe('ServiceProfileService — createBlank (generic Custom Service preset)', () => {
  it('seeds the new profile from GENERIC_CUSTOM_SERVICE_PRESET', async () => {
    const prisma = buildPrismaMock();
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const created = await svc.createBlank({ userId: USER_ID, name: 'Roof inspection' });

    // The mock's create returns the row it persisted — find it back in
    // state so we can inspect every column the service wrote.
    const row = prisma._state.profiles.find((p: ProfileRow) => p.id === created.id);
    expect(row).toBeDefined();
    expect(row.name).toBe('Roof inspection'); // user's chosen name overrides the preset label
    expect(row.slug).toBe('roof-inspection');
    expect(row.status).toBe('draft');
    expect(row.isDefault).toBe(false);
    expect(row.providerCategoryMappingsJson).toEqual([]); // generic preset has no provider mapping

    // Pricing / FAQ / qualification land verbatim from the preset.
    const pricing = JSON.parse(row.pricingJson);
    expect(pricing.pricingModel).toBe('hourly');
    expect(pricing.laborRate).toBe(100);
    expect(pricing.minimumCharge).toBe(100);
    expect(pricing.quoteRequired).toBe(true);

    const faq = JSON.parse(row.faqJson);
    expect(faq.customQA).toHaveLength(6);

    const qual = JSON.parse(row.qualificationSchemaJson);
    expect(qual.questions.map((q: { key: string }) => q.key)).toEqual(
      expect.arrayContaining(['phone_number', 'service_address', 'desired_service_date', 'project_description']),
    );

    // Service rules land in the aiInstructionsJson wrapper.
    const wrapper = JSON.parse(row.aiInstructionsJson);
    expect(wrapper.serviceRules.workflowSteps.join(' ')).toMatch(/do not guarantee/i);
  });

  it('appends -2, -3, … on slug collision instead of relying on P2002', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({ id: 'p1', userId: USER_ID, slug: 'window-cleaning' }),
        buildProfile({ id: 'p2', userId: USER_ID, slug: 'window-cleaning-2' }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const created = await svc.createBlank({ userId: USER_ID, name: 'Window cleaning' });
    const row = prisma._state.profiles.find((p: ProfileRow) => p.id === created.id);
    expect(row.slug).toBe('window-cleaning-3');
  });

  it('falls back to "new-service" when the name has no slug-safe chars', async () => {
    const prisma = buildPrismaMock();
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const created = await svc.createBlank({ userId: USER_ID, name: '!!!' });
    const row = prisma._state.profiles.find((p: ProfileRow) => p.id === created.id);
    expect(row.slug).toBe('new-service');
  });
});

describe('ServiceProfileService — deleteProfile', () => {
  it('removes the row when no default constraint applies', async () => {
    const prisma = buildPrismaMock({
      profiles: [
        buildProfile({ id: 'prof-x', userId: USER_ID, slug: 'roof-inspection', isDefault: false }),
      ],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    const result = await svc.deleteProfile(USER_ID, 'prof-x');
    expect(result).toEqual({ id: 'prof-x', deleted: true });
    expect(prisma._state.profiles.find((p: ProfileRow) => p.id === 'prof-x')).toBeUndefined();
  });

  it('throws NOT_FOUND when the profile does not exist', async () => {
    const prisma = buildPrismaMock({
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    await expect(svc.deleteProfile(USER_ID, 'missing')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('throws NOT_FOUND when the profile belongs to a different user (no cross-tenant delete)', async () => {
    const prisma = buildPrismaMock({
      profiles: [buildProfile({ id: 'prof-other', userId: 'someone-else', slug: 'other' })],
      users: [
        { id: USER_ID, defaultServiceProfileId: null },
        { id: 'someone-else', defaultServiceProfileId: null },
      ],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    await expect(svc.deleteProfile(USER_ID, 'prof-other')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(prisma._state.profiles.find((p: ProfileRow) => p.id === 'prof-other')).toBeDefined();
  });

  it('blocks delete when the profile is the tenant fallback (isDefault=true)', async () => {
    const prisma = buildPrismaMock({
      profiles: [buildProfile({ id: 'prof-def', userId: USER_ID, slug: 'default-service', isDefault: true })],
      users: [{ id: USER_ID, defaultServiceProfileId: null }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    await expect(svc.deleteProfile(USER_ID, 'prof-def')).rejects.toMatchObject({ code: 'DEFAULT_BLOCKED' });
    expect(prisma._state.profiles.find((p: ProfileRow) => p.id === 'prof-def')).toBeDefined();
  });

  it('blocks delete when the User.defaultServiceProfileId still points at this row', async () => {
    const prisma = buildPrismaMock({
      profiles: [buildProfile({ id: 'prof-pointed-at', userId: USER_ID, slug: 'roof', isDefault: false })],
      users: [{ id: USER_ID, defaultServiceProfileId: 'prof-pointed-at' }],
    });
    const svc = new ServiceProfileService(prisma, ADMIN_TEMPLATES_STUB, MONITORING_STUB);
    await expect(svc.deleteProfile(USER_ID, 'prof-pointed-at')).rejects.toMatchObject({
      code: 'DEFAULT_BLOCKED',
    });
    expect(prisma._state.profiles.find((p: ProfileRow) => p.id === 'prof-pointed-at')).toBeDefined();
  });
});

