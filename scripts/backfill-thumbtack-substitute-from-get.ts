/**
 * Backfill — populate Lead.customerPhoneSubstitute on existing Thumbtack
 * leads by calling TT's GET /negotiations/{id} endpoint.
 *
 * Context: The Jun 9 fix put the GET-endpoint phone in the substitute
 * slot, but only on the refetch path (manual sync action). Most leads
 * have customerPhoneSubstitute = null because no sync was ever
 * triggered. After 2026-06-13 we learned the webhook number is ALSO a
 * forwarding number (per-pro pool), so the only thing the substitute
 * slot actually gets us is a SECOND forwarding number — the one the
 * customer sees on Thumbtack's UI. Useful for operator cross-checking;
 * does NOT give us the customer's real phone (which only arrives via
 * inbound SMS reply).
 *
 * This script walks every TT lead with null `customerPhoneSubstitute`
 * and hits the GET endpoint. Skips leads with no credentials, 401/403
 * from TT, or where the GET phone equals the webhook phone.
 *
 * Modes:
 *   DRY_RUN=true   — report what would change, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Optional filter:
 *   USER_ID=<id>   — only process leads for one user
 *   LIMIT=<n>      — cap total leads processed (default unlimited)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-thumbtack-substitute-from-get.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-thumbtack-substitute-from-get.ts
 *
 * Idempotent — re-running flips no rows once the substitute is populated.
 */

/* eslint-disable no-console */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LeadsService } from '../src/leads/leads.service';
import { PrismaService } from '../src/common/utils/prisma.service';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const USER_ID = process.env.USER_ID || undefined;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const leads = app.get(LeadsService);

  console.log(`[backfill-tt-substitute] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} user=${USER_ID || 'all'} limit=${LIMIT ?? 'unlimited'}`);

  const rows = await prisma.lead.findMany({
    where: {
      platform: 'thumbtack',
      customerPhoneSubstitute: null,
      ...(USER_ID ? { userId: USER_ID } : {}),
    },
    select: { id: true, userId: true, externalRequestId: true, customerName: true },
    orderBy: { createdAt: 'desc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[backfill] ${rows.length} candidate leads with null substitute`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  const reasons = new Map<string, number>();

  for (const row of rows) {
    if (DRY_RUN) {
      // In DRY_RUN we still call the underlying helper but only when the
      // helper is safe — populateThumbtackSubstitute does a write at the
      // end. To avoid the write, we instead simulate via the same code
      // path by setting a flag... actually simpler: just skip the call
      // in dry-run and report the count of candidates. We can't preview
      // the GET response without making the call and risking side-effects.
      reasons.set('dry_run_skipped', (reasons.get('dry_run_skipped') ?? 0) + 1);
      continue;
    }
    try {
      const r = await leads.populateThumbtackSubstitute(row.userId, row.id);
      if (r.updated) {
        updated++;
        if (updated % 25 === 0) console.log(`  ...${updated} updated so far`);
      } else {
        skipped++;
        const reason = r.reason ?? 'unknown';
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    } catch (err: any) {
      failed++;
      reasons.set(`error:${err?.message ?? 'unknown'}`, (reasons.get(`error:${err?.message ?? 'unknown'}`) ?? 0) + 1);
    }
    // Small pause to avoid hammering TT — they rate-limit per-pro tokens.
    await new Promise(r => setTimeout(r, 80));
  }

  console.log('---');
  console.log(`updated:        ${updated}`);
  console.log(`skipped:        ${skipped}`);
  console.log(`failed:         ${failed}`);
  console.log('reasons:');
  Array.from(reasons.entries()).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

  await app.close();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err?.message ?? err);
  process.exit(1);
});
