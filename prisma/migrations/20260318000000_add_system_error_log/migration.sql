-- CreateTable
CREATE TABLE "system_error_logs" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'error',
    "message" TEXT NOT NULL,
    "context" TEXT,
    "userId" TEXT,
    "accountId" TEXT,
    "accountName" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "emailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_error_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "system_error_logs_category_createdAt_idx" ON "system_error_logs"("category", "createdAt");

-- CreateIndex
CREATE INDEX "system_error_logs_resolved_createdAt_idx" ON "system_error_logs"("resolved", "createdAt");

-- CreateIndex
CREATE INDEX "system_error_logs_userId_createdAt_idx" ON "system_error_logs"("userId", "createdAt");
