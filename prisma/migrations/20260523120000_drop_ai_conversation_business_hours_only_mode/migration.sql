-- Normalize stale `business_hours_only` values to the default mode.
-- The UI only ever offered two modes (`always`, `when_dispatcher_unavailable`),
-- so this is defensive — any row carrying the dead value would have fallen
-- through the runtime gate as "unknown" once the branch was removed.
UPDATE "saved_accounts"
   SET "ai_conversation_mode" = 'when_dispatcher_unavailable'
 WHERE "ai_conversation_mode" = 'business_hours_only';
