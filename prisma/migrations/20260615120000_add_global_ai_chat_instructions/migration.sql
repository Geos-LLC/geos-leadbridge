-- Chat-added global instructions list. The AI Settings Assistant pushes
-- entries here so each can be deleted individually from the UI without
-- string-matching back into the freeform `global_ai_prompt` column.
ALTER TABLE "users"
  ADD COLUMN "global_ai_chat_instructions_json" JSONB;
