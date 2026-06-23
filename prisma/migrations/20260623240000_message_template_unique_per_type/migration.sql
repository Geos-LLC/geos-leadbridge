-- Widen MessageTemplate uniqueness from (userId, name) to (userId, name, type)
-- so the section-named prompt seed (Instant Reply, Instant Text, …) can
-- coexist with the same-named message templates. The 2026-06-23 templates
-- restructure assumed this; without it, getTemplates throws P2002 mid-rename
-- and the API returns 500 (frame_ant.js: GET /api/v1/templates → 500).
--
-- Safe — the new constraint is strictly more permissive. No existing rows
-- can violate it because (userId, name) was the old uniqueness and adding
-- `type` as an additional discriminator can only widen the allowed set.

ALTER TABLE "message_templates" DROP CONSTRAINT "message_templates_userId_name_key";
CREATE UNIQUE INDEX "message_templates_userId_name_type_key" ON "message_templates"("userId", "name", "type");
