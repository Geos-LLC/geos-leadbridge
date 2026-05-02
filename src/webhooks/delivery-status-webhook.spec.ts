/**
 * Tests for WebhooksService.handleSigcoreDeliveryStatus — the inbound webhook
 * handler that promotes NotificationLog rows from 'pending' to 'sent' /
 * 'delivered' / 'failed' based on Sigcore's delivery callback.
 *
 * This is the OTHER half of the fix: with the URL patched, Sigcore now
 * actually reaches us. These tests pin down the handler's behaviour so the
 * pending→delivered path can't silently regress.
 *
 * We bypass the constructor (the real WebhooksService has many DI
 * dependencies and a setInterval) and exercise only the method under test.
 */

import { WebhooksService } from './webhooks.service';
import { Logger } from '@nestjs/common';

function buildHarness(opts: {
  notificationLogFindFirst?: jest.Mock;
  notificationLogUpdate?: jest.Mock;
  messageFindFirst?: jest.Mock;
  messageUpdate?: jest.Mock;
  leadFindUnique?: jest.Mock;
  webhookEventCreate?: jest.Mock;
  webhookEventUpdate?: jest.Mock;
  eventEmitterEmit?: jest.Mock;
} = {}) {
  const svc = Object.create(WebhooksService.prototype);
  (svc as any).logger = new Logger('WebhooksServiceTest');

  const notificationLogFindFirst = opts.notificationLogFindFirst || jest.fn();
  const notificationLogUpdate = opts.notificationLogUpdate || jest.fn().mockResolvedValue({});
  const messageFindFirst = opts.messageFindFirst || jest.fn().mockResolvedValue(null);
  const messageUpdate = opts.messageUpdate || jest.fn().mockResolvedValue({});
  const leadFindUnique = opts.leadFindUnique || jest.fn().mockResolvedValue(null);
  const webhookEventCreate = opts.webhookEventCreate || jest.fn().mockResolvedValue({ id: 'wh-event-1' });
  const webhookEventUpdate = opts.webhookEventUpdate || jest.fn().mockResolvedValue({});
  const eventEmitterEmit = opts.eventEmitterEmit || jest.fn();

  (svc as any).prisma = {
    webhookEvent: { create: webhookEventCreate, update: webhookEventUpdate },
    notificationLog: { findFirst: notificationLogFindFirst, update: notificationLogUpdate },
    message: { findFirst: messageFindFirst, update: messageUpdate },
    lead: { findUnique: leadFindUnique },
  };
  (svc as any).eventEmitter = { emit: eventEmitterEmit };

  return {
    svc: svc as WebhooksService,
    notificationLogFindFirst,
    notificationLogUpdate,
    messageFindFirst,
    messageUpdate,
    leadFindUnique,
    webhookEventCreate,
    webhookEventUpdate,
    eventEmitterEmit,
  };
}

