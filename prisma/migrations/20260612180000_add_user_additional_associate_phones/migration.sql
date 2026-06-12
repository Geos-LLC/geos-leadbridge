-- AlterTable: user-scoped JSON column holding additional Thumbtack associate
-- phone numbers (team members / extra callback lines). Each entry shape:
--   { id: string, phoneNumber: "+E164", label?: string }
-- Defaults NULL, so this is a metadata-only ADD COLUMN in PG11+ (non-blocking).
-- See User.additionalAssociatePhonesJson in prisma/schema.prisma for the
-- read/write contract.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "additional_associate_phones_json" JSONB;
