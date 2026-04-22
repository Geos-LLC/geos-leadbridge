-- CreateEnum
CREATE TYPE "TrialType" AS ENUM ('LEAD_BASED', 'TIME_BASED', 'HYBRID');

-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "trialType"          "TrialType",
  ADD COLUMN "trialEndedAt"       TIMESTAMP(3),
  ADD COLUMN "trialEndNotifiedAt" TIMESTAMP(3);

-- Backfill: classify existing users by their currently connected platforms.
-- Existing trial limits (trialEndDate, trialLeadsLimit) are preserved untouched
-- per the rollout decision — only trialType is inferred, no retroactive upgrades.
UPDATE "users" u
SET "trialType" = CASE
  WHEN EXISTS (
    SELECT 1 FROM "saved_accounts" sa
    WHERE sa."userId" = u."id"
      AND lower(sa."platform") = 'thumbtack'
  ) AND EXISTS (
    SELECT 1 FROM "saved_accounts" sa
    WHERE sa."userId" = u."id"
      AND lower(sa."platform") = 'yelp'
  ) THEN 'HYBRID'::"TrialType"
  WHEN EXISTS (
    SELECT 1 FROM "saved_accounts" sa
    WHERE sa."userId" = u."id"
      AND lower(sa."platform") = 'yelp'
  ) THEN 'TIME_BASED'::"TrialType"
  WHEN EXISTS (
    SELECT 1 FROM "saved_accounts" sa
    WHERE sa."userId" = u."id"
      AND lower(sa."platform") = 'thumbtack'
  ) THEN 'LEAD_BASED'::"TrialType"
  ELSE NULL
END
WHERE u."trialStartDate" IS NOT NULL
  AND u."trialType" IS NULL;
