-- Admin Service Template Builder — new model for admin-generated
-- ServicePreset templates. Pure additive: no existing table touched,
-- no backfill. Drafts hidden from non-admins; published rows merge
-- into the public preset picker alongside code-side presets in
-- src/service-profile/presets/service-presets.ts.
CREATE TABLE "service_template_presets" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "providerCategoryName" TEXT NOT NULL,
  "providerCategoryId" TEXT,
  "description" TEXT,
  "serviceOptionsJson" TEXT NOT NULL,
  "pricingJson" TEXT NOT NULL,
  "customerAnswersJson" TEXT NOT NULL,
  "additionalInstructions" TEXT,
  "sourceJson" TEXT,
  "status" TEXT NOT NULL DEFAULT 'draft',
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_template_presets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "service_template_presets_key_key"
  ON "service_template_presets" ("key");

CREATE INDEX "service_template_presets_status_idx"
  ON "service_template_presets" ("status");

CREATE INDEX "service_template_presets_provider_status_idx"
  ON "service_template_presets" ("provider", "status");
