-- Make automationRuleId nullable to support synthetic AI Conversation
-- deferrals which have no backing AutomationRule row.
ALTER TABLE "pending_automated_messages"
  ALTER COLUMN "automationRuleId" DROP NOT NULL;

-- Discriminator for row origin: "rule" (default) | "ai_conversation".
ALTER TABLE "pending_automated_messages"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'rule';

-- For ai_conversation rows: the account that owns the deferred AI reply.
-- Lets executePendingMessage rebuild the synthetic rule at fire time.
ALTER TABLE "pending_automated_messages"
  ADD COLUMN "savedAccountId" TEXT;

-- Drop the old unique index — automationRuleId is now nullable and
-- ai_conversation rows dedup on savedAccountId instead. Code-level dedup
-- (scheduleAutomatedMessage findFirst) covers both shapes. Prisma created
-- this as a UNIQUE INDEX (not a CONSTRAINT), so we drop by index name.
DROP INDEX IF EXISTS "pending_automated_messages_automationRuleId_negotiationId_key";

-- Replacement non-unique index preserves lookup performance for the
-- classic rule-driven path.
CREATE INDEX IF NOT EXISTS "pending_automated_messages_automationRuleId_negotiationId_idx"
  ON "pending_automated_messages" ("automationRuleId", "negotiationId");

-- Lookup index for the ai_conversation path
-- (findFirst by savedAccountId + negotiationId on dedup).
CREATE INDEX IF NOT EXISTS "pending_automated_messages_savedAccountId_negotiationId_idx"
  ON "pending_automated_messages" ("savedAccountId", "negotiationId");

-- Cron sweep / status filtering.
CREATE INDEX IF NOT EXISTS "pending_automated_messages_kind_status_idx"
  ON "pending_automated_messages" ("kind", "status");

-- FK for savedAccountId (cascade matches the existing leadId FK semantics).
ALTER TABLE "pending_automated_messages"
  ADD CONSTRAINT "pending_automated_messages_savedAccountId_fkey"
  FOREIGN KEY ("savedAccountId") REFERENCES "saved_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
