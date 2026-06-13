-- CreateTable: append-only audit log for AI Settings Assistant writes.
-- One row per successful /v1/ai-settings-assistant/apply call. Records
-- the original natural-language request, the storage target, and the
-- raw before/after value strings so we can both trace and roll back a
-- specific change. See SettingsChangeAuditLog in prisma/schema.prisma
-- for the read/write contract and the area/target enum-string values.

CREATE TABLE "settings_change_audit_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "savedAccountId" TEXT,
    "area" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "userMessage" TEXT NOT NULL,
    "proposalSummary" TEXT NOT NULL,
    "beforeValue" TEXT,
    "afterValue" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_change_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "settings_change_audit_logs_userId_createdAt_idx"
    ON "settings_change_audit_logs"("userId", "createdAt");

CREATE INDEX "settings_change_audit_logs_savedAccountId_idx"
    ON "settings_change_audit_logs"("savedAccountId");

ALTER TABLE "settings_change_audit_logs"
    ADD CONSTRAINT "settings_change_audit_logs_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
