/**
 * Backfill — create one default ServiceProfile per existing tenant
 * and point User.defaultServiceProfileId at it. Idempotent.
 *
 * For each User:
 *   1. Skip if they already have a row in service_profiles with
 *      slug='default-service' (re-run safe).
 *   2. Find the "primary" SavedAccount — the most recently used one.
 *      If none, still create an empty default so the resolver has a
 *      fallback target (status=active, pricing/faq null).
 *   3. Create one ServiceProfile:
 *        name='Default Service', slug='default-service', status='active',
 *        isDefault=true, pricingJson + faqJson copied verbatim.
 *   4. Set User.defaultServiceProfileId.
 *
 * Modes:
 *   DRY_RUN=true   — report what would change, no writes (default)
 *   DRY_RUN=false  — execute the writes
 *
 * Optional filters:
 *   USER_ID=<id>   — only process one user (useful for staging
 *                    canary on a single Spotless tenant first)
 *   LIMIT=<n>      — cap total users processed
 *
 * Usage:
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=true  npx ts-node scripts/backfill-service-profiles.ts
 *   DATABASE_URL=$DIRECT_URL DRY_RUN=false npx ts-node scripts/backfill-service-profiles.ts
 *
 * Hard constraints:
 *   - Never deletes or clears SavedAccount columns. Pricing/FAQ stay
 *     populated in their original home; this script only creates copies.
 *   - Never overwrites an existing default-service profile.
 *   - One row per user — the partial unique index on isDefault=true
 *     guarantees that even if this script raced with itself.
 */

/* eslint-disable no-console */

import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/utils/prisma.service';
import { pickPrimarySavedAccount } from '../src/service-profile/service-profile.types';

const DRY_RUN = (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';
const USER_ID = process.env.USER_ID || undefined;
const LIMIT = process.env.LIMIT ? parseInt(process.env.LIMIT, 10) : undefined;

type Counters = {
  scanned: number;
  alreadyHasDefault: number;
  noSavedAccount: number;
  created: number;
  pointedToDefault: number;
  errors: number;
};

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  const prisma = app.get(PrismaService);

  console.log(
    `[backfill-service-profiles] mode=${DRY_RUN ? 'DRY_RUN' : 'APPLY'} ` +
    `user=${USER_ID || 'all'} limit=${LIMIT ?? 'unlimited'}`,
  );

  const users = await prisma.user.findMany({
    where: USER_ID ? { id: USER_ID } : {},
    select: {
      id: true,
      email: true,
      defaultServiceProfileId: true,
    },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  console.log(`[backfill] ${users.length} user(s) to evaluate`);

  const c: Counters = {
    scanned: 0,
    alreadyHasDefault: 0,
    noSavedAccount: 0,
    created: 0,
    pointedToDefault: 0,
    errors: 0,
  };

  for (const u of users) {
    c.scanned += 1;

    try {
      // Idempotency check — look for the canonical default-service slug.
      // Picking by slug is the same key the resolver + admin scripts use,
      // so re-runs are guaranteed no-ops on already-backfilled users.
      const existing = await prisma.serviceProfile.findUnique({
        where: { userId_slug: { userId: u.id, slug: 'default-service' } },
      });

      if (existing) {
        c.alreadyHasDefault += 1;
        if (!u.defaultServiceProfileId && !DRY_RUN) {
          // Found the profile but the User pointer is missing — fix the pointer.
          await prisma.user.update({
            where: { id: u.id },
            data: { defaultServiceProfileId: existing.id },
          });
          c.pointedToDefault += 1;
        }
        continue;
      }

      // Tiered preference: pick the SavedAccount carrying BOTH pricing
      // and FAQ first, then pricing-only, then FAQ-only, then anything.
      // Within tier, ties break on most-recently-used.
      //
      // Replaces the original naive "lastUsedAt DESC" picker that bit
      // Spotless during the Phase 1 backfill — Wesley Chapel was last
      // touched but had null faqJson, so the default profile inherited
      // null FAQ over 6 sibling accounts that all had populated FAQs.
      //
      // See pickPrimarySavedAccount in service-profile.types.ts.
      const candidates = await prisma.savedAccount.findMany({
        where: { userId: u.id },
        select: {
          id: true,
          businessName: true,
          servicePricingJson: true,
          faqJson: true,
          lastUsedAt: true,
        },
      });
      const primary = pickPrimarySavedAccount(candidates);

      if (!primary) {
        c.noSavedAccount += 1;
        // Still create the empty default so the resolver has a fallback.
        // Without it, the user would always hit legacy_fallback — which is
        // technically fine (no behavior change) but defeats the point of
        // Phase 1 foundation (every tenant has a profile to read).
      }

      if (DRY_RUN) {
        c.created += 1;
        continue;
      }

      const created = await prisma.serviceProfile.create({
        data: {
          userId: u.id,
          name: 'Default Service',
          slug: 'default-service',
          status: 'active',
          isDefault: true,
          providerCategoryMappingsJson: [],
          pricingJson: primary?.servicePricingJson ?? null,
          faqJson: primary?.faqJson ?? null,
        },
      });
      c.created += 1;

      await prisma.user.update({
        where: { id: u.id },
        data: { defaultServiceProfileId: created.id },
      });
      c.pointedToDefault += 1;
    } catch (err: any) {
      c.errors += 1;
      console.warn(`[backfill] user=${u.id} (${u.email}) FAILED: ${err?.message ?? err}`);
    }
  }

  console.log('');
  console.log('==== backfill summary ====');
  console.log(`mode                : ${DRY_RUN ? 'DRY_RUN (no writes)' : 'APPLY'}`);
  console.log(`users scanned       : ${c.scanned}`);
  console.log(`already has default : ${c.alreadyHasDefault}`);
  console.log(`no saved account    : ${c.noSavedAccount}`);
  console.log(`profiles created    : ${c.created}`);
  console.log(`pointers updated    : ${c.pointedToDefault}`);
  console.log(`errors              : ${c.errors}`);

  await app.close();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
