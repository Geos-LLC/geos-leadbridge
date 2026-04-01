-- Add savedAccountId to follow_up_sequence_templates for per-account scoping
ALTER TABLE "follow_up_sequence_templates" ADD COLUMN "savedAccountId" TEXT;
CREATE INDEX "follow_up_sequence_templates_savedAccountId_platform_triggerSt_idx" ON "follow_up_sequence_templates"("savedAccountId", "platform", "triggerState");
ALTER TABLE "follow_up_sequence_templates" ADD CONSTRAINT "follow_up_sequence_templates_savedAccountId_fkey" FOREIGN KEY ("savedAccountId") REFERENCES "saved_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
