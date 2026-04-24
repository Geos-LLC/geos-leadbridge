/**
 * Webhooks Service — Phase A tests (Yelp inbound persistence + echo fallback)
 *
 * Covers Sections 1 & 2 of FOLOW_UP_AND_CONVERSATION_FIX.md:
 *  - classifyYelpNewEvent returns 'echo' when latest event is user_type=BIZ
 *  - classifyYelpNewEvent returns 'unknown' when adapter fetch fails (no 90s fallback)
 *  - classifyYelpNewEvent returns 'unknown' when adapter returns empty list
 *  - classifyYelpNewEvent returns 'customer' with latest CONSUMER event fields
 *  - markYelpEventForReconciliation writes reconcile:yelp:<...> marker on WebhookEvent
 *
 * The full handleYelpNewEvent path has ~14 injected dependencies and a
 * setInterval in its constructor; we bypass the constructor with
 * Object.create(prototype) and exercise only the extracted private methods.
 */

import { WebhooksService } from './webhooks.service';
import { Logger } from '@nestjs/common';

function buildServiceHarness(overrides: {
  getLeadEvents?: jest.Mock;
  webhookEventFindFirst?: jest.Mock;
  webhookEventUpdate?: jest.Mock;
} = {}) {
  const svc = Object.create(WebhooksService.prototype);
  const getLeadEvents = overrides.getLeadEvents || jest.fn().mockResolvedValue([]);
  svc.logger = new Logger('WebhooksServiceTest');
  svc.platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLeadEvents }) };
  svc.prisma = {
    webhookEvent: {
      findFirst: overrides.webhookEventFindFirst || jest.fn().mockResolvedValue(null),
      update: overrides.webhookEventUpdate || jest.fn().mockResolvedValue({}),
    },
  };
  return { svc, getLeadEvents };
}

describe('WebhooksService — Yelp echo classification (Phase A)', () => {
  describe('classifyYelpNewEvent', () => {
    it('returns outcome=echo when latest event user_type is BIZ', async () => {
      const getLeadEvents = jest.fn().mockResolvedValue([
        { id: 'e-biz', user_type: 'BIZ', event_type: 'TEXT', time_created: '2026-04-20T12:00:01Z', event_content: { text: 'our reply' } },
        { id: 'e-cons', user_type: 'CONSUMER', event_type: 'TEXT', time_created: '2026-04-20T11:00:00Z', event_content: { text: 'hi' } },
      ]);
      const { svc } = buildServiceHarness({ getLeadEvents });

      const result = await svc.classifyYelpNewEvent('lead-1', 'evt-1', 'tok-1');

      expect(result.outcome).toBe('echo');
      expect(result.reason).toBe('latest_is_biz');
      // Latest consumer event metadata still extracted for audit / reconciliation.
      expect(result.latestCustomerMessage).toBe('hi');
      expect(result.latestCustomerEventId).toBe('e-cons');
    });

    it('returns outcome=customer when latest event is CONSUMER', async () => {
      const getLeadEvents = jest.fn().mockResolvedValue([
        { id: 'e-cons-new', user_type: 'CONSUMER', event_type: 'TEXT', time_created: '2026-04-20T12:30:00Z', event_content: { text: 'new customer msg' } },
      ]);
      const { svc } = buildServiceHarness({ getLeadEvents });

      const result = await svc.classifyYelpNewEvent('lead-2', 'evt-2', 'tok-2');

      expect(result.outcome).toBe('customer');
      expect(result.latestCustomerMessage).toBe('new customer msg');
      expect(result.latestCustomerEventId).toBe('e-cons-new');
      expect(result.latestCustomerSentAt).toEqual(new Date('2026-04-20T12:30:00Z'));
    });

    it('returns outcome=unknown when adapter throws (fail-open, not 90s fallback)', async () => {
      const getLeadEvents = jest.fn().mockRejectedValue(new Error('network timeout'));
      const { svc } = buildServiceHarness({ getLeadEvents });

      const result = await svc.classifyYelpNewEvent('lead-3', 'evt-3', 'tok-3');

      expect(result.outcome).toBe('unknown');
      expect(result.reason).toContain('fetch_threw');
      // Caller treats 'unknown' as customer reply AND schedules reconciliation.
    });

    it('returns outcome=unknown when adapter returns empty array', async () => {
      // A NEW_EVENT webhook implies at least one event exists — empty means fetch failed.
      const getLeadEvents = jest.fn().mockResolvedValue([]);
      const { svc } = buildServiceHarness({ getLeadEvents });

      const result = await svc.classifyYelpNewEvent('lead-4', 'evt-4', 'tok-4');

      expect(result.outcome).toBe('unknown');
      expect(result.reason).toBe('empty_events_from_adapter');
    });

    it('handles string event_content (legacy Yelp format)', async () => {
      const getLeadEvents = jest.fn().mockResolvedValue([
        { id: 'e-1', user_type: 'CONSUMER', event_type: 'TEXT', time_created: '2026-04-20T12:00:00Z', event_content: 'plain string content' },
      ]);
      const { svc } = buildServiceHarness({ getLeadEvents });

      const result = await svc.classifyYelpNewEvent('lead-5', 'evt-5', 'tok-5');

      expect(result.outcome).toBe('customer');
      expect(result.latestCustomerMessage).toBe('plain string content');
    });
  });

  describe('markYelpEventForReconciliation', () => {
    it('stamps processingError with reconcile:yelp:<leadId>:<businessId>:<reason>:attempts=0', async () => {
      const webhookEventFindFirst = jest.fn().mockResolvedValue({ id: 'row-1' });
      const webhookEventUpdate = jest.fn().mockResolvedValue({});
      const { svc } = buildServiceHarness({ webhookEventFindFirst, webhookEventUpdate });

      await svc.markYelpEventForReconciliation('yelp-evt-99', 'lead-42', 'biz-7', 'empty_events_from_adapter');

      expect(webhookEventFindFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ platform: 'yelp', payload: { contains: 'yelp-evt-99' } }),
        }),
      );
      expect(webhookEventUpdate).toHaveBeenCalledWith({
        where: { id: 'row-1' },
        data: { processingError: 'reconcile:yelp:lead-42:biz-7:empty_events_from_adapter:attempts=0' },
      });
    });

    it('silently skips when no matching WebhookEvent row exists', async () => {
      const webhookEventFindFirst = jest.fn().mockResolvedValue(null);
      const webhookEventUpdate = jest.fn();
      const { svc } = buildServiceHarness({ webhookEventFindFirst, webhookEventUpdate });

      await svc.markYelpEventForReconciliation('yelp-evt-missing', 'lead-1', 'biz-1', 'reason');

      expect(webhookEventUpdate).not.toHaveBeenCalled();
    });
  });
});
