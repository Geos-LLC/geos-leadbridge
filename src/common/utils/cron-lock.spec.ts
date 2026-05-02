/**
 * Tests for the shared withCronLock helper.
 *
 * Covers the four invariants every caller depends on:
 *   1. lock acquired → callback runs and result returns
 *   2. lock not acquired → callback skipped, helper returns { skipped: true }
 *   3. callback throws → transaction rolls back / lock auto-releases (no
 *      manual unlock query is ever issued)
 *   4. happy path uses pg_try_advisory_xact_lock — no session-scoped variant
 *
 * The helper is exercised against a Prisma mock that replays $transaction
 * by handing the same mock back as `tx`, so $queryRaw calls inside the
 * callback flow through one place we can inspect.
 */

import { Logger } from '@nestjs/common';
import { isSkipped, withCronLock } from './cron-lock';

function buildHarness(opts: { lockHeldByOther?: boolean } = {}) {
  const calls = {
    lockSql: [] as string[],
    unlockSql: [] as string[],
    transactions: 0,
    transactionOptions: [] as any[],
  };
  const prisma: any = {};
  prisma.$queryRaw = jest.fn().mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join(' ');
    if (/pg_try_advisory_xact_lock/.test(sql)) {
      calls.lockSql.push(sql);
      return [{ locked: !opts.lockHeldByOther }];
    }
    if (/pg_advisory_unlock/.test(sql)) {
      calls.unlockSql.push(sql);
    }
    return [];
  });
  prisma.$queryRawUnsafe = jest.fn().mockImplementation(async (sql: string) => {
    if (/pg_advisory_unlock/.test(sql)) calls.unlockSql.push(sql);
    return [];
  });
  prisma.$transaction = jest.fn().mockImplementation(async (fn: any, txOpts?: any) => {
    calls.transactions++;
    if (txOpts) calls.transactionOptions.push(txOpts);
    return fn(prisma);
  });
  const logger = new Logger('test');
  // Silence the .debug() call when the lock is held — we still verify the
  // skip path via the return value, no need to clutter test output.
  jest.spyOn(logger, 'debug').mockImplementation(() => {});
  return { prisma, logger, calls };
}

describe('withCronLock', () => {
  it('1. lock acquired → callback runs and the result is returned', async () => {
    const { prisma, logger, calls } = buildHarness();
    const work = jest.fn().mockResolvedValue({ updatedCount: 5 });

    const result = await withCronLock(prisma, logger, 7001, 'TestLabel', work);

    expect(calls.transactions).toBe(1);
    expect(calls.lockSql).toHaveLength(1);
    expect(calls.lockSql[0]).toMatch(/pg_try_advisory_xact_lock/);
    expect(work).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ updatedCount: 5 });
    expect(isSkipped(result)).toBe(false);
  });

  it('2. lock not acquired → callback never runs and helper returns { skipped: true }', async () => {
    const { prisma, logger, calls } = buildHarness({ lockHeldByOther: true });
    const work = jest.fn().mockResolvedValue('should-not-run');

    const result = await withCronLock(prisma, logger, 7001, 'TestLabel', work);

    expect(calls.transactions).toBe(1);
    expect(work).not.toHaveBeenCalled();
    expect(isSkipped(result)).toBe(true);
  });

  it('3. callback throws → error propagates, no manual unlock issued (xact rollback releases)', async () => {
    const { prisma, logger, calls } = buildHarness();
    const work = jest.fn().mockRejectedValue(new Error('boom'));

    await expect(withCronLock(prisma, logger, 7001, 'TestLabel', work)).rejects.toThrow('boom');

    expect(calls.transactions).toBe(1);
    expect(work).toHaveBeenCalledTimes(1);
    // Critical: NO explicit unlock — the transaction's rollback releases the
    // xact-scoped lock automatically. If this assertion ever fails it means
    // someone re-introduced a manual cleanup path that defeats the point.
    expect(calls.unlockSql).toHaveLength(0);
  });

  it('4. lock acquire query uses xact-scoped variant (not session-scoped)', async () => {
    const { prisma, logger, calls } = buildHarness();

    await withCronLock(prisma, logger, 12345, 'TestLabel', async () => 'ok');

    // Both invariants matter here: the new function name is present, and the
    // legacy session-scoped form is absent. \b prevents the regex matching
    // the substring inside pg_try_advisory_xact_lock.
    expect(calls.lockSql.join('\n')).toMatch(/pg_try_advisory_xact_lock/);
    expect(calls.lockSql.join('\n')).not.toMatch(/pg_try_advisory_lock\b/);
  });

  it('honours custom timeout and maxWait via $transaction options', async () => {
    const { prisma, logger, calls } = buildHarness();

    await withCronLock(
      prisma,
      logger,
      7001,
      'CustomTimeout',
      async () => 'ok',
      { timeoutMs: 600_000, maxWaitMs: 10_000 },
    );

    expect(calls.transactionOptions).toHaveLength(1);
    expect(calls.transactionOptions[0]).toMatchObject({ timeout: 600_000, maxWait: 10_000 });
  });

  it('uses default timeout/maxWait when no options are passed', async () => {
    const { prisma, logger, calls } = buildHarness();

    await withCronLock(prisma, logger, 7001, 'DefaultTimeout', async () => 'ok');

    expect(calls.transactionOptions).toHaveLength(1);
    expect(calls.transactionOptions[0]).toMatchObject({ timeout: 120_000, maxWait: 5_000 });
  });
});

describe('isSkipped type guard', () => {
  it('returns true for { skipped: true }', () => {
    expect(isSkipped({ skipped: true })).toBe(true);
  });

  it('returns false for actual results', () => {
    expect(isSkipped({ updatedCount: 1 })).toBe(false);
    expect(isSkipped(null as any)).toBe(false);
    expect(isSkipped(undefined as any)).toBe(false);
    expect(isSkipped('something' as any)).toBe(false);
    expect(isSkipped({ skipped: false } as any)).toBe(false);
  });
});

/**
 * Source-level invariant for the whole repo: no production source file under
 * src/ should be calling pg_try_advisory_lock(N) or pg_advisory_unlock(N)
 * directly anymore. New callers must go through withCronLock.
 *
 * Test files and the comment block at the top of cron-lock.ts are exempt —
 * they reference the legacy names to document why we replaced them.
 */
describe('repo invariant: no session-scoped advisory locks remain in production code', () => {
  it('no src/ file (excluding tests + the helper itself) calls pg_try_advisory_lock or pg_advisory_unlock', () => {
    const fs = require('fs');
    const path = require('path');
    const srcRoot = path.resolve(__dirname, '..', '..');

    function walk(dir: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'generated') continue;
          out.push(...walk(full));
        } else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.spec\.ts$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    }

    const helper = path.resolve(__dirname, 'cron-lock.ts');
    const offenders: { file: string; line: number; text: string }[] = [];
    for (const file of walk(srcRoot)) {
      if (file === helper) continue;
      const content = fs.readFileSync(file, 'utf8');
      // Strip block + line comments so doc references don't fail the test.
      const stripped = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      const lines = stripped.split(/\r?\n/);
      lines.forEach((text: string, i: number) => {
        if (/pg_try_advisory_lock\b|pg_advisory_unlock/.test(text)) {
          offenders.push({ file, line: i + 1, text: text.trim() });
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
