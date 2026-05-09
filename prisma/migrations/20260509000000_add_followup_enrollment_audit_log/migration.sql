-- Phase 1 Task 4 — Add FollowUpEnrollmentAuditLog table.
-- Records every state transition on FollowUpEnrollment with optional
-- sourceEventId-based dedup. New rows only; no backfill of historical state
-- changes. Cascade-deletes when an enrollment is deleted (rare; scheduler-
-- driven hard-deletes are not part of normal lifecycle).

CREATE TABLE "follow_up_enrollment_audit_log" (
  "id"            TEXT NOT NULL,
  "enrollmentId"  TEXT NOT NULL,
  "oldStatus"     TEXT NOT NULL,
  "newStatus"     TEXT NOT NULL,
  "reason"        TEXT,
  "sourceEventId" TEXT,
  "actorType"     TEXT,
  "actorId"       TEXT,
  "occurredAt"    TIMESTAMP(3) NOT NULL,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "follow_up_enrollment_audit_log_pkey" PRIMARY KEY ("id")
);

-- History reconstruction: latest transitions for an enrollment first.
CREATE INDEX "follow_up_enrollment_audit_log_enrollmentId_createdAt_idx"
  ON "follow_up_enrollment_audit_log"("enrollmentId", "createdAt" DESC);

-- Idempotency lookup: caller provides sourceEventId; we check this index
-- before any state-change to no-op retries. NOT a unique index because
-- distinct enrollments may legitimately share a sourceEventId
-- (e.g. a single webhook fires handleCustomerReply across N enrollments).
CREATE INDEX "follow_up_enrollment_audit_log_sourceEventId_idx"
  ON "follow_up_enrollment_audit_log"("sourceEventId");

ALTER TABLE "follow_up_enrollment_audit_log"
  ADD CONSTRAINT "follow_up_enrollment_audit_log_enrollmentId_fkey"
  FOREIGN KEY ("enrollmentId") REFERENCES "follow_up_enrollments"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
