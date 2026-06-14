/**
 * Tests for the Price-Intent Runtime Guard.
 *
 * Pins the 4 spec cases the user filed against the Peter Pidochev
 * 2026-06-10 incident plus the detector vocabulary:
 *   1. price question + quote available → guard fires with "$X" + don't-ask
 *   2. price question + missing pricing input → guard asks ONE pricing question
 *   3. non-price question → guard does NOT fire (returns null)
 *   4. template/default prompt cannot override calculated quote rule
 *      (we verify the guard text explicitly carries the "this overrides
 *       template/strategy" sentence — the BASE HARD RULES side is
 *       covered by playbook-renderer.spec.ts independently)
 *
 * The pricing engine itself is tested in pricing-engine.spec.ts; here
 * we only test the price-intent layer (detector + builder).
 */

import { hydratePricing } from '../users/pricing-hydrate';
import { calculateQuote, computeQuoteAndIntent } from './pricing-engine';
import { detectPriceIntent, isPriceSeekingMessage, buildPriceIntentBlock } from './price-intent';
import { STRATEGY_PROMPTS } from '../ai/strategy-prompts';

const pricing = hydratePricing(null); // DEFAULT_CLEANING_PRICING

describe('detectPriceIntent', () => {
  it.each([
    ['price', 'Can you send me a price estimate for the job?'],
    ['price word alone', 'price?'],
    ['estimate', "what's your estimate?"],
    ['quote', 'i need a quote please'],
    ['cost', 'how much does it cost'],
    ['how much', 'how much for a 3 bed 2 bath?'],
    ['rate', 'do you have rates?'],
    ['fee', 'what are your fees?'],
    ['charge', 'what do you charge?'],
    ['budget', 'my budget is around $200'],
    ['pricing', 'what is your pricing'],
    ['quoting', 'are you quoting yet?'],
    ['punctuation tolerant', 'price.'],
  ])('detects price intent for "%s"', (_label, msg) => {
    expect(detectPriceIntent(msg)).toBe(true);
  });

  it.each([
    ['scheduling', 'when can you come?'],
    ['confirmation', 'sounds good thank you'],
    ['hours', 'what are your hours?'],
    ['empty', ''],
    ['whitespace only', '   '],
    ['nullish', null],
    ['the word "priceless" should not over-match', 'this service is priceless'],
  ])('does NOT detect price intent for "%s"', (_label, msg) => {
    expect(detectPriceIntent(msg as any)).toBe(false);
  });
});

describe('buildPriceIntentBlock', () => {
  it('1. price question + quote available → fires with calculated total + "do not ask first"', () => {
    const calculation = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: ['fridge', 'oven'],
    });
    const block = buildPriceIntentBlock({
      customerMessage: 'Can you send me a price estimate for the job?',
      calculation,
    })!;
    expect(block).toContain('The customer just asked about price.');
    expect(block).toContain('$299'); // 219 + 40 + 40
    // Explicit don't-ask-first instruction is the load-bearing part of the
    // guard — pin the exact wording so a careless edit can't soften it.
    expect(block).toMatch(/do not ask for scheduling/i);
    expect(block).toMatch(/lead this reply with the calculated quote/i);
  });

  it('2. price question + missing pricing inputs → asks ONE pricing question, not scheduling', () => {
    const calculation = calculateQuote({
      pricing,
      bedrooms: null,
      bathrooms: null,
      extras: [],
    });
    const block = buildPriceIntentBlock({
      customerMessage: 'how much?',
      calculation,
    })!;
    expect(block).toContain('Pricing has NOT been calculated');
    expect(block).toContain('bedrooms');
    expect(block).toMatch(/ask one specific question/i);
    expect(block).toMatch(/do not ask about scheduling/i);
  });

  it('3. non-price question → guard returns null (no override)', () => {
    const calculation = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    expect(
      buildPriceIntentBlock({
        customerMessage: 'when can you come this week?',
        calculation,
      }),
    ).toBeNull();
  });

  it('4. carries the "override template / strategy" instruction so default prompts cannot soften it', () => {
    // The user's customized "First Reply" template uses conditional
    // language ("give a price range IF you have enough info"). The guard
    // has to spell out that it wins over that softer language.
    const calculation = calculateQuote({
      pricing,
      serviceType: 'regular',
      bedrooms: 5,
      bathrooms: 4,
      extras: [],
    });
    const block = buildPriceIntentBlock({
      customerMessage: 'can you send me a price estimate?',
      calculation,
    })!;
    expect(block).toMatch(/overrides any softer.*PRIMARY INSTRUCTION or template/i);
    expect(block).toContain('$269'); // 5BR/4BA regular default
  });

  it('returns null when there is no calculation result at all (engine disabled)', () => {
    expect(
      buildPriceIntentBlock({
        customerMessage: 'how much?',
        calculation: null,
      }),
    ).toBeNull();
  });

  it('returns null when no customer message is provided', () => {
    const calculation = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    expect(buildPriceIntentBlock({ customerMessage: null, calculation })).toBeNull();
  });

  it('partial: extras known + base unknown → surfaces add-on prices and asks for home size, not scheduling', () => {
    // Customer asks "how much for fridge cleaning?" before disclosing
    // home size. We know fridge=$40 from the table; we can SHOW that
    // and ask for bed/bath. We must NOT slip to scheduling.
    const calculation = calculateQuote({
      pricing,
      bedrooms: null,
      bathrooms: null,
      extras: ['fridge'],
    });
    const block = buildPriceIntentBlock({
      customerMessage: 'how much extra for fridge cleaning?',
      calculation,
    })!;
    expect(block).toContain('Inside Fridge: +$40');
    expect(block).toContain('bedrooms');
    // The block IS allowed to mention scheduling in the negative
    // ("do not ask about scheduling") — what matters is that the
    // directive forbids it, not the word's absence.
    expect(block).toMatch(/(do not ask about scheduling|not.*scheduling.*until)/i);
  });
});

