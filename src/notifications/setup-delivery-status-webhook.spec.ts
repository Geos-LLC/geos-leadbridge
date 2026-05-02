/**
 * Tests for NotificationsService.setupDeliveryStatusWebhook — the idempotent
 * registration of the workspace-level Sigcore delivery-status webhook
 * subscription.
 *
 * The method is workspace-scoped and uses the platform SIGCORE_API_KEY (not
 * a tenant key). It should:
 *   - List existing subs and match by name='LeadBridge Delivery Notifications'
 *   - Fast-path: do nothing when an existing sub is already correct
 *   - PATCH stale URL / events / status='paused' to the current values
 *   - POST a new sub when none exists
 *   - Be cheap to call repeatedly (in-process cache)
 *
 * We bypass the real constructor with Object.create so we don't have to wire
 * up the full DI graph for these unit tests.
 */

import { NotificationsService } from './notifications.service';
import { Logger } from '@nestjs/common';

const SIGCORE_BASE = 'https://sigcore-production.up.railway.app/api';
const SUBS_ENDPOINT = `${SIGCORE_BASE}/v1/webhook-subscriptions`;
const EXPECTED_URL = 'https://api.example.com/api/webhooks/sigcore/delivery-status';
const EXPECTED_NAME = 'LeadBridge Delivery Notifications';
const EXPECTED_EVENTS = ['message.sent', 'message.delivered', 'message.failed'];

function buildHarness(env: Record<string, string> = {}) {
  const svc = Object.create(NotificationsService.prototype) as NotificationsService;
  (svc as any).logger = new Logger('NotificationsServiceTest');
  (svc as any).configService = {
    get: (key: string, def?: any) => env[key] ?? def,
  };
  // Reset the static cache between tests so each scenario starts clean.
  (NotificationsService as any).deliveryStatusWebhookCachedAt = 0;
  (NotificationsService as any).cachedDeliveryStatusWebhookId = null;
  return svc;
}

function jsonResponse(body: any, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as any;
}

describe('NotificationsService.setupDeliveryStatusWebhook', () => {
  const baseEnv = {
    SIGCORE_API_KEY: 'sc_test_workspace_key',
    SIGCORE_API_URL: SIGCORE_BASE,
    BACKEND_PUBLIC_URL: 'https://api.example.com',
  };

  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    fetchSpy = jest.spyOn(global, 'fetch' as any);
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('creates a new subscription when none exists', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // list — empty
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'sub-new-123' } })); // create

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('created');
    expect(result.webhookId).toBe('sub-new-123');

    // List call
    expect(fetchSpy).toHaveBeenNthCalledWith(1, SUBS_ENDPOINT, expect.objectContaining({
      headers: { 'x-api-key': 'sc_test_workspace_key' },
    }));

    // Create call
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      SUBS_ENDPOINT,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-api-key': 'sc_test_workspace_key' }),
      }),
    );
    const createBody = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
    expect(createBody).toEqual({
      name: EXPECTED_NAME,
      webhookUrl: EXPECTED_URL,
      events: expect.arrayContaining(EXPECTED_EVENTS),
    });
  });

  it('is a no-op when an existing sub already has correct URL/events/status', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'sub-existing-1',
            name: EXPECTED_NAME,
            tenantId: null,
            webhookUrl: EXPECTED_URL,
            events: EXPECTED_EVENTS,
            status: 'active',
          },
        ],
      }),
    );

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('noop');
    expect(result.webhookId).toBe('sub-existing-1');
    // Only the list call — no PATCH, no POST.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('PATCHes the URL when the existing sub points at a stale host (this is the bug we shipped against)', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'sub-stale-1',
              name: EXPECTED_NAME,
              tenantId: null,
              webhookUrl: 'https://www.leadbridge360.com/api/webhooks/sigcore/delivery-status', // the old broken URL
              events: EXPECTED_EVENTS,
              status: 'paused', // failures racked up → paused
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'sub-stale-1' } })); // patch response

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('patched');
    expect(result.webhookId).toBe('sub-stale-1');

    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      `${SUBS_ENDPOINT}/sub-stale-1`,
      expect.objectContaining({ method: 'PATCH' }),
    );
    const patchBody = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
    expect(patchBody.webhookUrl).toBe(EXPECTED_URL);
    expect(patchBody.status).toBe('active');
    // Events match in this scenario, so the PATCH should NOT include them
    expect(patchBody.events).toBeUndefined();
  });

  it('PATCHes events when they drift from the expected set', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            {
              id: 'sub-events-drift',
              name: EXPECTED_NAME,
              tenantId: null,
              webhookUrl: EXPECTED_URL,
              // Missing 'message.failed' — needs to be patched.
              events: ['message.sent', 'message.delivered'],
              status: 'active',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'sub-events-drift' } }));

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('patched');
    const patchBody = JSON.parse((fetchSpy.mock.calls[1][1] as any).body);
    expect(patchBody.events).toEqual(expect.arrayContaining(EXPECTED_EVENTS));
    expect(patchBody.webhookUrl).toBeUndefined(); // URL already correct
  });

  it('returns cached result on the second call within TTL — no Sigcore calls', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            id: 'sub-cache-1',
            name: EXPECTED_NAME,
            tenantId: null,
            webhookUrl: EXPECTED_URL,
            events: EXPECTED_EVENTS,
            status: 'active',
          },
        ],
      }),
    );

    const first = await svc.setupDeliveryStatusWebhook();
    expect(first.action).toBe('noop');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call should hit cache, not Sigcore.
    const second = await svc.setupDeliveryStatusWebhook();
    expect(second.action).toBe('cached');
    expect(second.webhookId).toBe('sub-cache-1');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('skips registration when SIGCORE_API_KEY is not configured (no throw)', async () => {
    // Don't set SIGCORE_API_KEY.
    const svc = buildHarness({ BACKEND_PUBLIC_URL: 'https://api.example.com' });

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('skipped');
    expect(result.webhookId).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not match tenant-scoped subs (only workspace-level)', async () => {
    const svc = buildHarness(baseEnv);
    fetchSpy
      .mockResolvedValueOnce(
        jsonResponse({
          data: [
            // A tenant-scoped sub with matching name should be ignored.
            {
              id: 'tenant-sub-1',
              name: EXPECTED_NAME,
              tenantId: 'some-tenant',
              webhookUrl: EXPECTED_URL,
              events: EXPECTED_EVENTS,
              status: 'active',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { id: 'sub-fresh-create' } }));

    const result = await svc.setupDeliveryStatusWebhook();

    expect(result.action).toBe('created');
    expect(result.webhookId).toBe('sub-fresh-create');
  });
});
