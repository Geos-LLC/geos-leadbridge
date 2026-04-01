-- AlterTable
ALTER TABLE "saved_accounts" ADD COLUMN "followUpMode" TEXT;
ALTER TABLE "saved_accounts" ADD COLUMN "followUpPreset" TEXT;
ALTER TABLE "saved_accounts" ADD COLUMN "followUpReplyType" TEXT;
ALTER TABLE "saved_accounts" ADD COLUMN "followUpActiveHoursStart" TEXT;
ALTER TABLE "saved_accounts" ADD COLUMN "followUpActiveHoursEnd" TEXT;
ALTER TABLE "saved_accounts" ADD COLUMN "followUpTimezone" TEXT;
