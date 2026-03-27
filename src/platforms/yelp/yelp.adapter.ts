/**
 * Yelp Platform Adapter
 * Implements IPlatformAdapter for Yelp Leads integration
 * Auth: API Key (webhooks/subscriptions) + OAuth (per-business lead access/reply)
 */

import { Injectable, Logger } from '@nestjs/common';
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
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly apiBaseUrl: string;
  private readonly authBaseUrl = 'https://biz.yelp.com/oauth2';
  private readonly tokenUrl = 'https://api.yelp.com/oauth2/token';

  constructor(private configService: ConfigService) {
    this.apiKey = this.configService.get<string>('yelp.apiKey') || '';
    this.clientId = this.configService.get<string>('yelp.clientId') || '';
    this.clientSecret = this.configService.get<string>('yelp.clientSecret') || '';
    this.redirectUri = this.configService.get<string>('yelp.redirectUri') || '';
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
  // OAuth — Business Owner authorization
  // ==========================================

  getAuthUrl(_userId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'leads r2r_business_owner r2r_get_businesses',
      state,
    });

    return `${this.authBaseUrl}/authorize?${params.toString()}`;
  }

  async handleCallback(code: string, _userId: string): Promise<PlatformCredentials> {
    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('client_id', this.clientId);
      params.append('client_secret', this.clientSecret);
      params.append('code', code);
      params.append('redirect_uri', this.redirectUri);

      this.logger.log(`Exchanging Yelp authorization code for tokens — client_id=${this.clientId}, redirect_uri=${this.redirectUri}, code=${code.substring(0, 10)}...`);

      const response = await axios.post(this.tokenUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const { access_token, refresh_token, expires_in, token_type } = response.data;

      this.logger.log(`Yelp OAuth token received, type=${token_type}, expires_in=${expires_in}`);

      return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: expires_in ? new Date(Date.now() + expires_in * 1000) : undefined,
      };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Yelp OAuth callback error — status=${status} data=${JSON.stringify(data)}`);
      throw new Error(`Failed to exchange Yelp authorization code: ${data?.error_description || error.message}`);
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<PlatformCredentials> {
    this.logger.log('Attempting to refresh Yelp access token...');
    try {
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('client_id', this.clientId);
      params.append('client_secret', this.clientSecret);
      params.append('refresh_token', refreshToken);

      const response = await axios.post(this.tokenUrl, params, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      });

      const { access_token, refresh_token: new_refresh_token, expires_in } = response.data;

      const newExpiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : undefined;
      this.logger.log(`Yelp token refreshed successfully! Expires at: ${newExpiresAt?.toISOString() || 'unknown'}`);

      return {
        accessToken: access_token,
        refreshToken: new_refresh_token || refreshToken,
        expiresAt: newExpiresAt,
      };
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Yelp token refresh failed — status=${status} data=${JSON.stringify(data)}`);
      throw new Error(`Failed to refresh Yelp token: ${data?.error_description || error.message} (status=${status})`);
    }
  }

  async disconnect(_userId: string): Promise<void> {
    // No revocation endpoint documented for Yelp
  }

  /**
   * Returns credentials using the configured API key.
   * Used for subscription management (not lead access).
   */
  getApiCredentials(): PlatformCredentials {
    return { accessToken: this.apiKey };
  }

  // ==========================================
  // Business Owner — fetch claimed businesses
  // ==========================================

  async getClaimedBusinesses(accessToken: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get('/businesses/claimed', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const businesses = response.data?.businesses || [];
      this.logger.log(`Yelp claimed businesses response: ${JSON.stringify(response.data)}`);
      this.logger.log(`Found ${businesses.length} claimed businesses`);
      return businesses;
    } catch (error) {
      const status = error.response?.status;
      const data = error.response?.data;
      this.logger.error(`Error fetching Yelp claimed businesses — status=${status} data=${JSON.stringify(data)}`);
      return [];
    }
  }

  // ==========================================
  // Leads API
  // ==========================================

  async getLeads(_credentials: PlatformCredentials, _options?: LeadFetchOptions): Promise<NormalizedLead[]> {
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

  async getLeadEvents(credentials: PlatformCredentials, leadId: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get(`/leads/${leadId}/events`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
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
      const response = await this.httpClient.post(
        `/leads/${leadId}/events`,
        { request_type: 'TEXT', request_content: message },
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
      if (status === 401) throw new Error('Yelp token expired — please reconnect your Yelp account');
      throw new Error(`Failed to send message to Yelp: ${error.message}`);
    }
  }

  // ==========================================
  // Quotes (not applicable for Yelp)
  // ==========================================

  async sendQuote(_credentials: PlatformCredentials, _requestId: string, _quote: QuoteData): Promise<NormalizedQuote> {
    throw new Error('Yelp does not support quotes');
  }

  // ==========================================
  // Webhook Verification & Handling
  // ==========================================

  verifyWebhookSignature(signature: string, payload: string, secret: string): boolean {
    if (!signature || !secret) return true;
    try {
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
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
  // Business Subscriptions (uses API key)
  // ==========================================

  async subscribeToBusinesses(businessIds: string[]): Promise<void> {
    try {
      await this.httpClient.post(
        '/leads/subscriptions',
        { business_ids: businessIds, subscription_types: ['WEBHOOK'] },
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
    lead.threadId = data.id || data.lead_id;
    lead.status = data.status || 'new';
    lead.createdAt = new Date(data.time_created || data.created_at || Date.now());
    lead.updatedAt = new Date(data.time_updated || data.updated_at || Date.now());
    lead.raw = data;
    return lead;
  }
}
