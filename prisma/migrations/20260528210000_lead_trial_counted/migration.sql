-- Trial meter idempotency flag on Lead.
-- Set to true exactly once by TrialService.consumeLead(userId, leadId) when
-- the lead is counted toward User.trialLeadsHandled. Webhook retries, late
-- re-deliveries, and reconciliation passes all become no-ops via a compare-
-- and-swap pattern (UPDATE ... WHERE trialCounted = false).
--
-- Backfills, scrape imports, sync upserts, and synthetic test leads do NOT
-- touch this flag, so they never burn trial quota.
ALTER TABLE "leads" ADD COLUMN "trialCounted" BOOLEAN NOT NULL DEFAULT false;
