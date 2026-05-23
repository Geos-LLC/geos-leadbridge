-- Promote `aiConversationEnabled` from per-SavedAccount to per-User.
--
-- Why: today the column lives on SavedAccount (one row per connected
-- platform account). Conceptually it represents a single user-level
-- decision — "do I want AI Conversation capability at all on my LB
-- subscription?" — and the UI dances around this by fan-out writing
-- the same value to every connected account on save. That fan-out is
-- fragile: a partial save (network blip, race, admin tool, direct DB
-- write) leaves the per-account rows diverged, and the per-account
-- column ends up disagreeing with the per-account `aiConversationMode`
-- string (FargiPro: enabled=false / mode='always' → AI silently off).
--
-- New shape: a single Boolean on User. SavedAccount keeps its own
-- `aiConversationMode` for the per-account "when" question.
--
-- Migration steps:
--   1. Add User.ai_conversation_enabled (default false).
--   2. Backfill: any user whose SavedAccounts had it true keeps it on
--      at the user level. Any user with all-false stays off.
--   3. Leave the SavedAccount column in place for one release as a
--      read fallback while every caller migrates. Drop in a follow-up.

ALTER TABLE "users"
  ADD COLUMN "ai_conversation_enabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: union-promote. If ANY of a user's accounts had AI Conversation
-- enabled (per the per-account column), the user-level boolean becomes true.
-- Table is "saved_accounts" (snake_case via @@map), column is literally
-- "aiConversationEnabled" (camelCase, no @map) — keep the quoting exact.
UPDATE "users"
   SET "ai_conversation_enabled" = TRUE
 WHERE "id" IN (
   SELECT DISTINCT "userId"
     FROM "saved_accounts"
    WHERE "aiConversationEnabled" = TRUE
 );
