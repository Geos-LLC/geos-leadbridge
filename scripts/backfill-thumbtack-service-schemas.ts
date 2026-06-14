/**
 * Backfill — populate `service_schemas` from existing Thumbtack
 * Lead.rawJson rows. One-shot. Default DRY_RUN — APPLY only with an
 * explicit env flag, no auto-run in deploy.
 *
 * Why: the webhook accumulator (see service-schema.service.ts) starts
 * mining schemas going forward, but every TT lead we've ever stored
 * already has `request.category.name` + `request.details[]` sitting in
 * Lead.rawJson. This script walks those rows and feeds them through
 * the SAME merger the webhook uses — so the per-category catalog jumps
 * from empty to "everything we've ever seen" in one pass.
 *
 * Idempotent (re-running just bumps observationsCount and re-dedupes
 * options) but counts every lead it merges, so re-runs do inflate
 * observationsCount. For a clean re-run, truncate `service_schemas`
 * first.
 *
 * Modes:
 *   DRY_RUN=true   — count + report only, no writes (default)
 *   DRY_RUN=false  — execute the merges
 *
 * Optional filters:
 *   USER_ID=<id>   — only process leads for one user
 *   LIMIT=<n>      — cap total leads scanned (default unlimited)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-thumbtack-service-schemas.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-thumbtack-service-schemas.ts
 */

/* eslint-disable no-console */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/utils/prisma.service';
import { ServiceSchemaService } from '../src/service-schema/service-schema.service';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const USER_ID = process.env.USER_ID || undefined;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

type Counters = {
  scanned: number;
  noRawJson: number;
  parseErrors: number;
  noCategory: number;
  noDetails: number;
  merged: number;
  rowsCreated: number;
  rowsUpdated: number;
  questionsAdded: number;
  optionsAdded: number;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);
  const schemas = app.get(ServiceSchemaService);

  console.log(
    `[backfill-tt-service-schemas] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} ` +
    `user=${USER_ID || 'all'} limit=${LIMIT ?? 'unlimited'}`,
  );

  const where = {
    platform: 'thumbtack',
    ...(USER_ID ? { userId: USER_ID } : {}),
    NOT: { rawJson: null as any },
  };

  const rows = await prisma.lead.findMany({
    where: where as any,
    select: { id: true, rawJson: true, createdAt: true, category: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[backfill] ${rows.length} candidate TT leads with rawJson`);

  const c: Counters = {
    scanned: 0,
    noRawJson: 0,
    parseErrors: 0,
    noCategory: 0,
    noDetails: 0,
    merged: 0,
    rowsCreated: 0,
    rowsUpdated: 0,
    questionsAdded: 0,
    optionsAdded: 0,
  };

  const categoriesSeen = new Set<string>();

  for (const row of rows) {
    c.scanned += 1;

    if (!row.rawJson) {
      c.noRawJson += 1;
      continue;
    }

    // Quick pre-check so DRY_RUN can produce useful counters without
    // calling the merger (which would write inside its transaction).
    let parsed: any;
    try {
      parsed = JSON.parse(row.rawJson);
    } catch {
      c.parseErrors += 1;
      continue;
    }
    const categoryName: string = typeof parsed?.request?.category?.name === 'string'
      ? parsed.request.category.name.trim()
      : '';
    if (!categoryName) {
      c.noCategory += 1;
      continue;
    }
    categoriesSeen.add(categoryName);

    const details = Array.isArray(parsed?.request?.details) ? parsed.request.details : [];
    if (details.length === 0) {
      c.noDetails += 1;
      // Still merge: we want a row even with no questions so operators
      // see the category in the catalog. Fall through.
    }

    if (DRY_RUN) {
      c.merged += 1;
      continue;
    }

    try {
      const result = await schemas.mergeFromThumbtackPayload({
        rawPayload: parsed,
        observedAt: row.createdAt ?? new Date(),
      });
      if (result.status === 'merged') {
        c.merged += 1;
        c.questionsAdded += result.questionsAdded;
        c.optionsAdded += result.optionsAdded;
        if (result.created) c.rowsCreated += 1;
        else c.rowsUpdated += 1;
      } else {
        // accumulator-side guard fired despite our pre-checks
        if (result.reason === 'no_category') c.noCategory += 1;
        else if (result.reason === 'parse_error') c.parseErrors += 1;
        else if (result.reason === 'no_payload') c.noRawJson += 1;
      }
    } catch (err: any) {
      console.warn(`[backfill] merge failed leadId=${row.id}: ${err?.message ?? err}`);
    }
  }

  console.log('');
  console.log('==== backfill summary ====');
  console.log(`mode               : ${DRY_RUN ? 'DRY_RUN (no writes)' : 'APPLY'}`);
  console.log(`leads scanned      : ${c.scanned}`);
  console.log(`  no rawJson       : ${c.noRawJson}`);
  console.log(`  parse errors     : ${c.parseErrors}`);
  console.log(`  no category      : ${c.noCategory}`);
  console.log(`  no details       : ${c.noDetails}`);
  console.log(`merged             : ${c.merged}`);
  if (!DRY_RUN) {
    console.log(`  rows created     : ${c.rowsCreated}`);
    console.log(`  rows updated     : ${c.rowsUpdated}`);
    console.log(`  questions added  : ${c.questionsAdded}`);
    console.log(`  options added    : ${c.optionsAdded}`);
  }
  console.log('');
  console.log(`unique categories observed (${categoriesSeen.size}):`);
  for (const name of [...categoriesSeen].sort()) {
    console.log(`  - ${name}`);
  }

  await app.close();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
