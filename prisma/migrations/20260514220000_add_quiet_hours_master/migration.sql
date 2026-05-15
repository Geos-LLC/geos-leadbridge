-- Quiet Hours master on users + per-account follow-ups opt-in on saved_accounts.
-- Separate from business hours (Mon-Fri 9-6) — quiet hours is a daily politeness
-- window for follow-ups (e.g. no texting 10pm-8am, every day).

ALTER TABLE "users"
  ADD COLUMN "quiet_hours_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "quiet_hours_start" TEXT,
  ADD COLUMN "quiet_hours_end" TEXT,
  ADD COLUMN "quiet_hours_tz" TEXT DEFAULT 'America/New_York';

ALTER TABLE "saved_accounts"
  ADD COLUMN "follow_ups_apply_quiet_hours" BOOLEAN NOT NULL DEFAULT true;
