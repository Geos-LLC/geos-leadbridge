-- One-shot backfill: re-classify stale ThreadContext.conversationState rows.
--
-- Pre-fix, three writers landed `conversationState='human_handling'` AFTER a
-- manual reply, and the AI-reply path landed nothing — both leave the state
-- stuck at customer_replied / human_handling while the outbound conversation
-- has clearly moved on. Symptom: ~30% of "Human Handoff" badges on the inbox
-- were stale (operator replied days ago, badge still red).
--
-- The activity-bucket helper is a pure mapping from TC state → bucket and is
-- not patched; instead we correct the underlying state once-and-for-all for
-- every Active lead currently affected. Future-side: the four code fixes in
-- this commit prevent re-drift.
--
-- Rule (applied per row):
--
--   Active leads (status in ('new','engaged','contacted','quoted','in_progress'))
--   with TC.conversationState IN ('customer_replied','human_handling') AND
--   an outbound message NEWER than the customer's last message:
--
--     - AI message is newest  → conversationState = 'ai_engaging'
--     - business is newest    → conversationState = 'awaiting_customer'
--
--   Rows where the customer's last message is still the most recent stay
--   untouched (they're legitimately waiting on a human).
--
-- Idempotent: re-running matches zero rows because the WHERE clause selects
-- only stale `customer_replied` / `human_handling` rows, and after the
-- update they no longer satisfy that filter.

BEGIN;

-- Stale → ai_engaging (AI message is the most recent activity)
UPDATE thread_contexts
   SET "conversationState" = 'ai_engaging'
 WHERE "conversationState" IN ('customer_replied', 'human_handling')
   AND "conversationId" IN (
       SELECT l."threadId"
         FROM leads l
        WHERE LOWER(COALESCE(l.status, '')) IN ('new','engaged','contacted','quoted','in_progress')
   )
   AND "lastCustomerMessageAt" IS NOT NULL
   AND COALESCE("lastAiMessageAt", to_timestamp(0))
       > GREATEST(
           COALESCE("lastCustomerMessageAt", to_timestamp(0)),
           COALESCE("lastBusinessMessageAt", to_timestamp(0))
         );

-- Stale → awaiting_customer (business message is the most recent activity)
UPDATE thread_contexts
   SET "conversationState" = 'awaiting_customer'
 WHERE "conversationState" IN ('customer_replied', 'human_handling')
   AND "conversationId" IN (
       SELECT l."threadId"
         FROM leads l
        WHERE LOWER(COALESCE(l.status, '')) IN ('new','engaged','contacted','quoted','in_progress')
   )
   AND "lastCustomerMessageAt" IS NOT NULL
   AND COALESCE("lastBusinessMessageAt", to_timestamp(0)) > COALESCE("lastCustomerMessageAt", to_timestamp(0));

COMMIT;
