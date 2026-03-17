-- Add AI fields to AutomationRule
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "useAi" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AutomationRule" ADD COLUMN IF NOT EXISTS "aiSystemPrompt" TEXT;

-- Make templateId optional (nullable) to support AI-only rules
ALTER TABLE "AutomationRule" ALTER COLUMN "templateId" DROP NOT NULL;

-- Drop old FK constraint and re-add with SET NULL on delete
ALTER TABLE "AutomationRule" DROP CONSTRAINT IF EXISTS "AutomationRule_templateId_fkey";
ALTER TABLE "AutomationRule" ADD CONSTRAINT "AutomationRule_templateId_fkey"
  FOREIGN KEY ("templateId") REFERENCES "MessageTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
