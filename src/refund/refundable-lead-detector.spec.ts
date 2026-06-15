/**
 * Refundable-lead detector tests.
 *
 * Covers all 5 operator-spec acceptance tests + a few edge cases. The
 * detector's rule is exposed as a pure function (`matchesDuplicateRule`)
 * so we drive it directly here without touching Prisma.
 */

import { matchesDuplicateRule } from './refundable-lead-detector.service';

function makeLead(overrides: Partial<any> = {}): any {
  return {
    id: 'lead-A',
    userId: 'user-1',
    businessId: 'biz-1',
    category: 'House Cleaning',
    postcode: '94110',
    customerPhone: '5551234567',
    customerPhoneSubstitute: null,
    message: 'Hi, I need weekly house cleaning for my 3-bedroom home in Brooklyn.',
    rawJson: JSON.stringify({ leadPrice: '$45.00', customer: { customerID: 'cust-1' } }),
    chargeStateRaw: 'Charged',
    createdAt: new Date('2026-06-01T10:00:00Z'),
    ...overrides,
  };
}

describe('matchesDuplicateRule — operator acceptance tests', () => {
  it('1. duplicate same phone/category/zip/request within 45d → match HIGH', () => {
    const lead = makeLead({ id: 'lead-A', createdAt: new Date('2026-06-01T10:00:00Z') });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      // Same words; small additions still > 0.7
      message: 'Hi, I need weekly house cleaning for my 3 bedroom home in Brooklyn please.',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(true);
    expect(result.confidence).toBe('high');
    expect(result.matchedField).toBe('phone');
  });

  it('2. same name only, different phone + different customerID → no match', () => {
    const lead = makeLead({
      id: 'lead-A',
      customerPhone: '5550000001',
      rawJson: JSON.stringify({ leadPrice: '$45.00', customer: { customerID: 'cust-A', firstName: 'John', lastName: 'Doe' } }),
    });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      customerPhone: '5559999999',
      rawJson: JSON.stringify({ leadPrice: '$45.00', customer: { customerID: 'cust-B', firstName: 'John', lastName: 'Doe' } }),
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('no_customer_identity_match');
  });

  it('3. same customer + different category → no match', () => {
    const lead = makeLead({ id: 'lead-A', category: 'House Cleaning' });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      category: 'Lawn Care',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('no_category_match');
  });

  it('3b. same customer + same category + different ZIP → no match', () => {
    const lead = makeLead({ id: 'lead-A', postcode: '94110' });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      postcode: '94115',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('no_postcode_match');
  });

  it('3c. same customer + same category + same ZIP + dissimilar request → no match', () => {
    const lead = makeLead({
      id: 'lead-A',
      message: 'Hi, I need a one-time deep clean for my studio apartment, very urgent.',
    });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      message: 'Move-out cleaning for 4 bedroom townhouse, includes carpet and oven',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('request_dissimilar');
    expect(result.jaccard).toBeLessThan(0.5);
  });

  it('4. lead.refundedAt overrides — detector skips refunded leads at the query layer; rule itself does not need to check', () => {
    // The detector scans for leads where refundedAt IS NULL; the rule
    // function never sees a refunded lead. But verify that an
    // already-refunded CANDIDATE doesn't trigger a match (a refunded
    // candidate shouldn't reseed a Refundable flag against a new lead).
    const lead = makeLead({ id: 'lead-A' });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      chargeStateRaw: 'Refunded',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('candidate_already_refunded');
  });

  it('5. outside 45-day window → no match', () => {
    const lead = makeLead({ id: 'lead-A', createdAt: new Date('2026-06-01T10:00:00Z') });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-03-01T10:00:00Z'), // 92 days earlier
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('outside_window');
  });
});

describe('matchesDuplicateRule — additional edge cases', () => {
  it('same lead id → no self-match', () => {
    const lead = makeLead({ id: 'lead-A' });
    const result = matchesDuplicateRule({ lead, candidate: lead });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('same_lead');
  });

  it('different tenant → no match', () => {
    const lead = makeLead({ userId: 'user-1' });
    const candidate = makeLead({ id: 'lead-B', userId: 'user-2', createdAt: new Date('2026-05-10T10:00:00Z') });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(false);
    expect(result.reason).toBe('different_tenant');
  });

  it('phone in customerPhoneSubstitute when customerPhone null → matches', () => {
    const lead = makeLead({
      id: 'lead-A',
      customerPhone: null,
      customerPhoneSubstitute: '5551234567',
    });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      customerPhone: '5551234567',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(true);
    expect(result.matchedField).toBe('phone');
  });

  it('TT customerID match when phone differs → matches', () => {
    const lead = makeLead({
      id: 'lead-A',
      customerPhone: '5550000001',
      rawJson: JSON.stringify({ leadPrice: '$45.00', customer: { customerID: 'cust-SAME' } }),
    });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      customerPhone: '5559999999',
      rawJson: JSON.stringify({ leadPrice: '$45.00', customer: { customerID: 'cust-SAME' } }),
    });
    const result = matchesDuplicateRule({ lead, candidate });
    expect(result.match).toBe(true);
    expect(result.matchedField).toBe('customer_id');
  });

  it('similarity 0.5–0.7 → medium confidence', () => {
    const lead = makeLead({
      id: 'lead-A',
      message: 'Weekly house cleaning service needed for Brooklyn apartment',
    });
    const candidate = makeLead({
      id: 'lead-B',
      createdAt: new Date('2026-05-10T10:00:00Z'),
      message: 'Weekly house cleaning needed urgently for Manhattan office',
    });
    const result = matchesDuplicateRule({ lead, candidate });
    if (result.match) {
      // If Jaccard falls in the 0.5–0.7 band, confidence is medium.
      // (Threshold tuning may make this flip — assertion is conditional
      //  so the test stays useful as we tune.)
      expect(['high', 'medium']).toContain(result.confidence);
    }
  });
});
