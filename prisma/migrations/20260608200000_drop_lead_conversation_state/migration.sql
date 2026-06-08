-- Drop the empty `leads.conversationState` column.
--
-- This column was added experimentally as part of an early PR-1 draft
-- ("add Lead.conversationState"). The architecture decision was reverted
-- in favor of **A + D**: keep `ThreadContext.conversationState` as the
-- single source of truth for conversation/activity mode and derive the
-- Lead-level activity badge at query time. See
-- src/conversation-context/activity-bucket.ts for the derivation.
--
-- The column was all-NULL (2,398 rows, zero non-null) and had no writer
-- or reader in the codebase — no data is lost, no behavior changes.

ALTER TABLE leads DROP COLUMN IF EXISTS "conversationState";
