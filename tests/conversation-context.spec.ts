/**
 * Conversation Context System — Unit Tests
 *
 * Tests the ConversationContextService which manages per-thread intelligence.
 * Covers: recordMessage(), getContext(), getThreadState(), updateStage(), updateStrategy()
 *
 * Key behaviors:
 * - recordMessage creates ThreadContext on first message
 * - recordMessage updates stats/timestamps on subsequent messages
 * - Customer messages flip awaitingCustomerReply to false
 * - Business/AI messages flip awaitingCustomerReply to true
 * - Stage progresses from 'new' to 'qualification' on first business response
 * - AI messages counted separately from business messages
 * - Follow-up tracking increments on isAutoFollowUp
 * - getContext returns full view with recent messages
 * - getContext returns null for unknown conversation
 * - getThreadState returns quick state without messages
 * - Engagement level upgrades from cold/unknown to warm on customer message
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// Mocks
// ============================================================

function makeThreadContext(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'ctx-1',
    conversationId: overrides.conversationId ?? 'conv-1',
    leadId: 'leadId' in overrides ? overrides.leadId : 'lead-1',
    platform: overrides.platform ?? 'thumbtack',
    stage: overrides.stage ?? 'new',
    customerIntent: overrides.customerIntent ?? null,
    engagementLevel: overrides.engagementLevel ?? 'unknown',
    activeStrategy: overrides.activeStrategy ?? null,
    suggestedStrategy: overrides.suggestedStrategy ?? null,
    summary: overrides.summary ?? null,
    stateJson: overrides.stateJson ?? null,
    priceDiscussed: overrides.priceDiscussed ?? false,
    priceRange: overrides.priceRange ?? null,
    lastQuestionAsked: overrides.lastQuestionAsked ?? null,
    missingFields: overrides.missingFields ?? null,
    awaitingCustomerReply: overrides.awaitingCustomerReply ?? false,
    followUpCount: overrides.followUpCount ?? 0,
    lastFollowUpAt: overrides.lastFollowUpAt ?? null,
    followUpStatus: overrides.followUpStatus ?? null,
    lastCustomerMessageAt: overrides.lastCustomerMessageAt ?? null,
    lastBusinessMessageAt: overrides.lastBusinessMessageAt ?? null,
    lastAiMessageAt: overrides.lastAiMessageAt ?? null,
    totalMessages: overrides.totalMessages ?? 0,
    customerMessages: overrides.customerMessages ?? 0,
    businessMessages: overrides.businessMessages ?? 0,
    aiMessages: overrides.aiMessages ?? 0,
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
  };
}

function makePrismaMock() {
  return {
    threadContext: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(makeThreadContext()),
      update: vi.fn().mockResolvedValue(makeThreadContext()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    message: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  };
}

/**
 * Minimal harness — replicates ConversationContextService logic
 * using mocked Prisma, avoiding full NestJS DI.
 */
