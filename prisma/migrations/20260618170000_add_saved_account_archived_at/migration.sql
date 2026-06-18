-- Auto-archive timestamp on SavedAccount. Non-null when the proactive
-- token health sweep has decided the account is permanently disconnected
-- (>= 30 days of unresolved token_refresh errors).
--
-- Additive nullable column. Existing rows stay NULL → unchanged behavior.
-- User-facing queries filter `archivedAt: null` so archived rows drop
-- out of the connected-accounts list and dead-token warning. A future
-- OAuth reconnect on the same userId+platform+businessId resurrects
-- the row with its config (FAQ, pricing, playbook, follow-ups) intact.
ALTER TABLE "saved_accounts"
  ADD COLUMN "archivedAt" TIMESTAMP(3);

-- Partial index so the sweep cron's "find candidates" query stays cheap
-- (it only needs to scan archived=null rows joined to SystemErrorLog).
CREATE INDEX "saved_accounts_archived_at_idx"
  ON "saved_accounts" ("archivedAt")
  WHERE "archivedAt" IS NULL;
