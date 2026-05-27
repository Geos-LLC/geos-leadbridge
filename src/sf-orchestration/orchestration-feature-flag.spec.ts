import { ConfigService } from '@nestjs/config';
import { OrchestrationFeatureFlag } from './orchestration-feature-flag';

function buildFlag(envValue: string | undefined): OrchestrationFeatureFlag {
  const fakeConfig: Partial<ConfigService> = {
    get: ((key: string, def?: any) => {
      if (key === 'BOOKING_ORCHESTRATION_ENABLED_USER_IDS') return envValue ?? def;
      return def;
    }) as any,
  };
  return new OrchestrationFeatureFlag(fakeConfig as ConfigService);
}

describe('OrchestrationFeatureFlag', () => {
  describe('isEnabledForUser', () => {
    it('returns false when env is unset', () => {
      const flag = buildFlag(undefined);
      expect(flag.isEnabledForUser('user-A')).toBe(false);
    });

    it('returns false when env is empty string', () => {
      const flag = buildFlag('');
      expect(flag.isEnabledForUser('user-A')).toBe(false);
    });

    it('returns false when env is just whitespace + commas', () => {
      const flag = buildFlag(' , , ,');
      expect(flag.isEnabledForUser('user-A')).toBe(false);
    });

    it('returns true for a userId present in the CSV', () => {
      const flag = buildFlag('user-A,user-B');
      expect(flag.isEnabledForUser('user-A')).toBe(true);
      expect(flag.isEnabledForUser('user-B')).toBe(true);
    });

    it('returns false for a userId NOT in the CSV', () => {
      const flag = buildFlag('user-A,user-B');
      expect(flag.isEnabledForUser('user-C')).toBe(false);
    });

    it('tolerates whitespace around entries', () => {
      const flag = buildFlag('  user-A , user-B , ');
      expect(flag.isEnabledForUser('user-A')).toBe(true);
      expect(flag.isEnabledForUser('user-B')).toBe(true);
    });

    it.each([null, undefined, ''])('returns false for falsy userId %s', (v) => {
      const flag = buildFlag('user-A');
      expect(flag.isEnabledForUser(v as any)).toBe(false);
    });

    it('has NO global escape hatch — unset env never enables anyone', () => {
      // Critical safety property. SF_STATUS_WINS has a global true/false.
      // This flag deliberately does NOT — preventing accidental global
      // canary if someone sets BOOKING_ORCHESTRATION_ENABLED_USER_IDS=true.
      const flag = buildFlag('true');
      expect(flag.isEnabledForUser('user-A')).toBe(false);
      expect(flag.isEnabledForUser('true')).toBe(true); // it's a userId match, not a global toggle
    });
  });

  describe('getEnabledUserIds', () => {
    it('returns [] when env is unset', () => {
      expect(buildFlag(undefined).getEnabledUserIds()).toEqual([]);
    });
    it('parses + trims + dedupes-via-presence', () => {
      expect(buildFlag(' user-A , user-B ,user-C').getEnabledUserIds()).toEqual([
        'user-A',
        'user-B',
        'user-C',
      ]);
    });
    it('returns a fresh array each call (safe to mutate)', () => {
      const flag = buildFlag('user-A');
      const a = flag.getEnabledUserIds();
      const b = flag.getEnabledUserIds();
      expect(a).not.toBe(b);
      a.push('user-X');
      expect(flag.getEnabledUserIds()).toEqual(['user-A']);
    });
  });

  describe('getEnabledTenantCount', () => {
    it('matches the length of the CSV', () => {
      expect(buildFlag('').getEnabledTenantCount()).toBe(0);
      expect(buildFlag('user-A').getEnabledTenantCount()).toBe(1);
      expect(buildFlag('user-A,user-B,user-C').getEnabledTenantCount()).toBe(3);
    });
  });
});
