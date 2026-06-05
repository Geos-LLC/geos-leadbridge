-- SF Lead-only link metadata on `leads`. Additive / nullable / no backfill.
--
-- When SF's historical reconciliation finds a matching SF Lead record (but
-- no SF Customer or SF Job yet), the bulk_link receiver writes:
--   syncStatus       = 'lead_linked'
--   sf_lead_id       = SF Lead PK (string)
--   sf_lead_stage_name = "Contacted" / "Estimate Sent" / etc. (snapshot)
--   sf_lead_matched_at = timestamp when SF confirmed the match
--
-- 'lead_linked' is behaviorally identical to LB-only (LB still owns AI /
-- follow-up / classifier / status). It exists to (a) record the SF Lead
-- identity so the candidates query stops re-presenting these rows to SF
-- and (b) give operators a badge surface in the UI. See
-- src/integrations/sf-historical-sync/sf-historical-sync.contracts.ts and
-- the 2026-06-04 architecture confirmation for full rationale.

ALTER TABLE "leads"
  ADD COLUMN "sf_lead_id"          TEXT,
  ADD COLUMN "sf_lead_stage_name"  TEXT,
  ADD COLUMN "sf_lead_matched_at"  TIMESTAMP(3);
