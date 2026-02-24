-- AlterTable: add test_data JSONB column to admin_config
ALTER TABLE "admin_config" ADD COLUMN IF NOT EXISTS "test_data" JSONB;
