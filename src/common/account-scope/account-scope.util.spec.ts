/**
 * Unit tests for parseAccountScope.
 *
 * The helper is the single source of truth for "which saved account is this
 * request asking about?" — every list endpoint that returns leads/conversations
 * runs requests through it. The matrix below pins all branches so a regression
 * (e.g. silently returning unified scope when only `businessId=` was passed)
 * fails fast in CI.
 *
 * Strict-by-default: missing both `businessId` and `scope=all` → 400. The
 * transition-mode fallback was removed after the production migration was
 * complete (see PR notes for chore/account-boundary-strict-mode).
 */

import { BadRequestException } from '@nestjs/common';
import { parseAccountScope } from './account-scope.util';

describe('parseAccountScope', () => {
  describe('account scope', () => {
    it('businessId only → account scope', () => {
      expect(parseAccountScope({ businessId: 'biz-1' })).toEqual({
        kind: 'account',
        businessId: 'biz-1',
      });
    });

    it('trims whitespace from businessId', () => {
      expect(parseAccountScope({ businessId: '  biz-1  ' })).toEqual({
        kind: 'account',
        businessId: 'biz-1',
      });
    });

    it("rejects businessId='all' as ambiguous", () => {
      expect(() => parseAccountScope({ businessId: 'all' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ businessId: 'ALL' })).toThrow(BadRequestException);
    });
  });

  describe('unified scope', () => {
    it('scope=all → unified', () => {
      expect(parseAccountScope({ scope: 'all' })).toEqual({ kind: 'all' });
    });

    it('scope is case-insensitive', () => {
      expect(parseAccountScope({ scope: 'ALL' })).toEqual({ kind: 'all' });
      expect(parseAccountScope({ scope: 'All' })).toEqual({ kind: 'all' });
    });

    it("rejects other scope values (only 'all' is accepted)", () => {
      expect(() => parseAccountScope({ scope: 'organization' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ scope: 'team' })).toThrow(BadRequestException);
      expect(() => parseAccountScope({ scope: 'none' })).toThrow(BadRequestException);
    });
  });

  describe('mutual exclusion', () => {
    it('businessId AND scope=all → 400', () => {
      expect(() => parseAccountScope({ businessId: 'biz-1', scope: 'all' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('strict-mode (default)', () => {
    it('missing both → 400', () => {
      expect(() => parseAccountScope({})).toThrow(BadRequestException);
    });

    it('empty-string businessId behaves as missing → 400', () => {
      expect(() => parseAccountScope({ businessId: '' })).toThrow(BadRequestException);
    });

    it('whitespace-only businessId behaves as missing → 400', () => {
      expect(() => parseAccountScope({ businessId: '   ' })).toThrow(BadRequestException);
    });

    it('null params behave as missing → 400', () => {
      expect(() => parseAccountScope({ businessId: null, scope: null })).toThrow(
        BadRequestException,
      );
    });
  });
});
