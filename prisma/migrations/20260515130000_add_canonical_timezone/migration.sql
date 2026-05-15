-- Canonical timezone — single source of truth at the User level + optional
-- per-account override. Replaces the four parallel TZ columns that the
-- follow-up engine, business-hours service, quiet-hours service, and
-- automation service used to read independently:
--
--   users.business_hours_tz
--   users.quiet_hours_tz
--   saved_accounts.followUpTimezone        (camelCase, no @map)
--   saved_accounts.business_hours_override.timezone  (inside JSON)
--
-- The legacy columns are NOT dropped here — they remain as read fallbacks
-- for one deploy cycle so the new column can roll out without coordinated
-- write-then-read deploys. Reads prefer `timezone` / `timezone_override`,
-- fall back to the legacy columns, then to the literal 'America/New_York'.
-- Writes go to the new column only.
--
-- Backfill picks the first non-null value from each row's existing
-- columns (priority: business_hours_tz, then quiet_hours_tz). The same
-- precedence resolveTimezone() uses, so the value the resolver returns
-- today is the value the new column gets seeded with — no behavior
-- change on existing rows.
--
-- For saved_accounts.timezone_override, we backfill from
-- followUpTimezone (the only existing per-account TZ that's a top-level
-- column). Accounts that relied on business_hours_override.timezone
-- stay covered by the JSON-read path in BusinessHoursService until they
-- next save their hours through the UI (which dual-writes both).

ALTER TABLE "users"
  ADD COLUMN "timezone" TEXT DEFAULT 'America/New_York';

UPDATE "users"
SET "timezone" = COALESCE("business_hours_tz", "quiet_hours_tz", 'America/New_York')
WHERE "timezone" IS NULL OR "timezone" = 'America/New_York';

ALTER TABLE "saved_accounts"
  ADD COLUMN "timezone_override" TEXT;

UPDATE "saved_accounts"
SET "timezone_override" = "followUpTimezone"
WHERE "followUpTimezone" IS NOT NULL AND "followUpTimezone" <> '';
