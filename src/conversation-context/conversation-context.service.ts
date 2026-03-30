/**
 * Conversation Context Service
 *
 * Core intelligence service for per-thread conversation memory.
 * Manages ThreadContext records: creation, updates, context retrieval.
 *
 * Public API (consumed by webhook handlers, automation, AI service):
 *   - recordMessage()   — update thread context after a message is stored
 *   - getContext()       — retrieve full context for AI prompt generation
 *   - getThreadState()   — quick read of structured state
 *
 * Internal (called by recordMessage):
 *   - updateMessageStats()
 *   - updateStage()       (rule-based, v1)
 *   - updateSummary()     (AI-powered, Phase 2)
 *   - updateState()       (Phase 2)
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

/** Input when recording a new message in the thread */
export interface RecordMessageInput {
  conversationId: string;
  leadId?: string;
  platform: string;
  sender: 'customer' | 'pro' | 'system';
  senderType?: 'customer' | 'business' | 'ai' | 'user' | 'system';
  content: string;
  aiGenerated?: boolean;
  strategyUsed?: string;
  isAutoFollowUp?: boolean;
  timestamp?: Date;
}

/** Thread context returned for AI prompt generation */
export interface ThreadContextView {
  conversationId: string;
  leadId: string | null;
  platform: string;

  // Stage & strategy
  stage: string;
  customerIntent: string | null;
  engagementLevel: string;
  activeStrategy: string | null;
  suggestedStrategy: string | null;

  // Summary & state
  summary: string | null;
  state: Record<string, any> | null;

  // Progress
  priceDiscussed: boolean;
  priceRange: string | null;
  lastQuestionAsked: string | null;
  missingFields: string[];
  awaitingCustomerReply: boolean;

  // Follow-up
  followUpCount: number;
  followUpStatus: string | null;

  // Stats
  totalMessages: number;
  customerMessages: number;
  businessMessages: number;
  aiMessages: number;

  // Timestamps
  lastCustomerMessageAt: Date | null;
  lastBusinessMessageAt: Date | null;
  lastAiMessageAt: Date | null;

  // Recent messages (for AI prompt — loaded separately from Message table)
  recentMessages: Array<{
    sender: string;
    content: string;
    sentAt: Date;
    aiGenerated?: boolean;
  }>;
}

