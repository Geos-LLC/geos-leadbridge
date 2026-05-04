import {
  CONTENT_MATCH_DEFAULT_WINDOW_MS,
  findBackfillCandidate,
  normalizeMessageContent,
} from './content-match.util';

describe('normalizeMessageContent', () => {
  it('collapses whitespace runs to a single space', () => {
    expect(normalizeMessageContent('  hello   world\nthere\t  ')).toBe('hello world there');
  });

  it('folds em-dash and en-dash to "--"', () => {
    expect(normalizeMessageContent('open 9 — 5 – weekdays')).toBe('open 9 -- 5 -- weekdays');
  });

  it('folds curly single and double quotes to straight', () => {
    expect(normalizeMessageContent('Let’s talk about “that”')).toBe(
      "Let's talk about \"that\"",
    );
  });

  it('returns "" for null or empty', () => {
    expect(normalizeMessageContent(null)).toBe('');
    expect(normalizeMessageContent(undefined)).toBe('');
    expect(normalizeMessageContent('')).toBe('');
  });
});

describe('findBackfillCandidate', () => {
  function makePrisma(rows: any[]) {
    return {
      message: {
        findMany: jest.fn().mockResolvedValue(rows),
      },
    } as any;
  }

  const baseInput = {
    conversationId: 'conv-1',
    platform: 'yelp',
    sender: 'pro' as const,
  };

  it('returns the synthetic row when normalized content matches', async () => {
    const sentAt = new Date('2026-05-03T16:02:00Z');
    const prisma = makePrisma([
      {
        id: 'synthetic-1',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
        content: 'Hi — happy to help',
        sentAt: new Date('2026-05-03T16:01:55Z'),
      },
    ]);

    const result = await findBackfillCandidate(prisma, {
      ...baseInput,
      content: 'Hi -- happy to help',
      sentAt,
    });

    expect(result?.id).toBe('synthetic-1');
    const args = prisma.message.findMany.mock.calls[0][0];
    expect(args.where).toEqual(
      expect.objectContaining({
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
      }),
    );
    // Time window is bounded around sentAt by default
    expect(args.where.sentAt.gte.getTime()).toBe(sentAt.getTime() - CONTENT_MATCH_DEFAULT_WINDOW_MS);
    expect(args.where.sentAt.lte.getTime()).toBe(sentAt.getTime() + CONTENT_MATCH_DEFAULT_WINDOW_MS);
  });

  it('returns null when no candidate content matches', async () => {
    const prisma = makePrisma([
      {
        id: 'synthetic-1',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
        content: 'totally different body',
        sentAt: new Date('2026-05-03T16:01:55Z'),
      },
    ]);

    const result = await findBackfillCandidate(prisma, {
      ...baseInput,
      content: 'incoming reply',
      sentAt: new Date('2026-05-03T16:02:00Z'),
    });

    expect(result).toBeNull();
  });

  it('returns null when no candidates at all', async () => {
    const prisma = makePrisma([]);

    const result = await findBackfillCandidate(prisma, {
      ...baseInput,
      content: 'anything',
    });

    expect(result).toBeNull();
  });

  it('picks the candidate with the smallest time delta when multiple match', async () => {
    const incoming = new Date('2026-05-03T16:02:00Z');
    const prisma = makePrisma([
      {
        id: 'older',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
        content: 'duplicate body',
        sentAt: new Date('2026-05-03T10:00:00Z'),
      },
      {
        id: 'closest',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
        content: 'duplicate body',
        sentAt: new Date('2026-05-03T16:01:55Z'),
      },
    ]);

    const result = await findBackfillCandidate(prisma, {
      ...baseInput,
      content: 'duplicate body',
      sentAt: incoming,
    });

    expect(result?.id).toBe('closest');
  });

  it('does not match when incoming content normalizes to empty', async () => {
    const prisma = makePrisma([
      {
        id: 'synthetic-1',
        conversationId: 'conv-1',
        platform: 'yelp',
        sender: 'pro',
        externalMessageId: null,
        content: '',
        sentAt: new Date('2026-05-03T16:01:55Z'),
      },
    ]);

    const result = await findBackfillCandidate(prisma, {
      ...baseInput,
      content: '   ',
      sentAt: new Date('2026-05-03T16:02:00Z'),
    });

    expect(result).toBeNull();
  });
});
