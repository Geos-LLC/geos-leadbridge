/**
 * Yelp Platform Adapter
 * Implements IPlatformAdapter for Yelp Leads integration
 * Auth: API key (no OAuth) — YELP_API_KEY env var
 */

import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import {
  IPlatformAdapter,
  PlatformCredentials,
  LeadFetchOptions,
  PaginationOptions,
  QuoteData,
  WebhookEventResult,
  PlatformName,
} from '../../common/interfaces/platform.interface';
import {
  NormalizedLead,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedQuote,
  MessageSender,
} from '../../common/dto/normalized.dto';

@Injectable()
export class YelpAdapter implements IPlatformAdapter {
  private readonly logger = new Logger(YelpAdapter.name);
  private readonly httpClient: AxiosInstance;
  private readonly apiKey: string;
  private readonly apiBaseUrl: string;

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('yelp.apiKey') || '';
    this.apiBaseUrl = this.configService.get<string>('yelp.apiBaseUrl') || 'https://api.yelp.com/v3';

    this.httpClient = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 30000,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  getPlatformName(): string {
    return PlatformName.YELP;
  }

  // ==========================================
  // Auth — Yelp uses API key, not OAuth
  // ==========================================

  getAuthUrl(_userId: string, _state: string): string {
    throw new NotImplementedException('Yelp uses API key authentication, not OAuth');
  }

  async handleCallback(_code: string, _userId: string): Promise<PlatformCredentials> {
    throw new NotImplementedException('Yelp uses API key authentication, not OAuth');
  }

  async refreshAccessToken(_refreshToken: string): Promise<PlatformCredentials> {
    throw new NotImplementedException('Yelp API key does not expire or rotate');
  }

  async disconnect(_userId: string): Promise<void> {
    // No-op — API key is global, not per-user
  }

  /**
   * Returns credentials using the configured API key.
   * Since Yelp is API-key based, all users share the same key.
   */
  getApiCredentials(): PlatformCredentials {
    return { accessToken: this.apiKey };
  }

  // ==========================================
  // Leads API
  // ==========================================

  async getLeads(_credentials: PlatformCredentials, _options?: LeadFetchOptions): Promise<NormalizedLead[]> {
    // Yelp delivers leads via webhooks; polling is not the primary flow.
    // For backfill, use getLead() per lead_id from webhook history.
    return [];
  }

  async getLead(credentials: PlatformCredentials, leadId: string): Promise<NormalizedLead> {
    try {
      const response = await this.httpClient.get(`/leads/${leadId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      return this.normalizeLead(response.data);
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Error fetching Yelp lead ${leadId} — status=${status} data=${JSON.stringify(data)}`);
      throw new Error(`Failed to fetch Yelp lead: ${error.message}`);
    }
  }

  /**
   * Fetch lead events (messages) for a given lead.
   * Yelp webhook payloads don't include message content — call this to get actual text.
   */
  async getLeadEvents(leadId: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get(`/leads/${leadId}/events`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.data?.events || response.data?.data || [];
    } catch (error) {
      const status = error.response?.status;
      this.logger.error(`Error fetching Yelp lead events for ${leadId} — status=${status} msg=${error.message}`);
      return [];
    }
  }

  // ==========================================
  // Messaging
  // ==========================================

  async getConversations(_credentials: PlatformCredentials, _options?: PaginationOptions): Promise<NormalizedConversation[]> {
    return [];
  }

  async getConversation(_credentials: PlatformCredentials, _threadId: string, _options?: PaginationOptions): Promise<NormalizedMessage[]> {
    return [];
  }

