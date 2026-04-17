-- Follow-up duplicate enrollment / rapid-send fix
-- 1) Adds conversation-level send cooldown field to thread_contexts
-- 2) Adds atomic claim lease fields to follow_up_enrollments
-- 3) Cleans up existing duplicate active enrollments (keeps oldest per conversation)
-- 4) Enforces one active enrollment per conversation via partial unique index
-- 5) Back-populates the cooldown field from historical step executions

-- ==========================================
-- 1. ThreadContext: lastFollowUpSentAt (conversation-level send cooldown SoT)
-- ==========================================
ALTER TABLE "thread_contexts"
  ADD COLUMN IF NOT EXISTS "lastFollowUpSentAt" TIMESTAMP(3);

-- ==========================================
-- 2. FollowUpEnrollment: atomic claim lease
-- ==========================================
ALTER TABLE "follow_up_enrollments"
  ADD COLUMN IF NOT EXISTS "processingUntil" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "processingToken" TEXT;

-- ==========================================
-- 3. Data cleanup: stop duplicate active enrollments (keep oldest per conversation)
--    Must run BEFORE creating the partial unique index below.
-- ==========================================
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "conversationId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "follow_up_enrollments"
  WHERE "status" = 'active'
)
UPDATE "follow_up_enrollments"
SET "status"       = 'stopped',
    "stoppedReason" = 'duplicate_cleanup',
    "completedAt"  = NOW(),
    "updatedAt"    = NOW()
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- Cancel pending suggestions/scheduled executions on the just-stopped duplicates
UPDATE "follow_up_step_executions"
SET "status" = 'cancelled'
WHERE "enrollmentId" IN (
  SELECT "id" FROM "follow_up_enrollments"
  WHERE "status"       = 'stopped'
    AND "stoppedReason" = 'duplicate_cleanup'
    AND "completedAt"  > NOW() - INTERVAL '5 minutes'
)
AND "status" IN ('scheduled', 'suggested');

-- ==========================================
-- 4. Partial unique index: one active enrollment per conversation
-- ==========================================
CREATE UNIQUE INDEX IF NOT EXISTS "follow_up_enrollments_conversationId_active_unique"
ON "follow_up_enrollments" ("conversationId")
WHERE "status" = 'active';

-- ==========================================
-- 5. Back-populate ThreadContext.lastFollowUpSentAt from historical sent executions
-- ==========================================
UPDATE "thread_contexts" tc
SET "lastFollowUpSentAt" = sub.last_sent
FROM (
  SELECT fue."conversationId" AS conversation_id,
         MAX(fse."executedAt") AS last_sent
  FROM "follow_up_step_executions" fse
  JOIN "follow_up_enrollments" fue ON fue."id" = fse."enrollmentId"
  WHERE fse."status" = 'sent'
    AND fse."executedAt" IS NOT NULL
  GROUP BY fue."conversationId"
) sub
WHERE tc."conversationId" = sub.conversation_id
  AND tc."lastFollowUpSentAt" IS NULL;
