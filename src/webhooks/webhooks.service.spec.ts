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

/* ------------------------------------------------------------------ *
 * Sigcore inbound SMS — P2002-tolerant fan-out persistence
 * ------------------------------------------------------------------ */

function buildSmsHarness(opts: {
  ensureMessagePersisted: jest.Mock;
} = { ensureMessagePersisted: jest.fn() }) {
  const svc = Object.create(WebhooksService.prototype);
  svc.logger = new Logger('WebhooksServiceTest');
  svc._recentInboundSmsIds = new Set<string>();

  const lead = {
    id: 'lead-1',
    userId: 'user-1',
    threadId: 'conv-1',
    customerName: 'Customer',
    customerPhone: '+15551234567',
    businessId: 'biz-1',
    category: 'cleaning',
    city: 'Tampa',
    state: 'FL',
    postcode: '33601',
    conversation: { id: 'conv-1' },
  };

  svc.prisma = {
    webhookEvent: {
      create: jest.fn().mockResolvedValue({ id: 'wh-1' }),
      update: jest.fn().mockResolvedValue({}),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    lead: {
      findFirst: jest.fn().mockResolvedValue(lead),
      update: jest.fn().mockResolvedValue({}),
    },
    conversation: {
      create: jest.fn().mockResolvedValue({ id: 'conv-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({ id: 'acct-1', platform: 'sms', businessName: 'Biz', userId: 'user-1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'acct-1', platform: 'sms', businessName: 'Biz', userId: 'user-1', businessId: 'biz-1' }),
    },
    notificationSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    tenantPhoneNumber: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };

  svc.conversationContextService = {
    ensureMessagePersisted: opts.ensureMessagePersisted,
    recordMessage: jest.fn().mockResolvedValue(undefined),
  };

  svc.notificationsService = {
    handleCustomerReply: jest.fn().mockResolvedValue(undefined),
    forwardInboundSms: jest.fn().mockResolvedValue(undefined),
    sendAgentGuidanceSms: jest.fn().mockResolvedValue(undefined),
  };

  svc.eventEmitter = { emit: jest.fn() };
  svc.configService = { get: jest.fn().mockReturnValue('') };

  return svc;
}

function smsParams(messageId: string, accountId: string) {
  return {
    eventType: 'message.inbound',
    timestamp: '2026-04-25T13:51:39.469Z',
    signature: 'sig',
    accountId,
    payload: {
      event: 'message.inbound',
      data: {
        messageId,
        conversationId: 'sigcore-conv-1',
        direction: 'in',
        channel: 'sms',
        body: 'Okay',
        fromNumber: '+15555550147',
        toNumber: '+15555550100',
      },
    },
    rawBody: '{}',
  };
}

describe('WebhooksService.handleInboundSms — P2002-tolerant persistence', () => {
  it('first fan-out arm persists the Message and runs side-effects once', async () => {
    const ensureMessagePersisted = jest.fn().mockResolvedValue({ id: 'msg-1', created: true });
    const svc = buildSmsHarness({ ensureMessagePersisted });

    await svc.handleInboundSms(smsParams('sigcore-msg-A', 'tenant-A'));

    expect(ensureMessagePersisted).toHaveBeenCalledTimes(1);
    expect(ensureMessagePersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: 'sms',
        externalMessageId: 'sigcore-msg-A',
        sender: 'customer',
        leadId: 'lead-1',
      }),
    );
    expect(svc.prisma.conversation.update).toHaveBeenCalledTimes(1);
    expect(svc.notificationsService.handleCustomerReply).toHaveBeenCalledTimes(1);
    expect(svc.eventEmitter.emit).toHaveBeenCalledWith(
      'sms.inbound.user-1',
      expect.objectContaining({ leadId: 'lead-1' }),
    );
  });

  it('duplicate fan-out arm (created=false) skips conversation update + notifications + SSE', async () => {
    const ensureMessagePersisted = jest.fn().mockResolvedValue({ id: 'msg-1', created: false });
    const svc = buildSmsHarness({ ensureMessagePersisted });

    await svc.handleInboundSms(smsParams('sigcore-msg-A', 'tenant-B'));

    expect(ensureMessagePersisted).toHaveBeenCalledTimes(1);
    // Side-effects MUST be skipped — first arm already ran them
    expect(svc.prisma.conversation.update).not.toHaveBeenCalled();
    expect(svc.notificationsService.handleCustomerReply).not.toHaveBeenCalled();
    expect(svc.notificationsService.forwardInboundSms).not.toHaveBeenCalled();
    expect(svc.eventEmitter.emit).not.toHaveBeenCalled();
    // Webhook event still marked processed (not as error)
    const updates = (svc.prisma.webhookEvent.update.mock.calls as any[]).map(c => c[0]);
    expect(updates.some(u => u.data?.processed === true && !u.data?.processingError)).toBe(true);
  });

  it('does not throw or log P2002 when same messageId arrives across the fan-out', async () => {
    // First arm: row created. Second arm: row already exists (P2002 swallowed inside ensureMessagePersisted).
    const ensureMessagePersisted = jest
      .fn()
      .mockResolvedValueOnce({ id: 'msg-1', created: true })
      .mockResolvedValueOnce({ id: 'msg-1', created: false });

    const svc = buildSmsHarness({ ensureMessagePersisted });
    const errorSpy = jest.spyOn(svc.logger, 'error');

    await svc.handleInboundSms(smsParams('sigcore-msg-X', 'tenant-A'));
    await svc.handleInboundSms(smsParams('sigcore-msg-X', 'tenant-B'));

    expect(ensureMessagePersisted).toHaveBeenCalledTimes(2);
    expect(errorSpy).not.toHaveBeenCalled();
    // Side-effects fire once (only first arm)
    expect(svc.prisma.conversation.update).toHaveBeenCalledTimes(1);
    expect(svc.notificationsService.handleCustomerReply).toHaveBeenCalledTimes(1);
    expect(svc.eventEmitter.emit).toHaveBeenCalledTimes(1);
  });

  it('passes synthetic externalMessageId when payload has no messageId (no dedup possible)', async () => {
    const ensureMessagePersisted = jest.fn().mockResolvedValue({ id: 'msg-1', created: true });
    const svc = buildSmsHarness({ ensureMessagePersisted });

    const params = smsParams('', 'tenant-A');
    delete (params.payload.data as any).messageId;

    await svc.handleInboundSms(params);

    expect(ensureMessagePersisted).toHaveBeenCalledWith(
      expect.objectContaining({
        externalMessageId: expect.stringMatching(/^inbound-\d+$/),
      }),
    );
  });
});
