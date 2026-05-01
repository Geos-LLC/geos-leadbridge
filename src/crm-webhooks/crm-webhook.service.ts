/**
 * CRM Webhook Service
 *
 * Outbound webhook delivery for external CRM integrations (e.g., ServiceFlow).
 * Emits normalized events with Sigcore identity context when available.
 * HMAC-SHA256 signed, 1 retry on failure, never breaks core webhook processing.
 */

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import * as crypto from 'crypto';

/** Supported CRM webhook event types */
export type CrmEventType = 'lead.created' | 'message.received' | 'message.sent' | 'lead.status_changed';

/** Normalized event payload — stable contract across all platforms */
export interface CrmEventPayload {
  event_id: string;
  event_type: CrmEventType;
  occurred_at: string;

  provider: 'leadbridge';
  channel: string; // "thumbtack" | "yelp" | "sms"

  // Sigcore business identity (null if not yet registered)
  sigcore_workspace_id: string | null;
  sigcore_business_id: string | null;

  // Provider account context
  account_id: string | null;
  external_account_id: string | null;
  external_business_id: string | null;
  external_location_id: string | null;
  external_location_name: string | null;

  // Communication asset
  asset: {
    type: 'phone' | 'email' | null;
    value: string | null;
    normalized: string | null;
    role: 'lead_capture' | 'customer_contact' | null;
  };

  // Thread context
  thread: {
    external_conversation_id: string | null;
    external_thread_id: string | null;
    external_lead_id: string | null;
  };

  // Customer/participant
  participant: {
    external_contact_id: string | null;
    name: string | null;
    phone: string | null;
    email: string | null;
  };

  // Message (for message events)
  message: {
    external_message_id: string | null;
    direction: 'inbound' | 'outbound';
    body: string | null;
    sent_at: string | null;
    sender_type: 'user' | 'ai' | 'customer' | null;
  } | null;

  // Lead data
  lead: {
    id: string | null;
    status: string | null;
    category: string | null;
    budget: number | null;
    city: string | null;
    state: string | null;
  } | null;

  raw: any;
}

/** Context passed to buildPayload for constructing normalized events */
export interface CrmEventContext {
  userId: string;
  platform: string;
  businessId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  messageDirection?: 'inbound' | 'outbound';
  messageBody?: string | null;
  messageSentAt?: Date | null;
  messageSenderType?: 'user' | 'ai' | 'customer' | null;
  previousStatus?: string | null;
  raw?: any;
  /**
   * Optional caller-supplied event id. When present it becomes the
   * payload.event_id sent to the receiver AND CrmWebhookDelivery.eventId,
   * so a single id traces LB write → outbound delivery → SF inbound →
   * downstream audit log. When absent, a fresh evt_<uuid> is generated.
   */
  eventId?: string;
}

