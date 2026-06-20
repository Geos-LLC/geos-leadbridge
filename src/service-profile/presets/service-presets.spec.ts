/**
 * Tests for the two ServicePreset constants retained as seed/fallback
 * data after the customer-facing registry collapsed onto
 * `service_template_presets`. Pins:
 *
 *   - the data shape (pricing items, qualification questions, FAQ)
 *     so an accidental refactor surfaces in CI, and
 *   - the `buildServiceProfileFromPreset` factory contract since
 *     `ServiceProfileService.createBlank` still calls it directly.
 */

import {
  UPHOLSTERY_FURNITURE_CLEANING_PRESET,
  GENERIC_CUSTOM_SERVICE_PRESET,
  buildServiceProfileFromPreset,
} from './service-presets';

describe('UPHOLSTERY_FURNITURE_CLEANING_PRESET — data shape', () => {
  it('pricing items include all 7 furniture pieces', () => {
    const items = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items ?? [];
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.key).sort()).toEqual([
      'chair', 'curtains', 'loveseat', 'mattress', 'ottoman', 'sectional', 'sofa',
    ]);
  });

  it.each([
    ['sofa',      96],
    ['loveseat',  76],
    ['chair',     44],
    ['sectional', 149],
    ['mattress',  92],
    ['ottoman',   35],
  ])('%s base price = %d (thumbtack_average)', (key, expectedPrice) => {
    const item = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items!.find((i) => i.key === key);
    expect(item).toBeDefined();
    expect(item!.price).toBe(expectedPrice);
    expect(item!.source).toBe('thumbtack_average');
  });

  it('curtains item is sourced as interpolated (not thumbtack_average)', () => {
    const curtains = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items!.find((i) => i.key === 'curtains');
    expect(curtains).toBeDefined();
    expect(curtains!.source).toBe('interpolated');
    expect(curtains!.price).toBe(60);
  });

  it('stain_cleaning add-on has quoteManually=true (no thumbtack price)', () => {
    const addOns = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.addOns ?? [];
    const stain = addOns.find((a) => a.key === 'stain_cleaning');
    expect(stain).toBeDefined();
    expect(stain!.quoteManually).toBe(true);
    expect(stain!.source).toBe('missing_from_thumbtack');
    expect(stain!.price).toBe(0);
  });

  it('qualification schema contains 4 questions', () => {
    const questions = UPHOLSTERY_FURNITURE_CLEANING_PRESET.qualificationSchemaJson.questions;
    expect(questions).toHaveLength(4);
    expect(questions.map((q) => q.key)).toEqual([
      'furniture_pieces',
      'furniture_piece_count',
      'stain_types',
      'upholstery_material',
    ]);
  });

  it('qualification question types are typed correctly', () => {
    const byKey = Object.fromEntries(
      UPHOLSTERY_FURNITURE_CLEANING_PRESET.qualificationSchemaJson.questions.map((q) => [q.key, q]),
    );
    expect(byKey.furniture_pieces.type).toBe('multi_select');
    expect(byKey.furniture_pieces.options).toContain('sofa');
    expect(byKey.furniture_pieces.options).toContain('curtains');
    expect(byKey.furniture_piece_count.type).toBe('single_select');
    expect(byKey.stain_types.type).toBe('multi_select');
    expect(byKey.upholstery_material.type).toBe('single_select');
    expect(byKey.upholstery_material.options).toContain('customer_not_sure');
  });

  it('FAQ covers furniture pieces, stains, materials, and supplies', () => {
    const faqs = UPHOLSTERY_FURNITURE_CLEANING_PRESET.faqJson.customQA;
    const text = faqs.map((qa) => `${qa.question} ${qa.answer}`.toLowerCase()).join('\n');
    expect(text).toMatch(/furniture pieces/);
    expect(text).toMatch(/stain/);
    expect(text).toMatch(/upholstery material/);
    expect(text).toMatch(/cleaning supplies/);
    expect(faqs).toHaveLength(4);
  });

  it('carries the seven required-detail items from the v1 spec', () => {
    const rules = UPHOLSTERY_FURNITURE_CLEANING_PRESET.serviceRules;
    expect(rules).toBeDefined();
    expect(rules!.requiredDetails).toEqual(
      expect.arrayContaining([
        'Number of seats',
        'Area rug size',
        'Mattress size',
        'Fabric type',
        'Full name',
        'Address',
        'Phone number',
      ]),
    );
  });

  it('flags leather + wool rug cleaning as unsupported', () => {
    const rules = UPHOLSTERY_FURNITURE_CLEANING_PRESET.serviceRules!;
    expect(rules.unsupportedServices).toContain('Leather cleaning');
    expect(rules.unsupportedServices).toContain('Wool rug cleaning');
  });

  it('all pricing items carry a unit + active=true', () => {
    const items = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items ?? [];
    for (const item of items) {
      expect(item.unit).toMatch(/^per /);
      expect(item.active).toBe(true);
    }
  });
});

