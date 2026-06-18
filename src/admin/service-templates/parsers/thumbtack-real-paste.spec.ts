/**
 * Real-world Thumbtack paste fixtures.
 *
 * Locks in the parser behavior on the actual line-separated copy-paste
 * shape we get when an admin selects the Thumbtack admin pricing/options
 * UI and pastes the result. The clean shape from the canonical
 * spec (label + price inline, bulleted options) is covered by
 * parsers.spec.ts.
 *
 * If a future change breaks these fixtures, an admin will see garbled
 * JSON when generating from a live Thumbtack copy-paste.
 */

import { parsePricing } from './pricing-parser';
import { parseServiceOptions } from './service-options-parser';
import { generateCustomerAnswers } from './customer-answers-generator';

const FULL_PASTE = `1 room

Avg. $79

2 rooms

Avg. $103

3 rooms

Avg. $132

4 rooms

Avg. $163

5 rooms

Avg. $197

6 rooms

Avg. $235

Enter add-on prices
Tell customers what you charge extra for. Or check the box to let customers know it's included at no extra cost.


Flights of stairs
Cleaning 1 flight of stairs
Cleaning 2 flights of stairs
Cleaning 3 flights of stairs

Cleaning home with pet(s)

Cleaning home with smoker(s)

Cleaning stains (pet, food or drink)
 for prices and Which types of stains do you clean?

Pet stains

Food stains

Drink stains
Which types of houses do you clean?

Houses with regular smokers

Houses without regular smokers
How many flights of stairs do you clean?

Houses with no stairs

1 flight

2 flights

3 flights
Which types of houses do you clean?

Houses with pets

Houses without pets
Which types of customers do you work with?

Customers that want steam cleaning

Customers that want dry cleaning

Customers that don't have a preference

I'm flexible
Which types of properties do you clean?

Apartment / condo

One-story house

Two-story house

Multi-unit building
How many rooms do you clean?

1 room

2 rooms

3 rooms

4 rooms

5 rooms

6 rooms`;

describe('Thumbtack line-separated paste (real-world)', () => {
  describe('parsePricing', () => {
    it('pairs label + "Avg. $X" lines into 6 room_quantity base prices', () => {
      const out = parsePricing(FULL_PASTE);
      expect(out.pricingModel).toBe('room_quantity');
      expect(out.basePrices).toHaveLength(6);
      expect(out.basePrices.map((b) => b.price)).toEqual([79, 103, 132, 163, 197, 235]);
      expect(out.basePrices.map((b) => b.quantity)).toEqual([1, 2, 3, 4, 5, 6]);
      for (const b of out.basePrices) {
        expect(b.source).toBe('thumbtack_average');
      }
    });

    it('captures add-ons as quoteManually=true (no prices given in source)', () => {
      const out = parsePricing(FULL_PASTE);
      const labels = out.addOns.map((a) => a.label);
      // The exact set will include the priceless add-on labels from the
      // Thumbtack paste. Spot-check the high-value ones.
      expect(labels).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/cleaning 1 flight of stairs/i),
          expect.stringMatching(/cleaning home with pet/i),
          expect.stringMatching(/cleaning home with smoker/i),
        ]),
      );
      for (const a of out.addOns) {
        expect(a.quoteManually).toBe(true);
        expect(a.source).toBe('missing');
      }
    });

    it('stops at the first Service Options heading — does not bleed into base prices', () => {
      const out = parsePricing(FULL_PASTE);
      // The bottom half contains "1 room", "2 rooms" etc again as
      // options under "How many rooms do you clean?" — those must NOT
      // appear as additional priced base rows.
      expect(out.basePrices).toHaveLength(6);
    });
  });

  describe('parseServiceOptions', () => {
    it('parses 6 question groups from the bottom half', () => {
      const out = parseServiceOptions(FULL_PASTE);
      const headings = out.groups.map((g) => g.label);
      expect(headings).toEqual(
        expect.arrayContaining([
          'Which types of stains do you clean?',
          'Which types of houses do you clean?',
          'How many flights of stairs do you clean?',
          'Which types of customers do you work with?',
          'Which types of properties do you clean?',
          'How many rooms do you clean?',
        ]),
      );
    });

    it('captures stain options under their heading', () => {
      const out = parseServiceOptions(FULL_PASTE);
      const stains = out.groups.find((g) => /types of stains/i.test(g.label));
      expect(stains).toBeDefined();
      expect(stains!.options.map((o) => o.label)).toEqual([
        'Pet stains',
        'Food stains',
        'Drink stains',
      ]);
    });

    it('captures property type options under "Which types of properties..."', () => {
      const out = parseServiceOptions(FULL_PASTE);
      const props = out.groups.find((g) => /types of properties/i.test(g.label));
      expect(props).toBeDefined();
      expect(props!.options.map((o) => o.label)).toEqual([
        'Apartment / condo',
        'One-story house',
        'Two-story house',
        'Multi-unit building',
      ]);
    });

    it('classifies "How many ..." as single_select', () => {
      const out = parseServiceOptions(FULL_PASTE);
      const rooms = out.groups.find((g) => /how many rooms/i.test(g.label));
      expect(rooms?.type).toBe('single_select');
    });

    it('classifies "Which types of ..." as multi_select', () => {
      const out = parseServiceOptions(FULL_PASTE);
      const stains = out.groups.find((g) => /types of stains/i.test(g.label));
      expect(stains?.type).toBe('multi_select');
    });
  });

  describe('generateCustomerAnswers', () => {
    it('fires pets / smokers / stains / stairs / property_types signals', () => {
      const options = parseServiceOptions(FULL_PASTE);
      const pricing = parsePricing(FULL_PASTE);
      const answers = generateCustomerAnswers(options, pricing);
      const questions = answers.entries.map((e) => e.question);

      expect(questions).toEqual(
        expect.arrayContaining([
          'Do you clean homes with pets?',
          'Do you clean homes with smokers?',
          'Can you clean stains?',
          'Do you clean homes with stairs?',
          'What types of properties do you service?',
        ]),
      );
    });

    it('always includes the scheduling answer when any signal fired', () => {
      const options = parseServiceOptions(FULL_PASTE);
      const pricing = parsePricing(FULL_PASTE);
      const answers = generateCustomerAnswers(options, pricing);
      const questions = answers.entries.map((e) => e.question);
      expect(questions).toContain('How soon can the service be scheduled?');
    });

    it('emits a pricing answer mentioning rooms (room_quantity model)', () => {
      const options = parseServiceOptions(FULL_PASTE);
      const pricing = parsePricing(FULL_PASTE);
      const answers = generateCustomerAnswers(options, pricing);
      const pricingAnswer = answers.entries.find(
        (e) => e.question === 'How is pricing calculated?',
      );
      expect(pricingAnswer).toBeDefined();
      expect(pricingAnswer!.answer.toLowerCase()).toMatch(/room/);
    });
  });
});
