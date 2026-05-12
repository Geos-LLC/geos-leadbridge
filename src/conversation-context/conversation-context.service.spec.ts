/**
 * ConversationContextService — Phase A tests for ensureMessagePersisted()
 *
 * Covers Section 1 of FOLOW_UP_AND_CONVERSATION_FIX.md:
 *  - persists inbound customer message with dedup via platform+externalMessageId
 *  - returns existing message id on duplicate (no re-write)
 *  - bumps Lead.lastCustomerActivityAt when sender='customer' and message is new
 *  - does NOT bump Lead.lastCustomerActivityAt on duplicate
 *  - recovers from P2002 race by re-reading the existing row
 */

import { ConversationContextService } from './conversation-context.service';

function buildPrisma() {
  return {
    message: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'msg-new' }),
      update: jest.fn().mockResolvedValue({ id: 'msg-updated' }),
    },
    lead: {
      update: jest.fn().mockResolvedValue({}),
    },
    threadContext: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
}

function makeService(prisma: any): ConversationContextService {
  const configService = { get: jest.fn().mockReturnValue(undefined) } as any;
  return new ConversationContextService(prisma, configService);
}

describe('ConversationContextService.ensureMessagePersisted', () => {
  it('creates a new Message row when externalMessageId has not been seen', async () => {
    const prisma = buildPrisma();
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-evt-1',
      sender: 'customer',
      content: 'hi there',
      sentAt: new Date('2026-04-20T12:00:00Z'),
    });

    expect(result.created).toBe(true);
    expect(result.id).toBe('msg-new');
    expect(prisma.message.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { platform_externalMessageId: { platform: 'yelp', externalMessageId: 'yelp-evt-1' } },
      }),
    );
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('bumps Lead.lastCustomerActivityAt when inbound customer message is new', async () => {
    const prisma = buildPrisma();
    const service = makeService(prisma);
    const sentAt = new Date('2026-04-20T12:00:00Z');

    await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-evt-1',
      sender: 'customer',
      content: 'hi',
      sentAt,
    });

    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: 'lead-1' },
      data: { lastCustomerActivityAt: sentAt },
    });
  });

  it('does NOT bump Lead.lastCustomerActivityAt when duplicate externalMessageId is seen', async () => {
    const prisma = buildPrisma();
    prisma.message.findUnique.mockResolvedValue({ id: 'existing-msg-id' });
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-evt-1',
      sender: 'customer',
      content: 'hi',
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('existing-msg-id');
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('does NOT bump Lead.lastCustomerActivityAt for outbound (sender=pro) messages', async () => {
    const prisma = buildPrisma();
    const service = makeService(prisma);

    await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-out-1',
      sender: 'pro',
      senderType: 'ai',
      content: 'our reply',
    });

    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  // ----- Yelp synthetic-row backfill -----
  // Regression for the "AI" + "Platform" double-message bug. When Yelp's POST
  // /events response returns no event_id, sendMessage writes a synthetic row
  // (externalMessageId=null, senderType='ai'/'user'). When the same message
  // later arrives via webhook full-thread persist or runLazyMessageSync
  // carrying the real event_id, ensureMessagePersisted must update the existing
  // synthetic row (preserving senderType) instead of inserting a duplicate.

  it('backfills externalMessageId onto an existing synthetic AI row instead of inserting a duplicate', async () => {
    const prisma = buildPrisma();
    const aiSentAt = new Date('2026-05-03T16:02:00Z');
    const echoSentAt = new Date('2026-05-03T16:02:05Z');
    prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'synthetic-ai-row',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        senderType: 'ai',
        externalMessageId: null,
        content: 'Happy to help! Would morning or afternoon work better?',
        sentAt: aiSentAt,
        rawJson: null,
      },
    ]);
    prisma.message.update.mockResolvedValueOnce({ id: 'synthetic-ai-row' });
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-real-event-id',
      sender: 'pro',
      content: 'Happy to help! Would morning or afternoon work better?',
      sentAt: echoSentAt,
      rawJson: '{"id":"yelp-real-event-id","user_type":"BIZ"}',
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('synthetic-ai-row');
    expect(prisma.message.create).not.toHaveBeenCalled();
    // Synthetic row got upgraded with the real event_id; senderType is NOT in
    // the update payload (the existing 'ai' value is preserved by omission).
    expect(prisma.message.update).toHaveBeenCalledWith({
      where: { id: 'synthetic-ai-row' },
      data: expect.objectContaining({
        externalMessageId: 'yelp-real-event-id',
        sentAt: echoSentAt,
      }),
      select: { id: true },
    });
    const updateCall = prisma.message.update.mock.calls[0][0];
    expect(updateCall.data).not.toHaveProperty('senderType');
    expect(updateCall.data).not.toHaveProperty('content');
    // Backfill is not a "create" - recordMessage / lead.lastCustomerActivityAt
    // should NOT fire (the original send already updated thread context).
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('normalizes em-dash and curly quotes when matching synthetic rows', async () => {
    const prisma = buildPrisma();
    prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'synthetic-ai-row',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        senderType: 'ai',
        externalMessageId: null,
        // sendMessage stored em-dash + curly apostrophe; Yelp echoes back as -- and straight '
        content: "We're open 9-5 — happy to chat about it. Let’s schedule.",
        sentAt: new Date('2026-05-03T16:02:00Z'),
        rawJson: null,
      },
    ]);
    prisma.message.update.mockResolvedValueOnce({ id: 'synthetic-ai-row' });
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-real-event-id',
      sender: 'pro',
      content: "We're open 9-5 -- happy to chat about it. Let's schedule.",
      sentAt: new Date('2026-05-03T16:02:05Z'),
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('synthetic-ai-row');
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(prisma.message.update).toHaveBeenCalled();
  });

  it('does NOT backfill when no synthetic candidate matches by content', async () => {
    const prisma = buildPrisma();
    prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'unrelated-synthetic',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        senderType: 'ai',
        externalMessageId: null,
        content: 'completely different message body',
        sentAt: new Date('2026-05-03T16:02:00Z'),
        rawJson: null,
      },
    ]);
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-real-event-id',
      sender: 'pro',
      content: 'incoming message that does not match',
      sentAt: new Date('2026-05-03T16:02:05Z'),
    });

    expect(result.created).toBe(true);
    expect(prisma.message.update).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('does NOT backfill for system-sender messages', async () => {
    const prisma = buildPrisma();
    const service = makeService(prisma);

    await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-system-evt',
      sender: 'system',
      content: 'system event payload',
    });

    // No findMany call against synthetic candidates; system events go straight
    // to plain create (they don't echo back the way pro/customer sends do).
    expect(prisma.message.findMany).not.toHaveBeenCalled();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('falls through to insert if the backfill update throws (race with concurrent writer)', async () => {
    const prisma = buildPrisma();
    prisma.message.findMany.mockResolvedValueOnce([
      {
        id: 'synthetic-ai-row',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        senderType: 'ai',
        externalMessageId: null,
        content: 'msg body',
        sentAt: new Date('2026-05-03T16:02:00Z'),
        rawJson: null,
      },
    ]);
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.message.update.mockRejectedValueOnce(p2002);
    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-real-event-id',
      sender: 'pro',
      content: 'msg body',
      sentAt: new Date('2026-05-03T16:02:05Z'),
    });

    // Update failed -> we surface the row via the create path (or its P2002
    // recovery). Test asserts we don't blow up and we do return a row.
    expect(result.id).toBeDefined();
    expect(prisma.message.create).toHaveBeenCalled();
  });

  it('recovers from a P2002 unique-constraint race by re-reading the existing row', async () => {
    const prisma = buildPrisma();
    // First findUnique (pre-create check) returns null — we think the row doesn't exist.
    prisma.message.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'msg-won-the-race' });
    // Create throws P2002 because a concurrent writer beat us to it.
    const p2002 = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.message.create.mockRejectedValueOnce(p2002);

    const service = makeService(prisma);

    const result = await service.ensureMessagePersisted({
      conversationId: 'conv-1',
      leadId: 'lead-1',
      userId: 'user-1',
      platform: 'yelp',
      externalMessageId: 'yelp-evt-race',
      sender: 'customer',
      content: 'race',
    });

    expect(result.created).toBe(false);
    expect(result.id).toBe('msg-won-the-race');
    // Second findUnique re-reads the existing row — confirms dedup path ran.
    expect(prisma.message.findUnique).toHaveBeenCalledTimes(2);
  });
});
