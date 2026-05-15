-- Business Hours master on users + per-card wiring on saved_accounts.
-- See Liz Jacob 2026-05-14 incident + business-hours architecture plan.

-- AlterTable users
ALTER TABLE "users"
  ADD COLUMN "business_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "business_hours_start" TEXT,
  ADD COLUMN "business_hours_end" TEXT,
  ADD COLUMN "business_hours_tz" TEXT DEFAULT 'America/New_York',
  ADD COLUMN "business_hours_days" JSONB;

-- AlterTable saved_accounts
ALTER TABLE "saved_accounts"
  ADD COLUMN "business_hours_override" JSONB,
  ADD COLUMN "call_during_business_hours" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "first_msg_during_business_hours" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "follow_ups_use_business_hours" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ai_conversation_mode" TEXT DEFAULT 'when_dispatcher_unavailable';
