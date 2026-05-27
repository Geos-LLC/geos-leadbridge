-- Phase 2C PR-C1 — SF Connection foundation.
--
-- Additive new table `sf_connections`. Zero rows on first deploy.
-- Resolver falls through to env canary when no active row matches —
-- behavior bit-identical to current PR-B2 dark-launch for every tenant
-- until a row is created (which requires PR-C2 endpoints, not in this PR).

CREATE TABLE "sf_connections" (
  "id"                          TEXT NOT NULL,
  "userId"                      TEXT NOT NULL,

  -- SF-issued tenant identity
  "sfTenantId"                  TEXT NOT NULL,
  "sfTenantName"                TEXT,
  "baseUrl"                     TEXT NOT NULL,

  -- Current SF-issued authority token (opaque to LB; encrypted)
  "orchestrationToken"          TEXT NOT NULL,
  "orchestrationTokenKid"       TEXT,
  "orchestrationTokenScope"     TEXT,
  "tokenIssuedAt"               TIMESTAMP(3) NOT NULL,
  "tokenExpiresAt"              TIMESTAMP(3),
  "tokenLastReceivedAt"         TIMESTAMP(3) NOT NULL,
  "tokenLastRotationSource"     TEXT,

  -- Rotation grace window (5-min overlap during sf_push rotation)
  "previousOrchestrationToken"  TEXT,
  "previousTokenExpiresAt"      TIMESTAMP(3),

  -- Inbound SF → LB linkage (1:1 with CrmWebhookSubscription)
  "inboundSubscriptionId"       TEXT,

  -- Feature scope
  "events"                      TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

  -- Lifecycle
  "isActive"                    BOOLEAN NOT NULL DEFAULT true,
  "status"                      TEXT NOT NULL DEFAULT 'pending',
  "disconnectInitiator"         TEXT,
  "lastHealthAt"                TIMESTAMP(3),
  "lastHealthOk"                BOOLEAN,
  "lastErrorAt"                 TIMESTAMP(3),
  "lastErrorMessage"            TEXT,

  -- Audit
  "connectedAt"                 TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "disconnectedAt"              TIMESTAMP(3),
  "updatedAt"                   TIMESTAMP(3) NOT NULL,

  CONSTRAINT "sf_connections_pkey" PRIMARY KEY ("id")
);

-- 1:1 with User
CREATE UNIQUE INDEX "sf_connections_userId_key" ON "sf_connections"("userId");

-- 1:1 with CrmWebhookSubscription (nullable; set during handshake)
CREATE UNIQUE INDEX "sf_connections_inboundSubscriptionId_key"
  ON "sf_connections"("inboundSubscriptionId");

-- Lifecycle indexes for resolver + cleanup cron
CREATE INDEX "sf_connections_status_idx" ON "sf_connections"("status");
CREATE INDEX "sf_connections_isActive_idx" ON "sf_connections"("isActive");
CREATE INDEX "sf_connections_tokenExpiresAt_idx" ON "sf_connections"("tokenExpiresAt");
CREATE INDEX "sf_connections_previousTokenExpiresAt_idx" ON "sf_connections"("previousTokenExpiresAt");

-- FKs
ALTER TABLE "sf_connections"
  ADD CONSTRAINT "sf_connections_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sf_connections"
  ADD CONSTRAINT "sf_connections_inboundSubscriptionId_fkey"
  FOREIGN KEY ("inboundSubscriptionId") REFERENCES "crm_webhook_subscriptions"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