describe('WebhooksService.handleSigcoreDeliveryStatus', () => {
  it('promotes a stuck pending NotificationLog to delivered and sets deliveredAt', async () => {
    const stuckLog = {
      id: 'log-1',
      status: 'pending',
      sigcoreMessageId: 'msg-1',
      leadId: null, // simplest path — no SSE emit
    };
    const harness = buildHarness({
      notificationLogFindFirst: jest.fn().mockResolvedValue(stuckLog),
    });

    await harness.svc.handleSigcoreDeliveryStatus({
      eventType: 'message.delivered',
      timestamp: '2026-05-01T18:44:22Z',
      signature: 'sig',
      payload: { event: 'message.delivered', data: { messageId: 'msg-1', status: 'delivered' } },
      rawBody: '{}',
    });

    expect(harness.notificationLogFindFirst).toHaveBeenCalledWith({
      where: { sigcoreMessageId: 'msg-1' },
    });
    expect(harness.notificationLogUpdate).toHaveBeenCalledTimes(1);
    const updateArgs = harness.notificationLogUpdate.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 'log-1' });
    expect(updateArgs.data.status).toBe('delivered');
    expect(updateArgs.data.deliveredAt).toBeInstanceOf(Date);
  });

  it('records error details when status is failed', async () => {
    const stuckLog = {
      id: 'log-2',
      status: 'pending',
      sigcoreMessageId: 'msg-2',
      leadId: null,
    };
    const harness = buildHarness({
      notificationLogFindFirst: jest.fn().mockResolvedValue(stuckLog),
    });

    await harness.svc.handleSigcoreDeliveryStatus({
      eventType: 'message.failed',
      timestamp: '2026-05-01T18:00:00Z',
      signature: 'sig',
      payload: {
        event: 'message.failed',
        data: {
          messageId: 'msg-2',
          status: 'failed',
          errorCode: 30007,
          errorMessage: 'Carrier rejected',
        },
      },
      rawBody: '{}',
    });

    const updateArgs = harness.notificationLogUpdate.mock.calls[0][0];
    expect(updateArgs.data.status).toBe('failed');
    expect(updateArgs.data.error).toBe('Carrier rejected');
    expect(updateArgs.data.deliveredAt).toBeUndefined();
  });

  it('is idempotent — skips the update when the log is already at the target status', async () => {
    // Simulates the case where a workspace-level sub AND a tenant-level sub
    // both fire for the same event (we PATCHed the workspace sub on
    // 2026-05-01, but tenant subs have always had message.delivered too).
    const alreadyDelivered = {
      id: 'log-3',
      status: 'delivered',
      sigcoreMessageId: 'msg-3',
      leadId: null,
    };
    const harness = buildHarness({
      notificationLogFindFirst: jest.fn().mockResolvedValue(alreadyDelivered),
    });

    await harness.svc.handleSigcoreDeliveryStatus({
      eventType: 'message.delivered',
      timestamp: 'ts',
      signature: 'sig',
      payload: { event: 'message.delivered', data: { messageId: 'msg-3', status: 'delivered' } },
      rawBody: '{}',
    });

    expect(harness.notificationLogUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when no NotificationLog matches the messageId (cross-tenant fan-out)', async () => {
    const harness = buildHarness({
      notificationLogFindFirst: jest.fn().mockResolvedValue(null),
    });

    await harness.svc.handleSigcoreDeliveryStatus({
      eventType: 'message.delivered',
      timestamp: 'ts',
      signature: 'sig',
      payload: { event: 'message.delivered', data: { messageId: 'unknown-msg', status: 'delivered' } },
      rawBody: '{}',
    });

    expect(harness.notificationLogUpdate).not.toHaveBeenCalled();
    // We still record the WebhookEvent for audit, even when there's nothing
    // to update on our side.
    expect(harness.webhookEventCreate).toHaveBeenCalled();
    expect(harness.webhookEventUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ processed: true }) }),
    );
  });

  it('emits an SSE event for the lead owner when a linked Message exists and status changes', async () => {
    const stuckLog = {
      id: 'log-4',
      status: 'pending',
      sigcoreMessageId: 'msg-4',
      leadId: 'lead-4',
    };
    const harness = buildHarness({
      notificationLogFindFirst: jest.fn().mockResolvedValue(stuckLog),
      messageFindFirst: jest.fn().mockResolvedValue({ id: 'message-4' }),
      leadFindUnique: jest.fn().mockResolvedValue({ userId: 'user-4' }),
    });

    await harness.svc.handleSigcoreDeliveryStatus({
      eventType: 'message.delivered',
      timestamp: 'ts',
      signature: 'sig',
      payload: { event: 'message.delivered', data: { messageId: 'msg-4', status: 'delivered' } },
      rawBody: '{}',
    });

    expect(harness.eventEmitterEmit).toHaveBeenCalledWith(
      'sms.status.user-4',
      expect.objectContaining({
        messageId: 'message-4',
        logId: 'log-4',
        status: 'delivered',
      }),
    );
  });
});