describe('computeQuoteAndIntent (facade)', () => {
  // Pin the cross-block contract: the SAME computation produces BOTH the
  // CALCULATED QUOTE reference block (always emitted when there is
  // something to say) AND the PRICE INTENT ENFORCEMENT block (only
  // emitted when the customer just asked about price).

  it('Peter Pidochev case — 5BR/4BA standard + baseboards + "send me a price estimate" → both blocks fire with $284', () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: {
        'Bedrooms': '5',
        'Bathrooms': '4',
        'Cleaning type': 'Standard cleaning',
      },
      // Note: "baseboard" matches via the SYNONYMS map in addon-extractor.
      customerMessage: 'Can you send me a price estimate for the job? Also, baseboards please.',
    });
    expect(out.quoteBlock).toBeTruthy();
    expect(out.quoteBlock).toContain('Calculated total: $284'); // 269 + 15 baseboard
    expect(out.priceIntentBlock).toBeTruthy();
    expect(out.priceIntentBlock).toContain('$284');
    expect(out.priceIntentBlock).toMatch(/lead this reply with the calculated quote/i);
  });

  it('non-price customer message → CALCULATED QUOTE fires but PRICE INTENT does not', () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'when can you come?',
    });
    expect(out.quoteBlock).toBeTruthy();
    expect(out.priceIntentBlock).toBeNull();
  });

  it('price question + no platform facts → PRICE INTENT asks for the missing piece, not for time', () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: {},
      customerMessage: 'how much?',
    });
    expect(out.priceIntentBlock).toBeTruthy();
    expect(out.priceIntentBlock).toMatch(/missing inputs/i);
    expect(out.priceIntentBlock).toMatch(/do not ask about scheduling/i);
  });
});

describe('isPriceSeekingMessage (spec-spelling alias)', () => {
  it('is the same function as detectPriceIntent (identity check)', () => {
    expect(isPriceSeekingMessage).toBe(detectPriceIntent);
  });

  it('agrees with detectPriceIntent on the documented vocabulary', () => {
    expect(isPriceSeekingMessage('Can you send me a price estimate?')).toBe(true);
    expect(isPriceSeekingMessage('how much?')).toBe(true);
    expect(isPriceSeekingMessage('when can you come?')).toBe(false);
  });
});

describe('strategy alignment — guard fires regardless of which strategy prompt is PRIMARY', () => {
  // Spec test #6: strategy=price + price ask → guard aligns with strategy.
  //   The PRICE_ANCHOR strategy says "lead with a price range"; the guard
  //   says the same thing with a deterministic number. The two never
  //   conflict — the guard tightens the strategy, doesn't fight it.
  it('#6: strategy=price + customer asks price → guard fires AND strategy prompt also says "lead with a price range"', () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'Can you send me a price estimate?',
    });
    expect(out.priceIntentBlock).toBeTruthy();
    expect(out.priceIntentBlock).toMatch(/lead this reply with the calculated quote/i);
    // The strategy prompt the goal-resolver would have selected for this
    // account also says to lead with a price range. The guard is a
    // stricter, deterministic version of the same intent.
    expect(STRATEGY_PROMPTS.price.toLowerCase()).toMatch(/lead with a price range/);
  });

  // Spec test #7: strategy=qualify is the ONE strategy that normally
  // refuses to quote (it's the info-gathering ladder). But when the
  // customer EXPLICITLY asks about price AND we have a calculated
  // total, the runtime guard wins — the customer's direct ask beats
  // the strategy's general policy of "never quote".
  it("#7: strategy=qualify + customer asks price → guard STILL fires even though the strategy itself never quotes", () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'What is your estimate for this job?',
    });
    expect(out.priceIntentBlock).toBeTruthy();
    expect(out.priceIntentBlock).toContain('$219'); // 3/2 deep = 219
    expect(out.priceIntentBlock).toMatch(/lead this reply with the calculated quote/i);
    // Document the conflict the guard explicitly resolves: qualify
    // strategy's hardcoded "Quote even if the customer EXPLICITLY asks
    // the price — Qualify never quotes" rule. The runtime guard
    // overrides this for THIS reply because the customer is asking AND
    // the system has the number.
    expect(STRATEGY_PROMPTS.qualify).toMatch(/Quote even if the customer EXPLICITLY asks/i);
  });

  it("non-price message under any strategy → guard returns null (strategy continues to drive the reply)", () => {
    const out = computeQuoteAndIntent({
      pricing,
      leadDetails: { 'Bedrooms': '3', 'Bathrooms': '2', 'Cleaning type': 'Deep Clean' },
      customerMessage: 'Do you bring your own supplies?',
    });
    // Even though we have a fully-priceable lead, the customer's question
    // isn't about price — guard stays out of it.
    expect(out.priceIntentBlock).toBeNull();
  });
});

describe('wording compliance — guard text includes spec phrasing', () => {
  it("ready-quote branch includes 'You may ask one follow-up question AFTER the quote'", () => {
    // The spec calls out this exact affordance: model is free to ask
    // ONE follow-up question after quoting (e.g. "Would you like to
    // schedule a time?"). Pin the wording so a later refactor can't
    // silently remove it and turn the guard into a hard one-line cap.
    const calculation = calculateQuote({
      pricing,
      serviceType: 'deep',
      bedrooms: 3,
      bathrooms: 2,
      extras: [],
    });
    const block = buildPriceIntentBlock({
      customerMessage: 'how much for a 3 bed 2 bath deep clean?',
      calculation,
    })!;
    expect(block).toMatch(/you may ask one follow-up question after the quote/i);
  });
});
