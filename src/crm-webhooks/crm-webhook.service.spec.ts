/**
 * CRM Webhook Service Tests
 *
 * Tests: emit, buildPayload, sendWebhook (HMAC signing), test event, error isolation
 */

import { CrmWebhookService } from './crm-webhook.service';
import * as crypto from 'crypto';

// Mock axios
jest.mock('axios', () => ({
  post: jest.fn(),
}));

const USER_ID = 'user-123';
const BUSINESS_ID = 'biz-456';
const LEAD_ID = 'lead-789';
const WEBHOOK_URL = 'https://example.com/webhook';
const WEBHOOK_SECRET = 'test-secret-key';

function buildPrismaMock() {
  return {
    crmWebhookSubscription: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
      delete: jest.fn(),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({
        sigcoreWorkspaceId: 'sc_ws_001',
        sigcoreBusinessId: 'sc_biz_001',
      }),
    },
    savedAccount: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'acc-1',
        businessId: BUSINESS_ID,
        businessName: 'Test Business',
        platform: 'yelp',
      }),
    },
    lead: {
      findUnique: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        status: 'new',
        category: 'House Cleaning',
        budget: 189,
        city: 'Tampa',
        state: 'FL',
        customerName: 'Jane Doe',
        customerPhone: '+13015551234',
        customerEmail: 'jane@test.com',
        externalRequestId: 'ext-lead-1',
        threadId: 'thread-1',
        businessId: BUSINESS_ID,
      }),
    },
  } as any;
}

