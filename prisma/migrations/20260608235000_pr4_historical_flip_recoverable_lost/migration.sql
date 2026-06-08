-- PR 4 — Historical flip: recoverable "lost" leads → engaged + follow_up.
--
-- The conversation-state model says Lost is reserved for TRUE terminal:
--   - explicit opt_out
--   - operator manual close
--   - stale beyond the default window (>1 year)
--
-- TT/Yelp "No hire", "Hired Someone", "Archived" auto-writes do NOT meet
-- that bar — they're recoverable historical opportunities. PR 1+2 audited
-- this; ~880 prod rows currently mis-classified.
--
-- This migration flips them to:
--   Lead.status        = 'engaged'   (UI bucket "Active")
--   Lead.statusSource  = 'backfill_pr4_v1'
--   Lead.statusUpdatedAt = NOW()
--   Lead.lostReason     = NULL  (no longer lost — old reason kept in raw fields)
--   ThreadContext.conversationState = 'awaiting_customer'
--     (so the activity-bucket helper renders "Follow-up" — we sent
--      something historically, waiting for them to reply)
--
-- Keep-lost criteria (per the user-approved PR 2 spec):
--   A. lostReason = 'opt_out'        — compliance / explicit unsubscribe
--   B. statusSource = 'manual'       — operator decision
--   C. createdAt < now - 1 year      — stale beyond default window
--
-- Raw platform fields (thumbtackStatus, platformStatus) are preserved as
-- the historical breadcrumb — UI continues to show "TT: Open" etc.
--
-- Safety:
--   - No SF writes (sfJobId, sfCustomerId, sfJobOutcome untouched)
--   - No follow-up enrollments created
--   - No customer messages
--   - No new conversations
--   - LeadStatusAuditLog rows added for traceability
--
-- Idempotent: re-runs select zero rows because the WHERE excludes
-- status='engaged' (post-flip).

BEGIN;

-- ── Step 1: capture the set of leads to flip into a temp table ────────
CREATE TEMP TABLE pr4_flip_set ON COMMIT DROP AS
SELECT l.id, l."threadId", l."userId"
  FROM leads l
 WHERE l.status = 'lost'
   AND COALESCE(l."lostReason", '') <> 'opt_out'
   AND COALESCE(l."statusSource", '') <> 'manual'
   AND l."createdAt" >= NOW() - INTERVAL '1 year';

-- ── Step 2: flip Lead.status + clear lostReason ───────────────────────
UPDATE leads
   SET status            = 'engaged',
       "lostReason"      = NULL,
       "statusSource"    = 'backfill_pr4_v1',
       "statusUpdatedAt" = NOW()
 WHERE id IN (SELECT id FROM pr4_flip_set);

-- ── Step 3: TC.conversationState → awaiting_customer for those threads
--   that have an existing ThreadContext row. Leads without TC fall
--   through to the helper's `engagement` default (still under Active).
UPDATE thread_contexts
   SET "conversationState" = 'awaiting_customer',
       "updatedAt"         = NOW()
 WHERE "conversationId" IN (SELECT "threadId" FROM pr4_flip_set WHERE "threadId" IS NOT NULL);

-- ── Step 4: audit log entries for traceability ───────────────────────
INSERT INTO lead_status_audit_log
  (id, "leadId", "oldStatus", "newStatus", source, reason, "sourceEventId",
   "actorType", "createdAt")
SELECT
  gen_random_uuid(),
  id,
  'lost',
  'engaged',
  'backfill',
  'pr4_recoverable_lost_to_engaged',
  'pr4_v1',
  'system',
  NOW()
  FROM pr4_flip_set;

COMMIT;
