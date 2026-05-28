-- Phase 2C PR-C2 — additive S4 provisioning payload fields.
--
-- Three new nullable columns to hold values SF returns at exchange
-- time. All three are info-only / observability today; signatureKeyId
-- becomes load-bearing when SF rotates its inbound-webhook signing
-- key and we need to disambiguate which key signed a given push.

ALTER TABLE "sf_connections"
  ADD COLUMN IF NOT EXISTS "sourceInstance"  TEXT,
  ADD COLUMN IF NOT EXISTS "apiRegion"       TEXT,
  ADD COLUMN IF NOT EXISTS "signatureKeyId"  TEXT;
