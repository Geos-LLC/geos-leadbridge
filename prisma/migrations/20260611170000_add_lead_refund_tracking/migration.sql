-- AlterTable: refund / billing tracking on Lead.
-- chargeStateRaw : platform's raw value ('Refunded' | 'Charged' | 'Pending')
-- refundedAt     : observed-refunded timestamp (set together with chargeStateRaw='Refunded')
-- budgetVoidedAt : analytics gate — when set, leadPrice/budget is excluded from cost queries
--
-- All three default NULL so this is a metadata-only ADD COLUMN in PG11+ (non-blocking).
ALTER TABLE "leads"
  ADD COLUMN "chargeStateRaw" TEXT,
  ADD COLUMN "refundedAt"     TIMESTAMP(3),
  ADD COLUMN "budgetVoidedAt" TIMESTAMP(3);

-- Partial index supports analytics queries that filter "WHERE refundedAt IS NULL"
-- without scanning the whole table. Also supports operator reports that pull
-- refunded leads explicitly.
CREATE INDEX "leads_refundedAt_idx" ON "leads" ("refundedAt") WHERE "refundedAt" IS NOT NULL;
CREATE INDEX "leads_budgetVoidedAt_idx" ON "leads" ("budgetVoidedAt") WHERE "budgetVoidedAt" IS NOT NULL;
