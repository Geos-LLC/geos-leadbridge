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
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import OpenAI from 'openai';

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
  private _openai: OpenAI | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private get openai(): OpenAI | null {
    if (!this._openai) {
      const apiKey = this.configService.get<string>('OPENAI_API_KEY');
      if (!apiKey) return null;
      this._openai = new OpenAI({ apiKey });
    }
    return this._openai;
  }

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

    // Post-update hooks (non-blocking)
    // State extraction: runs on every message
    this.updateState(conversationId, { sender, content }).catch(err =>
      this.logger.warn(`State update failed for ${conversationId}: ${err.message}`),
    );
    // Summary: runs every 3 messages (throttled inside updateSummary)
    this.updateSummary(conversationId).catch(err =>
      this.logger.warn(`Summary update failed for ${conversationId}: ${err.message}`),
    );
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

  // ==========================================
  // Phase 2: Context Builder + Updaters
  // ==========================================

  /**
   * Build AI-ready prompt context for a conversation.
   * Returns a compact context object that replaces sending the full transcript.
   * Uses: summary (if available) + structured state + recent N messages.
   */
  async buildContext(conversationId: string, options?: {
    recentMessageLimit?: number;
    includeLeadDetails?: boolean;
  }): Promise<{
    systemContext: string;
    recentMessages: Array<{ role: 'customer' | 'pro'; content: string }>;
    threadState: Record<string, any>;
  } | null> {
    const ctx = await this.getContext(conversationId, options?.recentMessageLimit ?? 10);
    if (!ctx) return null;

    // Build system context string for AI prompt injection
    const parts: string[] = ['--- Thread Context ---'];

    if (ctx.summary) {
      parts.push(`Conversation summary: ${ctx.summary}`);
    }

    parts.push(`Stage: ${ctx.stage}`);
    if (ctx.engagementLevel !== 'unknown') parts.push(`Customer engagement: ${ctx.engagementLevel}`);
    if (ctx.activeStrategy) parts.push(`Active strategy: ${ctx.activeStrategy}`);
    if (ctx.priceDiscussed) parts.push(`Price discussed: ${ctx.priceRange || 'yes'}`);
    if (ctx.lastQuestionAsked) parts.push(`Last question asked: ${ctx.lastQuestionAsked}`);
    if (ctx.missingFields.length > 0) parts.push(`Missing information: ${ctx.missingFields.join(', ')}`);
    if (ctx.awaitingCustomerReply) parts.push('Status: awaiting customer reply');
    if (ctx.followUpCount > 0) parts.push(`Follow-ups sent: ${ctx.followUpCount}`);

    parts.push(`Messages: ${ctx.totalMessages} total (${ctx.customerMessages} customer, ${ctx.businessMessages} business, ${ctx.aiMessages} AI)`);
    parts.push('--- End Thread Context ---');

    // Convert recent messages to AI-ready format
    const recentMessages = ctx.recentMessages.map(m => ({
      role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
      content: m.content,
    }));

    // Build state object for programmatic access
    const threadState: Record<string, any> = {
      stage: ctx.stage,
      customerIntent: ctx.customerIntent,
      engagementLevel: ctx.engagementLevel,
      activeStrategy: ctx.activeStrategy,
      suggestedStrategy: ctx.suggestedStrategy,
      priceDiscussed: ctx.priceDiscussed,
      priceRange: ctx.priceRange,
      awaitingCustomerReply: ctx.awaitingCustomerReply,
      followUpCount: ctx.followUpCount,
      missingFields: ctx.missingFields,
      ...(ctx.state || {}),
    };

    return {
      systemContext: parts.join('\n'),
      recentMessages,
      threadState,
    };
  }

  /**
   * Update the rolling thread summary using AI.
   * Called after recordMessage when the conversation has enough messages.
   * Uses the last N messages + existing summary to generate an updated summary.
   */
  async updateSummary(conversationId: string): Promise<void> {
    if (!this.openai) {
      this.logger.debug('OpenAI not configured — skipping summary update');
      return;
    }

    const ctx = await this.prisma.threadContext.findUnique({
      where: { conversationId },
    });
    if (!ctx) return;

    // Only update summary every 3 messages to avoid excessive AI calls
    if (ctx.totalMessages < 2 || ctx.totalMessages % 3 !== 0) return;

    // Load recent messages for summarization
    const messages = await this.prisma.message.findMany({
      where: { conversationId },
      orderBy: { sentAt: 'asc' },
      take: 20, // last 20 messages max
      select: { sender: true, content: true, sentAt: true },
    });

    if (messages.length < 2) return;

    const transcript = messages
      .map(m => `${m.sender === 'customer' ? 'Customer' : 'Business'}: ${m.content}`)
      .join('\n');

    const existingSummary = ctx.summary ? `Previous summary: ${ctx.summary}\n\n` : '';

    try {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `You are a conversation analyst. Summarize the business-customer conversation in 2-3 sentences.
Focus on: customer intent, service requested, price discussed, unanswered questions, current next step.
Be factual and concise. This summary will be used as context for future AI responses.`,
          },
          {
            role: 'user',
            content: `${existingSummary}Recent messages:\n${transcript}\n\nWrite an updated summary:`,
          },
        ],
        max_tokens: 150,
        temperature: 0.3,
      });

      const summary = completion.choices[0]?.message?.content?.trim();
      if (summary) {
        await this.prisma.threadContext.update({
          where: { conversationId },
          data: { summary },
        });
        this.logger.log(`Summary updated for conversation ${conversationId} (${summary.length} chars)`);
      }
    } catch (err: any) {
      this.logger.warn(`Failed to update summary for ${conversationId}: ${err.message}`);
    }
  }

  /**
   * Update structured state from message content (rule-based v1).
   * Extracts: price mentions, questions asked, missing fields.
   * Called after recordMessage.
   */
  async updateState(conversationId: string, latestMessage: { sender: string; content: string }): Promise<void> {
    const ctx = await this.prisma.threadContext.findUnique({
      where: { conversationId },
    });
    if (!ctx) return;

    const content = latestMessage.content.toLowerCase();
    const updates: Record<string, any> = {};

    // Price detection
    const priceMatch = latestMessage.content.match(/\$\d[\d,]*(?:\.\d{2})?(?:\s*[-–]\s*\$?\d[\d,]*(?:\.\d{2})?)?/);
    if (priceMatch) {
      updates.priceDiscussed = true;
      updates.priceRange = priceMatch[0];
    }

    // Question detection (business asking customer)
    if (latestMessage.sender === 'pro' && latestMessage.content.includes('?')) {
      // Extract the last question from the message
      const questions = latestMessage.content.split(/[.!]\s+/).filter(s => s.includes('?'));
      if (questions.length > 0) {
        updates.lastQuestionAsked = questions[questions.length - 1].trim();
      }
    }

    // Missing fields detection (rule-based patterns)
    const missingFields: string[] = [];
    const fieldPatterns: Record<string, RegExp[]> = {
      bedrooms: [/how many bed/i, /number of bed/i, /bedrooms\??/i],
      bathrooms: [/how many bath/i, /number of bath/i, /bathrooms\??/i],
      schedule: [/when would/i, /what day/i, /preferred date/i, /when do you need/i],
      phone: [/phone number/i, /best number/i, /reach you/i, /call you/i],
      address: [/address/i, /where.*located/i, /exact location/i],
      budget: [/budget/i, /price range/i, /how much.*willing/i],
    };

    // If business asked about a field, it's missing
    if (latestMessage.sender === 'pro') {
      for (const [field, patterns] of Object.entries(fieldPatterns)) {
        if (patterns.some(p => p.test(latestMessage.content))) {
          missingFields.push(field);
        }
      }
    }

    // If customer provided info, remove from missing fields
    if (latestMessage.sender === 'customer' && ctx.missingFields) {
      const currentMissing = (ctx.missingFields as string[]) || [];
      const providedPatterns: Record<string, RegExp[]> = {
        bedrooms: [/\d+\s*bed/i, /bedroom/i],
        bathrooms: [/\d+\s*bath/i, /bathroom/i],
        phone: [/\d{3}[-.\s]?\d{3}[-.\s]?\d{4}/, /\(\d{3}\)/],
        schedule: [/monday|tuesday|wednesday|thursday|friday|saturday|sunday/i, /next week/i, /asap/i, /tomorrow/i],
        budget: [/\$\d/, /budget.*\d/i],
      };

      const stillMissing = currentMissing.filter(field => {
        const patterns = providedPatterns[field];
        if (!patterns) return true;
        return !patterns.some(p => p.test(latestMessage.content));
      });

      if (stillMissing.length !== currentMissing.length) {
        updates.missingFields = stillMissing;
      }
    }

    if (missingFields.length > 0) {
      const existing = (ctx.missingFields as string[]) || [];
      const merged = [...new Set([...existing, ...missingFields])];
      updates.missingFields = merged;
    }

    // Engagement level upgrade based on content signals
    if (latestMessage.sender === 'customer') {
      const hotSignals = [/book/i, /schedule/i, /ready/i, /let's do/i, /when can you/i, /hire/i, /yes/i, /sounds good/i, /perfect/i];
      const coldSignals = [/not interested/i, /too expensive/i, /no thanks/i, /maybe later/i, /never mind/i];

      if (hotSignals.some(p => p.test(latestMessage.content))) {
        updates.engagementLevel = 'hot';
      } else if (coldSignals.some(p => p.test(latestMessage.content))) {
        updates.engagementLevel = 'cold';
      }
    }

    // Stage progression based on content
    if (ctx.stage === 'qualification' && updates.priceDiscussed) {
      updates.stage = 'quoting';
    }

    // Build stateJson
    const currentState = ctx.stateJson ? JSON.parse(ctx.stateJson) : {};
    const newState = { ...currentState };
    if (updates.priceDiscussed) newState.priceDiscussed = true;
    if (updates.priceRange) newState.priceRange = updates.priceRange;
    if (updates.lastQuestionAsked) newState.lastQuestionAsked = updates.lastQuestionAsked;
    if (updates.engagementLevel) newState.engagementLevel = updates.engagementLevel;
    updates.stateJson = JSON.stringify(newState);

    if (Object.keys(updates).length > 1) { // > 1 because stateJson is always set
      await this.prisma.threadContext.update({
        where: { conversationId },
        data: updates,
      });
    }
  }
}
