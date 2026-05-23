-- Phase 2 of two staged removals on `saved_accounts`:
--
-- 1) `follow_ups_use_business_hours` — column had zero readers/writers in
--    src/ and frontend/src/ at the time of phase-1 (schema-level removal,
--    PR #171). The schema field was removed then; this migration drops
--    the DB column now that one release has passed and prod is green.
--
-- 2) `ai_conversation_enabled` — promoted from per-account to per-user on
--    2026-05-23 (PR #169 + downstream). All callers now read the
--    User-scope `users.ai_conversation_enabled` column. The per-account
--    column has been a no-op since that PR shipped.

ALTER TABLE "saved_accounts" DROP COLUMN IF EXISTS "follow_ups_use_business_hours";
-- The per-account ai_conversation_enabled was declared without @map, so the
-- actual DB column is the camelCase "aiConversationEnabled". The snake_case
-- form below is kept as a no-op safety net in case a future redeploy with
-- @map happens before this migration runs.
ALTER TABLE "saved_accounts" DROP COLUMN IF EXISTS "aiConversationEnabled";
ALTER TABLE "saved_accounts" DROP COLUMN IF EXISTS "ai_conversation_enabled";
