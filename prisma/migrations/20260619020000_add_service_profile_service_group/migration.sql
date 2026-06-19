-- Coarse routing bucket the new regex classifier in
-- src/service-profile/service-group-classifier.ts matches against.
-- Replaces the per-string `providerCategoryMappingsJson` matching that
-- forced operators to enumerate every Yelp variant they might ever
-- see ("Regular home cleaning" / "Move-in or move-out cleaning" /
-- "Deep cleaning" / …).
--
-- Values today: 'cleaning' | 'upholstery_carpet' | 'other'.
-- Default 'other' so existing rows are non-matching by default — a
-- companion app-level backfill (scripts/backfill-service-profile-service-group.js)
-- derives the correct group from each row's current
-- providerCategoryMappingsJson before the runtime relies on it.

ALTER TABLE "service_profiles"
  ADD COLUMN "serviceGroup" TEXT NOT NULL DEFAULT 'other';
