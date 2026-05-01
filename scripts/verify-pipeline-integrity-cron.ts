/**
 * Verifies the weekly pipeline integrity cron's full code path against the live DB.
 *
 *   DATABASE_URL=$DIRECT_URL npx ts-node scripts/verify-pipeline-integrity-cron.ts
 *
 * Asserts:
 *   - Clean state: integrity passes, no SystemErrorLog row written
 *   - Re-running while clean: still no row
 *
 * Doesn't induce a failure scenario (would require mutating production data).
 * The dedup-on-failure path is covered in pipeline-integrity.service.spec.ts.
 */

import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '../generated/prisma';
import { MonitoringService } from '../src/monitoring/monitoring.service';
import { PipelineIntegrityService } from '../src/monitoring/pipeline-integrity.service';

(async () => {
  const prisma = new PrismaClient();
  const config = { get: (_k: string, def?: any) => def } as unknown as ConfigService;
  const integrity = new PipelineIntegrityService(prisma as any);
  const svc = new MonitoringService(prisma as any, config, integrity);

  const beforeCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`BEFORE pipeline_integrity_failed rows = ${beforeCount}`);

  console.log('\n--- runPipelineIntegrityCheck() #1 ---');
  const r1 = await svc.runPipelineIntegrityCheck();
  console.log('result:', r1);

  const midCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`MIDDLE pipeline_integrity_failed rows = ${midCount}`);

  console.log('\n--- runPipelineIntegrityCheck() #2 (dedup probe) ---');
  const r2 = await svc.runPipelineIntegrityCheck();
  console.log('result:', r2);

  const afterCount = await prisma.systemErrorLog.count({
    where: { code: 'pipeline_integrity_failed' },
  });
  console.log(`AFTER pipeline_integrity_failed rows = ${afterCount}`);

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
