-- Phase 2A — Booking orchestration runtime on ThreadContext.
--
-- All additive, all nullable, no defaults except bookingAttemptCount=0.
-- Zero behavior change on its own — no write paths in PR-A, no SF API
-- calls, no follow-up/AI gating changes. The vocabulary file
-- (src/conversation-context/booking-runtime.ts) documents the state
-- machine; PR-B will wire writes once SF orchestration endpoints exist.
--
-- LB owns the booking *attempt*. SF owns the resulting job's operational
-- lifecycle. The `service_*` states below are mirrored from SF outcomes,
-- not authored by LB. LB does not create jobs directly — it submits
-- booking *requests* through SF's orchestration endpoints.

ALTER TABLE "thread_contexts"
  ADD COLUMN IF NOT EXISTS "bookingState"          TEXT,
  ADD COLUMN IF NOT EXISTS "bookingStateAt"        TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bookingStateReason"    TEXT,
  ADD COLUMN IF NOT EXISTS "bookingRequestedAt"    TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "proposedTimeSlotsJson" TEXT,
  ADD COLUMN IF NOT EXISTS "selectedTimeSlotJson"  TEXT,
  ADD COLUMN IF NOT EXISTS "bookingAttemptCount"   INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "lastBookingAttemptAt"  TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "bookingFailureReason"  TEXT;

-- Partial index — only rows that have ever entered the booking machine
-- get indexed. Mirrors the pattern used for conversationState/aiStatus
-- in the Phase 1 migration so existing-data backfill doesn't bloat the
-- index.
CREATE INDEX IF NOT EXISTS "thread_contexts_bookingState_idx"
  ON "thread_contexts" ("bookingState")
  WHERE "bookingState" IS NOT NULL;
