/**
 * Tests for WebhooksController's WEBHOOK_PROCESSING_OWNER guard.
 *
 * Staging and production share the same external webhook subscriptions
 * (Yelp/Thumbtack/Sigcore). Without this guard both instances race for the
 * advisory lock and the loser silently drops the event after partial work.
 * The guard MUST run before any DB write or service call so staging ACKs
 * with 200 OK and skips, leaving the work for production exclusively.
 *
 * We instantiate the controller directly with mock services so we can
 * verify the service is never called when the guard skips.
 */

import { WebhooksController } from './webhooks.controller';

function buildController() {
  const webhooksService = {
    handleThumbtackWebhook: jest.fn().mockResolvedValue(undefined),
    handleYelpWebhook: jest.fn().mockResolvedValue(undefined),
    handleSigcoreDeliveryStatus: jest.fn().mockResolvedValue(undefined),
    handleInboundSms: jest.fn().mockResolvedValue(undefined),
    getWebhookEvents: jest.fn().mockResolvedValue([]),
  };
  const callConnectService = {
    verifyWebhookSignature: jest.fn().mockResolvedValue(true),
    handleWebhookEvent: jest.fn().mockResolvedValue(undefined),
  };
  const ctrl = new WebhooksController(
    webhooksService as any,
    callConnectService as any,
  );
  return { ctrl, webhooksService, callConnectService };
}

describe('WebhooksController WEBHOOK_PROCESSING_OWNER guard', () => {
  const ORIGINAL = process.env.WEBHOOK_PROCESSING_OWNER;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.WEBHOOK_PROCESSING_OWNER;
    else process.env.WEBHOOK_PROCESSING_OWNER = ORIGINAL;
    jest.clearAllMocks();
  });

  describe('non-owner (staging)', () => {
    beforeEach(() => {
      process.env.WEBHOOK_PROCESSING_OWNER = 'false';
    });

    it('thumbtack: returns 200 + skipped without calling service', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleThumbtackWebhook('sig', { event_type: 'NegotiationCreatedV4' });
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleThumbtackWebhook).not.toHaveBeenCalled();
    });

    it('yelp: returns 200 + skipped without calling service', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleYelpWebhook(
        'sig',
        { data: { event_type: 'NEW_EVENT', id: 'biz1' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleYelpWebhook).not.toHaveBeenCalled();
    });

    it('sigcore delivery-status: skips without service call', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleSigcoreDeliveryStatus(
        'message.delivered',
        '2026-05-04T00:00:00Z',
        'sig',
        { event: 'message.delivered', data: { messageId: 'm1' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleSigcoreDeliveryStatus).not.toHaveBeenCalled();
    });

    it('sigcore call-connect: skips before signature verification', async () => {
      const { ctrl, callConnectService } = buildController();
      const res = await ctrl.handleSigcoreCallConnect(
        'sig',
        'acct',
        { event: 'call_connect.completed' },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(callConnectService.verifyWebhookSignature).not.toHaveBeenCalled();
      expect(callConnectService.handleWebhookEvent).not.toHaveBeenCalled();
    });

    it('sigcore inbound-sms: skips without service call', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleSigcoreInboundSms(
        'message.inbound',
        '2026-05-04T00:00:00Z',
        'sig',
        'acct',
        { event: 'message.inbound', data: { messageId: 'm1', fromNumber: '+15551112222' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleInboundSms).not.toHaveBeenCalled();
    });

    it('treats unset env var as non-owner (defaults to skip)', async () => {
      delete process.env.WEBHOOK_PROCESSING_OWNER;
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleYelpWebhook(
        'sig',
        { data: { event_type: 'NEW_EVENT' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleYelpWebhook).not.toHaveBeenCalled();
    });

    it('treats truthy-but-not-"true" values as non-owner (no implicit owner)', async () => {
      process.env.WEBHOOK_PROCESSING_OWNER = '1';
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleYelpWebhook(
        'sig',
        { data: { event_type: 'NEW_EVENT' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true, skipped: true });
      expect(webhooksService.handleYelpWebhook).not.toHaveBeenCalled();
    });
  });

  describe('owner (production)', () => {
    beforeEach(() => {
      process.env.WEBHOOK_PROCESSING_OWNER = 'true';
    });

    it('thumbtack: invokes service and returns received', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleThumbtackWebhook('sig', { event_type: 'NegotiationCreatedV4' });
      expect(res).toEqual({ received: true });
      expect(webhooksService.handleThumbtackWebhook).toHaveBeenCalledTimes(1);
    });

    it('yelp: invokes service and returns received', async () => {
      const { ctrl, webhooksService } = buildController();
      const res = await ctrl.handleYelpWebhook(
        'sig',
        { data: { event_type: 'NEW_EVENT', id: 'biz1' } },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true });
      expect(webhooksService.handleYelpWebhook).toHaveBeenCalledTimes(1);
    });

    it('sigcore call-connect: continues to signature verification', async () => {
      const { ctrl, callConnectService } = buildController();
      const res = await ctrl.handleSigcoreCallConnect(
        'sig',
        'acct',
        { event: 'call_connect.completed' },
        { rawBody: Buffer.from('{}') } as any,
      );
      expect(res).toEqual({ received: true });
      expect(callConnectService.verifyWebhookSignature).toHaveBeenCalledTimes(1);
      expect(callConnectService.handleWebhookEvent).toHaveBeenCalledTimes(1);
    });
  });
});
