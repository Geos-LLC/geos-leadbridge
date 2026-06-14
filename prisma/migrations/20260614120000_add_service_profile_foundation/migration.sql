-- Phase 1 foundation for Service Profiles.
-- See ServiceProfile model + User.defaultServiceProfileId + SavedAccount.serviceOverridesJson
-- in prisma/schema.prisma for the read/write contract.
--
-- Strictly additive: no DROP, no NOT NULL retrofit, no column rename. Every
-- new column defaults to NULL or a JSONB default, so this is metadata-only
-- in PG11+ (non-blocking) and rollback-safe.

-- CreateTable: service_profiles
CREATE TABLE "service_profiles" (
  "id"                           TEXT          NOT NULL,
  "userId"                       TEXT          NOT NULL,
  "name"                         TEXT          NOT NULL,
  "slug"                         TEXT          NOT NULL,
  "status"                       TEXT          NOT NULL DEFAULT 'active',
  "isDefault"                    BOOLEAN       NOT NULL DEFAULT false,
  "providerCategoryMappingsJson" JSONB         NOT NULL DEFAULT '[]'::jsonb,
  "pricingJson"                  TEXT,
  "faqJson"                      TEXT,
  "qualificationSchemaJson"      TEXT,
  "aiInstructionsJson"           TEXT,
  "archivedAt"                   TIMESTAMP(3),
  "createdAt"                    TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                    TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "service_profiles_pkey" PRIMARY KEY ("id")
);

-- One slug per tenant. Default profile uses slug='default-service' so
-- backfill + admin scripts can find it deterministically.
CREATE UNIQUE INDEX "service_profiles_userId_slug_key"
  ON "service_profiles" ("userId", "slug");

-- Resolver hot path filters by status='active' and selects by userId.
CREATE INDEX "service_profiles_userId_status_idx"
  ON "service_profiles" ("userId", "status");

-- Exactly one default per tenant. Partial unique enforces this without
-- blocking multiple isDefault=false rows. Prisma's @@unique can't express
-- a partial constraint, so it lives only in raw SQL.
CREATE UNIQUE INDEX "service_profiles_one_default_per_user_idx"
  ON "service_profiles" ("userId")
  WHERE "isDefault" = true;

-- FK back to users with cascade. Deleting a user removes their profiles.
ALTER TABLE "service_profiles"
  ADD CONSTRAINT "service_profiles_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: User.defaultServiceProfileId — pointer to the tenant's
-- fallback profile. SetNull so deleting a profile cleans up the pointer
-- without taking the User with it. Backfill populates this for every
-- existing user before any consumer reads it.
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "defaultServiceProfileId" TEXT;

ALTER TABLE "users"
  ADD CONSTRAINT "users_defaultServiceProfileId_fkey"
  FOREIGN KEY ("defaultServiceProfileId") REFERENCES "service_profiles"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: SavedAccount.serviceOverridesJson — per-location deltas
-- over ServiceProfile base config. Null by default so the legacy
-- pricing/FAQ reader path keeps working unchanged.
ALTER TABLE "saved_accounts"
  ADD COLUMN IF NOT EXISTS "serviceOverridesJson" TEXT;
