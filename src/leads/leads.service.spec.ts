/**
 * LeadsService — focused tests for the cache-eligibility whitelist.
 *
 * The full service has ~15 injected dependencies; reconstructing one for
 * each test is noisy. `isCacheableLeadFilter` has no LeadsService-specific
 * state, so it's exported as a standalone function and exercised here.
 */

import { isCacheableLeadFilter } from './leads.service';

describe('isCacheableLeadFilter', () => {
  describe('cache-eligible shapes', () => {
    it('undefined filter → cacheable (no-filter key)', () => {
      expect(isCacheableLeadFilter(undefined)).toBe(true);
    });

    it('empty object → cacheable', () => {
      expect(isCacheableLeadFilter({})).toBe(true);
    });

    it('all fields explicitly undefined → cacheable (treated as empty)', () => {
      expect(isCacheableLeadFilter({ platform: undefined, status: undefined, limit: undefined })).toBe(true);
    });

    it('businessId only → cacheable', () => {
      expect(isCacheableLeadFilter({ businessId: 'biz-123' })).toBe(true);
    });

    it('empty-string fields are treated as unset', () => {
      expect(isCacheableLeadFilter({ platform: '', status: '', businessId: 'biz-1' })).toBe(true);
    });
  });

  describe('cache-ineligible shapes (bypass cache, hit DB directly)', () => {
    it('platform filter → not cacheable', () => {
      expect(isCacheableLeadFilter({ platform: 'thumbtack' })).toBe(false);
    });

    it('status filter → not cacheable', () => {
      expect(isCacheableLeadFilter({ status: 'new' })).toBe(false);
    });

    it('limit filter → not cacheable', () => {
      expect(isCacheableLeadFilter({ limit: 50 })).toBe(false);
    });

    it('businessId + any other filter → not cacheable', () => {
      expect(isCacheableLeadFilter({ businessId: 'biz-1', status: 'new' })).toBe(false);
      expect(isCacheableLeadFilter({ businessId: 'biz-1', platform: 'yelp' })).toBe(false);
      expect(isCacheableLeadFilter({ businessId: 'biz-1', limit: 20 })).toBe(false);
    });

    it('businessId that is not a string is rejected (truthy-but-invalid guard)', () => {
      // Hypothetical bad input from a caller that passed 0 / true / object.
      expect(isCacheableLeadFilter({ businessId: 0 as any })).toBe(false);
      expect(isCacheableLeadFilter({ businessId: true as any })).toBe(false);
      expect(isCacheableLeadFilter({ businessId: {} as any })).toBe(false);
    });
  });

  describe('future-proofing: unknown keys bypass the cache', () => {
    // The whole point of the whitelist approach. If a future filter field
    // (e.g. `dateRange`) is added and someone forgets to add it here, the
    // cache key would otherwise silently reuse the no-filter `leads:user:{userId}`
    // key and return wrong results. This test pins the guarantee.
    it('an unknown filter field → not cacheable', () => {
      expect(isCacheableLeadFilter({ dateRange: '2026-01-01..2026-04-01' } as any)).toBe(false);
      expect(isCacheableLeadFilter({ tag: 'hot' } as any)).toBe(false);
    });

    it('unknown field combined with businessId → still not cacheable', () => {
      expect(isCacheableLeadFilter({ businessId: 'biz-1', dateRange: 'x' } as any)).toBe(false);
    });
  });
});
