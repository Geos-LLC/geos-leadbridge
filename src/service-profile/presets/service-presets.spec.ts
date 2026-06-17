/**
 * Tests for the ServiceProfile preset registry v1.
 *
 * Covers the 13-case spec from the v1 brief:
 *   1.  Preset registry contains upholstery_furniture_cleaning
 *   2.  Pricing items include all 7 furniture pieces
 *   3.  Sofa price = 96
 *   4.  Loveseat price = 76
 *   5.  Chair price = 44
 *   6.  Sectional price = 149
 *   7.  Mattress price = 92
 *   8.  Ottoman price = 35
 *   9.  Curtains source = interpolated
 *   10. Stain cleaning add-on quoteManually = true
 *   11. Qualification schema contains 4 questions
 *   12. FAQ contains furniture pieces, stains, materials, and supplies
 *   13. Fuzzy service-name match suggests this preset for "Furniture Cleaning"
 *
 * Plus tests for the buildServiceProfileFromPreset factory — it's a
 * pure function and the future creation endpoint will call it, so
 * we pin the output shape now to avoid drift.
 */

import {
  SERVICE_PRESETS,
  UPHOLSTERY_FURNITURE_CLEANING_PRESET,
  GENERIC_CUSTOM_SERVICE_PRESET,
  buildServiceProfileFromPreset,
  getItemPrice,
  lookupPresetByKey,
  suggestPresetForCategory,
} from './service-presets';