@Injectable()
export class ConversationContextService {
  private readonly logger = new Logger(ConversationContextService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ==========================================
  // Public API
  // ==========================================

  /**
   * Record a message in the thread context.
   * Called by webhook handlers after storing the message in the Message table.
   * Creates ThreadContext if it doesn't exist, updates stats and timestamps.
   */
  async recordMessage(input: RecordMessageInput): Promise<void> {
    const { conversationId, leadId, platform, sender, senderType, content, aiGenerated, isAutoFollowUp, timestamp } = input;
    const now = timestamp || new Date();

    // Determine message category for stats
    const isCustomer = sender === 'customer';
    const isAi = aiGenerated || senderType === 'ai';
    const isBusiness = sender === 'pro' && !isAi;

    // Upsert ThreadContext — create on first message, update on subsequent
    const existing = await this.prisma.threadContext.findUnique({
      where: { conversationId },
    });

    if (!existing) {
      // First message in this thread — create context
      await this.prisma.threadContext.create({
        data: {
          conversationId,
          leadId: leadId || null,
          platform,
          stage: 'new',
          engagementLevel: isCustomer ? 'warm' : 'unknown',
          awaitingCustomerReply: !isCustomer,
          totalMessages: 1,
          customerMessages: isCustomer ? 1 : 0,
          businessMessages: isBusiness ? 1 : 0,
          aiMessages: isAi ? 1 : 0,
          followUpCount: isAutoFollowUp ? 1 : 0,
          lastFollowUpAt: isAutoFollowUp ? now : null,
          lastCustomerMessageAt: isCustomer ? now : null,
          lastBusinessMessageAt: isBusiness ? now : null,
          lastAiMessageAt: isAi ? now : null,
          ...(input.strategyUsed && { activeStrategy: input.strategyUsed }),
        },
      });
      this.logger.log(`ThreadContext created for conversation ${conversationId} (${platform})`);
      return;
    }

    // Update existing context
    const updates: Record<string, any> = {
      totalMessages: { increment: 1 },
      awaitingCustomerReply: !isCustomer, // flip: if customer just spoke, we're NOT awaiting
    };

    if (isCustomer) {
      updates.customerMessages = { increment: 1 };
      updates.lastCustomerMessageAt = now;
      // Customer replied → engagement level at least warm
      if (existing.engagementLevel === 'cold' || existing.engagementLevel === 'unknown') {
        updates.engagementLevel = 'warm';
      }
    }
    if (isBusiness) {
      updates.businessMessages = { increment: 1 };
      updates.lastBusinessMessageAt = now;
    }
    if (isAi) {
      updates.aiMessages = { increment: 1 };
      updates.lastAiMessageAt = now;
    }
    if (isAutoFollowUp) {
      updates.followUpCount = { increment: 1 };
      updates.lastFollowUpAt = now;
      updates.followUpStatus = 'sent';
    }
    if (input.strategyUsed) {
      updates.activeStrategy = input.strategyUsed;
    }

    // Stage progression (rule-based v1)
    if (existing.stage === 'new' && (isBusiness || isAi)) {
      updates.stage = 'qualification'; // business responded → moved past "new"
    }

    // Link to lead if not already linked
    if (leadId && !existing.leadId) {
      updates.leadId = leadId;
    }

    await this.prisma.threadContext.update({
      where: { conversationId },
      data: updates,
    });
  }

  /**
   * Get full thread context for AI prompt generation.
   * Includes summary, state, stats, and recent messages.
   */
  async getContext(conversationId: string, recentMessageLimit = 10): Promise<ThreadContextView | null> {
    const ctx = await this.prisma.threadContext.findUnique({
      where: { conversationId },
    });

    if (!ctx) return null;

    // Load recent messages from the operational Message table
    const recentMessages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'desc' },
      take: recentMessageLimit,
      select: {
        sender: true,
        content: true,
        sentAt: true,
        rawJson: true,
      },
    });

    // Parse stateJson
    let state: Record<string, any> | null = null;
    if (ctx.stateJson) {
      try { state = JSON.parse(ctx.stateJson); } catch { /* invalid JSON */ }
    }

    return {
      conversationId: ctx.conversationId,
      leadId: ctx.leadId,
      platform: ctx.platform,
      stage: ctx.stage,
      customerIntent: ctx.customerIntent,
      engagementLevel: ctx.engagementLevel,
      activeStrategy: ctx.activeStrategy,
      suggestedStrategy: ctx.suggestedStrategy,
      summary: ctx.summary,
      state,
      priceDiscussed: ctx.priceDiscussed,
      priceRange: ctx.priceRange,
      lastQuestionAsked: ctx.lastQuestionAsked,
      missingFields: (ctx.missingFields as string[]) || [],
      awaitingCustomerReply: ctx.awaitingCustomerReply,
      followUpCount: ctx.followUpCount,
      followUpStatus: ctx.followUpStatus,
      totalMessages: ctx.totalMessages,
      customerMessages: ctx.customerMessages,
      businessMessages: ctx.businessMessages,
      aiMessages: ctx.aiMessages,
      lastCustomerMessageAt: ctx.lastCustomerMessageAt,
      lastBusinessMessageAt: ctx.lastBusinessMessageAt,
      lastAiMessageAt: ctx.lastAiMessageAt,
      recentMessages: recentMessages.reverse().map(m => ({
        sender: m.sender,
        content: m.content || '',
        sentAt: m.sentAt,
      })),
    };
  }

  /**
   * Quick read of thread state (no message loading).
   * For automation decisions that don't need full context.
   */
  async getThreadState(conversationId: string): Promise<{
    stage: string;
    awaitingCustomerReply: boolean;
    followUpCount: number;
    engagementLevel: string;
    activeStrategy: string | null;
  } | null> {
    return this.prisma.threadContext.findUnique({
      where: { conversationId },
      select: {
        stage: true,
        awaitingCustomerReply: true,
        followUpCount: true,
        engagementLevel: true,
        activeStrategy: true,
      },
    });
  }

  /**
   * Update thread stage manually (e.g., from lead status change).
   */
  async updateStage(conversationId: string, stage: string): Promise<void> {
    await this.prisma.threadContext.updateMany({
      where: { conversationId },
      data: { stage },
    });
  }

  /**
   * Update strategy for a thread.
   */
  async updateStrategy(conversationId: string, activeStrategy: string, suggestedStrategy?: string): Promise<void> {
    await this.prisma.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeStrategy,
        ...(suggestedStrategy !== undefined && { suggestedStrategy }),
      },
    });
  }

  /**
   * Get all thread contexts for a user (for dashboard/admin).
   */
  async getThreadContextsForUser(userId: string, filters?: { platform?: string; stage?: string }): Promise<any[]> {
    return this.prisma.threadContext.findMany({
      where: {
        conversation: { userId },
        ...(filters?.platform && { platform: filters.platform }),
        ...(filters?.stage && { stage: filters.stage }),
      },
      include: {
        conversation: {
          select: { customerName: true, lastMessageAt: true, status: true },
        },
        lead: {
          select: { id: true, businessId: true, category: true, status: true },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }
}
