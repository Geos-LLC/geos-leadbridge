-- Canonical lead status foundation (Task 1, PR 1)
--
-- Adds:
--   leads.lostReason            ('opt_out' | 'hired_someone' | 'no_response' | 'manual')
--   leads.reengageAt            (when this lead becomes a re-engage candidate)
--   lead_status_audit_log.activityType  (default 'status_changed')
--   lead_status_audit_log.reason         (transition reason / lostReason mirror)
--   lead_status_audit_log.metadata       (JSONB escape hatch for future activity types)
--
-- Indexes:
--   leads(reengageAt)                                    — re-engage candidate queries
--   lead_status_audit_log(leadId, activityType, occurredAt) — Lead Activity timeline reads

ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "lostReason" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "reengageAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "leads_reengageAt_idx" ON "leads"("reengageAt");

ALTER TABLE "lead_status_audit_log" ADD COLUMN IF NOT EXISTS "activityType" TEXT NOT NULL DEFAULT 'status_changed';
ALTER TABLE "lead_status_audit_log" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "lead_status_audit_log" ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE INDEX IF NOT EXISTS "lead_status_audit_log_leadId_activityType_occurredAt_idx"
  ON "lead_status_audit_log"("leadId", "activityType", "occurredAt");
