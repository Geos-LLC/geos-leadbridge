-- Phase 3 — Support Grant
-- Time-bound, scope-limited authorization for admin reads of customer data.
-- See prisma/schema.prisma `SupportGrant` for the contract.

CREATE TABLE "support_grants" (
    "id" TEXT NOT NULL,
    "adminUserId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "scopes" TEXT[],
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "support_grants_adminUserId_expiresAt_idx" ON "support_grants"("adminUserId", "expiresAt");
CREATE INDEX "support_grants_tenantId_expiresAt_idx" ON "support_grants"("tenantId", "expiresAt");
