/**
 * ServiceProfileService — createFromAdminTemplate cross-module test.
 *
 * Covers spec case #6 (Create Service Profile from a published admin
 * template). The legacy code-preset creation path was retired when the
 * SERVICE_PRESETS registry collapsed onto the DB-backed
 * service_template_presets table.
 *
 * Bypasses NestJS DI with Object.create + prototype injection. We stub
 * the AdminServiceTemplatesService dependency directly so the test
 * stays focused on the bridging logic in ServiceProfileService.
 */

import { Logger } from '@nestjs/common';
import { ServiceProfileService } from './service-profile.service';

function buildPrismaStub() {
  const profiles: any[] = [];
  let nextId = 1;
  return {
    profiles,
    serviceProfile: {
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.userId_slug) {
          return profiles.find(
            (p) => p.userId === where.userId_slug.userId && p.slug === where.userId_slug.slug,
          ) ?? null;
        }
        return profiles.find((p) => p.id === where.id) ?? null;
      }),
      create: jest.fn(async ({ data, select }: any) => {
        const row = { id: String(nextId++), createdAt: new Date(), updatedAt: new Date(), ...data };
        profiles.push(row);
        if (!select) return row;
        const out: any = {};
        for (const k of Object.keys(select)) {
          if (select[k]) out[k] = row[k];
        }
        return out;
      }),
    },
  };
}

function buildService(args: { publishedTemplate?: any } = {}): {
  svc: ServiceProfileService;
  prisma: ReturnType<typeof buildPrismaStub>;
  adminTemplates: { getPublishedById: jest.Mock };
} {
  const svc: any = Object.create(ServiceProfileService.prototype);
  svc.logger = new Logger('ServiceProfileServiceTest');
  const prisma = buildPrismaStub();
  const adminTemplates = {
    getPublishedById: jest.fn(async (id: string) =>
      args.publishedTemplate && id === args.publishedTemplate.id ? args.publishedTemplate : null,
    ),
  };
  svc.prisma = prisma;
  svc.adminTemplates = adminTemplates;
  return { svc, prisma, adminTemplates };
}

