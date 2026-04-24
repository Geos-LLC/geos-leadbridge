import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export interface CacheGetOrSetOptions {
  /** Per-call override of the kill switch. Useful for temporarily bypassing cache on a specific path. */
  enabled?: boolean;
}

/**
 * Thin Redis wrapper with a no-op fallback.
 *
 * Contract:
 *  - When `cache.enabled` is false OR `REDIS_URL` is unset OR the client is
 *    disconnected, every method short-circuits and `getOrSet` invokes the loader
 *    directly. This is the kill-switch behavior: flip `CACHE_ENABLED=false` in
 *    Railway to disable caching without a code change.
 *  - Keys are automatically prefixed with `config.cache.keyPrefix` so staging
 *    and production can share one Redis instance safely.
 *  - `delPattern` uses SCAN (not KEYS) — KEYS is blocking and forbidden on
 *    managed Redis instances.
 *  - Thundering-herd protection: concurrent `getOrSet` calls for the same key
 *    await a single in-flight loader promise (per-process).
 *
 * Safety:
 *  - Never cache secrets, tokens, or decrypted credentials. Callers are
 *    responsible for passing sanitized DTOs.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);

  private client: Redis | null = null;
  private connected = false;
  private readonly enabled: boolean;
  private readonly keyPrefix: string;

  private readonly inflight = new Map<string, Promise<unknown>>();
  private stats = { hits: 0, misses: 0, errors: 0, sets: 0, dels: 0 };

  constructor(private readonly config: ConfigService) {
    this.enabled = this.config.get<boolean>('cache.enabled') ?? true;
    this.keyPrefix = this.config.get<string>('cache.keyPrefix') ?? 'lb:v1:dev:';
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Cache disabled via CACHE_ENABLED=false — using no-op fallback.');
      return;
    }

    const url = this.config.get<string>('cache.redisUrl');
    if (!url) {
      this.logger.warn('REDIS_URL is not set — using no-op cache fallback.');
      return;
    }

    this.client = new Redis(url, {
      // Do not queue commands while disconnected — short-circuit to no-op instead so
      // the app never blocks on an unavailable Redis.
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      // Short connect timeout so a dead Redis does not stall boot.
      connectTimeout: 5_000,
    });

    this.client.on('connect', () => {
      this.connected = true;
      this.logger.log(`Redis connected (keyPrefix="${this.keyPrefix}")`);
    });
    this.client.on('error', (err) => {
      this.stats.errors++;
      // Log at debug: ioredis retries on its own, noisy logs on flaps are unhelpful.
      this.logger.debug(`Redis error: ${err.message}`);
    });
    this.client.on('end', () => {
      this.connected = false;
      this.logger.warn('Redis connection closed.');
    });
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.quit().catch(() => this.client?.disconnect());
    }
  }

  /** True only when caching is configured AND the client is live. */
  isLive(): boolean {
    return this.enabled && this.connected && this.client !== null;
  }

  getStats() {
    return { ...this.stats, connected: this.connected, enabled: this.enabled, keyPrefix: this.keyPrefix };
  }

  /**
   * Cache-aside helper. Returns the cached value if present; otherwise calls
   * `loader`, caches the result for `ttlSeconds`, and returns it.
   *
   * If the cache is disabled or unavailable, falls back to the loader directly.
   * Thundering-herd protected: concurrent calls for the same key share one loader invocation.
   */
  async getOrSet<T>(key: string, ttlSeconds: number, loader: () => Promise<T>, options: CacheGetOrSetOptions = {}): Promise<T> {
    const shouldUseCache = (options.enabled ?? true) && this.isLive();
    if (!shouldUseCache) return loader();

    const prefixedKey = this.prefix(key);

    try {
      const cached = await this.client!.get(prefixedKey);
      if (cached !== null) {
        this.stats.hits++;
        return JSON.parse(cached) as T;
      }
    } catch (err) {
      this.stats.errors++;
      this.logger.debug(`Cache read failed for ${key}: ${(err as Error).message}`);
      return loader();
    }

    this.stats.misses++;

    // Thundering-herd: share one loader promise across concurrent callers for this key.
    const existing = this.inflight.get(prefixedKey);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      const value = await loader();
      // Fire-and-forget write; a failed write must never fail the request.
      this.trySet(prefixedKey, value, ttlSeconds);
      return value;
    })();

    this.inflight.set(prefixedKey, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(prefixedKey);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.isLive()) return null;
    try {
      const raw = await this.client!.get(this.prefix(key));
      if (raw === null) {
        this.stats.misses++;
        return null;
      }
      this.stats.hits++;
      return JSON.parse(raw) as T;
    } catch (err) {
      this.stats.errors++;
      this.logger.debug(`Cache get failed for ${key}: ${(err as Error).message}`);
      return null;
    }
  }

  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    if (!this.isLive()) return;
    await this.trySet(this.prefix(key), value, ttlSeconds);
  }

  async del(...keys: string[]): Promise<void> {
    if (!this.isLive() || keys.length === 0) return;
    try {
      await this.client!.del(...keys.map((k) => this.prefix(k)));
      this.stats.dels += keys.length;
    } catch (err) {
      this.stats.errors++;
      this.logger.debug(`Cache del failed: ${(err as Error).message}`);
    }
  }

  /**
   * Delete all keys matching a pattern using SCAN.
   *
   * NEVER replace this with KEYS — KEYS is O(N) blocking and forbidden on
   * managed Redis instances. SCAN is cursor-based and safe on large keyspaces.
   */
  async delPattern(pattern: string): Promise<number> {
    if (!this.isLive()) return 0;
    const prefixed = this.prefix(pattern);
    let deleted = 0;
    try {
      const stream = this.client!.scanStream({ match: prefixed, count: 100 });
      const pipeline = this.client!.pipeline();
      for await (const keys of stream as AsyncIterable<string[]>) {
        if (keys.length === 0) continue;
        for (const k of keys) pipeline.del(k);
        deleted += keys.length;
      }
      if (deleted > 0) {
        await pipeline.exec();
        this.stats.dels += deleted;
      }
    } catch (err) {
      this.stats.errors++;
      this.logger.debug(`Cache delPattern failed for ${pattern}: ${(err as Error).message}`);
    }
    return deleted;
  }

  private prefix(key: string): string {
    return key.startsWith(this.keyPrefix) ? key : `${this.keyPrefix}${key}`;
  }

  private async trySet<T>(prefixedKey: string, value: T, ttlSeconds: number): Promise<void> {
    try {
      await this.client!.set(prefixedKey, JSON.stringify(value), 'EX', Math.max(1, ttlSeconds));
      this.stats.sets++;
    } catch (err) {
      this.stats.errors++;
      this.logger.debug(`Cache set failed for ${prefixedKey}: ${(err as Error).message}`);
    }
  }
}
