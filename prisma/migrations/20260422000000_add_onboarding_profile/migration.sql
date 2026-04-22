-- CreateTable
CREATE TABLE "onboarding_profiles" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "primaryLeadSource" TEXT,
    "secondaryLeadSources" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "weeklyLeadVolume" TEXT,
    "serviceType" TEXT,
    "serviceTypeOther" TEXT,
    "step1CompletedAt" TIMESTAMP(3),
    "responseSpeed" TEXT,
    "missedLeadOutcome" TEXT,
    "avgJobValue" TEXT,
    "userGoal" TEXT,
    "step2CompletedAt" TIMESTAMP(3),
    "step2SkippedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "onboarding_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "onboarding_profiles_userId_key" ON "onboarding_profiles"("userId");

-- AddForeignKey
ALTER TABLE "onboarding_profiles" ADD CONSTRAINT "onboarding_profiles_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
