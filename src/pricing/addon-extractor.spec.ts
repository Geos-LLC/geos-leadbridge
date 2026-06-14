/**
 * Tests for the deterministic add-on extractor.
 *
 * Pins the synonym set + ambiguity surface used by the pricing engine.
 * Cases pinned to the P0 spec:
 *   1. "fridge" → fridge
 *   2. "refrigerator" → fridge (synonym)
 *   3. "inside fridge" → fridge (phrase synonym)
 *   4. "oven" → oven
 *   5. Multiple mentions in one message → multiple keys
 *   6. Platform leadDetails only (no message) → extracted from Q&A
 *   7. Message only (no leadDetails) → extracted from message
 *   8. Duplicate mentions are deduped
 *
 * Plus:
 *   - Ambiguous "appliances" without a specific match → `ambiguous`
 *   - Add-on the tenant has NOT configured is not returned (e.g. patio)
 *   - Custom tenant-added extras (not in default synonyms) match by their key/label
 */
import { hydratePricing } from '../users/pricing-hydrate';
import { extractAddons } from './addon-extractor';

const pricing = hydratePricing(null); // defaults include all 10 extras

describe('extractAddons — synonym map', () => {
  it('1. fridge → fridge', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'Can you also clean the fridge?',
    });
    expect(out.matched).toEqual(['fridge']);
    expect(out.ambiguous).toEqual([]);
  });

  it('2. refrigerator → fridge', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'I would also like the refrigerator cleaned.',
    });
    expect(out.matched).toEqual(['fridge']);
  });

  it('3. inside fridge → fridge', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'Need cleaning for inside fridge please.',
    });
    expect(out.matched).toEqual(['fridge']);
  });

  it('4. oven → oven', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'Also the oven — inside especially.',
    });
    expect(out.matched).toContain('oven');
  });

  it('5. multiple distinct mentions in one message return all keys', () => {
    const out = extractAddons({
      pricing,
      customerMessage:
        'Please clean inside the fridge and the oven, and also windows.',
    });
    expect(out.matched).toEqual(expect.arrayContaining(['fridge', 'oven', 'windows']));
    expect(out.matched.length).toBe(3);
  });

  it('6. platform leadDetails only (no message) → extracted', () => {
    const out = extractAddons({
      pricing,
      leadDetails: {
        'Add-ons': 'Inside Fridge, Inside Oven',
      },
    });
    expect(out.matched).toEqual(expect.arrayContaining(['fridge', 'oven']));
  });

  it('7. message only, no leadDetails → extracted from message', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'baseboards and blinds please',
    });
    expect(out.matched).toEqual(expect.arrayContaining(['baseboard', 'blinds']));
  });

  it('8. duplicate mentions are deduped', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'fridge fridge refrigerator inside the fridge',
      conversationHistory: [
        { role: 'customer', content: 'plus the fridge' },
      ],
    });
    expect(out.matched.filter(k => k === 'fridge').length).toBe(1);
  });
});

describe('extractAddons — ambiguous mentions', () => {
  it('"appliances" alone surfaces as ambiguous (no auto-add)', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'Can you clean the appliances?',
    });
    expect(out.matched).toEqual([]);
    expect(out.ambiguous).toEqual(['appliances']);
  });

  it('"appliances" together with a specific match → match wins, no ambiguous', () => {
    // When customer is specific elsewhere ("...the oven and other appliances")
    // we already have a concrete add-on; no need to ask.
    const out = extractAddons({
      pricing,
      customerMessage: 'Please clean the oven and other appliances.',
    });
    expect(out.matched).toEqual(['oven']);
    expect(out.ambiguous).toEqual([]);
  });
});

describe('extractAddons — pricing config gates the output', () => {
  it('does not return a key the tenant has not configured', () => {
    const noFridge = hydratePricing({
      extras: [
        { key: 'oven', label: 'Inside Oven', price: 40 },
      ],
    });
    const out = extractAddons({
      pricing: noFridge,
      customerMessage: 'fridge and oven',
    });
    // Only oven is offered → fridge mention dropped.
    expect(out.matched).toEqual(['oven']);
  });

  it('matches a tenant-custom extra by its key (not in the SYNONYMS map)', () => {
    const customExtras = hydratePricing({
      extras: [
        { key: 'porch', label: 'Porch Cleaning', price: 25 },
      ],
    });
    const out = extractAddons({
      pricing: customExtras,
      customerMessage: 'and the porch please',
    });
    expect(out.matched).toEqual(['porch']);
  });

  it('matches a tenant-custom extra by its label when key is not a real word', () => {
    const customExtras = hydratePricing({
      extras: [
        { key: 'pck_a', label: 'Range Hood', price: 30 },
      ],
    });
    const out = extractAddons({
      pricing: customExtras,
      customerMessage: 'And could you clean the range hood too?',
    });
    expect(out.matched).toEqual(['pck_a']);
  });

  it('skips tenant-custom extras configured at price 0', () => {
    const zeroPriced = hydratePricing({
      extras: [
        { key: 'porch', label: 'Porch Cleaning', price: 0 },
      ],
    });
    const out = extractAddons({
      pricing: zeroPriced,
      customerMessage: 'and the porch please',
    });
    expect(out.matched).toEqual([]);
  });
});

describe('extractAddons — corpus assembly', () => {
  it('scans customer messages in conversation history (not pro messages)', () => {
    const out = extractAddons({
      pricing,
      conversationHistory: [
        { role: 'pro', content: 'We have ovens listed' }, // ignored
        { role: 'customer', content: 'Yes please clean the oven' },
      ],
    });
    expect(out.matched).toEqual(['oven']);
  });

  it('scans additional_info (Yelp) free-text field', () => {
    const out = extractAddons({
      pricing,
      additionalInfo: 'Customer also mentioned wanting laundry done.',
    });
    expect(out.matched).toEqual(['laundry']);
  });

  it('does not match inside an unrelated word (e.g. "blindspot")', () => {
    const out = extractAddons({
      pricing,
      customerMessage: 'I have a blindspot about pricing — what does it run?',
    });
    expect(out.matched).toEqual([]);
  });

  it('returns empty when there is no corpus at all', () => {
    const out = extractAddons({ pricing });
    expect(out.matched).toEqual([]);
    expect(out.ambiguous).toEqual([]);
  });
});
