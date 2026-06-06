-- Thin Account layer (Phase A): add nullable account_id FK to Lead.
--
-- account_id points at SF's `public.accounts(id)` (uuid). Populated by
-- backfill (PR C) and ingestion (future PR). NULL until then.
--
-- Phase A is plumbing only — no LB behavior change:
--   - Matcher, follow-up scheduler, classifier untouched.
--   - SF<->LB syncStatus lifecycle unchanged.
--   - LB Inbox UI unchanged.
--
-- The column is intentionally nullable + un-constrained at the DB level.
-- Cross-database FK to SF Supabase is enforced at application write time,
-- not via a Postgres FOREIGN KEY (different physical database).

ALTER TABLE "leads"
  ADD COLUMN "account_id" UUID;

-- Reverse-lookup index for "all inquiries on this Account" queries.
CREATE INDEX "leads_account_id_idx" ON "leads"("account_id");
