/**
 * Yelp Platform Adapter
 * Implements IPlatformAdapter for Yelp Leads integration
 * Auth: API Key (webhooks/subscriptions) + OAuth (per-business lead access/reply)
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import * as crypto from 'crypto';
import { MonitoringService } from '../../monitoring/monitoring.service';
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
import {
  extractYelpEventContent,
  isDisplayableYelpEvent,
  yelpEventSender,
} from './yelp-event-content.util';

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
  // OAuth code-exchange dedup. Same defense as TT (see
  // thumbtack.adapter.ts) — RFC 6749 §4.1.2 mandates that any compliant
  // OAuth provider MUST deny code reuse and SHOULD revoke the
  // originally issued token. Yelp's multi-redirect chain
  // (logout → login → authorize → callback) gives proxy/browser retries
  // more chances to fire duplicate callbacks than a single-hop flow, so
  // applying the dedup defensively here even before we observe it.
  private readonly inFlightCodeExchanges = new Map<string, Promise<PlatformCredentials>>();
  private static readonly CODE_DEDUP_TTL_MS = 60_000;

  constructor(
    private configService: ConfigService,
    // Optional — feeds the cross-tenant burst detector when sendMessage
    // failures cluster across the prod instance (likely Yelp-side outage).
    @Optional() private readonly monitoring: MonitoringService | null = null,
  ) {
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
   * Yelp's /logout automatically redirects to /login?return_url=<whatever>.
   * So: logout?return_url=/oauth2/authorize?... becomes
   *     login?return_url=/oauth2/authorize?... → consent → callback.
   * The & in OAuth params is encoded as %26 so they stay inside return_url.
   */
  getAuthUrl(_userId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'leads r2r_business_owner r2r_get_businesses',
      state,
    });

    const rawOAuthPath = `/oauth2/authorize?${params.toString()}`;
    const encodedOAuthPath = `/oauth2/authorize?${params.toString().replace(/&/g, '%26')}`;
    const finalUrl = `https://biz.yelp.com/logout?return_url=${encodedOAuthPath}`;

    this.logger.log(`[Yelp OAuth] getAuthUrl built:`);
    this.logger.log(`[Yelp OAuth]   client_id=${this.clientId}`);
    this.logger.log(`[Yelp OAuth]   redirect_uri=${this.redirectUri}`);
    this.logger.log(`[Yelp OAuth]   state=${state.substring(0, 20)}...`);
    this.logger.log(`[Yelp OAuth]   raw OAuth path=${rawOAuthPath.substring(0, 100)}...`);
    this.logger.log(`[Yelp OAuth]   encoded OAuth path=${encodedOAuthPath.substring(0, 100)}...`);
    this.logger.log(`[Yelp OAuth]   final URL=${finalUrl.substring(0, 150)}...`);

    return finalUrl;
  }

  async handleCallback(code: string, _userId: string): Promise<PlatformCredentials> {
    const existing = this.inFlightCodeExchanges.get(code);
    if (existing) {
      this.logger.warn(
        `[oauth-dedup] duplicate Yelp exchange suppressed for code (head=${code.slice(0, 8)}); returning in-flight/cached result`,
      );
      return existing;
    }
    const exchange = this.exchangeCodeForTokens(code).finally(() => {
      setTimeout(
        () => this.inFlightCodeExchanges.delete(code),
        YelpAdapter.CODE_DEDUP_TTL_MS,
      ).unref();
    });
    this.inFlightCodeExchanges.set(code, exchange);
    return exchange;
  }

  private async exchangeCodeForTokens(code: string): Promise<PlatformCredentials> {
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

      const { access_token, refresh_token, expires_in, token_type, scope } = response.data;

      this.logger.log(`[Yelp OAuth] Token received — type=${token_type}, expires_in=${expires_in}, scope="${scope || 'NOT_RETURNED'}", all_fields=${Object.keys(response.data).join(',')}`);

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

      // Fetch lead events for phone number extraction only. The first event's
      // text is Yelp boilerplate ("Hi there… Here are my answers…") followed by
      // the full survey Q&A — we deliberately do NOT use it as lead.message.
      // The chat shows only the customer's free-form additional_info (see
      // normalizeLead); structured survey data lives on the lead details panel.
      let allEvents: any[] = [];
      try {
        allEvents = await this.getLeadEvents(credentials, leadId);
        this.logger.log(`Yelp lead events: ${allEvents.length} events — ${JSON.stringify(allEvents).substring(0, 1000)}`);
      } catch (evErr: any) {
        this.logger.warn(`Failed to fetch events for lead ${leadId}: ${evErr.message}`);
      }

      const lead = this.normalizeLead(response.data);

      // Extract phone from CONSUMER_PHONE_NUMBER_OPT_IN_EVENT if not in lead data
      if (!lead.customerPhone) {
        const phoneEvent = allEvents.find((e: any) => e.event_type === 'CONSUMER_PHONE_NUMBER_OPT_IN_EVENT');
        const phone = phoneEvent?.event_content?.phone_number || phoneEvent?.phone_number;
        if (phone) lead.customerPhone = phone;
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

  /**
   * Fetch the full event thread for a Yelp lead and return it as NormalizedMessage[].
   *
   * Yelp has no dedicated "messages" REST endpoint — lead events ARE the message
   * thread (TEXT, BIZ_REPLY, REGULAR_RESPONSE, RAQ_AVAILABILITY, …). We reuse
   * `getLeadEvents` and project each displayable event through the same helpers
   * the webhook write path uses (`isDisplayableYelpEvent`, `extractYelpEventContent`,
   * `yelpEventSender`) so resync output matches what the webhook would persist.
   *
   * Used by `LeadsService.resyncMessages` (the Refresh button in the UI). Without
   * this, the resync would silently return 0 messages for Yelp leads — the read
   * path falls back to the live Yelp API only when the DB row set is empty,
   * which means historic Yelp threads with one persisted customer message but
   * missing BIZ replies stay incomplete forever.
   */
  async getConversation(credentials: PlatformCredentials, threadId: string, _options?: PaginationOptions): Promise<NormalizedMessage[]> {
    const events = await this.getLeadEvents(credentials, threadId);
    if (!Array.isArray(events) || events.length === 0) return [];

    const messages: NormalizedMessage[] = [];
    for (const ev of events) {
      if (!ev?.id || !isDisplayableYelpEvent(ev)) continue;
      const content = extractYelpEventContent(ev);
      if (!content) continue;
      const sender = yelpEventSender(ev);
      const msg = new NormalizedMessage();
      msg.id = ev.id;
      msg.conversationId = threadId;
      msg.platform = PlatformName.YELP;
      msg.externalMessageId = ev.id;
      msg.sender = sender === 'pro' ? MessageSender.PRO : MessageSender.CUSTOMER;
      msg.content = content;
      msg.isRead = true;
      msg.sentAt = ev.time_created ? new Date(ev.time_created) : new Date();
      msg.raw = ev;
      messages.push(msg);
    }
    // Caller (importMessagesForNegotiation) reads the last element to set
    // conversation.lastMessageAt — sort ascending so that's actually the latest.
    messages.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    return messages;
  }

  async sendMessage(credentials: PlatformCredentials, leadId: string, message: string): Promise<NormalizedMessage> {
    try {
      this.logger.log(`[Yelp sendMessage] POST /leads/${leadId}/events — token=${credentials.accessToken?.substring(0, 15)}... msgLen=${message.length}`);
      const response = await this.httpClient.post(
        `/leads/${leadId}/events`,
        { request_type: 'TEXT', request_content: message },
        { headers: { Authorization: `Bearer ${credentials.accessToken}` } },
      );
      this.logger.log(`[Yelp sendMessage] SUCCESS — status=${response.status}`);
      const data = response.data;
      this.logger.log(`[Yelp sendMessage] Response data: ${JSON.stringify(data).substring(0, 500)}`);
      const msg = new NormalizedMessage();
      // Yelp's POST /events response returns `event_id` (sometimes `id`)
      const eventId = data.event_id || data.id;
      // TODO: msg.id is NOT a persisted DB identifier — when eventId is missing
      // this is a throwaway UUID. Callers that store it (e.g. FollowUpStepExecution.messageId)
      // end up with orphaned references. Prefer externalMessageId for lookups.
      msg.id = eventId || crypto.randomUUID();
      msg.conversationId = leadId;
      msg.platform = PlatformName.YELP;
      msg.externalMessageId = eventId;
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
      // Per-lead terminal state: customer archived the project. Not an account-level auth failure.
      const desc: string = data?.error?.description || '';
      if (status === 403 && /archived/i.test(desc)) {
        throw new Error(`Yelp lead archived by customer — ${desc}`);
      }
      if (status === 401 || status === 403) {
        const reason = data?.error?.code || (status === 401 ? 'token_expired' : 'no_business_access');
        throw new Error(`Yelp ${reason} (${status}) — reconnect your Yelp account to re-authorize`);
      }
      // Generic-failure path: feed the burst detector. 5xx from Yelp itself,
      // network timeouts, and unknown errors all land here — exactly the
      // failure modes that warrant an ops page when they spike. Per-tenant
      // 401/403 (token issues) are returned with a tenant-friendly message
      // above and intentionally NOT counted here.
      this.monitoring?.recordPlatformFailure('yelp_sendmessage');
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
    // Phone — can come from multiple places depending on opt-in status
    lead.customerPhone = data.user?.phone || data.consumer?.phone || data.phone_number || data.consumer_phone_number;

    // Message — only the customer's free-form "Additional details" goes into
    // the chat (matches Thumbtack: chat is empty when the customer didn't write
    // anything beyond the structured form). Structured survey answers + location
    // + availability still flow to the right-side lead details panel and the
    // business-owner SMS, but they read raw.project.survey_answers directly —
    // they do NOT come from lead.message.
    lead.message = data.project?.additional_info || '';

    // Fallback: Yelp's Partner API only returns a structured phone after the
    // consumer hits the opt-in flow. When the customer just types digits into
    // additional_info (common for Yelp leads), nothing above fires — so we
    // mirror the frontend regex in Messages.tsx and extract from the message
    // body. Runs before the lead row is upserted so the new-lead SMS, Instant
    // Call trigger, and AI context all see the number.
    if (!lead.customerPhone && lead.message) {
      const match = lead.message.match(/(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
      if (match) {
        const digits = match[1].replace(/\D/g, '');
        if (digits.length === 11 && digits.startsWith('1')) {
          lead.customerPhone = `+${digits}`;
        } else if (digits.length === 10) {
          lead.customerPhone = `+1${digits}`;
        }
      }
    }

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