describe('ServiceProfileService.createFromAdminTemplate (spec #6)', () => {
  const PUBLISHED_TEMPLATE = {
    id: 't-1',
    key: 'thumbtack_house_cleaning',
    label: 'House Cleaning',
    provider: 'thumbtack',
    providerCategoryName: 'House Cleaning',
    providerCategoryId: null,
    description: null,
    additionalInstructions: 'Always ask square footage.',
    serviceOptionsJson: JSON.stringify({
      groups: [
        {
          key: 'rooms',
          label: 'How many rooms?',
          type: 'single_select',
          options: [
            { key: 'one_room', label: '1 room' },
            { key: 'two_rooms', label: '2 rooms' },
          ],
        },
      ],
    }),
    pricingJson: JSON.stringify({
      pricingModel: 'room_quantity',
      currency: 'USD',
      basePrices: [
        { quantity: 1, label: '1 room', price: 79, source: 'thumbtack_average' },
      ],
      addOns: [],
    }),
    customerAnswersJson: JSON.stringify({
      entries: [{ question: 'Are supplies included?', answer: 'Yes, standard supplies.' }],
    }),
    status: 'published',
  };

  it('creates a draft profile from a published template', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });

    const profile = await svc.createFromAdminTemplate({
      userId: 'u-1',
      templateId: 't-1',
    });

    expect(profile.status).toBe('draft');
    expect(profile.name).toBe('House Cleaning');
    expect(profile.slug).toBe('house-cleaning');
    expect(prisma.profiles).toHaveLength(1);
  });

  it('bridges v2 serviceOptions → v1 qualificationSchema (string options)', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-1' });
    const written = prisma.profiles[0];
    const qual = JSON.parse(written.qualificationSchemaJson);
    expect(qual.questions).toHaveLength(1);
    expect(qual.questions[0].key).toBe('rooms');
    expect(qual.questions[0].options).toEqual(['1 room', '2 rooms']);
  });

  it('bridges v2 customerAnswers → v1 faq.customQA', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-1' });
    const written = prisma.profiles[0];
    const faq = JSON.parse(written.faqJson);
    expect(faq.customQA).toHaveLength(1);
    expect(faq.customQA[0].question).toBe('Are supplies included?');
  });

  it('stores additionalInstructions in v1 wrapper', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-1' });
    const written = prisma.profiles[0];
    const ai = JSON.parse(written.aiInstructionsJson);
    expect(ai.version).toBe(1);
    expect(ai.additionalInstructions).toBe('Always ask square footage.');
  });

  it('bridges v2 room_quantity pricing → v1 item_quantity shape for the PricingEditor', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-1' });
    const written = prisma.profiles[0];
    const pricing = JSON.parse(written.pricingJson);
    // v1 shape the PricingEditor knows how to render as a table.
    expect(pricing.pricingModel).toBe('item_quantity');
    expect(Array.isArray(pricing.items)).toBe(true);
    expect(pricing.items).toHaveLength(1);
    expect(pricing.items[0]).toMatchObject({
      label: '1 room',
      price: 79,
      source: 'thumbtack_average',
      active: true,
    });
    expect(typeof pricing.items[0].key).toBe('string');
  });

  it('bridges v2 hourly pricing through to v1 hourly', async () => {
    const hourlyTemplate = {
      ...PUBLISHED_TEMPLATE,
      id: 't-hr',
      pricingJson: JSON.stringify({
        pricingModel: 'hourly',
        currency: 'USD',
        basePrices: [],
        addOns: [],
        laborRate: 120,
        minimumCharge: 100,
        quoteRequired: true,
      }),
    };
    const { svc, prisma } = buildService({ publishedTemplate: hourlyTemplate });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-hr' });
    const pricing = JSON.parse(prisma.profiles[0].pricingJson);
    expect(pricing.pricingModel).toBe('hourly');
    expect(pricing.laborRate).toBe(120);
    expect(pricing.minimumCharge).toBe(100);
    expect(pricing.quoteRequired).toBe(true);
  });

  it('maps v2 source values to v1 PresetPricing source union', async () => {
    const sourceTemplate = {
      ...PUBLISHED_TEMPLATE,
      id: 't-src',
      pricingJson: JSON.stringify({
        pricingModel: 'item_quantity',
        currency: 'USD',
        basePrices: [
          { quantity: null, label: 'Sofa', price: 96, source: 'admin_input' },
          { quantity: null, label: 'Chair', price: 0, source: 'missing' },
        ],
        addOns: [],
      }),
    };
    const { svc, prisma } = buildService({ publishedTemplate: sourceTemplate });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-src' });
    const items = JSON.parse(prisma.profiles[0].pricingJson).items;
    expect(items[0].source).toBe('manual');
    expect(items[1].source).toBe('missing_from_thumbtack');
  });

  it('flattens v2 addOns INTO items[] (no separate addOns key) so the editor renders them', async () => {
    const tmpl = {
      ...PUBLISHED_TEMPLATE,
      id: 't-ao',
      pricingJson: JSON.stringify({
        pricingModel: 'room_quantity',
        currency: 'USD',
        basePrices: [
          { quantity: 1, label: '1 room', price: 79, source: 'thumbtack_average' },
        ],
        addOns: [
          { key: 'flights_of_stairs', label: 'Flights of stairs', price: 0, source: 'missing', quoteManually: true },
          { key: 'pets', label: 'Cleaning home with pet(s)', price: 0, source: 'missing', quoteManually: true },
        ],
      }),
    };
    const { svc, prisma } = buildService({ publishedTemplate: tmpl });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-ao' });
    const pricing = JSON.parse(prisma.profiles[0].pricingJson);

    // All 3 rows show up in items[] — the PricingEditor will render
    // them as editable table rows.
    expect(pricing.items).toHaveLength(3);
    expect(pricing.items.map((i: any) => i.label)).toEqual([
      '1 room',
      'Flights of stairs',
      'Cleaning home with pet(s)',
    ]);

    // Add-on rows carry the `Add-on` tag in notes and a missing-price
    // source so an operator can spot the ones that need pricing.
    const addOnRow = pricing.items.find((i: any) => i.label === 'Flights of stairs');
    expect(addOnRow).toMatchObject({
      notes: 'Add-on',
      source: 'missing_from_thumbtack',
      price: 0,
      active: true,
    });

    // Base rows do NOT get the Add-on tag.
    const baseRow = pricing.items.find((i: any) => i.label === '1 room');
    expect(baseRow.notes).toBeUndefined();

    // No separate addOns key — flattening into items[] is the whole point.
    expect(pricing.addOns).toBeUndefined();
  });

  it('attaches a providerCategoryMappings entry for the template provider', async () => {
    const { svc, prisma } = buildService({ publishedTemplate: PUBLISHED_TEMPLATE });
    await svc.createFromAdminTemplate({ userId: 'u-1', templateId: 't-1' });
    const written = prisma.profiles[0];
    const mappings = written.providerCategoryMappingsJson;
    expect(mappings).toEqual([
      {
        provider: 'thumbtack',
        categoryName: 'House Cleaning',
      },
    ]);
  });

  it('throws NOT_FOUND when the template is missing or not published', async () => {
    const { svc } = buildService({ publishedTemplate: null as any });
    await expect(
      svc.createFromAdminTemplate({ userId: 'u-1', templateId: 'missing' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

