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
      // Caller now bails on 'unknown' (only schedules reconciliation) — see
      // handleYelpNewEventInner. Persisting a placeholder corrupted threads on
      // dead-token businesses (Lavanda Cleaning 2026-05).
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

/* ------------------------------------------------------------------ *
 * Yelp NEW_EVENT — first chat row write contract
 *
 * Stan G regression (2026-05-14): a brand-new Yelp lead's initial chat
 * message must come from `leadData.message` (= project.additional_info)
 * — never the raw event_content.text boilerplate ("Hi there… Here are
 * my answers… <full survey Q&A>").
 *
 * Path A = classifyYelpNewEvent + persist `latestCustomerMessage`
 *          (event_content.text). Runs for existing-lead replies only.
 * Path B = persist initial chat row from `leadData.message` (additional_info)
 *          on a brand-new lead.
 *
 * The clean separation: Path A NEVER persists when isNewLead=true; Path B
 * owns the first chat row exclusively. classifyYelpNewEvent itself still
 * runs for both new and existing leads — its result is observational on
 * new leads, used for echo classification + automation decisions on
 * existing-lead replies.
 * ------------------------------------------------------------------ */

type ChatRow = {
  externalMessageId: string | null;
  content: string;
  sender: 'customer' | 'pro' | 'system';
};

function buildYelpHarness(opts: {
  // What classifyYelpNewEvent should return (controlled via getLeadEvents mock)
  events?: any[];
  // What yelp.getLead returns
  leadData: any;
  // Whether the lead already exists in DB (controls isNewLead branch)
  existingLead?: { id: string; createdAt: Date } | null;
}) {
  const ensureMessagePersisted = jest.fn().mockImplementation(async (input: any) => {
    // Mirror the real dedup contract: same (platform, externalMessageId) returns
    // the existing row without overwriting content. Each new pair creates.
    const key = `${input.platform}::${input.externalMessageId}`;
    if (input.externalMessageId && persistedKeys.has(key)) {
      return { id: persistedKeys.get(key)!, created: false };
    }
    const id = `msg-${persistedRows.length + 1}`;
    persistedRows.push({
      externalMessageId: input.externalMessageId,
      content: input.content,
      sender: input.sender,
    });
    if (input.externalMessageId) persistedKeys.set(key, id);
    return { id, created: true };
  });
  const persistedRows: ChatRow[] = [];
  const persistedKeys = new Map<string, string>();

  const getLeadEvents = jest.fn().mockResolvedValue(opts.events ?? []);
  const getLead = jest.fn().mockResolvedValue(opts.leadData);

  const svc = Object.create(WebhooksService.prototype);
  svc.logger = new Logger('WebhooksServiceTest');
  svc._recentWebhookEventIds = new Map();
  svc.platformFactory = { getAdapter: jest.fn().mockReturnValue({ getLead, getLeadEvents }) };

  const conversation = { id: 'conv-yelp-1' };
  const upsertedLead = {
    id: 'lead-yelp-1',
    userId: 'user-1',
    threadId: conversation.id,
    customerName: opts.leadData.customerName ?? 'Customer',
    customerPhone: opts.leadData.customerPhone ?? null,
    category: opts.leadData.category ?? null,
    city: opts.leadData.city ?? null,
    state: opts.leadData.state ?? null,
    postcode: opts.leadData.postcode ?? null,
    message: opts.leadData.message ?? '',
    rawJson: '{}',
    createdAt: new Date(),
  };

  svc.prisma = {
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'acct-1',
        userId: 'user-1',
        platform: 'yelp',
        businessName: 'Test Biz',
        credentialsJson: null,
      }),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue(opts.existingLead ?? null),
      upsert: jest.fn().mockResolvedValue(upsertedLead),
      update: jest.fn().mockResolvedValue(upsertedLead),
      count: jest.fn().mockResolvedValue(1),
    },
    conversation: {
      upsert: jest.fn().mockResolvedValue(conversation),
      update: jest.fn().mockResolvedValue(conversation),
    },
    message: {
      count: jest.fn().mockResolvedValue(2),
      findUnique: jest.fn().mockResolvedValue({ senderType: 'ai' }),
    },
    systemErrorLog: { create: jest.fn().mockResolvedValue({}) },
    webhookEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  svc.configService = {
    get: jest.fn().mockImplementation((key: string) => {
      if (key === 'features.yelpWebhookPersistFullThread') return true;
      if (key === 'yelp.apiKey') return 'test-key';
      if (key === 'encryption.key') return 'a'.repeat(64);
      return undefined;
    }),
  };

  svc.conversationContextService = { ensureMessagePersisted };

  const automationService = {
    handleNewLead: jest.fn().mockResolvedValue(undefined),
    handleCustomerReply: jest.fn().mockResolvedValue(undefined),
  };
  svc.automationService = automationService;

  const notificationsService = {
    sendLeadNotification: jest.fn().mockResolvedValue(undefined),
    handleCustomerReply: jest.fn().mockResolvedValue(undefined),
    sendReEngagementAlert: jest.fn().mockResolvedValue(undefined),
  };
  svc.notificationsService = notificationsService;

  svc.callConnectService = { triggerForLead: jest.fn().mockResolvedValue(undefined) };
  svc.followUpEngine = {
    handleCustomerReply: jest.fn().mockResolvedValue({ reEngagementAlert: null }),
    evaluateThread: jest.fn().mockResolvedValue(undefined),
  };
  svc.eventEmitter = { emit: jest.fn() };
  svc.crmWebhookService = { emit: jest.fn().mockResolvedValue(undefined) };
  svc.leadCache = { invalidateLeadMessagesAndList: jest.fn().mockResolvedValue(undefined) };
  // Trial meter — Yelp/TT NEW_EVENT path calls trialService.consumeLead on
  // every newly-persisted lead (PR #194, 2026-06-02). Stub it out — these
  // tests don't exercise the trial CAS, just the first-chat-row contract.
  svc.trialService = { consumeLead: jest.fn().mockResolvedValue(undefined) };

  return {
    svc,
    ensureMessagePersisted,
    persistedRows,
    getLeadEvents,
    automationService,
    notificationsService,
    upsertedLead,
  };
}

