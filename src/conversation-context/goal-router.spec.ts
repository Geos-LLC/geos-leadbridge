/**
 * Tests for the pure Auto goal router.
 *
 * Pins the rewrite contract from the suggestStrategy audit:
 *   - Phone wins on explicit live-contact intent
 *   - Price wins on explicit pricing intent
 *   - Qualify is the broad default (covers vague, exploratory,
 *     ready-to-book-without-details, and ex-Convert hot signals)
 *   - The router NEVER emits hidden legacy goals (hybrid / convert) —
 *     those only survive at runtime when explicitly saved per-account
 *     and resolved through the non-auto branches of resolveActiveGoal.
 */

import { routeFromCustomerMessage } from './goal-router';

describe('routeFromCustomerMessage — Phone', () => {
  const phoneCases = [
    'Can someone call me?',
    'My number is 813-555-1212',
    'I want to talk to a person',
    'Please call me at 555-1234',
    'Give me a call when you can',
    'Can I get a callback?',
    'Looking to talk to someone about this',
    'Is there a live person I can speak with?',
    'Speak with someone about scheduling',
    'You can reach me at the number above',
    'Text me at 555-9999',
    'Walkthrough call would be great',
    'phone number is 555-1234',
  ];

  it.each(phoneCases)('routes "%s" → phone', (msg) => {
    const r = routeFromCustomerMessage(msg);
    expect(r.suggested).toBe('phone');
    expect(r.scores.phone).toBeGreaterThan(0.5);
    expect(r.scores.hybrid).toBe(0);
    expect(r.scores.convert).toBe(0);
  });

  it('Phone wins over Price when both signals are present', () => {
    // Spec: "Phone should override hot/convert-style signals." Implementation
    // checks Phone first, so a message that contains both a price keyword and
    // a phone keyword routes to Phone.
    const r = routeFromCustomerMessage('How much would it cost? Please call me');
    expect(r.suggested).toBe('phone');
  });

  it('Phone wins over ready-to-book / scheduling signals', () => {
    const r = routeFromCustomerMessage("Sounds good, let's do it — can you give me a call?");
    expect(r.suggested).toBe('phone');
  });
});

describe('routeFromCustomerMessage — Price', () => {
  const priceCases = [
    'How much is a deep clean?',
    'Can I get a quote?',
    'What would it cost?',
    'Looking for an estimate',
    'What is your pricing for a 3BR?',
    'What\'s your rate?',
    'My budget is around $200',
    'How much would that cost?',
    'How much would it be for weekly cleaning?',
    'Ballpark price?',
    'How expensive is move-out cleaning?',
    'What do you charge for a 4BR home?',
  ];

  it.each(priceCases)('routes "%s" → price', (msg) => {
    const r = routeFromCustomerMessage(msg);
    expect(r.suggested).toBe('price');
    expect(r.scores.price).toBeGreaterThan(0.5);
    expect(r.scores.hybrid).toBe(0);
    expect(r.scores.convert).toBe(0);
  });
});

describe('routeFromCustomerMessage — Qualify default', () => {
  const qualifyCases = [
    // Vague / exploratory
    'Looking for cleaning',
    'I need help next week',
    'Hi, interested in your services',
    'Need a clean',
    // Ready-to-book without details — per spec, these go to Qualify, not
    // hidden Convert. "Booking still needs qualification, pricing
    // confirmation, or dispatcher confirmation."
    'Sounds good, let\'s schedule',
    'Sounds good, let\'s do it',
    'Ready to schedule',
    'When can you come?',
    'I want to book',
    'Thursday works for me',
    'Yes please',
    'Perfect, let\'s set it up',
    // Availability question without specifics
    'Are you available next week?',
    'Do you have any availability?',
  ];

  it.each(qualifyCases)('routes "%s" → qualify', (msg) => {
    const r = routeFromCustomerMessage(msg);
    expect(r.suggested).toBe('qualify');
    expect(r.scores.qualify).toBeGreaterThan(0.5);
  });

  it('routes empty string → qualify', () => {
    const r = routeFromCustomerMessage('');
    expect(r.suggested).toBe('qualify');
  });

  it('routes null → qualify', () => {
    const r = routeFromCustomerMessage(null);
    expect(r.suggested).toBe('qualify');
  });

  it('routes undefined → qualify', () => {
    const r = routeFromCustomerMessage(undefined);
    expect(r.suggested).toBe('qualify');
  });
});

describe('routeFromCustomerMessage — never emits hidden legacy goals', () => {
  it('hybrid never appears as a suggested goal', () => {
    const samples = [
      'hi', 'how much', 'call me', 'looking', 'ready to book',
      'estimate', 'phone', '', 'random message',
    ];
    for (const msg of samples) {
      const r = routeFromCustomerMessage(msg);
      expect(r.suggested).not.toBe('hybrid');
    }
  });

  it('convert never appears as a suggested goal', () => {
    const samples = [
      'sounds good let\'s do it',
      'ready to schedule',
      'yes book it',
      'perfect, when can you come',
      'I want to hire you',
    ];
    for (const msg of samples) {
      const r = routeFromCustomerMessage(msg);
      expect(r.suggested).not.toBe('convert');
    }
  });

  it('the score object always has all 5 legacy keys for back-compat consumers', () => {
    // Lead Activity preview row + telemetry dashboards look up
    // scores[hybrid] / scores[convert]. Keep them present (zeroed) so
    // those consumers don't crash on undefined access.
    const r = routeFromCustomerMessage('looking for cleaning');
    expect(r.scores).toHaveProperty('hybrid');
    expect(r.scores).toHaveProperty('price');
    expect(r.scores).toHaveProperty('qualify');
    expect(r.scores).toHaveProperty('convert');
    expect(r.scores).toHaveProperty('phone');
    expect(r.scores.hybrid).toBe(0);
    expect(r.scores.convert).toBe(0);
  });
});