describe('CrmWebhookService', () => {
  let service: CrmWebhookService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new CrmWebhookService(prisma);
    jest.clearAllMocks();
  });

  describe('buildPayload', () => {
    it('builds normalized payload with all identity fields', async () => {
      const payload = await service.buildPayload('lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      });

      expect(payload.event_type).toBe('lead.created');
      expect(payload.provider).toBe('leadbridge');
      expect(payload.channel).toBe('yelp');
      expect(payload.event_id).toMatch(/^evt_/);
      expect(payload.occurred_at).toBeDefined();

      // Sigcore identity
      expect(payload.sigcore_workspace_id).toBe('sc_ws_001');
      expect(payload.sigcore_business_id).toBe('sc_biz_001');

      // Provider account
      expect(payload.account_id).toBe('acc-1');
      expect(payload.external_business_id).toBe(BUSINESS_ID);
      expect(payload.external_location_name).toBe('Test Business');

      // Participant
      expect(payload.participant.name).toBe('Jane Doe');
      expect(payload.participant.phone).toBe('+13015551234');
      expect(payload.participant.email).toBe('jane@test.com');

      // Lead
      expect(payload.lead?.id).toBe(LEAD_ID);
      expect(payload.lead?.status).toBe('new');
      expect(payload.lead?.category).toBe('House Cleaning');
      expect(payload.lead?.budget).toBe(189);
      expect(payload.lead?.city).toBe('Tampa');

      // Asset
      expect(payload.asset.type).toBe('phone');
      expect(payload.asset.value).toBe('+13015551234');

      // Thread
      expect(payload.thread.external_thread_id).toBe('thread-1');
      expect(payload.thread.external_lead_id).toBe('ext-lead-1');
    });

    it('includes message data for message events', async () => {
      const payload = await service.buildPayload('message.received', {
        userId: USER_ID,
        platform: 'yelp',
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
        messageBody: 'Hi, I need a quote',
        messageDirection: 'inbound',
        messageSenderType: 'customer',
        messageSentAt: new Date('2026-04-08T15:00:00Z'),
      });

      expect(payload.message).not.toBeNull();
      expect(payload.message?.body).toBe('Hi, I need a quote');
      expect(payload.message?.direction).toBe('inbound');
      expect(payload.message?.sender_type).toBe('customer');
    });

    it('handles null Sigcore IDs gracefully', async () => {
      prisma.user.findUnique.mockResolvedValue({ sigcoreWorkspaceId: null, sigcoreBusinessId: null });

      const payload = await service.buildPayload('lead.created', {
        userId: USER_ID,
        platform: 'thumbtack',
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      });

      expect(payload.sigcore_workspace_id).toBeNull();
      expect(payload.sigcore_business_id).toBeNull();
      // Rest of payload still works
      expect(payload.lead?.id).toBe(LEAD_ID);
    });

    it('handles missing lead gracefully', async () => {
      prisma.lead.findUnique.mockResolvedValue(null);

      const payload = await service.buildPayload('lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        leadId: 'nonexistent',
      });

      expect(payload.lead).toBeNull();
      expect(payload.participant.name).toBeNull();
      expect(payload.asset.type).toBeNull();
    });
  });

  describe('emit', () => {
    it('sends to all matching subscriptions', async () => {
      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      prisma.crmWebhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'CRM 1', webhookUrl: WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['lead.created'], isActive: true },
        { id: 'sub-2', name: 'CRM 2', webhookUrl: 'https://other.com/hook', secret: 'other-secret', events: ['lead.created'], isActive: true },
      ]);

      await service.emit(USER_ID, 'lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        businessId: BUSINESS_ID,
        leadId: LEAD_ID,
      });

      expect(axios.post).toHaveBeenCalledTimes(2);
    });

    it('skips subscriptions that dont match the event type', async () => {
      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      prisma.crmWebhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'CRM 1', webhookUrl: WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['message.received'], isActive: true },
      ]);

      await service.emit(USER_ID, 'lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        leadId: LEAD_ID,
      });

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('does nothing when no subscriptions exist', async () => {
      const axios = require('axios');
      prisma.crmWebhookSubscription.findMany.mockResolvedValue([]);

      await service.emit(USER_ID, 'lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        leadId: LEAD_ID,
      });

      expect(axios.post).not.toHaveBeenCalled();
    });

    it('never throws even when delivery fails', async () => {
      const axios = require('axios');
      axios.post.mockRejectedValue(new Error('Network error'));

      prisma.crmWebhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'CRM 1', webhookUrl: WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['lead.created'], isActive: true },
      ]);

      // Should not throw
      await expect(
        service.emit(USER_ID, 'lead.created', { userId: USER_ID, platform: 'yelp', leadId: LEAD_ID }),
      ).resolves.not.toThrow();
    });

    it('retries once on first failure', async () => {
      const axios = require('axios');
      axios.post
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValueOnce({ status: 200 });

      prisma.crmWebhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'CRM 1', webhookUrl: WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['lead.created'], isActive: true },
      ]);

      await service.emit(USER_ID, 'lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        leadId: LEAD_ID,
      });

      // 2 calls: first attempt + retry
      expect(axios.post).toHaveBeenCalledTimes(2);
    });
  });

  describe('HMAC signing', () => {
    it('includes correct signature headers', async () => {
      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      prisma.crmWebhookSubscription.findMany.mockResolvedValue([
        { id: 'sub-1', name: 'CRM 1', webhookUrl: WEBHOOK_URL, secret: WEBHOOK_SECRET, events: ['lead.created'], isActive: true },
      ]);

      await service.emit(USER_ID, 'lead.created', {
        userId: USER_ID,
        platform: 'yelp',
        leadId: LEAD_ID,
      });

      const call = axios.post.mock.calls[0];
      const headers = call[2].headers;

      expect(headers['X-LB-Signature']).toBeDefined();
      expect(headers['X-LB-Timestamp']).toBeDefined();
      expect(headers['X-LB-Event']).toBe('lead.created');
      expect(headers['Content-Type']).toBe('application/json');

      // Verify signature is valid HMAC
      const body = call[1];
      const timestamp = headers['X-LB-Timestamp'];
      const expectedSig = crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
      expect(headers['X-LB-Signature']).toBe(expectedSig);
    });
  });

  describe('sendTestEvent', () => {
    it('sends test payload to subscription URL', async () => {
      const axios = require('axios');
      axios.post.mockResolvedValue({ status: 200 });

      prisma.crmWebhookSubscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        webhookUrl: WEBHOOK_URL,
        secret: WEBHOOK_SECRET,
      });

      const result = await service.sendTestEvent('sub-1', USER_ID);

      expect(result.success).toBe(true);
      expect(result.status).toBe(200);
      expect(axios.post).toHaveBeenCalledTimes(1);

      // Verify test payload shape
      const sentBody = JSON.parse(axios.post.mock.calls[0][1]);
      expect(sentBody.event_id).toMatch(/^evt_test_/);
      expect(sentBody.channel).toBe('test');
      expect(sentBody.lead.id).toBe('test');
    });

    it('returns error when subscription not found', async () => {
      prisma.crmWebhookSubscription.findFirst.mockResolvedValue(null);

      const result = await service.sendTestEvent('nonexistent', USER_ID);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('returns error details on delivery failure', async () => {
      const axios = require('axios');
      axios.post.mockRejectedValue({ message: 'Connection refused', response: { status: 502 } });

      prisma.crmWebhookSubscription.findFirst.mockResolvedValue({
        id: 'sub-1',
        webhookUrl: WEBHOOK_URL,
        secret: WEBHOOK_SECRET,
      });

      const result = await service.sendTestEvent('sub-1', USER_ID);

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
    });
  });
});
