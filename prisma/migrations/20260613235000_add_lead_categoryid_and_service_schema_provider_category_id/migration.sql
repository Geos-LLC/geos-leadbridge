-- AlterTable: Lead.categoryId — platform-side category ID (Thumbtack
-- request.category.categoryID; null elsewhere). Defaults NULL so this
-- is a metadata-only ADD COLUMN in PG11+ (non-blocking). Backfilled by
-- scripts/backfill-tt-lead-category.ts from existing Lead.rawJson rows.
ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

-- Partial index supports the future schema-join path (lead -> service_schemas
-- by categoryId). Partial-on-NOT-NULL keeps the index small while the
-- Yelp side stays null.
CREATE INDEX IF NOT EXISTS "leads_categoryId_idx"
  ON "leads" ("categoryId")
  WHERE "categoryId" IS NOT NULL;

-- AlterTable: ServiceSchema.providerCategoryId — stable platform-side
-- category ID. Mined opportunistically by the accumulator; never
-- overwrites a previously-set non-null value. Defaults NULL so existing
-- rows from PR #239 remain valid.
ALTER TABLE "service_schemas"
  ADD COLUMN IF NOT EXISTS "providerCategoryId" TEXT;

-- Lookup index for the future "fetch category schema by ID" path.
CREATE INDEX IF NOT EXISTS "service_schemas_provider_providerCategoryId_idx"
  ON "service_schemas" ("provider", "providerCategoryId")
  WHERE "providerCategoryId" IS NOT NULL;
