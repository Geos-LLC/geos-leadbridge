-- AlterTable: add SF rotation-notification fields (R1).
-- All columns are additive + nullable / default false so existing rows
-- continue to work unchanged. The webhook handler for credential.rotated
-- populates these on notification-shape deliveries; the resolver consults
-- them to surface rotation_pending state and to alert near grace expiry.
ALTER TABLE "sf_connections"
  ADD COLUMN "rotationPending"               BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "pendingRotationKid"            TEXT,
  ADD COLUMN "pendingRotationCredId"         TEXT,
  ADD COLUMN "pendingRotationGraceExpiresAt" TIMESTAMP(3),
  ADD COLUMN "pendingRotationObservedAt"     TIMESTAMP(3);

-- CreateIndex: lets the resolver / monitor cheaply scan for pending
-- rotations approaching grace expiry without a sequential scan.
CREATE INDEX "sf_connections_rotationPending_pendingRotationGraceExpiresA_idx"
  ON "sf_connections" ("rotationPending", "pendingRotationGraceExpiresAt");