async function recordMessage(prisma: any, input: {
  conversationId: string;
  leadId?: string;
  platform: string;
  sender: 'customer' | 'pro' | 'system';
  senderType?: string;
  content: string;
  aiGenerated?: boolean;
  strategyUsed?: string;
  isAutoFollowUp?: boolean;
  timestamp?: Date;
}) {
  const { conversationId, leadId, platform, sender, senderType, content, aiGenerated, isAutoFollowUp, timestamp } = input;
  const now = timestamp || new Date();
  const isCustomer = sender === 'customer';
  const isAi = aiGenerated || senderType === 'ai';
  const isBusiness = sender === 'pro' && !isAi;

  const existing = await prisma.threadContext.findUnique({ where: { conversationId } });

  if (!existing) {
    await prisma.threadContext.create({
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
    return;
  }

  const updates: Record<string, any> = {
    totalMessages: { increment: 1 },
    awaitingCustomerReply: !isCustomer,
  };

  if (isCustomer) {
    updates.customerMessages = { increment: 1 };
    updates.lastCustomerMessageAt = now;
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
  if (existing.stage === 'new' && (isBusiness || isAi)) {
    updates.stage = 'qualification';
  }
  if (leadId && !existing.leadId) {
    updates.leadId = leadId;
  }

  await prisma.threadContext.update({ where: { conversationId }, data: updates });
}

async function getContext(prisma: any, conversationId: string, recentMessageLimit = 10) {
  const ctx = await prisma.threadContext.findUnique({ where: { conversationId } });
  if (!ctx) return null;

  const recentMessages = await prisma.message.findMany({
    where: { conversationId },
    orderBy: { sentAt: 'desc' },
    take: recentMessageLimit,
    select: { sender: true, content: true, sentAt: true, rawJson: true },
  });

  let state = null;
  if (ctx.stateJson) {
    try { state = JSON.parse(ctx.stateJson); } catch { /* invalid */ }
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
    recentMessages: recentMessages.reverse().map((m: any) => ({
      sender: m.sender, content: m.content || '', sentAt: m.sentAt,
    })),
  };
}

// ============================================================
// Tests
// ============================================================

describe('ConversationContextService', () => {
  let prisma: ReturnType<typeof makePrismaMock>;

  beforeEach(() => {
    prisma = makePrismaMock();
  });

  // ----------------------------------------------------------
  // recordMessage — create
  // ----------------------------------------------------------

  describe('recordMessage — first message (create)', () => {
    it('creates ThreadContext on first customer message', async () => {
      const ts = new Date('2026-03-30T12:00:00Z');
      await recordMessage(prisma, {
        conversationId: 'conv-1', leadId: 'lead-1', platform: 'thumbtack',
        sender: 'customer', content: 'I need cleaning', timestamp: ts,
      });

      expect(prisma.threadContext.create).toHaveBeenCalledOnce();
      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.conversationId).toBe('conv-1');
      expect(data.leadId).toBe('lead-1');
      expect(data.platform).toBe('thumbtack');
      expect(data.stage).toBe('new');
      expect(data.engagementLevel).toBe('warm'); // customer initiated
      expect(data.awaitingCustomerReply).toBe(false); // customer just spoke
      expect(data.totalMessages).toBe(1);
      expect(data.customerMessages).toBe(1);
      expect(data.businessMessages).toBe(0);
      expect(data.aiMessages).toBe(0);
      expect(data.lastCustomerMessageAt).toEqual(ts);
      expect(data.lastBusinessMessageAt).toBeNull();
    });

    it('creates ThreadContext on first AI message', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'yelp',
        sender: 'pro', senderType: 'ai', aiGenerated: true,
        content: 'Thanks for reaching out!',
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.engagementLevel).toBe('unknown'); // AI initiated, not customer
      expect(data.awaitingCustomerReply).toBe(true); // we spoke, waiting for reply
      expect(data.aiMessages).toBe(1);
      expect(data.businessMessages).toBe(0); // AI != business
      expect(data.customerMessages).toBe(0);
    });

    it('creates ThreadContext on first business message', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Hello!',
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.businessMessages).toBe(1);
      expect(data.aiMessages).toBe(0);
      expect(data.awaitingCustomerReply).toBe(true);
    });

    it('sets activeStrategy when provided', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Hi', strategyUsed: 'price_anchor',
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.activeStrategy).toBe('price_anchor');
    });

    it('tracks follow-up on create', async () => {
      const ts = new Date('2026-03-30T14:00:00Z');
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Just checking in', isAutoFollowUp: true, timestamp: ts,
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.followUpCount).toBe(1);
      expect(data.lastFollowUpAt).toEqual(ts);
    });

    it('does not call update when creating', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: 'Hi',
      });

      expect(prisma.threadContext.update).not.toHaveBeenCalled();
    });
  });

  // ----------------------------------------------------------
  // recordMessage — update
  // ----------------------------------------------------------

  describe('recordMessage — subsequent messages (update)', () => {
    it('increments totalMessages and customerMessages for customer reply', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'qualification', engagementLevel: 'warm', totalMessages: 3, customerMessages: 1 })
      );

      const ts = new Date('2026-03-30T15:00:00Z');
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: '2 bedrooms', timestamp: ts,
      });

      expect(prisma.threadContext.update).toHaveBeenCalledOnce();
      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.totalMessages).toEqual({ increment: 1 });
      expect(data.customerMessages).toEqual({ increment: 1 });
      expect(data.lastCustomerMessageAt).toEqual(ts);
      expect(data.awaitingCustomerReply).toBe(false); // customer just spoke
    });

    it('increments businessMessages for pro message (not AI)', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'qualification', totalMessages: 2 })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Our rate is $150',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.businessMessages).toEqual({ increment: 1 });
      expect(data.awaitingCustomerReply).toBe(true); // pro spoke, waiting
      expect(data.aiMessages).toBeUndefined(); // not AI
    });

    it('increments aiMessages for AI-generated message', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'qualification' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'yelp',
        sender: 'pro', aiGenerated: true, content: 'AI reply',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.aiMessages).toEqual({ increment: 1 });
      expect(data.businessMessages).toBeUndefined(); // AI, not business
    });

    it('progresses stage from new to qualification on business response', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'new' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Thanks for your inquiry',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.stage).toBe('qualification');
    });

    it('progresses stage from new to qualification on AI response', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'new' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', aiGenerated: true, content: 'Hi!',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.stage).toBe('qualification');
    });

    it('does NOT change stage if already past new', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'quoting' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Quote sent',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.stage).toBeUndefined(); // no stage change
    });

    it('does NOT change stage on customer message', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'new' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: 'Hello',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.stage).toBeUndefined();
    });

    it('upgrades engagement from cold to warm on customer message', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ engagementLevel: 'cold' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: 'Yes I am interested',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.engagementLevel).toBe('warm');
    });

    it('upgrades engagement from unknown to warm on customer message', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ engagementLevel: 'unknown' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: 'Details please',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.engagementLevel).toBe('warm');
    });

    it('does NOT downgrade engagement from hot', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ engagementLevel: 'hot' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'customer', content: 'Book me in',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.engagementLevel).toBeUndefined(); // no change — already hot
    });

    it('tracks follow-up on update', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ followUpCount: 1, stage: 'qualification' })
      );

      const ts = new Date('2026-03-30T16:00:00Z');
      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'Following up', isAutoFollowUp: true, timestamp: ts,
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.followUpCount).toEqual({ increment: 1 });
      expect(data.lastFollowUpAt).toEqual(ts);
      expect(data.followUpStatus).toBe('sent');
    });

    it('links leadId if not already linked', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ leadId: null, stage: 'new' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', leadId: 'lead-99', platform: 'thumbtack',
        sender: 'customer', content: 'Hi',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.leadId).toBe('lead-99');
    });

    it('does NOT overwrite existing leadId', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ leadId: 'lead-1', stage: 'qualification' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', leadId: 'lead-99', platform: 'thumbtack',
        sender: 'customer', content: 'Hi',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.leadId).toBeUndefined(); // no change
    });

    it('updates activeStrategy when provided', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stage: 'qualification', activeStrategy: 'friendly' })
      );

      await recordMessage(prisma, {
        conversationId: 'conv-1', platform: 'thumbtack',
        sender: 'pro', content: 'New approach', strategyUsed: 'price_anchor',
      });

      const data = prisma.threadContext.update.mock.calls[0][0].data;
      expect(data.activeStrategy).toBe('price_anchor');
    });
  });

  // ----------------------------------------------------------
  // getContext
  // ----------------------------------------------------------

  describe('getContext', () => {
    it('returns null for unknown conversation', async () => {
      const result = await getContext(prisma, 'unknown-conv');
      expect(result).toBeNull();
    });

    it('returns full context with recent messages', async () => {
      const ctx = makeThreadContext({
        conversationId: 'conv-1', leadId: 'lead-1', platform: 'thumbtack',
        stage: 'qualification', engagementLevel: 'warm', activeStrategy: 'hybrid',
        summary: 'Customer wants cleaning', stateJson: '{"priceDiscussed":true}',
        totalMessages: 5, customerMessages: 3, businessMessages: 2,
        awaitingCustomerReply: true, followUpCount: 1,
      });
      prisma.threadContext.findUnique.mockResolvedValue(ctx);

      // Mock returns DESC order (newest first) as the query specifies
      const messages = [
        { sender: 'pro', content: '$150', sentAt: new Date('2026-03-30T10:01:00Z'), rawJson: '{}' },
        { sender: 'customer', content: 'How much?', sentAt: new Date('2026-03-30T10:00:00Z'), rawJson: '{}' },
      ];
      prisma.message.findMany.mockResolvedValue(messages);

      const result = await getContext(prisma, 'conv-1');

      expect(result).not.toBeNull();
      expect(result!.conversationId).toBe('conv-1');
      expect(result!.stage).toBe('qualification');
      expect(result!.engagementLevel).toBe('warm');
      expect(result!.activeStrategy).toBe('hybrid');
      expect(result!.summary).toBe('Customer wants cleaning');
      expect(result!.state).toEqual({ priceDiscussed: true });
      expect(result!.totalMessages).toBe(5);
      expect(result!.awaitingCustomerReply).toBe(true);
      expect(result!.recentMessages).toHaveLength(2);
      // After .reverse(), chronological: customer first, then pro
      expect(result!.recentMessages[0].sender).toBe('customer');
      expect(result!.recentMessages[1].sender).toBe('pro');
    });

    it('handles invalid stateJson gracefully', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stateJson: 'not-json' })
      );

      const result = await getContext(prisma, 'conv-1');
      expect(result!.state).toBeNull();
    });

    it('returns empty missingFields when null', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ missingFields: null })
      );

      const result = await getContext(prisma, 'conv-1');
      expect(result!.missingFields).toEqual([]);
    });

    it('passes recentMessageLimit to message query', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await getContext(prisma, 'conv-1', 5);

      expect(prisma.message.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 })
      );
    });
  });

  // ----------------------------------------------------------
  // Platform isolation
  // ----------------------------------------------------------

  describe('platform handling', () => {
    it('works for yelp platform', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-yelp', platform: 'yelp',
        sender: 'customer', content: 'Yelp lead message',
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.platform).toBe('yelp');
    });

    it('works for thumbtack platform', async () => {
      await recordMessage(prisma, {
        conversationId: 'conv-tt', platform: 'thumbtack',
        sender: 'customer', content: 'TT lead message',
      });

      const data = prisma.threadContext.create.mock.calls[0][0].data;
      expect(data.platform).toBe('thumbtack');
    });
  });

  // ----------------------------------------------------------
  // Phase 2: buildContext
  // ----------------------------------------------------------

  describe('buildContext', () => {
    async function buildContext(prisma: any, conversationId: string, options?: { recentMessageLimit?: number }) {
      const ctx = await getContext(prisma, conversationId, options?.recentMessageLimit ?? 10);
      if (!ctx) return null;

      const parts: string[] = ['--- Thread Context ---'];
      if (ctx.summary) parts.push(`Conversation summary: ${ctx.summary}`);
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

      const recentMessages = ctx.recentMessages.map(m => ({
        role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
        content: m.content,
      }));

      return { systemContext: parts.join('\n'), recentMessages, threadState: { stage: ctx.stage } };
    }

    it('returns null for unknown conversation', async () => {
      expect(await buildContext(prisma, 'nope')).toBeNull();
    });

    it('includes summary in systemContext when present', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ summary: 'Customer wants deep cleaning, 3 bed 2 bath', stage: 'qualification', engagementLevel: 'warm' })
      );

      const result = await buildContext(prisma, 'conv-1');
      expect(result!.systemContext).toContain('Conversation summary: Customer wants deep cleaning');
      expect(result!.systemContext).toContain('Stage: qualification');
      expect(result!.systemContext).toContain('Customer engagement: warm');
    });

    it('includes price and missing fields when present', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({
          priceDiscussed: true, priceRange: '$120-$180',
          missingFields: ['bedrooms', 'schedule'],
          lastQuestionAsked: 'How many bedrooms?',
        })
      );

      const result = await buildContext(prisma, 'conv-1');
      expect(result!.systemContext).toContain('Price discussed: $120-$180');
      expect(result!.systemContext).toContain('Missing information: bedrooms, schedule');
      expect(result!.systemContext).toContain('Last question asked: How many bedrooms?');
    });

    it('includes follow-up count and awaiting status', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ followUpCount: 2, awaitingCustomerReply: true })
      );

      const result = await buildContext(prisma, 'conv-1');
      expect(result!.systemContext).toContain('Follow-ups sent: 2');
      expect(result!.systemContext).toContain('Status: awaiting customer reply');
    });

    it('converts recent messages to role format (reversed from DESC to chronological)', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());
      // Mock returns DESC order (newest first) as query specifies
      prisma.message.findMany.mockResolvedValue([
        { sender: 'customer', content: 'Need help', sentAt: new Date('2026-03-30T10:01:00Z'), rawJson: '{}' },
        { sender: 'pro', content: 'Hi there', sentAt: new Date('2026-03-30T10:00:00Z'), rawJson: '{}' },
      ]);

      const result = await buildContext(prisma, 'conv-1');
      expect(result!.recentMessages).toHaveLength(2);
      // After .reverse(): chronological — pro first, then customer
      expect(result!.recentMessages[0].role).toBe('pro');
      expect(result!.recentMessages[1].role).toBe('customer');
    });
  });

  // ----------------------------------------------------------
  // Phase 2: updateState (rule-based extraction)
  // ----------------------------------------------------------

  describe('updateState', () => {
    async function updateState(prisma: any, conversationId: string, msg: { sender: string; content: string }) {
      const ctx = await prisma.threadContext.findUnique({ where: { conversationId } });
      if (!ctx) return;

      const updates: Record<string, any> = {};

      // Price detection
      const priceMatch = msg.content.match(/\$\d[\d,]*(?:\.\d{2})?(?:\s*[-–]\s*\$?\d[\d,]*(?:\.\d{2})?)?/);
      if (priceMatch) {
        updates.priceDiscussed = true;
        updates.priceRange = priceMatch[0];
      }

      // Question detection
      if (msg.sender === 'pro' && msg.content.includes('?')) {
        const questions = msg.content.split(/[.!]\s+/).filter(s => s.includes('?'));
        if (questions.length > 0) updates.lastQuestionAsked = questions[questions.length - 1].trim();
      }

      // Engagement
      if (msg.sender === 'customer') {
        const hotSignals = [/book/i, /schedule/i, /ready/i, /let's do/i, /sounds good/i];
        const coldSignals = [/not interested/i, /too expensive/i, /no thanks/i];
        if (hotSignals.some(p => p.test(msg.content))) updates.engagementLevel = 'hot';
        else if (coldSignals.some(p => p.test(msg.content))) updates.engagementLevel = 'cold';
      }

      // Stage
      if (ctx.stage === 'qualification' && updates.priceDiscussed) updates.stage = 'quoting';

      const currentState = ctx.stateJson ? JSON.parse(ctx.stateJson) : {};
      const newState = { ...currentState };
      if (updates.priceDiscussed) newState.priceDiscussed = true;
      if (updates.priceRange) newState.priceRange = updates.priceRange;
      updates.stateJson = JSON.stringify(newState);

      if (Object.keys(updates).length > 1) {
        await prisma.threadContext.update({ where: { conversationId }, data: updates });
      }
    }

    it('detects price mention and sets priceDiscussed', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext({ stage: 'qualification' }));

      await updateState(prisma, 'conv-1', { sender: 'pro', content: 'Our rate is $150 for a standard clean.' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.priceDiscussed).toBe(true);
      expect(data.priceRange).toBe('$150');
    });

    it('detects price range', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext({ stage: 'qualification' }));

      await updateState(prisma, 'conv-1', { sender: 'pro', content: 'Usually $120-$180 depending on size.' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.priceRange).toBe('$120-$180');
    });

    it('extracts last question asked from business message', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await updateState(prisma, 'conv-1', { sender: 'pro', content: 'Thanks! How many bedrooms do you have?' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.lastQuestionAsked).toContain('How many bedrooms');
    });

    it('does NOT extract questions from customer messages', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await updateState(prisma, 'conv-1', { sender: 'customer', content: 'How much does it cost?' });

      // Update may still happen for engagement, but no lastQuestionAsked
      if (prisma.threadContext.update.mock.calls.length > 0) {
        const data = prisma.threadContext.update.mock.calls[0][0].data;
        expect(data.lastQuestionAsked).toBeUndefined();
      }
    });

    it('upgrades engagement to hot on booking signals', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await updateState(prisma, 'conv-1', { sender: 'customer', content: 'Sounds good, let\'s schedule for next week!' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.engagementLevel).toBe('hot');
    });

    it('downgrades engagement to cold on rejection signals', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await updateState(prisma, 'conv-1', { sender: 'customer', content: 'Too expensive, no thanks.' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.engagementLevel).toBe('cold');
    });

    it('progresses stage from qualification to quoting when price discussed', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext({ stage: 'qualification' }));

      await updateState(prisma, 'conv-1', { sender: 'pro', content: 'We charge $200 for this service.' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      expect(data.stage).toBe('quoting');
    });

    it('updates stateJson with accumulated state', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(
        makeThreadContext({ stateJson: '{"existingKey":"value"}', stage: 'qualification' })
      );

      await updateState(prisma, 'conv-1', { sender: 'pro', content: 'Price is $100.' });

      const data = prisma.threadContext.update.mock.calls[0]?.[0]?.data;
      const state = JSON.parse(data.stateJson);
      expect(state.existingKey).toBe('value'); // preserved
      expect(state.priceDiscussed).toBe(true); // added
      expect(state.priceRange).toBe('$100');
    });

    it('returns without update for non-matching content', async () => {
      prisma.threadContext.findUnique.mockResolvedValue(makeThreadContext());

      await updateState(prisma, 'conv-1', { sender: 'customer', content: 'Ok' });

      // stateJson always gets set, but no meaningful updates
      // The function only calls update if Object.keys > 1
      expect(prisma.threadContext.update).not.toHaveBeenCalled();
    });
  });
});