describe('GENERIC_CUSTOM_SERVICE_PRESET — data shape', () => {
  it('pricing model is hourly with $100 labor + minimum + quoteRequired', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.pricingModel).toBe('hourly');
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.laborRate).toBe(100);
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.minimumCharge).toBe(100);
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.quoteRequired).toBe(true);
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.currency).toBe('USD');
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.notes).toMatch(/scope/i);
  });

  it('FAQ covers estimates, service area, scheduling, payment, insurance/licensing, on-site access', () => {
    const questions = GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA.map((q) => q.question);
    expect(questions).toHaveLength(6);
    expect(questions.some((q) => /estimate/i.test(q))).toBe(true);
    expect(questions.some((q) => /area|serve/i.test(q))).toBe(true);
    expect(questions.some((q) => /schedule|how soon/i.test(q))).toBe(true);
    expect(questions.some((q) => /payment/i.test(q))).toBe(true);
    expect(questions.some((q) => /insured|licensed|insurance/i.test(q))).toBe(true);
    expect(questions.some((q) => /on-?site|access/i.test(q))).toBe(true);
  });

  it('FAQ answers defer rather than promise — no hard guarantees', () => {
    const answers = GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA.map((q) => q.answer).join(' ');
    expect(answers).not.toMatch(/we guarantee/i);
    expect(answers).not.toMatch(/we are insured/i);
    expect(answers).not.toMatch(/we are licensed/i);
    for (const qa of GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA) {
      expect(qa.answer.length).toBeGreaterThan(10);
    }
  });

  it('qualification has phone, address, desired date, project description as required', () => {
    const qs = GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson.questions;
    const byKey = new Map(qs.map((q) => [q.key, q]));
    expect(byKey.get('phone_number')?.required).toBe(true);
    expect(byKey.get('service_address')?.required).toBe(true);
    expect(byKey.get('desired_service_date')?.required).toBe(true);
    expect(byKey.get('project_description')?.required).toBe(true);
  });

  it('qualification has photos + zip_code as optional', () => {
    const qs = GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson.questions;
    const byKey = new Map(qs.map((q) => [q.key, q]));
    expect(byKey.get('photos')).toBeDefined();
    expect(byKey.get('photos')?.required).toBeFalsy();
    expect(byKey.get('zip_code')).toBeDefined();
    expect(byKey.get('zip_code')?.required).toBeFalsy();
  });

  it('service rules forbid license / insurance / warranty / certification claims', () => {
    const rules = GENERIC_CUSTOM_SERVICE_PRESET.serviceRules!;
    const flat = rules.workflowSteps.join(' ').toLowerCase();
    expect(flat).toMatch(/do not claim/);
    expect(flat).toMatch(/licens/);
    expect(flat).toMatch(/insur/);
    expect(flat).toMatch(/do not guarantee a final price/);
  });
});

