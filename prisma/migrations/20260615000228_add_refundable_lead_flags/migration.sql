-- CreateTable
-- Per-lead "possibly refundable" flag. See prisma/schema.prisma model comment
-- for full lifecycle. Status is DERIVED: a flag is active when
-- validUntil > now AND Lead.refundedAt IS NULL.
CREATE TABLE "refundable_lead_flags" (
  "id"              TEXT NOT NULL,
  "leadId"          TEXT NOT NULL,
  "userId"          TEXT NOT NULL,
  "ruleId"          TEXT NOT NULL,
  "confidence"      TEXT NOT NULL,
  "evidenceSummary" TEXT NOT NULL,
  "evidenceJson"    TEXT,
  "detectedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil"      TIMESTAMP(3) NOT NULL,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "refundable_lead_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- One flag per (lead, rule). Detector upserts; re-runs are no-ops.
CREATE UNIQUE INDEX "refundable_lead_flags_leadId_ruleId_key"
  ON "refundable_lead_flags"("leadId", "ruleId");

-- CreateIndex
-- Primary list query — "tenant's currently-active flags".
CREATE INDEX "refundable_lead_flags_userId_validUntil_idx"
  ON "refundable_lead_flags"("userId", "validUntil");

-- CreateIndex
CREATE INDEX "refundable_lead_flags_leadId_idx"
  ON "refundable_lead_flags"("leadId");

-- AddForeignKey
ALTER TABLE "refundable_lead_flags"
  ADD CONSTRAINT "refundable_lead_flags_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refundable_lead_flags"
  ADD CONSTRAINT "refundable_lead_flags_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Composite indexes on leads to support the detector's duplicate scans.
-- Without these, scanning ~1500 leads per detector tick would full-scan.
-- Non-blocking ADD INDEX in PG11+ (uses CONCURRENTLY would be safer for
-- huge tables; ours is small enough that a brief lock is fine).
CREATE INDEX "leads_userId_customerPhone_businessId_createdAt_idx"
  ON "leads"("userId", "customerPhone", "businessId", "createdAt");

CREATE INDEX "leads_userId_category_postcode_createdAt_idx"
  ON "leads"("userId", "category", "postcode", "createdAt");