  async sendMessage(credentials: PlatformCredentials, leadId: string, message: string): Promise<NormalizedMessage> {
    try {
      // POST /v3/leads/{leadId}/events — send a message reply on a lead
      const response = await this.httpClient.post(
        `/leads/${leadId}/events`,
        { event_type: 'MESSAGE', text: message },
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
      );
      const data = response.data;
      const msg = new NormalizedMessage();
      msg.id = data.id || crypto.randomUUID();
      msg.conversationId = leadId;
      msg.platform = PlatformName.YELP;
      msg.externalMessageId = data.id;
      msg.sender = MessageSender.PRO;
      msg.content = message;
      msg.isRead = true;
      msg.sentAt = new Date();
      msg.raw = data;
      return msg;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Error sending Yelp message — status=${status} data=${JSON.stringify(data)} msg=${error.message}`);
      if (status === 401) throw new Error('Yelp API key invalid or expired — check YELP_API_KEY');
      throw new Error(`Failed to send message to Yelp: ${error.message}`);
    }
  }

  // ==========================================
  // Quotes (not applicable for Yelp)
  // ==========================================

  async sendQuote(_credentials: PlatformCredentials, _requestId: string, _quote: QuoteData): Promise<NormalizedQuote> {
    throw new NotImplementedException('Yelp does not support quotes');
  }

  // ==========================================
  // Webhook Verification & Handling
  // ==========================================

  verifyWebhookSignature(signature: string, payload: string, secret: string): boolean {
    if (!signature || !secret) return true;
    try {
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
      // Constant-time comparison
      const sigBuf = Buffer.from(signature.replace(/^sha256=/, ''));
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length) return false;
      return crypto.timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  async handleWebhookEvent(event: any): Promise<WebhookEventResult> {
    const eventType = event?.data?.event_type || event?.data?.updates?.[0]?.event_type || 'unknown';
    return { eventType, processed: true };
  }

  // ==========================================
  // Business Subscriptions
  // ==========================================

  /**
   * Subscribe businesses to Yelp lead webhooks.
   * Should be called for each business and synced at least every 24h.
   */
  async subscribeToBusinesses(businessIds: string[]): Promise<void> {
    try {
      await this.httpClient.post(
        '/leads/subscriptions',
        {
          business_ids: businessIds,
          subscription_types: ['WEBHOOK'],
        },
        { headers: { Authorization: `Bearer ${this.apiKey}` } },
      );
      this.logger.log(`Subscribed ${businessIds.length} businesses to Yelp lead webhooks`);
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Error subscribing Yelp businesses — status=${status} data=${JSON.stringify(data)}`);
      throw new Error(`Failed to subscribe to Yelp webhooks: ${error.message}`);
    }
  }

  /**
   * Unsubscribe businesses from Yelp lead webhooks.
   */
  async unsubscribeFromBusinesses(businessIds: string[]): Promise<void> {
    try {
      await this.httpClient.delete('/leads/subscriptions', {
        data: { business_ids: businessIds },
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      this.logger.log(`Unsubscribed ${businessIds.length} businesses from Yelp lead webhooks`);
    } catch (error) {
      this.logger.warn(`Failed to unsubscribe Yelp businesses: ${error.message}`);
    }
  }

  // ==========================================
  // Data Normalization
  // ==========================================

  normalizeLead(data: any): NormalizedLead {
    const lead = new NormalizedLead();
    lead.platform = PlatformName.YELP;
    lead.externalRequestId = data.id || data.lead_id;
    lead.businessId = data.business_id || data.businessId;
    lead.customerName = data.consumer?.name || data.customer?.name || 'Unknown';
    lead.customerPhone = data.consumer?.phone || data.customer?.phone;
    lead.customerEmail = data.consumer?.email || data.customer?.email;
    lead.message = data.request_text || data.message?.text || data.description || '';
    lead.city = data.location?.city;
    lead.state = data.location?.state;
    lead.postcode = data.location?.zip_code || data.location?.zipCode;
    lead.category = data.services?.[0]?.name || data.category;
    lead.threadId = data.id || data.lead_id; // lead_id doubles as thread ID on Yelp
    lead.status = data.status || 'new';
    lead.createdAt = new Date(data.time_created || data.created_at || Date.now());
    lead.updatedAt = new Date(data.time_updated || data.updated_at || Date.now());
    lead.raw = data;
    return lead;
  }
}