describe('WebhooksService.handleYelpNewEventInner — first chat row contract', () => {
  // Yelp's first TEXT event for any RAQ submission carries this boilerplate
  // text, regardless of what the customer actually typed.
  const YELP_FIRST_TEXT_BOILERPLATE =
    'Hi there, here are my answers:\n' +
    'Q: When do you require this service?\n' +
    'A: As soon as possible\n' +
    'Q: Where would you like the service?\n' +
    'A: 32256\n' +
    'Additional details: My faucet is leaking under the sink.';

  const FIRST_TEXT_EVENT = {
    id: 'yelp-evt-text-1',
    user_type: 'CONSUMER',
    event_type: 'TEXT',
    time_created: '2026-05-14T13:00:00Z',
    event_content: { text: YELP_FIRST_TEXT_BOILERPLATE },
  };

  it('brand-new lead with additional_info persists ONLY additional_info — not the boilerplate', async () => {
    const { svc, persistedRows, automationService } = buildYelpHarness({
      events: [FIRST_TEXT_EVENT],
      leadData: {
        platform: 'yelp',
        externalRequestId: 'yelp-lead-1',
        customerName: 'Stan G.',
        message: 'My faucet is leaking under the sink.', // = project.additional_info
        city: 'Jacksonville',
        state: 'FL',
        postcode: '32256',
        category: 'Plumbing',
        status: 'new',
        createdAt: new Date('2026-05-14T13:00:00Z'),
        updatedAt: new Date('2026-05-14T13:00:00Z'),
        raw: { project: { additional_info: 'My faucet is leaking under the sink.' } },
      },
      existingLead: null, // brand-new
    });

    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-1', event_id: 'yelp-evt-raq-1' },
      'yelp-lead-1',
      'yelp-evt-raq-1',
    );

    // The chat thread received exactly one customer row, and its content is
    // additional_info — NOT the "Hi there… Here are my answers…" boilerplate.
    const customerRows = persistedRows.filter(r => r.sender === 'customer');
    expect(customerRows).toHaveLength(1);
    expect(customerRows[0].content).toBe('My faucet is leaking under the sink.');
    expect(customerRows[0].content).not.toContain('Here are my answers');

    // New-lead automation ran (not customer-reply).
    expect(automationService.handleNewLead).toHaveBeenCalledTimes(1);
    expect(automationService.handleCustomerReply).not.toHaveBeenCalled();
  });

  it('brand-new lead with empty additional_info does not persist boilerplate as the first chat row', async () => {
    const { svc, persistedRows, automationService } = buildYelpHarness({
      events: [FIRST_TEXT_EVENT],
      leadData: {
        platform: 'yelp',
        externalRequestId: 'yelp-lead-2',
        customerName: 'Stan G.',
        message: '', // no project.additional_info
        category: 'Plumbing',
        status: 'new',
        createdAt: new Date('2026-05-14T13:00:00Z'),
        updatedAt: new Date('2026-05-14T13:00:00Z'),
        raw: { project: {} },
      },
      existingLead: null,
    });

    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-2', event_id: 'yelp-evt-raq-2' },
      'yelp-lead-2',
      'yelp-evt-raq-2',
    );

    // Zero customer rows — chat is empty (matches Thumbtack when the customer
    // submits the form without writing anything in the additional details box).
    const customerRows = persistedRows.filter(r => r.sender === 'customer');
    expect(customerRows).toHaveLength(0);
    // New-lead automation still fired so the business owner gets the SMS.
    expect(automationService.handleNewLead).toHaveBeenCalledTimes(1);
  });

  it('existing-lead customer reply persists the actual event_content.text (Path A unchanged)', async () => {
    const realReply = "Hi! I'd like a quote for Tuesday afternoon if possible.";
    const REPLY_EVENT = {
      id: 'yelp-evt-text-2',
      user_type: 'CONSUMER',
      event_type: 'TEXT',
      time_created: '2026-05-14T15:00:00Z',
      event_content: { text: realReply },
    };

    const { svc, persistedRows, automationService } = buildYelpHarness({
      events: [FIRST_TEXT_EVENT, REPLY_EVENT],
      leadData: {
        platform: 'yelp',
        externalRequestId: 'yelp-lead-3',
        customerName: 'Stan G.',
        message: 'original additional info',
        category: 'Plumbing',
        status: 'new',
        createdAt: new Date('2026-05-14T13:00:00Z'),
        updatedAt: new Date('2026-05-14T15:00:00Z'),
        raw: {},
      },
      existingLead: { id: 'lead-yelp-1', createdAt: new Date(Date.now() - 60_000) },
    });

    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-3', event_id: 'yelp-evt-text-2' },
      'yelp-lead-3',
      'yelp-evt-text-2',
    );

    // The single-message persist path wrote the real reply text.
    const replyRows = persistedRows.filter(r => r.externalMessageId === 'yelp-evt-text-2');
    expect(replyRows).toHaveLength(1);
    expect(replyRows[0].content).toBe(realReply);
    expect(replyRows[0].sender).toBe('customer');

    // Customer-reply automation fired (not new-lead).
    expect(automationService.handleCustomerReply).toHaveBeenCalledTimes(1);
    expect(automationService.handleNewLead).not.toHaveBeenCalled();
  });

  it('BIZ echo on existing lead does NOT create a customer message and does NOT trigger customer-reply automation', async () => {
    const BIZ_EVENT = {
      id: 'yelp-evt-biz-1',
      user_type: 'BIZ',
      event_type: 'TEXT',
      time_created: '2026-05-14T16:00:00Z',
      event_content: { text: "Thanks — we'd be happy to help. What's your address?" },
    };

    const {
      svc,
      persistedRows,
      automationService,
      notificationsService,
    } = buildYelpHarness({
      events: [FIRST_TEXT_EVENT, BIZ_EVENT],
      leadData: {
        platform: 'yelp',
        externalRequestId: 'yelp-lead-4',
        customerName: 'Stan G.',
        message: 'additional info',
        status: 'new',
        createdAt: new Date('2026-05-14T13:00:00Z'),
        updatedAt: new Date('2026-05-14T16:00:00Z'),
        raw: {},
      },
      existingLead: { id: 'lead-yelp-1', createdAt: new Date(Date.now() - 60_000) },
    });

    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-4', event_id: 'yelp-evt-biz-1' },
      'yelp-lead-4',
      'yelp-evt-biz-1',
    );

    // Echo path returns AFTER full-thread persist runs, so the consumer's
    // historical TEXT event still gets persisted (sender=customer) and the BIZ
    // echo gets persisted (sender=pro). Neither is treated as a fresh customer
    // reply: no customer-reply automation, no customer-reply SMS notification.
    const customerReplyRows = persistedRows.filter(
      r => r.sender === 'customer' && r.externalMessageId === 'yelp-evt-biz-1',
    );
    expect(customerReplyRows).toHaveLength(0);

    expect(automationService.handleCustomerReply).not.toHaveBeenCalled();
    expect(automationService.handleNewLead).not.toHaveBeenCalled();
    expect(notificationsService.handleCustomerReply).not.toHaveBeenCalled();
  });

  it('dedup by externalMessageId: replaying the same webhook event does not write a second customer row', async () => {
    const REPLY_EVENT = {
      id: 'yelp-evt-text-9',
      user_type: 'CONSUMER',
      event_type: 'TEXT',
      time_created: '2026-05-14T17:00:00Z',
      event_content: { text: 'Same reply, replayed' },
    };
    const { svc, persistedRows, ensureMessagePersisted } = buildYelpHarness({
      events: [REPLY_EVENT],
      leadData: {
        platform: 'yelp',
        externalRequestId: 'yelp-lead-5',
        customerName: 'Stan G.',
        message: 'add info',
        status: 'new',
        createdAt: new Date('2026-05-14T13:00:00Z'),
        updatedAt: new Date('2026-05-14T17:00:00Z'),
        raw: {},
      },
      existingLead: { id: 'lead-yelp-1', createdAt: new Date(Date.now() - 60_000) },
    });

    // First webhook delivery
    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-5', event_id: 'yelp-evt-text-9' },
      'yelp-lead-5',
      'yelp-evt-text-9',
    );
    // Second webhook delivery (same eventId) — at-least-once retry from Yelp.
    await svc.handleYelpNewEventInner(
      'biz-yelp-1',
      { lead_id: 'yelp-lead-5', event_id: 'yelp-evt-text-9' },
      'yelp-lead-5',
      'yelp-evt-text-9',
    );

    // ensureMessagePersisted was called multiple times (full-thread + single-message
    // persist on each delivery) but the harness mirrors the real dedup contract
    // so only one Message row exists for that externalMessageId.
    expect(ensureMessagePersisted.mock.calls.length).toBeGreaterThan(1);
    const rowsForEvent = persistedRows.filter(r => r.externalMessageId === 'yelp-evt-text-9');
    expect(rowsForEvent).toHaveLength(1);
  });
});
