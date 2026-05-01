-- Phase 1 observability: persist outbound CRM deliveries + capture inbound processing errors.
-- See plans/2026-04-17-job-sync-sf-lb.md and the Phase 1 spec.

-- AlterTable
ALTER TABLE "sf_inbound_events" ADD COLUMN "processingError" TEXT;

-- CreateTable
CREATE TABLE "crm_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "crm_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "crm_webhook_deliveries_eventId_idx" ON "crm_webhook_deliveries"("eventId");
