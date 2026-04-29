/**
 * Unit tests for parseAccountScope.
 *
 * The helper is the single source of truth for "which saved account is this
 * request asking about?" — every list endpoint that returns leads/conversations
 * runs requests through it. The matrix below pins all branches so a regression
 * (e.g. silently returning unified scope when only `businessId=` was passed)
 * fails fast in CI.
 */

import { BadRequestException } from '@nestjs/common';
import { parseAccountScope } from './account-scope.util';

describe('parseAccountScope', () => {
  describe('account scope', () => {
    it('businessId only → account scope', () => {
      const result = parseAccountScope({ businessId: 'biz-1' });
      expect(result).toEqual({ kind: 'account', businessId: 'biz-1' });
    });

    it('trims whitespace from businessId', () => {
      const result = parseAccountScope({ businessId: '  biz-1  ' });
      expect(result).toEqual({ kind: 'account', businessId: 'biz-1' });
    });

    it("rejects businessId='all' as ambiguous", () => {
      expect(() => parseAccountScope({ businessId: 'all' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ businessId: 'ALL' })).toThrow(BadRequestException);
    });
  });

  describe('unified scope', () => {
    it('scope=all → unified, no warning', () => {
      const result = parseAccountScope({ scope: 'all' });
      expect(result).toEqual({ kind: 'all', warn: false });
    });

    it('scope is case-insensitive', () => {
      expect(parseAccountScope({ scope: 'ALL' })).toEqual({ kind: 'all', warn: false });
      expect(parseAccountScope({ scope: 'All' })).toEqual({ kind: 'all', warn: false });
    });

    it("rejects other scope values (only 'all' is accepted)", () => {
      expect(() => parseAccountScope({ scope: 'organization' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ scope: 'team' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ scope: 'none' })).toThrow(BadRequestException);
    });
  });

  describe('mutual exclusion', () => {
    it('businessId AND scope=all → 400', () => {
      expect(() =>
        parseAccountScope({ businessId: 'biz-1', scope: 'all' }),
      ).toThrow(BadRequestException);
    });
  });

  describe('transition mode (strict: false)', () => {
    it('missing both → unified scope with warn: true', () => {
      const result = parseAccountScope({});
      expect(result).toEqual({ kind: 'all', warn: true });
    });

    it('empty-string businessId behaves as missing', () => {
      const result = parseAccountScope({ businessId: '' });
      expect(result).toEqual({ kind: 'all', warn: true });
    });

    it('whitespace-only businessId behaves as missing', () => {
      const result = parseAccountScope({ businessId: '   ' });
      expect(result).toEqual({ kind: 'all', warn: true });
    });

    it('null params behave as missing', () => {
      const result = parseAccountScope({ businessId: null, scope: null });
      expect(result).toEqual({ kind: 'all', warn: true });
    });
  });

  describe('strict mode', () => {
    it('missing both → 400', () => {
      expect(() => parseAccountScope({}, { strict: true })).toThrow(BadRequestException);
    });

    it('businessId set still works', () => {
      const result = parseAccountScope({ businessId: 'biz-1' }, { strict: true });
      expect(result).toEqual({ kind: 'account', businessId: 'biz-1' });
    });

    it('scope=all still works', () => {
      const result = parseAccountScope({ scope: 'all' }, { strict: true });
      expect(result).toEqual({ kind: 'all', warn: false });
    });
  });
});
