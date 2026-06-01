-- CreateTable: SF provisioning link_token single-use tracking.
-- Inserted by SfProvisioningService when consuming a link_token. The
-- primary-key constraint on `nonce` is the race-safety guarantee — two
-- concurrent provision calls with the same nonce: one wins the insert,
-- the other gets a unique-constraint violation and is rejected as a
-- replay.
CREATE TABLE "sf_provisioning_link_consumed" (
  "nonce"      TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "consumedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"  TIMESTAMP(3) NOT NULL,

  CONSTRAINT "sf_provisioning_link_consumed_pkey" PRIMARY KEY ("nonce")
);

-- CreateIndex: lets a future cleanup job (or lazy on-write delete) cheaply
-- find expired rows for purge. Not strictly needed for correctness — the
-- JWT also carries `exp` and is validated on every provision call.
CREATE INDEX "sf_provisioning_link_consumed_expiresAt_idx"
  ON "sf_provisioning_link_consumed" ("expiresAt");
