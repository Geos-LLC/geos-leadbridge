-- =========================================================================
-- Service Flow → LeadBridge bi-directional job status sync
-- + engagement-aware follow-up (short_term | long_term mode)
-- See plans/2026-04-17-job-sync-sf-lb.md
-- =========================================================================

-- Lead: SF sync + platform status columns
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "platformStatus" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "platformStatusAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sfJobId" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sfJobMappedAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "sfLastEventAt" TIMESTAMP(3);
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "statusSource" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "statusUpdatedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "leads_sfJobId_idx" ON "leads" ("sfJobId");
CREATE INDEX IF NOT EXISTS "leads_statusSource_idx" ON "leads" ("statusSource");

-- FollowUpEnrollment: engagement-aware mode
ALTER TABLE "follow_up_enrollments" ADD COLUMN IF NOT EXISTS "followUpMode" TEXT NOT NULL DEFAULT 'short_term';
ALTER TABLE "follow_up_enrollments" ADD COLUMN IF NOT EXISTS "modeChangedAt" TIMESTAMP(3);
ALTER TABLE "follow_up_enrollments" ADD COLUMN IF NOT EXISTS "modeReason" TEXT;

CREATE INDEX IF NOT EXISTS "follow_up_enrollments_followUpMode_status_idx"
  ON "follow_up_enrollments" ("followUpMode", "status");

-- CrmWebhookSubscription: direction + inbound support
ALTER TABLE "crm_webhook_subscriptions" ADD COLUMN IF NOT EXISTS "direction" TEXT NOT NULL DEFAULT 'outbound';
ALTER TABLE "crm_webhook_subscriptions" ADD COLUMN IF NOT EXISTS "lastEventAt" TIMESTAMP(3);

-- Replace old unique (userId, webhookUrl) with (userId, direction, webhookUrl).
-- The IF EXISTS form tolerates prior migration states.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'crm_webhook_subscriptions_userId_webhookUrl_key') THEN
    ALTER TABLE "crm_webhook_subscriptions" DROP CONSTRAINT "crm_webhook_subscriptions_userId_webhookUrl_key";
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "crm_webhook_subscriptions_userId_direction_webhookUrl_key"
  ON "crm_webhook_subscriptions" ("userId", "direction", "webhookUrl");
CREATE INDEX IF NOT EXISTS "crm_webhook_subscriptions_direction_isActive_idx"
  ON "crm_webhook_subscriptions" ("direction", "isActive");

-- =========================================================================
-- New tables
-- =========================================================================

CREATE TABLE IF NOT EXISTS "sf_inbound_events" (
  "id"                TEXT NOT NULL,
  "eventId"           TEXT NOT NULL,
  "userId"            TEXT,
  "leadId"            TEXT,
  "sfJobId"           TEXT,
  "sfSubscriptionId"  TEXT,
  "eventType"         TEXT NOT NULL,
  "occurredAt"        TIMESTAMP(3) NOT NULL,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status"            TEXT NOT NULL,
  "result"            TEXT,
  "payloadJson"       JSONB NOT NULL,
  CONSTRAINT "sf_inbound_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "sf_inbound_events_eventId_key" ON "sf_inbound_events" ("eventId");
CREATE INDEX IF NOT EXISTS "sf_inbound_events_leadId_idx" ON "sf_inbound_events" ("leadId");
CREATE INDEX IF NOT EXISTS "sf_inbound_events_status_receivedAt_idx" ON "sf_inbound_events" ("status", "receivedAt");
CREATE INDEX IF NOT EXISTS "sf_inbound_events_sfJobId_idx" ON "sf_inbound_events" ("sfJobId");

ALTER TABLE "sf_inbound_events" ADD CONSTRAINT "sf_inbound_events_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "lead_status_audit_log" (
  "id"            TEXT NOT NULL,
  "leadId"        TEXT NOT NULL,
  "oldStatus"     TEXT,
  "newStatus"     TEXT NOT NULL,
  "source"        TEXT NOT NULL,
  "sourceEventId" TEXT,
  "actorType"     TEXT,
  "actorId"       TEXT,
  "actorName"     TEXT,
  "conflict"      BOOLEAN NOT NULL DEFAULT false,
  "conflictNote"  TEXT,
  "occurredAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_status_audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "lead_status_audit_log_leadId_occurredAt_idx"
  ON "lead_status_audit_log" ("leadId", "occurredAt");
CREATE INDEX IF NOT EXISTS "lead_status_audit_log_conflict_idx"
  ON "lead_status_audit_log" ("conflict");

ALTER TABLE "lead_status_audit_log" ADD CONSTRAINT "lead_status_audit_log_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
