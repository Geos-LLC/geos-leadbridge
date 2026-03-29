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

  /**
   * Returns the full logout → login → OAuth authorize chain URL.
   * Chain: logout → /login?return_url=/oauth2/authorize?... → consent → callback.
   * Three-level nesting: logout return_url = /login?return_url=/oauth2/authorize?...
   * This ensures the user always sees the login page (can pick a different account).
   */
  getAuthUrl(_userId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'leads r2r_business_owner r2r_get_businesses',
      state,
    });

    // Build: /login?return_url=/oauth2/authorize?client_id=...%26redirect_uri=...
    // Inner & encoded as %26 so they stay inside the OAuth path
    const oauthPath = `/oauth2/authorize?${params.toString().replace(/&/g, '%26')}`;
    // Outer: logout return_url = /login?return_url=<oauthPath>
    // Encode the oauthPath for the login return_url param
    const loginPath = `/login?return_url=${encodeURIComponent(oauthPath)}`;
    return `https://biz.yelp.com/logout?return_url=${loginPath}`;
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
      // Per Yelp docs: partner-api.yelp.com/token/v1/businesses returns { business_ids: [...] }
      const response = await axios.get('https://partner-api.yelp.com/token/v1/businesses', {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      });
      const data = response.data;
      const businessIds: string[] = data?.business_ids || [];
      this.logger.log(`Yelp claimed business IDs: ${businessIds.length} found — ${JSON.stringify(businessIds)}`);

      if (businessIds.length === 0) return [];

      // Fetch business details for each ID using the Yelp Fusion API (API key)
      const businesses: any[] = [];
      for (const bizId of businessIds) {
        try {
          const bizResponse = await this.httpClient.get(`/businesses/${bizId}`, {
            headers: { Authorization: `Bearer ${this.apiKey}` },
          });
          businesses.push(bizResponse.data);
        } catch (err) {
          // If detail fetch fails, still return the ID so we can create a SavedAccount
          this.logger.warn(`Failed to fetch details for business ${bizId}, using ID only`);
          businesses.push({ id: bizId, name: bizId });
        }
      }

      this.logger.log(`Yelp businesses resolved: ${businesses.map(b => `${b.name} (${b.id})`).join(', ')}`);
      return businesses;
    } catch (error) {
      const status = error.response?.status;
      const errData = error.response?.data;
      this.logger.error(`Error fetching Yelp claimed businesses — status=${status} data=${JSON.stringify(errData)}`);
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
      // Fetch lead details
      const response = await this.httpClient.get(`/leads/${leadId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      this.logger.log(`Yelp getLead raw response: ${JSON.stringify(response.data).substring(0, 1000)}`);

      // Also fetch lead events to get the actual message text
      // (Yelp's getLead doesn't include message content — only events do)
      let messageText = '';
      try {
        const events = await this.getLeadEvents(credentials, leadId);
        this.logger.log(`Yelp lead events: ${events.length} events — ${JSON.stringify(events).substring(0, 1000)}`);
        // Find the first consumer message (Yelp uses event_type=TEXT, user_type=CONSUMER)
        const firstMessage = events.find((e: any) =>
          e.user_type === 'CONSUMER' && (e.event_type === 'TEXT' || e.event_type === 'RAQ_SUBMIT'),
        );
        messageText = firstMessage?.event_content?.text || firstMessage?.event_content?.fallback_text || firstMessage?.text || '';
      } catch (evErr: any) {
        this.logger.warn(`Failed to fetch events for lead ${leadId}: ${evErr.message}`);
      }

      const lead = this.normalizeLead(response.data);
      // Always prefer the full event message — it contains all survey Q&A
      // Strip Yelp boilerplate intro
      if (messageText) {
        lead.message = messageText
          .replace(/^Hi there!.*?regarding my project:\s*/s, '')
          .trim();
      }
      return lead;
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
      this.logger.log(`Yelp getLeadEvents raw: ${JSON.stringify(response.data).substring(0, 500)}`);
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
      if (status === 401 || status === 403) {
        const reason = data?.error?.code || (status === 401 ? 'token_expired' : 'no_business_access');
        throw new Error(`Yelp ${reason} (${status}) — reconnect your Yelp account to re-authorize`);
      }
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
        '/businesses/subscriptions',
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
      await this.httpClient.delete('/businesses/subscriptions', {
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

    // Customer info — Yelp uses "user.display_name" not "consumer.name"
    lead.customerName = data.user?.display_name || data.consumer?.name || 'Unknown';
    lead.customerEmail = data.temporary_email_address || data.consumer?.email;
    // Phone only available after CONSUMER_PHONE_NUMBER_OPT_IN_EVENT
    lead.customerPhone = data.user?.phone || data.consumer?.phone;

    // Message — combine survey answers + additional info for a complete picture
    const surveyParts: string[] = [];
    for (const q of data.project?.survey_answers || []) {
      const answer = Array.isArray(q.answer_text) ? q.answer_text.join(', ') : q.answer_text;
      surveyParts.push(`${q.question_text}: ${answer}`);
    }
    const availability = data.project?.availability?.status;
    if (availability) surveyParts.push(`Availability: ${availability}`);
    const additionalInfo = data.project?.additional_info;
    if (additionalInfo) surveyParts.push(`Additional details: ${additionalInfo}`);
    lead.message = surveyParts.join('\n') || data.request_text || '';

    // Location — Yelp uses project.location.postal_code
    lead.postcode = data.project?.location?.postal_code || data.location?.zip_code;
    lead.city = data.project?.location?.city || data.location?.city;
    lead.state = data.project?.location?.state || data.location?.state;

    // Category — Yelp uses project.job_names
    lead.category = data.project?.job_names?.[0] || data.services?.[0]?.name || data.category;

    // Don't set threadId — it's a FK to Conversation table (not applicable for Yelp)
    lead.status = data.ilq?.status || data.status || 'new';
    lead.createdAt = new Date(data.time_created || data.created_at || Date.now());
    lead.updatedAt = new Date(data.last_event_time || data.time_updated || Date.now());
    lead.raw = data;
    return lead;
  }
}
