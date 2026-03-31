-- Follow-Up Engine: 3 tables + ThreadContext additions
-- Fully reversible: DROP TABLE reverses, ALTER TABLE DROP COLUMN reverses

-- 1. FollowUpSequenceTemplate
CREATE TABLE "follow_up_sequence_templates" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerState" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'suggest',
    "generationMode" TEXT NOT NULL DEFAULT 'ai',
    "promptTemplateId" TEXT,
    "preset" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "active_hours_start" TEXT,
    "active_hours_end" TEXT,
    "active_hours_tz" TEXT DEFAULT 'America/New_York',
    "stepsJson" JSONB NOT NULL,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "follow_up_sequence_templates_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "follow_up_sequence_templates_userId_platform_triggerState_idx" ON "follow_up_sequence_templates"("userId", "platform", "triggerState");
CREATE INDEX "follow_up_sequence_templates_isDefault_platform_triggerState_idx" ON "follow_up_sequence_templates"("isDefault", "platform", "triggerState");
ALTER TABLE "follow_up_sequence_templates" ADD CONSTRAINT "follow_up_sequence_templates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. FollowUpEnrollment
CREATE TABLE "follow_up_enrollments" (
    "id" TEXT NOT NULL,
    "sequenceTemplateId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "leadId" TEXT,
    "platform" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "stoppedReason" TEXT,
    "currentStepIndex" INTEGER NOT NULL DEFAULT 0,
    "nextStepDueAt" TIMESTAMP(3),
    "mode" TEXT NOT NULL DEFAULT 'suggest',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastExecutedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "follow_up_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "follow_up_enrollments_status_nextStepDueAt_idx" ON "follow_up_enrollments"("status", "nextStepDueAt");
CREATE INDEX "follow_up_enrollments_conversationId_status_idx" ON "follow_up_enrollments"("conversationId", "status");
CREATE INDEX "follow_up_enrollments_leadId_idx" ON "follow_up_enrollments"("leadId");
ALTER TABLE "follow_up_enrollments" ADD CONSTRAINT "follow_up_enrollments_sequenceTemplateId_fkey" FOREIGN KEY ("sequenceTemplateId") REFERENCES "follow_up_sequence_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follow_up_enrollments" ADD CONSTRAINT "follow_up_enrollments_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "follow_up_enrollments" ADD CONSTRAINT "follow_up_enrollments_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. FollowUpStepExecution
CREATE TABLE "follow_up_step_executions" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL,
    "objective" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'scheduled',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "executedAt" TIMESTAMP(3),
    "generatedMessage" TEXT,
    "finalMessage" TEXT,
    "messageId" TEXT,
    "strategyUsed" TEXT,
    "metadataJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "follow_up_step_executions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "follow_up_step_executions_enrollmentId_stepIndex_idx" ON "follow_up_step_executions"("enrollmentId", "stepIndex");
CREATE INDEX "follow_up_step_executions_status_idx" ON "follow_up_step_executions"("status");
ALTER TABLE "follow_up_step_executions" ADD CONSTRAINT "follow_up_step_executions_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "follow_up_enrollments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. ThreadContext additions (cached fields — not source of truth)
ALTER TABLE "thread_contexts" ADD COLUMN "activeEnrollmentId" TEXT;
ALTER TABLE "thread_contexts" ADD COLUMN "nextFollowUpAt" TIMESTAMP(3);
ALTER TABLE "thread_contexts" ADD COLUMN "waitingSince" TIMESTAMP(3);
ALTER TABLE "thread_contexts" ADD COLUMN "followUpState" TEXT;
