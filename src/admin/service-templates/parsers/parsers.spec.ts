/**
 * Unit tests for the deterministic template parsers.
 *
 * Covers spec cases:
 *   #8  Customer Answers generated safely
 *   #9  Pricing parser detects pricing model
 *   #10 Service Options parser preserves labels
 *
 * Pure-function tests — no mocks, no DI, no Prisma. Each parser is a
 * standalone function whose contract is fixed by these expectations.
 */

import {
  classifyGroupType,
  parseServiceOptions,
  toKey,
} from './service-options-parser';
import { parsePricing } from './pricing-parser';
import { generateCustomerAnswers } from './customer-answers-generator';

describe('parseServiceOptions', () => {
  it('preserves original labels verbatim', () => {
    const input = `
      Which types of stains do you clean?
      - Pet stains
      - Food stains
      - Drink stains
    `;
    const out = parseServiceOptions(input);
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0].label).toBe('Which types of stains do you clean?');
    expect(out.groups[0].options.map((o) => o.label)).toEqual([
      'Pet stains',
      'Food stains',
      'Drink stains',
    ]);
  });

  it('generates stable snake_case keys without losing the label', () => {
    const out = parseServiceOptions(`
      Which cleaning method do customers want?
      - Steam cleaning
      - Dry cleaning
    `);
    expect(out.groups[0].key).toBe('which_cleaning_method_do_customers_want');
    expect(out.groups[0].options[0].key).toBe('steam_cleaning');
    expect(out.groups[0].options[1].key).toBe('dry_cleaning');
  });

  it('separates multiple groups by blank line', () => {
    const out = parseServiceOptions(`
      Which types of houses do you clean?
      - Houses with pets
      - Houses without pets

      How many rooms?
      - 1 room
      - 2 rooms
    `);
    expect(out.groups).toHaveLength(2);
    expect(out.groups[0].label).toBe('Which types of houses do you clean?');
    expect(out.groups[1].label).toBe('How many rooms?');
  });

  it('infers single_select for "How many ..." questions', () => {
    expect(classifyGroupType('How many rooms?')).toBe('single_select');
    expect(classifyGroupType('Which cleaning method do customers want?')).toBe('single_select');
    expect(classifyGroupType('Which one do you prefer?')).toBe('single_select');
  });

  it('defaults to multi_select for "Which types of ..." questions', () => {
    expect(classifyGroupType('Which types of stains do you clean?')).toBe('multi_select');
    expect(classifyGroupType('Which add-ons do you offer?')).toBe('multi_select');
  });

  it('returns empty groups for empty or invalid input', () => {
    expect(parseServiceOptions('').groups).toHaveLength(0);
    expect(parseServiceOptions(null).groups).toHaveLength(0);
    expect(parseServiceOptions(undefined).groups).toHaveLength(0);
  });

  it('deduplicates option keys within a single group', () => {
    const out = parseServiceOptions(`
      Pick one:
      - Same option
      - Same option
      - Same option
    `);
    const keys = out.groups[0].options.map((o) => o.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['same_option', 'same_option_2', 'same_option_3']);
  });

  it('toKey caps at 48 chars and falls back to "group" on empty', () => {
    expect(toKey('a'.repeat(200), 'group')).toHaveLength(48);
    expect(toKey('!!!', 'group')).toBe('group');
    expect(toKey('!!!', 'option')).toBe('option');
  });
});