describe('buildServiceProfileFromPreset — factory contract', () => {
  it('produces a draft profile by default with the preset slug + label', () => {
    const out = buildServiceProfileFromPreset(UPHOLSTERY_FURNITURE_CLEANING_PRESET, {
      userId: 'user-123',
    });
    expect(out.userId).toBe('user-123');
    expect(out.name).toBe('Upholstery and Furniture Cleaning');
    expect(out.slug).toBe('upholstery-furniture-cleaning');
    expect(out.status).toBe('draft');
    expect(out.isDefault).toBe(false);
  });

  it('copies pricingJson + faqJson + qualificationSchemaJson as stringified blobs', () => {
    const out = buildServiceProfileFromPreset(UPHOLSTERY_FURNITURE_CLEANING_PRESET, {
      userId: 'user-1',
    });
    const pricing = JSON.parse(out.pricingJson);
    expect(pricing.pricingModel).toBe('item_quantity');
    expect(pricing.items).toHaveLength(7);

    const faq = JSON.parse(out.faqJson);
    expect(Array.isArray(faq.customQA)).toBe(true);
    expect(faq.customQA).toHaveLength(4);

    const quals = JSON.parse(out.qualificationSchemaJson);
    expect(quals.questions).toHaveLength(4);
  });

  it('seeds the providerCategoryMappingsJson with the preset categoryName', () => {
    const out = buildServiceProfileFromPreset(UPHOLSTERY_FURNITURE_CLEANING_PRESET, {
      userId: 'user-1',
    });
    expect(out.providerCategoryMappingsJson).toEqual([
      { provider: 'thumbtack', categoryName: 'Upholstery and Furniture Cleaning' },
    ]);
  });

  it('honors status + slug overrides and merges extra category mappings', () => {
    const out = buildServiceProfileFromPreset(UPHOLSTERY_FURNITURE_CLEANING_PRESET, {
      userId: 'user-1',
      status: 'active',
      slug: 'custom-slug',
      extraCategoryMappings: [
        { provider: 'thumbtack', providerCategoryId: '219264413294461288', categoryName: 'Furniture Cleaning' },
      ],
    });
    expect(out.status).toBe('active');
    expect(out.slug).toBe('custom-slug');
    expect(out.providerCategoryMappingsJson).toEqual([
      { provider: 'thumbtack', categoryName: 'Upholstery and Furniture Cleaning' },
      { provider: 'thumbtack', providerCategoryId: '219264413294461288', categoryName: 'Furniture Cleaning' },
    ]);
  });

  it('seeds aiInstructionsJson with a versioned wrapper carrying serviceRules', () => {
    const out = buildServiceProfileFromPreset(UPHOLSTERY_FURNITURE_CLEANING_PRESET, {
      userId: 'user-1',
    });
    expect(out.aiInstructionsJson).not.toBeNull();
    const parsed = JSON.parse(out.aiInstructionsJson!);
    expect(parsed.version).toBe(1);
    expect(parsed.serviceRules).toBeDefined();
    expect(parsed.serviceRules.requiredDetails).toContain('Fabric type');
    expect(parsed.serviceRules.unsupportedServices).toContain('Leather cleaning');
    expect(parsed.serviceRules.workflowSteps.length).toBeGreaterThan(0);
  });

  it('omits aiInstructionsJson when the preset has no serviceRules', () => {
    const presetWithoutRules = {
      ...UPHOLSTERY_FURNITURE_CLEANING_PRESET,
      serviceRules: undefined,
    };
    const out = buildServiceProfileFromPreset(presetWithoutRules, { userId: 'user-1' });
    expect(out.aiInstructionsJson).toBeNull();
  });

  it('copies generic preset pricing, FAQ, qualification, and service rules', () => {
    const out = buildServiceProfileFromPreset(GENERIC_CUSTOM_SERVICE_PRESET, {
      userId: 'user-1',
    });
    expect(JSON.parse(out.pricingJson)).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson);
    expect(JSON.parse(out.faqJson)).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.faqJson);
    expect(JSON.parse(out.qualificationSchemaJson)).toEqual(
      GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson,
    );
    const wrapper = JSON.parse(out.aiInstructionsJson!);
    expect(wrapper.serviceRules).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.serviceRules);
  });
});
