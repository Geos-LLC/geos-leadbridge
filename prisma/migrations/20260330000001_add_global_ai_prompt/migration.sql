-- AlterTable: add global_ai_prompt to users
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "global_ai_prompt" TEXT;
