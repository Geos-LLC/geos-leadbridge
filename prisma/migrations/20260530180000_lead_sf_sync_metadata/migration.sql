-- SF historical-sync metadata on `leads`. All nullable / additive. No
-- backfill needed; null = "never considered for SF reconciliation".
-- Connection-time hook (src/integrations/sf-historical-sync/) populates
-- syncStatus = 'pending' or 'skipped' on first run per user.

ALTER TABLE "leads"
  ADD COLUMN "sfCustomerId"   TEXT,
  ADD COLUMN "syncStatus"     TEXT,
  ADD COLUMN "syncAttemptedAt" TIMESTAMP(3),
  ADD COLUMN "syncReason"     TEXT;

-- Dashboard query: count leads by (userId, syncStatus). Other lookups
-- already covered by existing single-column indexes.
CREATE INDEX "leads_userId_syncStatus_idx" ON "leads"("userId", "syncStatus");
