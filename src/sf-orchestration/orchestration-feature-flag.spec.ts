import { ConfigService } from '@nestjs/config';
import { OrchestrationFeatureFlag } from './orchestration-feature-flag';
import type { SfConnectionResolver, ResolvedSfCredentials } from './sf-connection-resolver.service';

function buildFlag(
  envValue: string | undefined,
  resolverStub?: Partial<SfConnectionResolver>,
): OrchestrationFeatureFlag {
  const fakeConfig: Partial<ConfigService> = {
    get: ((key: string, def?: any) => {
      if (key === 'BOOKING_ORCHESTRATION_ENABLED_USER_IDS') return envValue ?? def;
      return def;
    }) as any,
  };
  const resolver: Partial<SfConnectionResolver> = resolverStub ?? {
    isEnabledForUser: jest.fn(async () => false),
    resolveForUser: jest.fn(async () => ({ enabled: false, source: 'none' } as ResolvedSfCredentials)),
  };
  return new OrchestrationFeatureFlag(fakeConfig as ConfigService, resolver as SfConnectionResolver);
}

describe('OrchestrationFeatureFlag — isInEnvCsv (sync CSV-only check)', () => {
  // This is the sync CSV check the resolver uses internally + diagnostics
  // surface (enabledTenantCount). Behavior is the original PR-B1
  // isEnabledForUser semantics, just renamed.

  it('returns false when env is unset', () => {
    expect(buildFlag(undefined).isInEnvCsv('user-A')).toBe(false);
  });

  it('returns false when env is empty string', () => {
    expect(buildFlag('').isInEnvCsv('user-A')).toBe(false);
  });

  it('returns false when env is just whitespace + commas', () => {
    expect(buildFlag(' , , ,').isInEnvCsv('user-A')).toBe(false);
  });

  it('returns true for a userId present in the CSV', () => {
    const flag = buildFlag('user-A,user-B');
    expect(flag.isInEnvCsv('user-A')).toBe(true);
    expect(flag.isInEnvCsv('user-B')).toBe(true);
  });

  it('returns false for a userId NOT in the CSV', () => {
    expect(buildFlag('user-A,user-B').isInEnvCsv('user-C')).toBe(false);
  });

  it('tolerates whitespace around entries', () => {
    const flag = buildFlag('  user-A , user-B , ');
    expect(flag.isInEnvCsv('user-A')).toBe(true);
    expect(flag.isInEnvCsv('user-B')).toBe(true);
  });

  it.each([null, undefined, ''])('returns false for falsy userId %s', (v) => {
    expect(buildFlag('user-A').isInEnvCsv(v as any)).toBe(false);
  });

  it('has NO global escape hatch — unset env never enables anyone', () => {
    const flag = buildFlag('true');
    expect(flag.isInEnvCsv('user-A')).toBe(false);
    expect(flag.isInEnvCsv('true')).toBe(true);
  });
});

describe('OrchestrationFeatureFlag — isEnabledForUser (async, delegates to resolver)', () => {
  it('delegates to the resolver', async () => {
    const stub: Partial<SfConnectionResolver> = {
      isEnabledForUser: jest.fn(async () => true),
    };
    const flag = buildFlag('', stub);
    expect(await flag.isEnabledForUser('user-A')).toBe(true);
    expect(stub.isEnabledForUser).toHaveBeenCalledWith('user-A');
  });

  it('returns false (without calling resolver) when userId is falsy', async () => {
    const stub: Partial<SfConnectionResolver> = {
      isEnabledForUser: jest.fn(async () => true),
    };
    const flag = buildFlag('', stub);
    expect(await flag.isEnabledForUser(null)).toBe(false);
    expect(await flag.isEnabledForUser(undefined)).toBe(false);
    expect(await flag.isEnabledForUser('')).toBe(false);
    expect(stub.isEnabledForUser).not.toHaveBeenCalled();
  });

  it('returns false when resolver says enabled=false', async () => {
    const stub: Partial<SfConnectionResolver> = {
      isEnabledForUser: jest.fn(async () => false),
    };
    const flag = buildFlag('user-A', stub);
    // userId is in env CSV but resolver still wins — the resolver itself
    // is responsible for resolving CSV → env_canary. A false return from
    // resolver means "neither DB nor canary qualifies".
    expect(await flag.isEnabledForUser('user-A')).toBe(false);
  });
});

describe('OrchestrationFeatureFlag — getEnabledUserIds', () => {
  it('returns [] when env is unset', () => {
    expect(buildFlag(undefined).getEnabledUserIds()).toEqual([]);
  });

  it('parses + trims', () => {
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

describe('OrchestrationFeatureFlag — getEnabledTenantCount', () => {
  it('matches the length of the CSV', () => {
    expect(buildFlag('').getEnabledTenantCount()).toBe(0);
    expect(buildFlag('user-A').getEnabledTenantCount()).toBe(1);
    expect(buildFlag('user-A,user-B,user-C').getEnabledTenantCount()).toBe(3);
  });
});