describe('parsePricing', () => {
  it('detects room_quantity from "N rooms" rows', () => {
    const out = parsePricing(`
      1 room Avg. $79
      2 rooms Avg. $103
      3 rooms Avg. $132
    `);
    expect(out.pricingModel).toBe('room_quantity');
    expect(out.basePrices).toHaveLength(3);
    expect(out.basePrices[0]).toMatchObject({
      quantity: 1,
      price: 79,
      source: 'thumbtack_average',
    });
    expect(out.basePrices[2].price).toBe(132);
  });

  it('detects item_quantity from "Sofa $X" style rows', () => {
    const out = parsePricing(`
      Sofa $96
      Chair $44
      Loveseat $76
    `);
    expect(out.pricingModel).toBe('item_quantity');
    expect(out.basePrices.map((p) => p.price)).toEqual([96, 44, 76]);
    expect(out.basePrices[0].source).toBe('admin_input');
  });

  it('detects hourly model + extracts labor rate + minimum', () => {
    const out = parsePricing(`$100/hour, $100 minimum`);
    expect(out.pricingModel).toBe('hourly');
    expect(out.laborRate).toBe(100);
    expect(out.minimumCharge).toBe(100);
    expect(out.quoteRequired).toBe(true);
  });

  it('detects flat_rate from single "Service call $X" line', () => {
    const out = parsePricing(`Service call $120`);
    expect(out.pricingModel).toBe('flat_rate');
    expect(out.minimumCharge).toBe(120);
  });

  it('falls back to custom + quoteRequired on unrecognized input', () => {
    const out = parsePricing(`
      Pricing varies.
      Call for quote.
    `);
    expect(out.pricingModel).toBe('custom');
    expect(out.quoteRequired).toBe(true);
  });

  it('parses add-ons; missing prices become quoteManually=true', () => {
    const out = parsePricing(`
      1 room $79

      Add-ons:
      Cleaning 1 flight of stairs
      Cleaning stains $25
    `);
    expect(out.addOns).toHaveLength(2);
    expect(out.addOns[0]).toMatchObject({
      label: 'Cleaning 1 flight of stairs',
      price: 0,
      source: 'missing',
      quoteManually: true,
    });
    expect(out.addOns[1]).toMatchObject({
      label: 'Cleaning stains',
      price: 25,
      quoteManually: false,
    });
  });

  it('returns custom pricing for empty input', () => {
    const out = parsePricing('');
    expect(out.pricingModel).toBe('custom');
    expect(out.basePrices).toHaveLength(0);
    expect(out.addOns).toHaveLength(0);
    expect(out.quoteRequired).toBe(true);
  });
});

describe('generateCustomerAnswers', () => {
  it('produces a pets answer when service options mention pets', () => {
    const options = {
      groups: [
        {
          key: 'pets',
          label: 'Pets at home?',
          type: 'single_select' as const,
          options: [
            { key: 'yes', label: 'Yes - pets' },
            { key: 'no', label: 'No pets' },
          ],
        },
      ],
    };
    const pricing = {
      pricingModel: 'room_quantity' as const,
      currency: 'USD',
      basePrices: [],
      addOns: [],
    };
    const out = generateCustomerAnswers(options, pricing);
    const qs = out.entries.map((e) => e.question);
    expect(qs).toContain('Do you clean homes with pets?');
  });

  it('produces a pricing answer when pricing data exists', () => {
    const options = { groups: [] };
    const pricing = {
      pricingModel: 'room_quantity' as const,
      currency: 'USD',
      basePrices: [{ quantity: 1, label: '1 room', price: 79, source: 'thumbtack_average' as const }],
      addOns: [],
    };
    const out = generateCustomerAnswers(options, pricing);
    const qs = out.entries.map((e) => e.question);
    expect(qs).toContain('How is pricing calculated?');
  });

  it('never invents guarantees or unsupported services', () => {
    const options = { groups: [] };
    const pricing = {
      pricingModel: 'custom' as const,
      currency: 'USD',
      basePrices: [],
      addOns: [],
    };
    const out = generateCustomerAnswers(options, pricing);
    for (const e of out.entries) {
      expect(e.answer.toLowerCase()).not.toMatch(/guarantee/);
      expect(e.answer.toLowerCase()).not.toMatch(/we do not/);
      expect(e.answer.toLowerCase()).not.toMatch(/unsupported/);
    }
  });

  it('always includes a scheduling answer when there is anything to say', () => {
    const options = {
      groups: [
        {
          key: 'method',
          label: 'Which method?',
          type: 'single_select' as const,
          options: [{ key: 'steam', label: 'Steam' }],
        },
      ],
    };
    const pricing = {
      pricingModel: 'custom' as const,
      currency: 'USD',
      basePrices: [],
      addOns: [],
    };
    const out = generateCustomerAnswers(options, pricing);
    const qs = out.entries.map((e) => e.question);
    expect(qs).toContain('How soon can the service be scheduled?');
  });

  it('returns empty entries for empty input', () => {
    const out = generateCustomerAnswers(
      { groups: [] },
      { pricingModel: 'custom', currency: 'USD', basePrices: [], addOns: [] },
    );
    expect(out.entries).toEqual([]);
  });
});
