/**
 * CacheKeys — pin the lead cache key shape and the v2 prefix invariants.
 *
 * Reason: a regression here can silently leak cached leads across saved
 * accounts (we already had one, see hotfix/account-boundary-lead-filtering).
 * Each businessId variant must produce a distinct key, the unscoped key must
 * not collide with any biz key, and the pattern must cover every variant for
 * a single delPattern() invalidation.
 */

import { CacheKeys } from './cache-keys';

const USER_ID = 'user-1';

describe('CacheKeys.leadsList', () => {
  it('unscoped key uses the v2 prefix', () => {
    expect(CacheKeys.leadsList(USER_ID)).toBe(`leads:v2:user:${USER_ID}`);
  });

  it('per-account key uses the v2 prefix and includes businessId', () => {
    expect(CacheKeys.leadsList(USER_ID, 'biz-A')).toBe(
      `leads:v2:user:${USER_ID}:biz:biz-A`,
    );
  });

  it('per-account keys for different businesses are distinct', () => {
    const a = CacheKeys.leadsList(USER_ID, 'biz-A');
    const b = CacheKeys.leadsList(USER_ID, 'biz-B');
    expect(a).not.toBe(b);
  });

  it('unscoped key is distinct from any per-account key', () => {
    const unscoped = CacheKeys.leadsList(USER_ID);
    expect(unscoped).not.toBe(CacheKeys.leadsList(USER_ID, 'biz-A'));
  });

  it('pattern matches both unscoped and per-account keys for the same user', () => {
    const pattern = CacheKeys.leadsListPattern(USER_ID);
    const matchesPattern = (key: string) => {
      // Pattern is a glob-style prefix in our store; equivalent regex anchor.
      const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
      return regex.test(key);
    };
    expect(matchesPattern(CacheKeys.leadsList(USER_ID))).toBe(true);
    expect(matchesPattern(CacheKeys.leadsList(USER_ID, 'biz-A'))).toBe(true);
  });

  it('pattern does NOT match a v1 key — v2 prefix bump fully invalidates pre-fix entries', () => {
    const pattern = CacheKeys.leadsListPattern(USER_ID);
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    // A pre-fix value that would have lived in cache under the v1 layout.
    expect(regex.test(`leads:user:${USER_ID}`)).toBe(false);
    expect(regex.test(`leads:user:${USER_ID}:biz:biz-A`)).toBe(false);
  });

  it("doesn't bleed across users", () => {
    const u1 = CacheKeys.leadsList('u-1', 'biz-A');
    const u2 = CacheKeys.leadsList('u-2', 'biz-A');
    expect(u1).not.toBe(u2);
  });
});

describe('CacheKeys.userAllPattern', () => {
  it('uses the v2 leads prefix so admin wipes match real keys', () => {
    const patterns = CacheKeys.userAllPattern(USER_ID);
    expect(patterns).toContain(`leads:v2:user:${USER_ID}*`);
    expect(patterns).not.toContain(`leads:user:${USER_ID}*`);
  });
});
