-- AlterTable: nullable boolean on the AI Settings Assistant audit log.
-- Set to TRUE when a write came in via the "Add anyway" resolution path
-- on a conflict-detected proposal. Null for every other write — most
-- writes never hit the conflict detector so the column is meaningfully
-- only ever true or null. See SettingsChangeAuditLog.conflictOverride
-- in prisma/schema.prisma.

ALTER TABLE "settings_change_audit_logs"
  ADD COLUMN IF NOT EXISTS "conflict_override" BOOLEAN;
