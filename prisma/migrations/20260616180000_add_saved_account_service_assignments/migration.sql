-- PR-E — account ↔ service assignment layer.
--
-- Additive, nullable column. Existing rows stay NULL until an operator
-- explicitly assigns services to an account via the new Manage
-- Availability surface. NULL preserves the current resolver behavior
-- (pure category matching), so this migration is a pure no-op for any
-- tenant that hasn't configured assignments yet.
ALTER TABLE "SavedAccount"
  ADD COLUMN "serviceProfileAssignmentsJson" TEXT;
