-- Phase 1 — Conversation runtime + SF operational lifecycle mirror.
--
-- All additive, all nullable, no defaults. Zero behavior change on its own —
-- write paths land in a follow-up commit. Read paths still use the legacy
-- fields; new fields are populated in parallel.

ALTER TABLE "thread_contexts"
  ADD COLUMN IF NOT EXISTS "conversationState" TEXT,
  ADD COLUMN IF NOT EXISTS "conversationStateAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "conversationStateReason" TEXT,
  ADD COLUMN IF NOT EXISTS "aiStatus" TEXT,
  ADD COLUMN IF NOT EXISTS "aiStatusAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "aiStatusReason" TEXT,
  ADD COLUMN IF NOT EXISTS "lastClassifiedIntent" TEXT,
  ADD COLUMN IF NOT EXISTS "lastClassifiedConfidence" DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS "lastClassifiedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoffRequestedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "handoffRequestedReason" TEXT,
  ADD COLUMN IF NOT EXISTS "handoffResolvedAt" TIMESTAMP(3);

ALTER TABLE "leads"
  ADD COLUMN IF NOT EXISTS "sfJobOutcome" TEXT,
  ADD COLUMN IF NOT EXISTS "sfJobOutcomeAt" TIMESTAMP(3);

-- Light indexes for the queries the new UI will run (dashboard "AI paused"
-- counts, "awaiting customer" lists, "handoff pending" alerts). All partial
-- indexes (skip nulls) so existing-data backfill doesn't bloat them.
CREATE INDEX IF NOT EXISTS "thread_contexts_aiStatus_idx"
  ON "thread_contexts" ("aiStatus")
  WHERE "aiStatus" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "thread_contexts_conversationState_idx"
  ON "thread_contexts" ("conversationState")
  WHERE "conversationState" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "thread_contexts_handoffRequested_open_idx"
  ON "thread_contexts" ("handoffRequestedAt")
  WHERE "handoffRequestedAt" IS NOT NULL AND "handoffResolvedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "leads_sfJobOutcome_idx"
  ON "leads" ("sfJobOutcome")
  WHERE "sfJobOutcome" IS NOT NULL;
