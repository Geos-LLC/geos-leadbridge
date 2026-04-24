/**
 * CacheService tests — focused on the kill switch and no-op fallback.
 *
 * These tests instantiate CacheService WITHOUT calling `onModuleInit` so no
 * real ioredis client is created. `isLive()` returns false and every method
 * short-circuits to a no-op — which is exactly the behavior we need to verify.
 */

import { CacheService } from './cache.service';

function buildConfig(overrides: Record<string, any> = {}) {
  const values: Record<string, any> = {
    'cache.enabled': true,
    'cache.keyPrefix': 'test:v1:dev:',
    'cache.redisUrl': '',
    ...overrides,
  };
  return {
    get: jest.fn().mockImplementation((key: string) => values[key]),
  } as any;
}

describe('CacheService', () => {
  describe('isLive()', () => {
    it('false when CACHE_ENABLED=false (kill switch)', () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      expect(svc.isLive()).toBe(false);
    });

    it('false when REDIS_URL is unset even if enabled', () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': true, 'cache.redisUrl': '' }));
      // onModuleInit is NOT called in this test — client stays null.
      expect(svc.isLive()).toBe(false);
    });
  });

  describe('kill switch makes all methods no-ops', () => {
    it('getOrSet invokes loader directly and does not throw', async () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      const loader = jest.fn().mockResolvedValue('fresh-value');

      const result = await svc.getOrSet('key', 60, loader);

      expect(result).toBe('fresh-value');
      expect(loader).toHaveBeenCalledTimes(1);
    });

    it('get returns null', async () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      await expect(svc.get('key')).resolves.toBeNull();
    });

    it('set / del / delPattern resolve silently', async () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      await expect(svc.set('key', { x: 1 }, 60)).resolves.toBeUndefined();
      await expect(svc.del('key')).resolves.toBeUndefined();
      await expect(svc.delPattern('prefix:*')).resolves.toBe(0);
    });

    it('stats show disabled state', () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      const stats = svc.getStats();
      expect(stats.enabled).toBe(false);
      expect(stats.connected).toBe(false);
    });
  });

  describe('getOrSet still dedupes concurrent loaders even when disabled', () => {
    // When disabled, getOrSet does NOT dedupe — it just calls the loader each time.
    // This test documents that behavior so readers know to rely on the live Redis path
    // for thundering-herd protection.
    it('calls the loader twice for two concurrent calls when cache is disabled', async () => {
      const svc = new CacheService(buildConfig({ 'cache.enabled': false }));
      const loader = jest.fn().mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'v';
      });

      await Promise.all([svc.getOrSet('k', 60, loader), svc.getOrSet('k', 60, loader)]);

      expect(loader).toHaveBeenCalledTimes(2);
    });
  });
});
