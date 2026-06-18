/**
 * Customer Answers (formerly FAQ) generator — deterministic.
 *
 * Given the parsed Service Options + Pricing, emit a small bank of
 * safe starter Q/A entries the AI can use as a base. Every entry is
 * either:
 *   - generic enough to be true for any business in the category, OR
 *   - explicitly hedged ("may", "depends on", "we can usually") so the
 *     AI never makes a guarantee.
 *
 * We deliberately avoid:
 *   - insurance / license claims
 *   - service-area / response-time promises
 *   - guaranteed stain removal / damage-free service
 *   - payment-method specifics
 *
 * The admin can always edit the generated set before publishing.
 *
 * Pure — no I/O, no exceptions, no LLM. Same input shape always
 * produces the same output.
 */

import {
  AdminPricingJson,
  CustomerAnswerEntry,
  CustomerAnswersJson,
  ServiceOptionsJson,
} from '../admin-service-templates.types';

type Signal =
  | 'pets'
  | 'smokers'
  | 'stains'
  | 'stairs'
  | 'supplies'
  | 'rooms'
  | 'items'
  | 'hourly'
  | 'method'
  | 'mattress'
  | 'house_apartment'
  | 'property_types'
  | 'addons_present';

function collectSignals(
  options: ServiceOptionsJson,
  pricing: AdminPricingJson,
): Set<Signal> {
  const signals = new Set<Signal>();

  // Join everything to one big lowercase haystack so we don't repeat
  // case-insensitive checks per option.
  const haystackLines: string[] = [];
  for (const group of options.groups) {
    haystackLines.push(group.label);
    for (const opt of group.options) haystackLines.push(opt.label);
  }
  for (const row of pricing.basePrices) haystackLines.push(row.label);
  for (const addon of pricing.addOns) haystackLines.push(addon.label);
  const text = haystackLines.join(' \n ').toLowerCase();

  if (/\bpets?\b/.test(text)) signals.add('pets');
  if (/\bsmokers?\b/.test(text)) signals.add('smokers');
  if (/\bstains?\b/.test(text)) signals.add('stains');
  if (/\bstairs?\b|\bflights?\b/.test(text)) signals.add('stairs');
  if (/\bsupplies?\b/.test(text)) signals.add('supplies');
  if (/\brooms?\b/.test(text)) signals.add('rooms');
  if (/\bsofa|chair|loveseat|sectional|mattress|curtain|ottoman|item\b/.test(text)) {
    signals.add('items');
  }
  if (pricing.pricingModel === 'hourly') signals.add('hourly');
  if (/\bsteam|dry|deep\b/.test(text)) signals.add('method');
  if (/\bmattress\b/.test(text)) signals.add('mattress');
  if (/\bhouse|apartment|condo\b/.test(text)) signals.add('house_apartment');
  if (/\bone-story\b|\btwo-story\b|\bmulti-unit\b|\bapartment\b|\bcondo\b/.test(text)) {
    signals.add('property_types');
  }
  if (pricing.addOns.length > 0) signals.add('addons_present');

  return signals;
}

/**
 * Small dictionary of safe Q/A entries keyed by triggering signal. We
 * iterate the dictionary in insertion order so the resulting answer
 * list reads in a logical sequence (overview → method → pricing →
 * logistics).
 */
const DICT: Array<{ signal: Signal; entry: CustomerAnswerEntry }> = [
  {
    signal: 'pets',
    entry: {
      question: 'Do you clean homes with pets?',
      answer:
        'Yes, we can service homes with pets. Additional pricing or steps may apply based on the situation.',
    },
  },
  {
    signal: 'smokers',
    entry: {
      question: 'Do you clean homes with smokers?',
      answer:
        'Yes, we can service homes with smokers. Additional pricing or steps may apply based on the situation.',
    },
  },
  {
    signal: 'stains',
    entry: {
      question: 'Can you clean stains?',
      answer:
        'We can usually help with common stains, but some may require inspection before we confirm what is possible.',
    },
  },
  {
    signal: 'stairs',
    entry: {
      question: 'Do you clean homes with stairs?',
      answer:
        'Yes, we can clean homes with stairs. Pricing may depend on how many flights are involved.',
    },
  },
  {
    signal: 'property_types',
    entry: {
      question: 'What types of properties do you service?',
      answer:
        'We service a range of residential properties including apartments, condos, single-story and multi-story houses. Final scope is confirmed when scheduling.',
    },
  },
  {
    signal: 'method',
    entry: {
      question: 'Which cleaning method do you use?',
      answer:
        'We can discuss the recommended method based on the materials and conditions of the job.',
    },
  },
  {
    signal: 'mattress',
    entry: {
      question: 'Do you clean mattresses?',
      answer:
        'Yes, mattress cleaning is available. Pricing depends on size and condition.',
    },
  },
  {
    signal: 'house_apartment',
    entry: {
      question: 'Do you service both houses and apartments?',
      answer:
        'We service a range of residential properties. Final scope is confirmed when scheduling.',
    },
  },
  {
    signal: 'supplies',
    entry: {
      question: 'Are supplies included?',
      answer: 'Standard supplies are included unless otherwise noted for your job.',
    },
  },
  {
    signal: 'rooms',
    entry: {
      question: 'How is pricing calculated?',
      answer:
        'Pricing is based on the selected service details such as room count and any add-ons.',
    },
  },
  {
    signal: 'items',
    entry: {
      question: 'How is pricing calculated?',
      answer:
        'Pricing is based on the items being serviced and any add-ons selected.',
    },
  },
  {
    signal: 'hourly',
    entry: {
      question: 'How is pricing calculated?',
      answer:
        'This service is priced hourly, with a minimum based on the job. Final pricing depends on the scope and time needed.',
    },
  },
  {
    signal: 'addons_present',
    entry: {
      question: 'Do you offer add-ons?',
      answer:
        'Yes, we offer additional services that can be added to your job. Pricing depends on the specific add-on.',
    },
  },
];

/**
 * Always-present scheduling answer — every service should be able to
 * answer "how soon can you come". Deferred-on-availability wording so
 * we never imply same-day for tenants that don't offer it.
 */
const SCHEDULING_ENTRY: CustomerAnswerEntry = {
  question: 'How soon can the service be scheduled?',
  answer:
    'Availability depends on the date and time you need. Share your preferred window and we will confirm.',
};

/**
 * Main entry point. Pure.
 */
export function generateCustomerAnswers(
  options: ServiceOptionsJson,
  pricing: AdminPricingJson,
): CustomerAnswersJson {
  const signals = collectSignals(options, pricing);
  const seen = new Set<string>();
  const entries: CustomerAnswerEntry[] = [];

  for (const { signal, entry } of DICT) {
    if (!signals.has(signal)) continue;
    if (seen.has(entry.question)) continue;
    seen.add(entry.question);
    entries.push(entry);
  }

  // Always include scheduling if we have anything else — keeps the
  // template useful even when the options/pricing input was sparse.
  if (entries.length > 0 || signals.size > 0) {
    if (!seen.has(SCHEDULING_ENTRY.question)) {
      entries.push(SCHEDULING_ENTRY);
    }
  }

  return { entries };
}