describe('ServicePreset registry — upholstery v1', () => {
  it('case 1: registry contains upholstery_furniture_cleaning', () => {
    const found = SERVICE_PRESETS.find((p) => p.key === 'upholstery_furniture_cleaning');
    expect(found).toBeDefined();
    expect(lookupPresetByKey('upholstery_furniture_cleaning')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
  });

  it('case 1b: lookupPresetByKey returns null for unknown keys', () => {
    expect(lookupPresetByKey('does_not_exist')).toBeNull();
    expect(lookupPresetByKey('')).toBeNull();
  });

  it('case 2: pricing items include all 7 furniture pieces', () => {
    const items = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items ?? [];
    expect(items).toHaveLength(7);
    expect(items.map((i) => i.key).sort()).toEqual([
      'chair', 'curtains', 'loveseat', 'mattress', 'ottoman', 'sectional', 'sofa',
    ]);
  });

  // Cases 3-8: per-item base price pins. Using the convenience
  // accessor so a future refactor that renames internal item keys can
  // still ship without quietly changing prices.
  it.each([
    ['sofa',      96],
    ['loveseat',  76],
    ['chair',     44],
    ['sectional', 149],
    ['mattress',  92],
    ['ottoman',   35],
  ])('case 3-8: %s base price = %d (thumbtack_average)', (key, expectedPrice) => {
    const item = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items!.find((i) => i.key === key);
    expect(item).toBeDefined();
    expect(item!.price).toBe(expectedPrice);
    expect(item!.source).toBe('thumbtack_average');
    expect(getItemPrice(UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson, key)).toBe(expectedPrice);
  });

  it('case 9: curtains item is sourced as interpolated (not thumbtack_average)', () => {
    const curtains = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items!.find((i) => i.key === 'curtains');
    expect(curtains).toBeDefined();
    expect(curtains!.source).toBe('interpolated');
    expect(curtains!.price).toBe(60);
  });

  it('case 10: stain_cleaning add-on has quoteManually=true (no thumbtack price)', () => {
    const addOns = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.addOns ?? [];
    const stain = addOns.find((a) => a.key === 'stain_cleaning');
    expect(stain).toBeDefined();
    expect(stain!.quoteManually).toBe(true);
    expect(stain!.source).toBe('missing_from_thumbtack');
    expect(stain!.price).toBe(0); // placeholder until owner sets it
  });

  it('case 11: qualification schema contains 4 questions', () => {
    const questions = UPHOLSTERY_FURNITURE_CLEANING_PRESET.qualificationSchemaJson.questions;
    expect(questions).toHaveLength(4);
    expect(questions.map((q) => q.key)).toEqual([
      'furniture_pieces',
      'furniture_piece_count',
      'stain_types',
      'upholstery_material',
    ]);
  });

  it('case 11b: qualification question types are typed correctly', () => {
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

  it('case 12: FAQ covers furniture pieces, stains, materials, and supplies', () => {
    const faqs = UPHOLSTERY_FURNITURE_CLEANING_PRESET.faqJson.customQA;
    const text = faqs.map((qa) => `${qa.question} ${qa.answer}`.toLowerCase()).join('\n');
    expect(text).toMatch(/furniture pieces/);
    expect(text).toMatch(/stain/);
    expect(text).toMatch(/upholstery material/);
    expect(text).toMatch(/cleaning supplies/);
    expect(faqs).toHaveLength(4);
  });

  it('case 13: suggestPresetForCategory matches the upholstery preset for "Furniture Cleaning"', () => {
    expect(suggestPresetForCategory('Furniture Cleaning')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
  });

  it('case 13b: suggestPresetForCategory case-insensitive, also matches verbatim providerCategoryName + other aliases', () => {
    expect(suggestPresetForCategory('Upholstery and Furniture Cleaning')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
    expect(suggestPresetForCategory('upholstery and furniture cleaning')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
    expect(suggestPresetForCategory('UPHOLSTERY CLEANING')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
    expect(suggestPresetForCategory('  furniture cleaning  ')).toBe(UPHOLSTERY_FURNITURE_CLEANING_PRESET);
  });

  it('case 13c: suggestPresetForCategory returns null for unrelated categories', () => {
    // Substring-style false positives we must NOT pick up.
    expect(suggestPresetForCategory('House Cleaning')).toBeNull();
    expect(suggestPresetForCategory('Wood Furniture Repair')).toBeNull();
    expect(suggestPresetForCategory('Carpet Cleaning')).toBeNull();
    expect(suggestPresetForCategory(null)).toBeNull();
    expect(suggestPresetForCategory(undefined)).toBeNull();
    expect(suggestPresetForCategory('')).toBeNull();
    expect(suggestPresetForCategory('   ')).toBeNull();
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
    expect(out.status).toBe('draft'); // default — operator must promote
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
});

describe('UPHOLSTERY preset — service rules + item units', () => {
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

  it('all pricing items carry a unit + active=true (default state)', () => {
    const items = UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items ?? [];
    for (const item of items) {
      expect(item.unit).toMatch(/^per /);
      expect(item.active).toBe(true);
    }
  });
});

/**
 * Generic "Custom Service" preset — covers the v1 spec for the
 * "Create custom service" flow. Pins the safe-defaults shape so an
 * accidental refactor (e.g. dropping quoteRequired or bumping the
 * laborRate) shows up in CI rather than as a surprise live quote.
 *
 * Also pins what the preset must NOT do: never collide with the
 * upholstery / cleaning presets, never auto-match via
 * suggestPresetForCategory (it's a manual opt-in only).
 */
describe('ServicePreset registry — generic custom service v1', () => {
  it('case 1: registry contains generic_custom_service', () => {
    const found = SERVICE_PRESETS.find((p) => p.key === 'generic_custom_service');
    expect(found).toBeDefined();
    expect(lookupPresetByKey('generic_custom_service')).toBe(GENERIC_CUSTOM_SERVICE_PRESET);
  });

  it('case 2: pricing model is hourly', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.pricingModel).toBe('hourly');
  });

  it('case 3: laborRate = 100', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.laborRate).toBe(100);
  });

  it('case 4: minimumCharge = 100', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.minimumCharge).toBe(100);
  });

  it('case 5: quoteRequired = true', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.quoteRequired).toBe(true);
  });

  it('case 5b: currency = USD with caveat notes', () => {
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.currency).toBe('USD');
    expect(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson.notes).toMatch(/scope/i);
  });

  it('case 6: FAQ covers estimates, service area, scheduling, payment, insurance/licensing, on-site access', () => {
    const questions = GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA.map((q) => q.question);
    expect(questions).toHaveLength(6);
    // Each topic must show up in at least one question.
    expect(questions.some((q) => /estimate/i.test(q))).toBe(true);
    expect(questions.some((q) => /area|serve/i.test(q))).toBe(true);
    expect(questions.some((q) => /schedule|how soon/i.test(q))).toBe(true);
    expect(questions.some((q) => /payment/i.test(q))).toBe(true);
    expect(questions.some((q) => /insured|licensed|insurance/i.test(q))).toBe(true);
    expect(questions.some((q) => /on-?site|access/i.test(q))).toBe(true);
  });

  it('case 6b: FAQ answers defer rather than promise — no hard guarantees', () => {
    const answers = GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA.map((q) => q.answer).join(' ');
    // The AI must defer until scope is known. None of these answers
    // should hand-wave a guarantee that the tenant hasn't configured.
    expect(answers).not.toMatch(/we guarantee/i);
    expect(answers).not.toMatch(/we are insured/i); // see "licensing varies" answer
    expect(answers).not.toMatch(/we are licensed/i);
    // Each answer must either ask for more info or defer to the owner.
    for (const qa of GENERIC_CUSTOM_SERVICE_PRESET.faqJson.customQA) {
      expect(qa.answer.length).toBeGreaterThan(10);
    }
  });

  it('case 7: qualification has phone, address, desired date, project description as required', () => {
    const qs = GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson.questions;
    const byKey = new Map(qs.map((q) => [q.key, q]));
    expect(byKey.get('phone_number')?.required).toBe(true);
    expect(byKey.get('service_address')?.required).toBe(true);
    expect(byKey.get('desired_service_date')?.required).toBe(true);
    expect(byKey.get('project_description')?.required).toBe(true);
  });

  it('case 7b: qualification has photos + zip_code as optional', () => {
    const qs = GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson.questions;
    const byKey = new Map(qs.map((q) => [q.key, q]));
    expect(byKey.get('photos')).toBeDefined();
    expect(byKey.get('photos')?.required).toBeFalsy();
    expect(byKey.get('zip_code')).toBeDefined();
    expect(byKey.get('zip_code')?.required).toBeFalsy();
  });

  it('case 8: buildServiceProfileFromPreset copies pricing, FAQ, qualification, and service rules', () => {
    const out = buildServiceProfileFromPreset(GENERIC_CUSTOM_SERVICE_PRESET, {
      userId: 'user-1',
    });
    expect(JSON.parse(out.pricingJson)).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.pricingJson);
    expect(JSON.parse(out.faqJson)).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.faqJson);
    expect(JSON.parse(out.qualificationSchemaJson)).toEqual(
      GENERIC_CUSTOM_SERVICE_PRESET.qualificationSchemaJson,
    );
    // serviceRules land in the aiInstructionsJson wrapper.
    const wrapper = JSON.parse(out.aiInstructionsJson!);
    expect(wrapper.serviceRules).toEqual(GENERIC_CUSTOM_SERVICE_PRESET.serviceRules);
  });

  it('case 9: existing presets stay unchanged — upholstery still ships intact', () => {
    // Sanity: adding the generic preset MUST NOT have altered the
    // upholstery preset shape. Pin the contract that already shipped.
    expect(UPHOLSTERY_FURNITURE_CLEANING_PRESET.key).toBe('upholstery_furniture_cleaning');
    expect(UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.pricingModel).toBe('item_quantity');
    expect(UPHOLSTERY_FURNITURE_CLEANING_PRESET.pricingJson.items).toHaveLength(7);
    expect(UPHOLSTERY_FURNITURE_CLEANING_PRESET.faqJson.customQA).toHaveLength(4);
  });

  it('case 10: registry order — upholstery first, generic last (curated presets stay above the catch-all)', () => {
    // The UI lists presets in registry order; the catch-all should sit
    // below the curated ones so it doesn't visually compete with the
    // platform-mapped templates.
    const lastKey = SERVICE_PRESETS[SERVICE_PRESETS.length - 1].key;
    expect(lastKey).toBe('generic_custom_service');
  });

  it('does NOT auto-match via suggestPresetForCategory — provider=manual is opt-in only', () => {
    // The fuzzy matcher walks providerCategoryName + aliases. Even
    // though "custom service" is an alias, no real provider category
    // would carry that string, and we never want a TT/Yelp scrape to
    // silently land tenants on the generic preset when their actual
    // category (e.g. "Roofing repair") didn't match any curated one.
    expect(suggestPresetForCategory('Roofing repair')).toBeNull();
    expect(suggestPresetForCategory('Plumbing')).toBeNull();
    // But the alias still works when a tenant explicitly types one of
    // the generic synonyms — useful when we later expose preset lookup
    // by name from the AddServiceModal copy.
    expect(suggestPresetForCategory('Custom Service')).toBe(GENERIC_CUSTOM_SERVICE_PRESET);
    expect(suggestPresetForCategory('Other')).toBe(GENERIC_CUSTOM_SERVICE_PRESET);
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
