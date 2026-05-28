-- Phase 2C PR-C2.1 — contract-alignment fields on sf_connections.
--
-- All additive, all nullable. Aligns LB-side storage with SF's S4
-- canonical provisioning payload.
--   tokenPrefix          — 13-char safe-to-log token prefix from SF
--   sfWorkspaceId        — distinct from sfTenantId in SF's model
--   endpointsJson        — SF-supplied paths for the 5 orchestration
--                          endpoints (JSON: { availability, booking_request,
--                          booking_cancel, handoff, disconnect })
--   signatureAlgorithm   — SF-declared inbound webhook HMAC algorithm
--                          (locked to 'hmac-sha256-hex' today)
--   maxClockSkewSeconds  — SF-declared timestamp skew window (locked 300)

ALTER TABLE "sf_connections"
  ADD COLUMN IF NOT EXISTS "tokenPrefix"          TEXT,
  ADD COLUMN IF NOT EXISTS "sfWorkspaceId"        TEXT,
  ADD COLUMN IF NOT EXISTS "endpointsJson"        TEXT,
  ADD COLUMN IF NOT EXISTS "signatureAlgorithm"   TEXT,
  ADD COLUMN IF NOT EXISTS "maxClockSkewSeconds"  INTEGER;
