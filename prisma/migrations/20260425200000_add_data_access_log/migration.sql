-- Phase 2 — Data Access Log
-- See prisma/schema.prisma `DataAccessLog` for the contract.

CREATE TABLE "data_access_logs" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "actorRole" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "accessType" TEXT NOT NULL,
    "reason" TEXT,
    "route" TEXT,
    "method" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "data_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "data_access_logs_actorUserId_createdAt_idx" ON "data_access_logs"("actorUserId", "createdAt");
CREATE INDEX "data_access_logs_tenantId_createdAt_idx" ON "data_access_logs"("tenantId", "createdAt");
CREATE INDEX "data_access_logs_resourceType_resourceId_idx" ON "data_access_logs"("resourceType", "resourceId");
CREATE INDEX "data_access_logs_accessType_createdAt_idx" ON "data_access_logs"("accessType", "createdAt");
