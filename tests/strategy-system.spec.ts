/**
 * Strategy System — Unit Tests
 *
 * Tests the unified strategy system that powers both Lead Activity
 * preview buttons and follow-up generation.
 *
 * Covers:
 * - STRATEGY_PROMPTS: all 5 strategies defined with required sections
 * - OBJECTIVE_FLAVORS: all step objectives have flavor text
 * - suggestStrategy(): scoring logic for all thread states
 * - suggestStrategy(): manual override respected
 * - suggestStrategy(): enabled strategies filtering
 * - buildPricingPrompt(): pricing JSON → AI-readable prompt
 * - Follow-up generator: strategy selection flow
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { STRATEGY_PROMPTS, OBJECTIVE_FLAVORS, STRATEGY_KEYS } from '../src/ai/strategy-prompts';

// ============================================================
// Strategy Prompts
// ============================================================

describe('STRATEGY_PROMPTS', () => {
  it('defines all 6 strategies (incl. booking added 2026-06-16)', () => {
    expect(Object.keys(STRATEGY_PROMPTS)).toEqual(
      expect.arrayContaining(['hybrid', 'price', 'qualify', 'convert', 'phone', 'booking']),
    );
    expect(Object.keys(STRATEGY_PROMPTS).length).toBe(6);
  });

  it('each strategy has a non-empty prompt', () => {
    for (const key of STRATEGY_KEYS) {
      expect(STRATEGY_PROMPTS[key].length).toBeGreaterThan(50);
    }
  });

  it('hybrid prompt asks one question and answers price when asked', () => {
    const p = STRATEGY_PROMPTS.hybrid;
    // Hybrid acknowledges + moves the lead forward with EXACTLY ONE
    // question, and answers from the PRICING TABLE only when the
    // customer explicitly asks about price.
    expect(p).toContain('ONE question');
    expect(p).toMatch(/explicitly asks about price/i);
    expect(p).toContain('PRICING TABLE');
  });

  it('price prompt forbids questions', () => {
    const p = STRATEGY_PROMPTS.price;
    expect(p).toContain('DO NOT');
    expect(p).toContain('Ask questions');
  });

  it('qualify prompt forbids volunteering pricing', () => {
    const p = STRATEGY_PROMPTS.qualify;
    expect(p).toContain('NEVER');
    expect(p).toContain('Volunteer a price');
  });

  it('convert prompt asks customer for their preferred time', () => {
    const p = STRATEGY_PROMPTS.convert;
    expect(p).toMatch(/when the customer.+want|asking the customer when/i);
  });

  it('phone (Call Handoff) prompt has multi-step flow', () => {
    const p = STRATEGY_PROMPTS.phone;
    expect(p).toContain('Step 1');
    expect(p).toContain('Step 2');
    expect(p).toContain('hesitation');
  });

  it('phone prompt is labelled Call Handoff while keeping the phone key', () => {
    const p = STRATEGY_PROMPTS.phone;
    expect(p).toMatch(/CALL HANDOFF/i);
  });

  it('booking prompt asks for preferred service date/time', () => {
    const p = STRATEGY_PROMPTS.booking;
    expect(p).toMatch(/preferred service date/i);
  });

  it('booking prompt uses AVAILABILITY block when slots are present', () => {
    const p = STRATEGY_PROMPTS.booking;
    expect(p).toContain('AVAILABILITY');
    expect(p).toMatch(/two of them|two|EXACTLY TWO/i);
  });

  it('booking prompt answers price first when customer asks price first', () => {
    const p = STRATEGY_PROMPTS.booking;
    expect(p).toMatch(/asks about price BEFORE/i);
    expect(p).toMatch(/answer the price question first/i);
  });

  it('booking prompt hands off when customer asks for a call', () => {
    const p = STRATEGY_PROMPTS.booking;
    expect(p).toMatch(/asks for a phone call/i);
    expect(p).toMatch(/hand off/i);
  });

  it('booking prompt does NOT chain through every Qualify field', () => {
    const p = STRATEGY_PROMPTS.booking;
    expect(p).toMatch(/booking-critical/i);
    expect(p).toMatch(/random qualification questions/i);
  });
});

describe('OBJECTIVE_FLAVORS', () => {
  it('has all common step objectives', () => {
    const required = ['quick_check_in', 'value_add', 'soft_nudge', 're_engagement', 'last_chance', 'booking_reminder'];
    for (const key of required) {
      expect(OBJECTIVE_FLAVORS[key]).toBeDefined();
      expect(OBJECTIVE_FLAVORS[key].length).toBeGreaterThan(10);
    }
  });
});

describe('STRATEGY_KEYS', () => {
  it('matches STRATEGY_PROMPTS keys', () => {
    expect([...STRATEGY_KEYS]).toEqual(Object.keys(STRATEGY_PROMPTS));
  });
});

// ============================================================
// suggestStrategy() scoring logic
// ============================================================

// Replicate the scoring logic from conversation-context.service.ts
// for isolated testing without Prisma/DB dependencies
function scoreStrategies(ctx: {
  engagementLevel: string;
  customerIntent: string | null;
  priceDiscussed: boolean;
  missingFields: string[];
  stage: string;
  totalMessages: number;
}) {
  const scores: Record<string, number> = { hybrid: 0.5, price: 0.3, qualify: 0.3, convert: 0.2, phone: 0.15 };

  if (ctx.engagementLevel === 'hot') {
    scores.convert = 0.85;
    scores.hybrid = 0.5;
    scores.price = 0.4;
    scores.qualify = 0.25;
  } else if (ctx.engagementLevel === 'cold') {
    scores.price = 0.6;
    scores.hybrid = 0.45;
    scores.convert = 0.15;
    scores.qualify = 0.3;
  }

  if (ctx.customerIntent === 'price_shopping' && !ctx.priceDiscussed) {
    scores.price = Math.max(scores.price, 0.8);
    scores.hybrid = Math.max(scores.hybrid, 0.55);
  }

  if (ctx.missingFields.length >= 2) {
    scores.qualify = Math.max(scores.qualify, 0.75);
    scores.hybrid = Math.max(scores.hybrid, 0.5);
  } else if (ctx.missingFields.length === 1) {
    scores.qualify = Math.max(scores.qualify, 0.5);
  }

  if (ctx.stage === 'quoting' || ctx.priceDiscussed) {
    scores.convert = Math.max(scores.convert, 0.7);
    scores.price = Math.min(scores.price, 0.35);
  }

  if (ctx.engagementLevel === 'hot' && ctx.totalMessages >= 6) {
    scores.phone = Math.max(scores.phone, 0.65);
  }
  if (ctx.missingFields.length >= 3) {
    scores.phone = Math.max(scores.phone, 0.55);
  }

  const suggested = Object.entries(scores).reduce((best, [key, score]) =>
    score > best.score ? { key, score } : best,
    { key: 'hybrid', score: 0 },
  ).key;

  return { suggested, scores };
}

const baseCtx = {
  engagementLevel: 'warm',
  customerIntent: null,
  priceDiscussed: false,
  missingFields: [] as string[],
  stage: 'qualification',
  totalMessages: 3,
};

describe('suggestStrategy() scoring', () => {
  it('defaults to hybrid when no strong signals', () => {
    const { suggested } = scoreStrategies(baseCtx);
    expect(suggested).toBe('hybrid');
  });

  it('suggests convert for hot engagement', () => {
    const { suggested, scores } = scoreStrategies({ ...baseCtx, engagementLevel: 'hot' });
    expect(suggested).toBe('convert');
    expect(scores.convert).toBe(0.85);
  });

  it('suggests price for price_shopping intent without price discussed', () => {
    const { suggested, scores } = scoreStrategies({ ...baseCtx, customerIntent: 'price_shopping' });
    expect(suggested).toBe('price');
    expect(scores.price).toBe(0.8);
  });

  it('suggests qualify when 2+ missing fields', () => {
    const { suggested } = scoreStrategies({ ...baseCtx, missingFields: ['bedrooms', 'bathrooms'] });
    expect(suggested).toBe('qualify');
  });

  it('suggests convert when price already discussed', () => {
    const { suggested } = scoreStrategies({ ...baseCtx, priceDiscussed: true });
    expect(suggested).toBe('convert');
  });

  it('caps price score when price already discussed', () => {
    const { scores } = scoreStrategies({ ...baseCtx, priceDiscussed: true });
    expect(scores.price).toBeLessThanOrEqual(0.35);
  });

  it('suggests price for cold engagement', () => {
    const { suggested } = scoreStrategies({ ...baseCtx, engagementLevel: 'cold' });
    expect(suggested).toBe('price');
  });

  it('boosts phone for hot + long conversation', () => {
    const { scores } = scoreStrategies({ ...baseCtx, engagementLevel: 'hot', totalMessages: 8 });
    expect(scores.phone).toBeGreaterThanOrEqual(0.65);
  });

  it('boosts phone for 3+ missing fields (complex job)', () => {
    const { scores } = scoreStrategies({ ...baseCtx, missingFields: ['a', 'b', 'c'] });
    expect(scores.phone).toBeGreaterThanOrEqual(0.55);
  });

  it('all scores are between 0 and 1', () => {
    const testCases = [
      baseCtx,
      { ...baseCtx, engagementLevel: 'hot', totalMessages: 10 },
      { ...baseCtx, customerIntent: 'price_shopping' },
      { ...baseCtx, missingFields: ['a', 'b', 'c', 'd'] },
      { ...baseCtx, priceDiscussed: true, stage: 'quoting' },
    ];
    for (const ctx of testCases) {
      const { scores } = scoreStrategies(ctx);
      for (const [key, score] of Object.entries(scores)) {
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('returns scores for all 5 strategies', () => {
    const { scores } = scoreStrategies(baseCtx);
    expect(Object.keys(scores).sort()).toEqual(['convert', 'hybrid', 'phone', 'price', 'qualify']);
  });
});

// ============================================================
// buildPricingPrompt() logic
// ============================================================

function buildPricingPrompt(pricingJson: string | null): string | null {
  if (!pricingJson) return null;
  try {
    const p = JSON.parse(pricingJson);
    const parts: string[] = ['--- Your Pricing Guide (use these EXACT prices when quoting) ---'];

    const enabledTypes = (p.cleaningTypes || []).filter((t: any) => t.enabled);
    if (p.priceTable?.length > 0 && enabledTypes.length > 0) {
      parts.push('Base prices by property size:');
      for (const row of p.priceTable) {
        const prices = enabledTypes.map((t: any) => `${t.label}: $${row[t.key] || '?'}`).join(', ');
        parts.push(`  ${row.bed}BR/${row.bath}BA — ${prices}`);
      }
    }

    if (p.frequencyDiscounts?.length > 0) {
      const discounts = p.frequencyDiscounts
        .filter((fd: any) => fd.discount > 0)
        .map((fd: any) => `${fd.label}: ${fd.discount}% off`);
      if (discounts.length > 0) parts.push(`Recurring discounts: ${discounts.join(', ')}`);
    }

    if (p.extras?.length > 0) {
      const extrasList = p.extras.filter((e: any) => e.label && e.price > 0).map((e: any) => `${e.label}: +$${e.price}`);
      if (extrasList.length > 0) parts.push(`Add-ons available: ${extrasList.join(', ')}`);
    }

    if (p.petSurcharge > 0) parts.push(`Pet surcharge: +$${p.petSurcharge}`);

    if (p.recurringDiscount > 0) parts.push(`Recurring cleaning discount: ${p.recurringDiscount}% off for customers who book regular recurring service`);

    if (p.orderDiscounts?.length > 0) {
      const tiers = p.orderDiscounts
        .filter((od: any) => od.minAmount > 0 && od.discount > 0)
        .sort((a: any, b: any) => a.minAmount - b.minAmount)
        .map((od: any) => `orders over $${od.minAmount}: ${od.discount}% off`);
      if (tiers.length > 0) parts.push(`Order discounts: ${tiers.join(', ')}`);
    }

    parts.push('--- End Pricing Guide ---');
    return parts.join('\n');
  } catch {
    return null;
  }
}

describe('buildPricingPrompt()', () => {
  it('returns null for null input', () => {
    expect(buildPricingPrompt(null)).toBeNull();
  });

  it('returns null for invalid JSON', () => {
    expect(buildPricingPrompt('not-json')).toBeNull();
  });

  it('builds prompt with price table', () => {
    const pricing = {
      cleaningTypes: [{ key: 'regular', label: 'Regular', enabled: true }],
      priceTable: [{ bed: 2, bath: 2, regular: 139 }],
      extras: [],
      frequencyDiscounts: [],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('2BR/2BA');
    expect(result).toContain('Regular: $139');
  });

  it('skips disabled cleaning types', () => {
    const pricing = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: false },
      ],
      priceTable: [{ bed: 1, bath: 1, regular: 119, deep: 149 }],
      extras: [],
      frequencyDiscounts: [],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('Regular: $119');
    expect(result).not.toContain('Deep');
  });

  it('includes extras', () => {
    const pricing = {
      cleaningTypes: [{ key: 'regular', label: 'Regular', enabled: true }],
      priceTable: [{ bed: 1, bath: 1, regular: 100 }],
      extras: [{ key: 'fridge', label: 'Inside Fridge', price: 40 }],
      frequencyDiscounts: [],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('Inside Fridge: +$40');
  });

  it('includes frequency discounts', () => {
    const pricing = {
      cleaningTypes: [{ key: 'regular', label: 'Regular', enabled: true }],
      priceTable: [{ bed: 1, bath: 1, regular: 100 }],
      extras: [],
      frequencyDiscounts: [
        { key: 'weekly', label: 'Weekly', discount: 15 },
        { key: 'once', label: 'One Time', discount: 0 },
      ],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('Weekly: 15% off');
    expect(result).not.toContain('One Time');
  });

  it('includes pet surcharge', () => {
    const pricing = {
      cleaningTypes: [],
      priceTable: [],
      extras: [],
      frequencyDiscounts: [],
      petSurcharge: 20,
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('Pet surcharge: +$20');
  });

  it('includes recurring discount', () => {
    const pricing = {
      cleaningTypes: [],
      priceTable: [],
      extras: [],
      frequencyDiscounts: [],
      recurringDiscount: 10,
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('Recurring cleaning discount: 10%');
  });

  it('includes order amount discounts', () => {
    const pricing = {
      cleaningTypes: [],
      priceTable: [],
      extras: [],
      frequencyDiscounts: [],
      orderDiscounts: [
        { minAmount: 200, discount: 10 },
        { minAmount: 300, discount: 15 },
      ],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing));
    expect(result).toContain('orders over $200: 10% off');
    expect(result).toContain('orders over $300: 15% off');
  });

  it('builds complete prompt with all sections', () => {
    const pricing = {
      cleaningTypes: [
        { key: 'regular', label: 'Regular', enabled: true },
        { key: 'deep', label: 'Deep', enabled: true },
      ],
      priceTable: [
        { bed: 1, bath: 1, regular: 129, deep: 179 },
        { bed: 2, bath: 2, regular: 139, deep: 189 },
      ],
      extras: [
        { key: 'oven', label: 'Inside Oven', price: 40 },
        { key: 'fridge', label: 'Inside Fridge', price: 40 },
      ],
      frequencyDiscounts: [
        { key: 'weekly', label: 'Weekly', discount: 15 },
        { key: 'biweekly', label: 'Every 2 Weeks', discount: 10 },
      ],
      conditionSurcharges: [
        { key: 'fair', label: 'Fair', surcharge: 50 },
      ],
      petSurcharge: 20,
      recurringDiscount: 10,
      orderDiscounts: [{ minAmount: 200, discount: 10 }],
    };
    const result = buildPricingPrompt(JSON.stringify(pricing))!;
    expect(result).toContain('Pricing Guide');
    expect(result).toContain('1BR/1BA');
    expect(result).toContain('2BR/2BA');
    expect(result).toContain('Regular: $129');
    expect(result).toContain('Deep: $179');
    expect(result).toContain('Inside Oven: +$40');
    expect(result).toContain('Weekly: 15% off');
    expect(result).toContain('Pet surcharge: +$20');
    expect(result).toContain('Recurring cleaning discount: 10%');
    expect(result).toContain('orders over $200: 10% off');
    expect(result).toContain('End Pricing Guide');
  });
});

// ============================================================
// Follow-up generator: strategy selection
// ============================================================

describe('Follow-up generator strategy selection', () => {
  // Simulates the strategy selection logic from follow-up-generator.service.ts
  function selectStrategy(
    activeStrategy: string | null,
    suggestion: { suggested: string; scores: Record<string, number> } | null,
    enabledStrategies: string[] | null,
  ): string {
    if (activeStrategy && STRATEGY_PROMPTS[activeStrategy]) {
      return activeStrategy; // manual override wins
    }

    if (!suggestion) return 'hybrid';

    if (enabledStrategies && enabledStrategies.includes(suggestion.suggested)) {
      return suggestion.suggested;
    }

    if (enabledStrategies) {
      const bestEnabled = Object.entries(suggestion.scores)
        .filter(([key]) => enabledStrategies.includes(key))
        .sort(([, a], [, b]) => b - a)[0];
      if (bestEnabled) return bestEnabled[0];
    }

    return suggestion.suggested;
  }

  it('manual override wins over suggestion', () => {
    const result = selectStrategy('price', { suggested: 'convert', scores: { convert: 0.85, price: 0.3 } }, null);
    expect(result).toBe('price');
  });

  it('uses suggestion when no override', () => {
    const result = selectStrategy(null, { suggested: 'convert', scores: { convert: 0.85 } }, null);
    expect(result).toBe('convert');
  });

  it('respects enabled strategies filter', () => {
    const result = selectStrategy(null, { suggested: 'convert', scores: { convert: 0.85, hybrid: 0.5, price: 0.3 } }, ['hybrid', 'price']);
    expect(result).toBe('hybrid'); // convert disabled, falls back to highest enabled
  });

  it('falls back to hybrid when no suggestion', () => {
    const result = selectStrategy(null, null, null);
    expect(result).toBe('hybrid');
  });

  it('ignores invalid activeStrategy', () => {
    const result = selectStrategy('invalid_strategy', { suggested: 'price', scores: { price: 0.8 } }, null);
    expect(result).toBe('price');
  });

  it('falls back to best enabled when suggested is disabled', () => {
    const scores = { hybrid: 0.5, price: 0.8, qualify: 0.3, convert: 0.2, phone: 0.1 };
    const result = selectStrategy(null, { suggested: 'price', scores }, ['qualify', 'convert']);
    expect(result).toBe('qualify'); // price disabled, qualify is highest enabled
  });

  it('all strategies have valid prompts for selection', () => {
    for (const key of STRATEGY_KEYS) {
      expect(STRATEGY_PROMPTS[key]).toBeDefined();
      expect(typeof STRATEGY_PROMPTS[key]).toBe('string');
    }
  });
});

// ============================================================
// Yelp message sync deduplication
// ============================================================

describe('Yelp message sync dedup logic', () => {
  // Simulates the dedup check from leads.service.ts syncYelpMessagesToLocal
  function shouldSync(existingMessageIds: string[], incomingId: string): boolean {
    return !existingMessageIds.includes(incomingId);
  }

  it('syncs new message', () => {
    expect(shouldSync(['msg-1', 'msg-2'], 'msg-3')).toBe(true);
  });

  it('skips existing message', () => {
    expect(shouldSync(['msg-1', 'msg-2'], 'msg-1')).toBe(false);
  });

  it('syncs when no existing messages', () => {
    expect(shouldSync([], 'msg-1')).toBe(true);
  });
});

// ============================================================
// Yelp phone extraction
// ============================================================

describe('Yelp phone extraction from events', () => {
  function extractPhone(events: any[], leadPhone: string | null): string | null {
    if (leadPhone) return leadPhone;
    const phoneEvent = events.find((e: any) => e.event_type === 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT');
    return phoneEvent?.event_content?.phone_number || phoneEvent?.phone_number || null;
  }

  it('returns lead phone when already set', () => {
    expect(extractPhone([], '+15551234567')).toBe('+15551234567');
  });

  it('extracts phone from opt-in event content', () => {
    const events = [
      { event_type: 'TEXT', event_content: { text: 'Hello' } },
      { event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT', event_content: { phone_number: '+15559876543' } },
    ];
    expect(extractPhone(events, null)).toBe('+15559876543');
  });

  it('extracts phone from top-level field', () => {
    const events = [
      { event_type: 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT', phone_number: '+15551111111' },
    ];
    expect(extractPhone(events, null)).toBe('+15551111111');
  });

  it('returns null when no phone available', () => {
    const events = [
      { event_type: 'TEXT', event_content: { text: 'Hi' } },
    ];
    expect(extractPhone(events, null)).toBeNull();
  });
});

// ============================================================
// Timeline dedup (initial message injection)
// ============================================================

describe('Timeline initial message dedup', () => {
  function shouldInjectInitialMessage(
    leadMessage: string,
    timelineMessages: { direction: string; content: string }[],
  ): boolean {
    const firstMsgContent = leadMessage.trim();
    if (firstMsgContent.length === 0) return false;
    const firstMsgWords = firstMsgContent.substring(0, 80);
    return !timelineMessages.some(e =>
      e.direction === 'inbound' && e.content && (
        e.content.includes(firstMsgWords) || firstMsgContent.includes(e.content.trim().substring(0, 80))
      ),
    );
  }

  it('injects when no matching message in timeline', () => {
    const result = shouldInjectInitialMessage('Regular cleaning 2BR', [
      { direction: 'outbound', content: 'Thanks for reaching out' },
    ]);
    expect(result).toBe(true);
  });

  it('skips when exact match exists', () => {
    const result = shouldInjectInitialMessage('Regular cleaning 2BR', [
      { direction: 'inbound', content: 'Regular cleaning 2BR' },
    ]);
    expect(result).toBe(false);
  });

  it('skips when Yelp boilerplate version exists (overlap)', () => {
    const leadMsg = 'What kind of cleaning? Regular How many bedrooms? 2';
    const yelpMsg = 'Hi there, please respond. What kind of cleaning? Regular How many bedrooms? 2';
    const result = shouldInjectInitialMessage(leadMsg, [
      { direction: 'inbound', content: yelpMsg },
    ]);
    expect(result).toBe(false);
  });

  it('skips when lead message contains timeline message', () => {
    const leadMsg = 'What kind of cleaning? Regular cleaning How often? Just once How many bedrooms? 1';
    const timelineMsg = 'What kind of cleaning? Regular cleaning How often? Just once How many bedrooms? 1 bathroom';
    const result = shouldInjectInitialMessage(leadMsg, [
      { direction: 'inbound', content: timelineMsg },
    ]);
    expect(result).toBe(false);
  });

  it('returns false for empty lead message', () => {
    expect(shouldInjectInitialMessage('', [])).toBe(false);
    expect(shouldInjectInitialMessage('  ', [])).toBe(false);
  });
});
