/**
 * ServiceProfileService — createFromAdminTemplate cross-module test.
 *
 * Covers spec cases:
 *   #6 Create Service Profile from a published admin template
 *   #7 Existing code presets still work (createFromPreset path)
 *
 * Bypasses NestJS DI with Object.create + prototype injection. We stub
 * the AdminServiceTemplatesService dependency directly so the test
 * stays focused on the bridging logic in ServiceProfileService.
 */

import { Logger } from '@nestjs/common';
import { ServiceProfileService } from './service-profile.service';
import {
  UPHOLSTERY_FURNITURE_CLEANING_PRESET,
} from './presets/service-presets';

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

describe('ServiceProfileService.createFromPreset (spec #7 — code presets still work)', () => {
  it('creates a draft profile from a curated code preset', async () => {
    const { svc, prisma } = buildService();
    const profile = await svc.createFromPreset({
      userId: 'u-1',
      preset: UPHOLSTERY_FURNITURE_CLEANING_PRESET,
      status: 'draft',
    });
    expect(profile.status).toBe('draft');
    expect(profile.name).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET.label);
    expect(prisma.profiles).toHaveLength(1);
    const written = prisma.profiles[0];
    expect(written.pricingJson).toBeTruthy();
    expect(written.faqJson).toBeTruthy();
    expect(written.qualificationSchemaJson).toBeTruthy();
  });
});