@Injectable()
export class CrmWebhookService {
  private readonly logger = new Logger(CrmWebhookService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Emit a CRM webhook event to all active OUTBOUND subscriptions for this user.
   * Fire-and-forget — never throws, never blocks core processing.
   *
   * Loop prevention: for lead.status_changed, if the triggering write came from
   * Service Flow (lead.statusSource = 'service_flow'), suppress emission to
   * avoid SF → LB → SF → LB bouncing. See plans/2026-04-17-job-sync-sf-lb.md §5.2.
   */
  async emit(userId: string, eventType: CrmEventType, context: CrmEventContext): Promise<void> {
    try {
      // Loop guard: skip lead.status_changed when the write came from SF itself.
      if (eventType === 'lead.status_changed' && context.leadId) {
        const lead = await this.prisma.lead.findUnique({
          where: { id: context.leadId },
          select: { statusSource: true },
        });
        if (lead?.statusSource === 'service_flow') {
          this.logger.debug(
            `[CrmWebhook] event_id=null sub_id=null attempt=0 status_code=null result=loop_suppressed event_type=${eventType} lead_id=${context.leadId}`,
          );
          return;
        }
      }

      const subscriptions = await this.prisma.crmWebhookSubscription.findMany({
        where: { userId, isActive: true, direction: 'outbound' },
      });

      if (subscriptions.length === 0) return;

      // Filter to subscriptions that listen for this event type
      const matching = subscriptions.filter(s => s.events.includes(eventType));
      if (matching.length === 0) return;

      const payload = await this.buildPayload(eventType, context);

      // Send to all matching subscriptions in parallel, non-blocking
      await Promise.allSettled(
        matching.map(sub => this.sendWebhook(sub, payload)),
      );
    } catch (err: any) {
      this.logger.error(
        `[CrmWebhook] event_id=null sub_id=null attempt=0 status_code=null result=failed event_type=${eventType} error=${this.sanitizeError(err?.message)}`,
      );
      // Never rethrow — must not break core processing
    }
  }

  /**
   * Build the normalized event payload with full identity context.
   */
  async buildPayload(eventType: CrmEventType, ctx: CrmEventContext): Promise<CrmEventPayload> {
    // Load user for Sigcore identity fields
    const user = await this.prisma.user.findUnique({
      where: { id: ctx.userId },
      select: { sigcoreWorkspaceId: true, sigcoreBusinessId: true },
    });

    // Load saved account for provider context
    let account: any = null;
    if (ctx.businessId) {
      account = await this.prisma.savedAccount.findFirst({
        where: { userId: ctx.userId, businessId: ctx.businessId },
        select: { id: true, businessId: true, businessName: true, platform: true },
      });
    }

    // Load lead data
    let lead: any = null;
    if (ctx.leadId) {
      lead = await this.prisma.lead.findUnique({
        where: { id: ctx.leadId },
        select: {
          id: true, status: true, category: true, budget: true,
          city: true, state: true, customerName: true, customerPhone: true,
          customerEmail: true, externalRequestId: true, threadId: true,
          businessId: true,
        },
      });
    }

    return {
      event_id: ctx.eventId || `evt_${crypto.randomUUID()}`,
      event_type: eventType,
      occurred_at: new Date().toISOString(),

      provider: 'leadbridge',
      channel: ctx.platform,

      // Sigcore identity — transitional, populated when available
      sigcore_workspace_id: user?.sigcoreWorkspaceId || null,
      sigcore_business_id: user?.sigcoreBusinessId || null,

      // Provider account
      account_id: account?.id || null,
      external_account_id: null, // Platform-specific account ID if distinct
      external_business_id: ctx.businessId || lead?.businessId || null,
      external_location_id: ctx.businessId || null,
      external_location_name: account?.businessName || null,

      // Communication asset
      asset: {
        type: lead?.customerPhone ? 'phone' : null,
        value: lead?.customerPhone || null,
        normalized: lead?.customerPhone || null,
        role: 'lead_capture',
      },

      // Thread
      thread: {
        external_conversation_id: ctx.conversationId || lead?.threadId || null,
        external_thread_id: lead?.threadId || null,
        external_lead_id: lead?.externalRequestId || null,
      },

      // Participant (customer)
      participant: {
        external_contact_id: lead?.id || null,
        name: lead?.customerName || null,
        phone: lead?.customerPhone || null,
        email: lead?.customerEmail || null,
      },

      // Message (populated for message events)
      message: ctx.messageBody !== undefined ? {
        external_message_id: ctx.messageId || null,
        direction: ctx.messageDirection || 'inbound',
        body: ctx.messageBody || null,
        sent_at: ctx.messageSentAt?.toISOString() || new Date().toISOString(),
        sender_type: ctx.messageSenderType || null,
      } : null,

      // Lead
      lead: lead ? {
        id: lead.id,
        status: lead.status,
        category: lead.category,
        budget: lead.budget ? parseFloat(lead.budget.toString()) : null,
        city: lead.city,
        state: lead.state,
      } : null,

      raw: ctx.raw || {},
    };
  }

  /**
   * Send webhook to a subscription endpoint with HMAC-SHA256 signature.
   * Persists a CrmWebhookDelivery row keyed by payload.event_id; updates
   * attempts/state/lastStatusCode/lastError after each attempt. Retries once.
   */
  private async sendWebhook(subscription: any, payload: CrmEventPayload): Promise<void> {
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.sign(timestamp, body, subscription.secret);

    const headers = {
      'Content-Type': 'application/json',
      'X-LB-Signature': signature,
      'X-LB-Timestamp': timestamp,
      'X-LB-Event': payload.event_type,
    };

    // Create the delivery row up front. attempts increments per attempt.
    let deliveryId: string | null = null;
    try {
      const row = await this.prisma.crmWebhookDelivery.create({
        data: {
          subscriptionId: subscription.id,
          eventType: payload.event_type,
          eventId: payload.event_id,
          attempts: 0,
          state: 'pending',
        },
        select: { id: true },
      });
      deliveryId = row.id;
    } catch (err: any) {
      // Persistence failure must never break delivery — log and continue.
      this.logger.warn(
        `[CrmWebhook] event_id=${payload.event_id} sub_id=${subscription.id} attempt=0 status_code=null result=persist_failed error=${this.sanitizeError(err?.message)}`,
      );
    }

    const axios = require('axios');

    // Attempt 1
    try {
      const res = await axios.post(subscription.webhookUrl, body, { headers, timeout: 10000 });
      await this.recordDelivery(deliveryId, {
        attempts: 1,
        state: 'sent',
        lastStatusCode: res?.status ?? 200,
        deliveredAt: new Date(),
      });
      this.logger.log(
        `[CrmWebhook] event_id=${payload.event_id} sub_id=${subscription.id} attempt=1 status_code=${res?.status ?? 200} result=success`,
      );
      return;
    } catch (err: any) {
      const status = err?.response?.status ?? null;
      await this.recordDelivery(deliveryId, {
        attempts: 1,
        state: 'pending',
        lastStatusCode: status,
        lastError: this.sanitizeError(err?.message),
      });
      this.logger.warn(
        `[CrmWebhook] event_id=${payload.event_id} sub_id=${subscription.id} attempt=1 status_code=${status ?? 'null'} result=failed error=${this.sanitizeError(err?.message)}`,
      );
    }

    // Attempt 2 (retry)
    try {
      const res = await axios.post(subscription.webhookUrl, body, { headers, timeout: 15000 });
      await this.recordDelivery(deliveryId, {
        attempts: 2,
        state: 'sent',
        lastStatusCode: res?.status ?? 200,
        deliveredAt: new Date(),
      });
      this.logger.log(
        `[CrmWebhook] event_id=${payload.event_id} sub_id=${subscription.id} attempt=2 status_code=${res?.status ?? 200} result=success`,
      );
    } catch (err: any) {
      const status = err?.response?.status ?? null;
      await this.recordDelivery(deliveryId, {
        attempts: 2,
        state: 'failed',
        lastStatusCode: status,
        lastError: this.sanitizeError(err?.message),
      });
      this.logger.error(
        `[CrmWebhook] event_id=${payload.event_id} sub_id=${subscription.id} attempt=2 status_code=${status ?? 'null'} result=failed error=${this.sanitizeError(err?.message)}`,
      );
    }
  }

  private async recordDelivery(
    id: string | null,
    patch: {
      attempts?: number;
      state?: 'pending' | 'sent' | 'failed';
      lastStatusCode?: number | null;
      lastError?: string | null;
      deliveredAt?: Date;
    },
  ): Promise<void> {
    if (!id) return;
    try {
      await this.prisma.crmWebhookDelivery.update({ where: { id }, data: patch });
    } catch {
      // best-effort
    }
  }

  private sanitizeError(msg: string | undefined | null): string {
    if (!msg) return 'unknown';
    // Strip newlines/spaces so the k=v log line stays parseable.
    return String(msg).replace(/\s+/g, ' ').slice(0, 300);
  }

  /**
   * HMAC-SHA256 signature: sign(timestamp + '.' + body)
   */
  private sign(timestamp: string, body: string, secret: string): string {
    return crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex');
  }

  /**
   * Send a test event to verify webhook connectivity.
   */
  async sendTestEvent(subscriptionId: string, userId: string): Promise<{ success: boolean; status?: number; error?: string }> {
    const sub = await this.prisma.crmWebhookSubscription.findFirst({
      where: { id: subscriptionId, userId, direction: 'outbound' },
    });
    if (!sub) throw new NotFoundException('Subscription not found');

    const testPayload: CrmEventPayload = {
      event_id: `evt_test_${crypto.randomUUID()}`,
      event_type: 'lead.created',
      occurred_at: new Date().toISOString(),
      provider: 'leadbridge',
      channel: 'test',
      sigcore_workspace_id: null,
      sigcore_business_id: null,
      account_id: null,
      external_account_id: null,
      external_business_id: null,
      external_location_id: null,
      external_location_name: null,
      asset: { type: null, value: null, normalized: null, role: null },
      thread: { external_conversation_id: null, external_thread_id: null, external_lead_id: null },
      participant: { external_contact_id: null, name: 'Test Customer', phone: '+10000000000', email: null },
      message: null,
      lead: { id: 'test', status: 'new', category: 'Test', budget: null, city: 'Test', state: 'FL' },
      raw: { test: true },
    };

    const body = JSON.stringify(testPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = this.sign(timestamp, body, sub.secret);

    try {
      const axios = require('axios');
      const res = await axios.post(sub.webhookUrl, body, {
        headers: {
          'Content-Type': 'application/json',
          'X-LB-Signature': signature,
          'X-LB-Timestamp': timestamp,
          'X-LB-Event': 'lead.created',
        },
        timeout: 10000,
      });
      return { success: true, status: res.status };
    } catch (err: any) {
      return { success: false, status: err.response?.status, error: err.message };
    }
  }
}
