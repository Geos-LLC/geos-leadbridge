-- CreateTable: thread_contexts (Conversation Context intelligence layer)
CREATE TABLE "thread_contexts" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "leadId" TEXT,
    "platform" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "customerIntent" TEXT,
    "engagementLevel" TEXT NOT NULL DEFAULT 'unknown',
    "activeStrategy" TEXT,
    "suggestedStrategy" TEXT,
    "summary" TEXT,
    "stateJson" TEXT,
    "priceDiscussed" BOOLEAN NOT NULL DEFAULT false,
    "priceRange" TEXT,
    "lastQuestionAsked" TEXT,
    "missingFields" JSONB,
    "awaitingCustomerReply" BOOLEAN NOT NULL DEFAULT false,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lastFollowUpAt" TIMESTAMP(3),
    "followUpStatus" TEXT,
    "lastCustomerMessageAt" TIMESTAMP(3),
    "lastBusinessMessageAt" TIMESTAMP(3),
    "lastAiMessageAt" TIMESTAMP(3),
    "totalMessages" INTEGER NOT NULL DEFAULT 0,
    "customerMessages" INTEGER NOT NULL DEFAULT 0,
    "businessMessages" INTEGER NOT NULL DEFAULT 0,
    "aiMessages" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "thread_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "thread_contexts_conversationId_key" ON "thread_contexts"("conversationId");
CREATE INDEX "thread_contexts_leadId_idx" ON "thread_contexts"("leadId");
CREATE INDEX "thread_contexts_platform_idx" ON "thread_contexts"("platform");
CREATE INDEX "thread_contexts_stage_idx" ON "thread_contexts"("stage");
CREATE INDEX "thread_contexts_awaitingCustomerReply_idx" ON "thread_contexts"("awaitingCustomerReply");
CREATE INDEX "thread_contexts_updatedAt_idx" ON "thread_contexts"("updatedAt");

-- AddForeignKey
ALTER TABLE "thread_contexts" ADD CONSTRAINT "thread_contexts_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "thread_contexts" ADD CONSTRAINT "thread_contexts_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
