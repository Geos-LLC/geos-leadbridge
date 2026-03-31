-- AlterTable: add follow-up active hours to automation_rules
ALTER TABLE "automation_rules" ADD COLUMN "active_hours_start" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "active_hours_end" TEXT;
ALTER TABLE "automation_rules" ADD COLUMN "active_hours_tz" TEXT DEFAULT 'America/New_York';
ALTER TABLE "automation_rules" ADD COLUMN "is_follow_up" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "automation_rules" ADD COLUMN "stop_on_customer_reply" BOOLEAN NOT NULL DEFAULT true;
