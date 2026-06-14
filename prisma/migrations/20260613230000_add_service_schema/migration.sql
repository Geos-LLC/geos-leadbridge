-- CreateTable: service_schemas
-- Per-category question catalog accumulated from inbound lead payloads.
-- See ServiceSchema in prisma/schema.prisma for the read/write contract.
-- Step-1 source is 'webhook_accumulator' only; future PR may add
-- 'official_api' rows side-by-side under a different `source` value.
CREATE TABLE "service_schemas" (
  "id"                   TEXT          NOT NULL,
  "provider"             TEXT          NOT NULL,
  "providerCategoryName" TEXT          NOT NULL,
  "providerServiceId"    TEXT,
  "source"               TEXT          NOT NULL,
  "sourceConfidence"     TEXT          NOT NULL DEFAULT 'partial',
  "questionsJson"        JSONB         NOT NULL DEFAULT '[]'::jsonb,
  "observationsCount"    INTEGER       NOT NULL DEFAULT 0,
  "lastSeenAt"           TIMESTAMP(3),
  "createdAt"            TIMESTAMP(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3)  NOT NULL,
  CONSTRAINT "service_schemas_pkey" PRIMARY KEY ("id")
);

-- One row per (provider, category, source). Prevents duplicate rows
-- when concurrent webhooks race on the same category.
CREATE UNIQUE INDEX "service_schemas_provider_providerCategoryName_source_key"
  ON "service_schemas" ("provider", "providerCategoryName", "source");

-- Supports the admin GET endpoint that lists recently-observed schemas
-- and the background sweep that prunes stale rows.
CREATE INDEX "service_schemas_provider_lastSeenAt_idx"
  ON "service_schemas" ("provider", "lastSeenAt");
