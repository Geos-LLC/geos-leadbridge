-- Add reply_mode to automation_rules
-- "custom" = static template (useAi=false)
-- "price" = AI-generated using locked price anchor strategy + pricing table
-- "auto"  = AI-generated using user-selected prompt template
ALTER TABLE "automation_rules"
  ADD COLUMN "reply_mode" TEXT NOT NULL DEFAULT 'custom';

-- Backfill existing rules based on current useAi flag
UPDATE "automation_rules"
SET "reply_mode" = CASE WHEN "useAi" = true THEN 'auto' ELSE 'custom' END;
