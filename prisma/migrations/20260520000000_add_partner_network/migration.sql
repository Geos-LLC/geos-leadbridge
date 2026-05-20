-- Partner Network Beta: self-contained module for partner businesses to
-- exchange/sell qualified local leads via referral QR links + public intent
-- form. Designed as an isolated bounded context so it can be extracted into
-- a standalone product later. All tables use `workspaceId` (LeadBridge
-- userId for now) as a plain string instead of a foreign key into "users"
-- to keep the module portable.

-- CreateEnum
CREATE TYPE "PartnerLeadIntent" AS ENUM ('this_week', 'this_month', 'not_sure');
CREATE TYPE "PartnerLeadStatus" AS ENUM ('new', 'contacted', 'qualified', 'rejected', 'booked', 'paid_manually');

-- CreateTable: partner_businesses
CREATE TABLE "partner_businesses" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "serviceArea" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_businesses_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_businesses_workspaceId_idx" ON "partner_businesses"("workspaceId");

-- CreateTable: partner_relationships
CREATE TABLE "partner_relationships" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sourceBusinessId" TEXT NOT NULL,
    "destinationBusinessId" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultOfferText" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_relationships_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_relationships_workspaceId_idx" ON "partner_relationships"("workspaceId");
CREATE INDEX "partner_relationships_sourceBusinessId_idx" ON "partner_relationships"("sourceBusinessId");
CREATE INDEX "partner_relationships_destinationBusinessId_idx" ON "partner_relationships"("destinationBusinessId");

-- CreateTable: partner_referral_codes
CREATE TABLE "partner_referral_codes" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "sourceBusinessId" TEXT NOT NULL,
    "destinationBusinessId" TEXT NOT NULL,
    "partnerRelationshipId" TEXT,
    "employeeName" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "publicUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_referral_codes_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "partner_referral_codes_code_key" ON "partner_referral_codes"("code");
CREATE INDEX "partner_referral_codes_workspaceId_idx" ON "partner_referral_codes"("workspaceId");
CREATE INDEX "partner_referral_codes_code_idx" ON "partner_referral_codes"("code");
CREATE INDEX "partner_referral_codes_sourceBusinessId_idx" ON "partner_referral_codes"("sourceBusinessId");
CREATE INDEX "partner_referral_codes_destinationBusinessId_idx" ON "partner_referral_codes"("destinationBusinessId");

-- CreateTable: partner_leads
CREATE TABLE "partner_leads" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "referralCodeId" TEXT NOT NULL,
    "sourceBusinessId" TEXT NOT NULL,
    "destinationBusinessId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "notes" TEXT,
    "intentTiming" "PartnerLeadIntent" NOT NULL,
    "estimatedValue" INTEGER NOT NULL,
    "status" "PartnerLeadStatus" NOT NULL DEFAULT 'new',
    "possibleDuplicate" BOOLEAN NOT NULL DEFAULT false,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "partner_leads_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_leads_workspaceId_idx" ON "partner_leads"("workspaceId");
CREATE INDEX "partner_leads_referralCodeId_idx" ON "partner_leads"("referralCodeId");
CREATE INDEX "partner_leads_sourceBusinessId_idx" ON "partner_leads"("sourceBusinessId");
CREATE INDEX "partner_leads_destinationBusinessId_idx" ON "partner_leads"("destinationBusinessId");
CREATE INDEX "partner_leads_status_idx" ON "partner_leads"("status");
CREATE INDEX "partner_leads_destinationBusinessId_customerPhone_createdAt_idx" ON "partner_leads"("destinationBusinessId", "customerPhone", "createdAt");

-- AddForeignKey: partner_relationships
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_sourceBusinessId_fkey" FOREIGN KEY ("sourceBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_relationships" ADD CONSTRAINT "partner_relationships_destinationBusinessId_fkey" FOREIGN KEY ("destinationBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: partner_referral_codes
ALTER TABLE "partner_referral_codes" ADD CONSTRAINT "partner_referral_codes_sourceBusinessId_fkey" FOREIGN KEY ("sourceBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_referral_codes" ADD CONSTRAINT "partner_referral_codes_destinationBusinessId_fkey" FOREIGN KEY ("destinationBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_referral_codes" ADD CONSTRAINT "partner_referral_codes_partnerRelationshipId_fkey" FOREIGN KEY ("partnerRelationshipId") REFERENCES "partner_relationships"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: partner_leads
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_referralCodeId_fkey" FOREIGN KEY ("referralCodeId") REFERENCES "partner_referral_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_sourceBusinessId_fkey" FOREIGN KEY ("sourceBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "partner_leads" ADD CONSTRAINT "partner_leads_destinationBusinessId_fkey" FOREIGN KEY ("destinationBusinessId") REFERENCES "partner_businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
