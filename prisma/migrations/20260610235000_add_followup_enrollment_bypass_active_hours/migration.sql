-- AlterTable
-- Per-enrollment opt-out from the per-account active-hours snap (Gate 3 in
-- FollowUpSchedulerService.processEnrollment). Default false so normal cadence
-- is unchanged. Set to true only by operator-triggered Immediate Reactivation
-- paths. Does NOT bypass master quiet hours or legacy per-account quiet hours.
--
-- Postgres handles ADD COLUMN ... DEFAULT FALSE as a metadata-only change in
-- PG11+, so this is non-blocking on the live follow_up_enrollments table.
ALTER TABLE "follow_up_enrollments"
  ADD COLUMN "bypassActiveHours" BOOLEAN NOT NULL DEFAULT false;
