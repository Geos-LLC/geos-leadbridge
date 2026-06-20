-- Add v1 ServicePreset fields to service_template_presets so the table
-- can absorb the two remaining hardcoded code presets
-- (upholstery_furniture_cleaning, generic_custom_service). After this
-- migration + the boot-time seeder, the DB becomes the single source of
-- truth for the customer-facing preset picker and the admin Templates
-- page; the code-side SERVICE_PRESETS registry can be deleted.
--
-- All columns are nullable: admin-generated rows keep their v2 shape
-- (serviceOptionsJson / customerAnswersJson / additionalInstructions)
-- and leave these blank; seeded code presets populate these and leave
-- the v2 columns at sensible defaults via the seeder.
ALTER TABLE "service_template_presets"
  ADD COLUMN "qualificationSchemaJson" TEXT,
  ADD COLUMN "faqJson"                 TEXT,
  ADD COLUMN "serviceRules"            TEXT,
  ADD COLUMN "aliases"                 TEXT;
