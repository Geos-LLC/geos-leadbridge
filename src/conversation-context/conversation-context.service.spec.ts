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
      create: jest.fn().mockResolvedValue({ id: 'msg-new' }),
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
