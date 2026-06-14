/**
 * Backfill — populate `Lead.categoryId` (new column) and
 * `Lead.category` (older nullable column) for existing Thumbtack leads
 * by parsing `Lead.rawJson`. Pure local DB work — no Thumbtack API calls,
 * no OAuth, no scope changes.
 *
 * Why this script exists:
 *   1. The new `Lead.categoryId` column starts NULL for every historical
 *      row. Every TT webhook payload carries `request.category.categoryID`,
 *      so we can hydrate every existing row from `rawJson`.
 *   2. Some legacy TT leads have `Lead.category = null` despite their
 *      `rawJson.request.category.name` being present (observed live on
 *      Spotless JAX during the 2026-06-13 probe). The webhook update
 *      branch is now fixed forward, but historical rows need a sweep.
 *
 * Modes:
 *   DRY_RUN=true   — report what would change, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Optional filters:
 *   USER_ID=<id>   — only process leads for one user
 *   LIMIT=<n>      — cap total leads scanned (default unlimited)
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-tt-lead-category.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-tt-lead-category.ts
 *
 * Idempotent: re-running flips no rows once both columns are populated.
 * Safe to re-run alongside scripts/backfill-thumbtack-service-schemas.ts.
 */

/* eslint-disable no-console */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/utils/prisma.service';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const USER_ID = process.env.USER_ID || undefined;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

type ParsedHints = {
  categoryName: string | null;
  categoryId: string | null;
};

/**
 * Extract category hints from a Lead.rawJson string. Defensive: any
 * parse error or unexpected shape returns nulls. Exported-style helper
 * (kept local) so it can be unit-tested via the accumulator spec if
 * needed.
 */
function extractCategoryHints(rawJson: string | null): ParsedHints {
  if (!rawJson) return { categoryName: null, categoryId: null };
  let parsed: any;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { categoryName: null, categoryId: null };
  }
  const cat = parsed?.request?.category;
  const name = typeof cat?.name === 'string' && cat.name.trim().length > 0
    ? cat.name.trim()
    : null;
  let id: string | null = null;
  if (typeof cat?.categoryID === 'string' && cat.categoryID.trim().length > 0) {
    id = cat.categoryID.trim();
  } else if (typeof cat?.categoryID === 'number') {
    id = String(cat.categoryID);
  }
  return { categoryName: name, categoryId: id };
}

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);

  console.log(
    `[backfill-tt-lead-category] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} ` +
    `user=${USER_ID || 'all'} limit=${LIMIT ?? 'unlimited'}`,
  );

  // Only sweep rows that are still missing one of the two fields. Once
  // both are populated, the row no longer matches this filter — re-runs
  // become cheap no-ops.
  const rows = await prisma.lead.findMany({
    where: {
      platform: 'thumbtack',
      ...(USER_ID ? { userId: USER_ID } : {}),
      OR: [
        { categoryId: null },
        { category: null },
      ],
    },
    select: { id: true, category: true, categoryId: true, rawJson: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[backfill] ${rows.length} candidate TT leads missing category and/or categoryId`);

  const c = {
    scanned: 0,
    noRawJson: 0,
    parseErrors: 0,
    noCategory: 0,
    wouldSetCategoryId: 0,
    wouldSetCategory: 0,
    updated: 0,
    skippedAlreadyOk: 0,
  };

  for (const row of rows) {
    c.scanned += 1;

    if (!row.rawJson) {
      c.noRawJson += 1;
      continue;
    }

    const hints = extractCategoryHints(row.rawJson);
    if (!hints.categoryName && !hints.categoryId) {
      c.noCategory += 1;
      continue;
    }

    const patch: { category?: string; categoryId?: string } = {};
    if (!row.category && hints.categoryName) {
      patch.category = hints.categoryName;
      c.wouldSetCategory += 1;
    }
    if (!row.categoryId && hints.categoryId) {
      patch.categoryId = hints.categoryId;
      c.wouldSetCategoryId += 1;
    }

    if (Object.keys(patch).length === 0) {
      c.skippedAlreadyOk += 1;
      continue;
    }

    if (DRY_RUN) continue;

    try {
      await prisma.lead.update({
        where: { id: row.id },
        data: patch,
      });
      c.updated += 1;
    } catch (err: any) {
      console.warn(`[backfill] update failed leadId=${row.id}: ${err?.message ?? err}`);
    }
  }

  console.log('');
  console.log('==== backfill summary ====');
  console.log(`mode                : ${DRY_RUN ? 'DRY_RUN (no writes)' : 'APPLY'}`);
  console.log(`leads scanned       : ${c.scanned}`);
  console.log(`  no rawJson        : ${c.noRawJson}`);
  console.log(`  parse / no cat    : ${c.parseErrors + c.noCategory}`);
  console.log(`would set category  : ${c.wouldSetCategory}`);
  console.log(`would set categoryId: ${c.wouldSetCategoryId}`);
  console.log(`already populated   : ${c.skippedAlreadyOk}`);
  if (!DRY_RUN) {
    console.log(`rows actually updated: ${c.updated}`);
  }

  await app.close();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
