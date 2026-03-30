-- AlterTable: add type column to message_templates
ALTER TABLE "message_templates" ADD COLUMN IF NOT EXISTS "type" TEXT NOT NULL DEFAULT 'message';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "message_templates_type_idx" ON "message_templates"("type");

-- AlterTable: add prompt_template_id to automation_rules
ALTER TABLE "automation_rules" ADD COLUMN IF NOT EXISTS "prompt_template_id" TEXT;

-- AddForeignKey
ALTER TABLE "automation_rules" ADD CONSTRAINT "automation_rules_prompt_template_id_fkey" FOREIGN KEY ("prompt_template_id") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
