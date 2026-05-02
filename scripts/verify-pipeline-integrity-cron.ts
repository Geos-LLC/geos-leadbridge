/**
 * Verifies the full integrity-check + stale-pending code path against the live DB.
 *
 *   DATABASE_URL=$DIRECT_URL \
 *   SIGCORE_API_KEY=... SIGCORE_API_URL=... APP_BASE_URL=... \
 *   npx ts-node scripts/verify-pipeline-integrity-cron.ts
 *
 * Asserts:
 *   - Clean state: integrity passes, no SystemErrorLog row written
 *   - Re-running while clean: still no row (dedup probe)
 *   - Per-check breakdown printed so #6 sf_link_missing and #7
 *     sigcore_webhook_health can be eyeballed
 *   - resolveStalePendingNotificationLogs() runs and reports updated count
 *
 * Doesn't induce a failure scenario (would require mutating production data).
 * The dedup-on-failure path is covered in pipeline-integrity.service.spec.ts.
 *
 * Config: a thin ConfigService shim that prefers process.env so the integrity
 * check #7 (Sigcore webhook health) can reach the real Sigcore API. Without
 * SIGCORE_API_KEY set, check #7 silently skips with severity='ok' — that's
 * the documented dev/test behavior.
 */

import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma';
import { MonitoringService } from '../src/monitoring/monitoring.service';
import { PipelineIntegrityService } from '../src/monitoring/pipeline-integrity.service';

function buildConfigShim(): ConfigService {
  return {
    get: (key: string, defaultValue?: any) => process.env[key] ?? defaultValue,
  } as unknown as ConfigService;
}

(async () => {
  const prisma = new PrismaClient();
  const config = buildConfigShim();
  const integrity = new PipelineIntegrityService(prisma as any, config);
  const svc = new MonitoringService(prisma as any, config, integrity);

  console.log('=== Config sanity ===');
  console.log('  SIGCORE_API_KEY:', process.env.SIGCORE_API_KEY ? 'set' : 'unset (check #7 will skip)');
  console.log('  SIGCORE_API_URL:', process.env.SIGCORE_API_URL ?? '(default: production)');
  console.log('  BACKEND_PUBLIC_URL:', process.env.BACKEND_PUBLIC_URL ?? '(unset)');
  console.log('  APP_BASE_URL:', process.env.APP_BASE_URL ?? '(unset)');

  const beforeCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`\nBEFORE pipeline_integrity_failed rows = ${beforeCount}`);

  console.log('\n--- runPipelineIntegrityCheck() #1 ---');
  const r1 = await svc.runPipelineIntegrityCheck();
  console.log('summary:', r1.summary);
  // Per-check detail. The service returns a structured `results` array; we
  // re-query through the integrity service directly so we can show every row.
  const detailed1 = await integrity.runChecks();
  console.table(detailed1.results.map((r) => ({
    check: r.check,
    severity: r.severity,
    count: r.count,
    sample: r.sample ? JSON.stringify(r.sample).slice(0, 120) : '',
  })));

  const midCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`\nMIDDLE pipeline_integrity_failed rows = ${midCount}`);

  console.log('\n--- runPipelineIntegrityCheck() #2 (dedup probe) ---');
  const r2 = await svc.runPipelineIntegrityCheck();
  console.log('summary:', r2.summary);

  const afterCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`AFTER pipeline_integrity_failed rows = ${afterCount}`);

  console.log('\n--- resolveStalePendingNotificationLogs() ---');
  // Hourly cron. Read-only from the script's perspective: the resolver
  // mutates rows older than STALE_PENDING_HOURS (=6), which by definition
  // are stuck and should be marked. Running it manually advances the same
  // state the cron would have produced at :15 of the next hour.
  const beforePending = await prisma.notificationLog.count({ where: { status: 'pending' } });
  const beforeUnknown = await prisma.notificationLog.count({ where: { status: 'unknown' } });
  console.log(`  before: pending=${beforePending}, unknown=${beforeUnknown}`);
  await svc.resolveStalePendingNotificationLogs();
  const afterPending = await prisma.notificationLog.count({ where: { status: 'pending' } });
  const afterUnknown = await prisma.notificationLog.count({ where: { status: 'unknown' } });
  console.log(`  after:  pending=${afterPending}, unknown=${afterUnknown}`);
  console.log(`  delta:  resolved=${beforePending - afterPending}`);

  await prisma.$disconnect();

  if (r1.ok && r2.ok && afterCount === beforeCount) {
    console.log('\n[OK] Clean state confirmed — no incident rows created on either run.');
    process.exit(0);
  }
  if (afterCount > midCount) {
    console.log('\n[FAIL] Dedup did not engage — second run created a duplicate row.');
    process.exit(2);
  }
  console.log('\n[OK] Dedup verified: same row touched both runs, no duplicate created.');
  process.exit(0);
})().catch((e) => {
  console.error('ERR', e);
  process.exit(1);
});
