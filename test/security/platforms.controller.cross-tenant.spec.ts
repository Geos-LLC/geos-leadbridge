/**
 * Cross-tenant access tests for PlatformsController — Phase 1B.
 *
 * `webhooks/recent` previously dumped the system-wide WebhookEvent table
 * with an `isYourAccount: false` flag — leaking other tenants' business IDs,
 * negotiation IDs, and message IDs. The patch filters in-memory to only the
 * caller's businesses before returning, drops the leaky `isYourAccount` flag
 * entirely, and returns an empty result when the caller has no Thumbtack
 * accounts (instead of every tenant's events).
 */

import { PlatformsController } from '../../src/platforms/platforms.controller';

function buildPrisma(opts: {
  callerBusinessIds: string[];
  events: Array<{ id: string; eventType: string; payload: any; receivedAt?: Date; processed?: boolean; processingError?: string | null }>;
}) {
  return {
    savedAccount: {
      findMany: jest.fn().mockResolvedValue(opts.callerBusinessIds.map(b => ({ id: `acct-${b}`, businessId: b, platform: 'thumbtack' }))),
    },
    webhookEvent: {
      findMany: jest.fn().mockResolvedValue(
        opts.events.map(e => ({
          id: e.id,
          eventType: e.eventType,
          payload: JSON.stringify(e.payload),
          receivedAt: e.receivedAt ?? new Date(),
          processed: e.processed ?? false,
          processingError: e.processingError ?? null,
        })),
      ),
    },
    platform: { findUnique: jest.fn() },
  } as any;
}

describe('PlatformsController.getRecentWebhookEvents — cross-tenant filtering', () => {
  it('returns only events whose businessID matches the caller', async () => {
    const prisma = buildPrisma({
      callerBusinessIds: ['biz-a'],
      events: [
        { id: 'e1', eventType: 'NegotiationCreatedV4', payload: { data: { business: { businessID: 'biz-a' }, negotiationID: 'neg-a-1' } } },
        { id: 'e2', eventType: 'NegotiationCreatedV4', payload: { data: { business: { businessID: 'biz-b' }, negotiationID: 'neg-b-1', messageID: 'm-b-1' } } },
        { id: 'e3', eventType: 'NegotiationUpdatedV4', payload: { data: { business: { businessID: 'biz-c' }, negotiationID: 'neg-c-1' } } },
      ],
    });
    const controller = new PlatformsController({} as any, prisma);

    const res = await controller.getRecentWebhookEvents({ id: 'user-a' });

    expect(res.totalEvents).toBe(1);
    expect(res.recentEvents).toHaveLength(1);
    expect(res.recentEvents[0].businessId).toBe('biz-a');
    // Critically: no event with biz-b or biz-c slips through
    const allBusinessIds = res.recentEvents.map((e: any) => e.businessId);
    expect(allBusinessIds).not.toContain('biz-b');
    expect(allBusinessIds).not.toContain('biz-c');
  });

  it('returns an empty result when the caller has no Thumbtack accounts', async () => {
    const prisma = buildPrisma({
      callerBusinessIds: [],
      events: [
        { id: 'e1', eventType: 'NegotiationCreatedV4', payload: { data: { business: { businessID: 'biz-x' } } } },
      ],
    });
    const controller = new PlatformsController({} as any, prisma);
    const res = await controller.getRecentWebhookEvents({ id: 'user-with-no-tt' });
    expect(res.totalEvents).toBe(0);
    expect(res.recentEvents).toEqual([]);
    // Should not have queried webhookEvent at all when there are no business IDs.
    expect(prisma.webhookEvent.findMany).not.toHaveBeenCalled();
  });

  it('does NOT return an `isYourAccount` flag (would leak existence of other tenant rows)', async () => {
    const prisma = buildPrisma({
      callerBusinessIds: ['biz-a'],
      events: [
        { id: 'e1', eventType: 'NegotiationCreatedV4', payload: { data: { business: { businessID: 'biz-a' } } } },
      ],
    });
    const controller = new PlatformsController({} as any, prisma);
    const res = await controller.getRecentWebhookEvents({ id: 'user-a' });
    for (const event of res.recentEvents) {
      expect(event).not.toHaveProperty('isYourAccount');
    }
  });
});
