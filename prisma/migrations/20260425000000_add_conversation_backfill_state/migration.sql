-- Phase 0: backfill bookkeeping for Conversation.
-- Lets future recurring sync pick "needs backfill" deterministically without
-- per-row Message.count queries. Both columns nullable; no behavior change yet.
-- Read paths land in later cache-plan phases behind feature flags.

ALTER TABLE "conversations" ADD COLUMN "backfillStatus" TEXT;
ALTER TABLE "conversations" ADD COLUMN "lastBackfilledAt" TIMESTAMP(3);

CREATE INDEX "conversations_backfillStatus_idx" ON "conversations"("backfillStatus");
