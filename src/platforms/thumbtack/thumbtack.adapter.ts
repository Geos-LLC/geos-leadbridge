/**
 * Thumbtack Platform Adapter
 * Implements IPlatformAdapter for Thumbtack integration
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
  QuoteStatus,
} from '../../common/dto/normalized.dto';

@Injectable()
export class ThumbtackAdapter implements IPlatformAdapter {
  private readonly logger = new Logger(ThumbtackAdapter.name);
  private readonly httpClient: AxiosInstance;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly authBaseUrl: string;
  private readonly apiBaseUrl: string;

  constructor(private configService: ConfigService) {
    this.clientId = this.configService.get<string>('thumbtack.clientId') || '';
    this.clientSecret = this.configService.get<string>('thumbtack.clientSecret') || '';
    this.redirectUri = this.configService.get<string>('thumbtack.redirectUri') || '';
    this.authBaseUrl = this.configService.get<string>('thumbtack.authBaseUrl') || 'https://auth.thumbtack.com/oauth2';
    this.apiBaseUrl = this.configService.get<string>('thumbtack.apiBaseUrl') || 'https://api.thumbtack.com/api/v4';

    this.httpClient = axios.create({
      baseURL: this.apiBaseUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  getPlatformName(): string {
    return PlatformName.THUMBTACK;
  }

  // ==========================================
  // OAuth & Connection Management
  // ==========================================

  getAuthUrl(_userId: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'supply::businesses.list supply::messages.read supply::messages.write supply::negotiations.read supply::users.read supply::webhooks.read supply::webhooks.write offline_access',
      state,
      audience: 'urn:partner-api',
    });

    return `${this.authBaseUrl}/auth?${params.toString()}`;
  }

  async handleCallback(code: string, _userId: string): Promise<PlatformCredentials> {
    try {
      // OAuth2 token endpoint requires form-urlencoded format
      const params = new URLSearchParams();
      params.append('grant_type', 'authorization_code');
      params.append('code', code);
      params.append('redirect_uri', this.redirectUri);

      // Thumbtack requires client_secret_basic authentication (credentials in header)
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(`${this.authBaseUrl}/token`, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      });

      const { access_token, refresh_token, expires_in, scope } = response.data;

      return {
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(Date.now() + expires_in * 1000),
        scope,
      };
    } catch (error) {
      this.logger.error('OAuth callback error:', error.response?.data || error.message);
      throw new Error('Failed to exchange authorization code for tokens');
    }
  }

  async refreshAccessToken(refreshToken: string): Promise<PlatformCredentials> {
    this.logger.log('Attempting to refresh access token...');
    try {
      // OAuth2 token endpoint requires form-urlencoded format
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      // Thumbtack requires client_secret_basic authentication (credentials in header)
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      this.logger.log(`Making token refresh request to: ${this.authBaseUrl}/token`);

      const response = await axios.post(`${this.authBaseUrl}/token`, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      });

      const { access_token, refresh_token: new_refresh_token, expires_in, scope } = response.data;

      const newExpiresAt = new Date(Date.now() + expires_in * 1000);
      this.logger.log(`Token refreshed successfully! New token expires at: ${newExpiresAt.toISOString()}`);

      return {
        accessToken: access_token,
        refreshToken: new_refresh_token || refreshToken, // Some providers don't return new refresh token
        expiresAt: newExpiresAt,
        scope,
      };
    } catch (error) {
      this.logger.error('Token refresh error:', error.response?.status, error.response?.data || error.message);
      this.logger.error('Full refresh error:', JSON.stringify({
        status: error.response?.status,
        data: error.response?.data,
        message: error.message,
      }));
      throw new Error(`Failed to refresh access token: ${error.response?.data?.error_description || error.message}`);
    }
  }

  async disconnect(userId: string): Promise<void> {
    // Thumbtack doesn't have a revoke endpoint, but we'll log this
    this.logger.log(`Disconnecting Thumbtack for user ${userId}`);
  }

  // ==========================================
  // User Info
  // ==========================================

  /**
   * Get the current user's info from Thumbtack
   */
  async getCurrentUser(credentials: PlatformCredentials): Promise<any> {
    try {
      this.logger.log('Fetching current user from Thumbtack API');
      const response = await this.httpClient.get('/users/me', {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      this.logger.log('Thumbtack user response:', JSON.stringify(response.data));
      return response.data;
    } catch (error) {
      this.logger.error('Error fetching user:', error.response?.data || error.message);
      throw new Error(`Failed to fetch user from Thumbtack: ${error.response?.data?.message || error.message}`);
    }
  }

  // ==========================================
  // Business Management
  // ==========================================

  /**
   * Get businesses for the authenticated user
   * Note: Thumbtack uses webhooks for leads - this returns the user's businesses
   */
  async getBusinesses(credentials: PlatformCredentials): Promise<any[]> {
    try {
      this.logger.log('Fetching businesses from Thumbtack API');
      this.logger.log('Token scope:', credentials.scope);
      this.logger.log('Token expires:', credentials.expiresAt);

      const response = await this.httpClient.get('/businesses', {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      this.logger.log('Thumbtack businesses response:', JSON.stringify(response.data));

      const businesses = response.data.data || response.data.businesses || response.data || [];
      this.logger.log(`Found ${businesses.length} businesses`);

      // If empty, log a helpful message
      if (businesses.length === 0) {
        this.logger.warn('No businesses returned. This could mean:');
        this.logger.warn('1. The account is not a Thumbtack Pro account');
        this.logger.warn('2. No business profiles have been created in Thumbtack Pro');
        this.logger.warn('3. The OAuth scope supply::businesses.list was not granted');
      }

      return businesses;
    } catch (error) {
      this.logger.error('Error fetching businesses:', error.response?.data || error.message);
      this.logger.error('Full error:', error.response?.status, error.response?.statusText);
      throw new Error(`Failed to fetch businesses from Thumbtack: ${error.response?.data?.message || error.message}`);
    }
  }

  // ==========================================
  // Negotiation/Lead Management
  // Note: Thumbtack has NO "list all leads" endpoint
  // Leads are delivered via webhooks and stored locally
  // You can only fetch a SPECIFIC negotiation by ID
  // ==========================================

  async getLeads(
    _credentials: PlatformCredentials,
    _options?: LeadFetchOptions,
  ): Promise<NormalizedLead[]> {
    // Thumbtack API does NOT have a "list negotiations" endpoint
    // Leads must be received via webhooks and stored in your database
    this.logger.warn('Thumbtack has no "list leads" API. Leads come via webhooks. Query your local database.');
    return [];
  }

  /**
   * Get a specific negotiation (lead) by ID from Thumbtack API
   * Note: You must know the negotiationID (from webhook) to fetch details
   */
  async getLead(credentials: PlatformCredentials, negotiationId: string): Promise<NormalizedLead> {
    try {
      // GET /v4/negotiations/{negotiationID}
      const response = await this.httpClient.get(`/negotiations/${negotiationId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      return this.normalizeNegotiation(response.data);
    } catch (error) {
      this.logger.error('Error fetching negotiation:', error.response?.data || error.message);
      throw new Error('Failed to fetch negotiation from Thumbtack');
    }
  }

  /**
   * Normalize Thumbtack negotiation to NormalizedLead format
   * API format: { negotiationID, createdAt, customer: { customerID, firstName, lastName, phone },
   *              business: {...}, request: { requestID, description, category, location, details, ... },
   *              estimate: {...}, status, leadPrice, chargeState }
   */
  private normalizeNegotiation(negotiation: any): NormalizedLead {
    const customer = negotiation.customer || {};
    const request = negotiation.request || {};
    const location = request.location || {};
    const business = negotiation.business || {};

    return {
      id: '',
      platform: PlatformName.THUMBTACK,
      businessId: business.businessID,
      externalRequestId: negotiation.negotiationID,
      customerName: customer.firstName && customer.lastName
        ? `${customer.firstName} ${customer.lastName}`
        : customer.displayName || 'Unknown',
      customerPhone: customer.phone,
      customerEmail: undefined, // API doesn't provide email
      message: request.description || '',
      budget: negotiation.estimate?.total ? parseFloat(negotiation.estimate.total) : undefined,
      postcode: location.zipCode,
      city: location.city,
      state: location.state,
      category: request.category?.name,
      status: this.mapThumbtackStatus(negotiation.status),
      threadId: negotiation.negotiationID,
      createdAt: new Date(negotiation.createdAt || Date.now()),
      updatedAt: new Date(negotiation.createdAt || Date.now()),
      raw: negotiation,
    };
  }

  // ==========================================
  // Messaging (v4 API uses negotiations)
  // ==========================================

  async getConversations(
    _credentials: PlatformCredentials,
    _options?: PaginationOptions,
  ): Promise<NormalizedConversation[]> {
    // v4 API doesn't have a list conversations endpoint
    // Messages are associated with negotiations (leads) which come via webhooks
    this.logger.warn('Conversations are tied to negotiations (leads) delivered via webhooks');
    return [];
  }

  async getConversation(
    credentials: PlatformCredentials,
    negotiationId: string,
    _options?: PaginationOptions,
  ): Promise<NormalizedMessage[]> {
    try {
      this.logger.log(`Fetching messages for negotiation: ${negotiationId}`);
      // v4 endpoint: GET /api/v4/negotiations/{negotiationID}/messages
      // Response: { data: [...messages], pagination: { limit, cursor } }
      // We need to paginate to get all messages

      const allMessages: any[] = [];
      let cursor: string | undefined;
      const limit = 20; // Thumbtack API max is 20 per request
      let pageCount = 0;

      do {
        pageCount++;
        const params: any = { limit };
        if (cursor) {
          params.cursor = cursor;
        }

        this.logger.log(`Fetching page ${pageCount}, cursor: ${cursor || 'none'}`);

        const response = await this.httpClient.get(`/negotiations/${negotiationId}/messages`, {
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
          params,
        });

        this.logger.log(`Thumbtack messages response (page ${pageCount}): status=${response.status}`);

        const messages = response.data.data || response.data.messages || [];
        this.logger.log(`Page ${pageCount}: got ${messages.length} messages`);
        allMessages.push(...messages);

        // Check if there are more messages
        cursor = response.data.pagination?.cursor;
        this.logger.log(`Page ${pageCount}: next cursor: ${cursor || 'none'}`);

        // Safety: limit to 20 pages max (1000 messages)
        if (pageCount >= 20) {
          this.logger.warn('Reached maximum pagination limit (20 pages)');
          break;
        }

      } while (cursor);

      this.logger.log(`Total messages fetched: ${allMessages.length} across ${pageCount} pages`);

      const normalized = allMessages.map((message: any) => this.normalizeMessage(message, negotiationId));

      // Sort by sentAt ascending (oldest first)
      normalized.sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());

      return normalized;
    } catch (error) {
      this.logger.error('Error fetching messages:', error.response?.status, error.response?.data || error.message);
      this.logger.error('Full error details:', JSON.stringify({
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
      }));
      throw new Error(`Failed to fetch messages from Thumbtack: ${error.response?.data?.message || error.message}`);
    }
  }

  async sendMessage(
    credentials: PlatformCredentials,
    negotiationId: string,
    message: string,
  ): Promise<NormalizedMessage> {
    try {
      // v4 endpoint: POST /v4/negotiations/{negotiationID}/messages
      const response = await this.httpClient.post(
        `/negotiations/${negotiationId}/messages`,
        { text: message },
        {
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
        },
      );

      return this.normalizeMessage(response.data, negotiationId);
    } catch (error) {
      this.logger.error('Error sending message:', error.response?.data || error.message);
      throw new Error('Failed to send message to Thumbtack');
    }
  }

  // ==========================================
  // Quotes & Negotiations
  // ==========================================

  async sendQuote(
    credentials: PlatformCredentials,
    requestId: string,
    quote: QuoteData,
  ): Promise<NormalizedQuote> {
    try {
      const response = await this.httpClient.post(
        `/requests/${requestId}/quote`,
        {
          price: quote.amount,
          message: quote.description,
          valid_until: quote.validUntil?.toISOString(),
        },
        {
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
        },
      );

      return this.normalizeQuote(response.data);
    } catch (error) {
      this.logger.error('Error sending quote:', error.response?.data || error.message);
      throw new Error('Failed to send quote to Thumbtack');
    }
  }

  // ==========================================
  // Webhook Management
  // ==========================================

  /**
   * Register a webhook for a business to receive NegotiationCreatedV4 and MessageCreatedV4 events
   */
  async registerWebhook(
    credentials: PlatformCredentials,
    businessId: string,
    webhookUrl: string,
  ): Promise<{ webhookId: string }> {
    try {
      const response = await this.httpClient.post(
        `/businesses/${businessId}/webhooks`,
        {
          webhookURL: webhookUrl,
          eventTypes: ['NegotiationCreatedV4', 'MessageCreatedV4'],
          enabled: true,
        },
        {
          headers: { Authorization: `Bearer ${credentials.accessToken}` },
        },
      );

      return { webhookId: response.data.webhookID };
    } catch (error) {
      this.logger.error('Error registering webhook:', error.response?.data || error.message);
      throw new Error('Failed to register webhook with Thumbtack');
    }
  }

  /**
   * Get all webhooks for a business
   */
  async getWebhooks(credentials: PlatformCredentials, businessId: string): Promise<any[]> {
    try {
      const response = await this.httpClient.get(`/businesses/${businessId}/webhooks`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      return response.data.data || [];
    } catch (error) {
      this.logger.error('Error fetching webhooks:', error.response?.data || error.message);
      throw new Error('Failed to fetch webhooks from Thumbtack');
    }
  }

  /**
   * Delete a webhook for a business
   */
  async deleteWebhook(
    credentials: PlatformCredentials,
    businessId: string,
    webhookId: string,
  ): Promise<void> {
    try {
      await this.httpClient.delete(`/businesses/${businessId}/webhooks/${webhookId}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
    } catch (error) {
      this.logger.error('Error deleting webhook:', error.response?.data || error.message);
      throw new Error('Failed to delete webhook from Thumbtack');
    }
  }

  // ==========================================
  // Webhook Signature Verification
  // ==========================================

  verifyWebhookSignature(signature: string, payload: string, secret: string): boolean {
    // Guard against undefined/null inputs
    if (!signature || !payload || !secret) {
      this.logger.warn('verifyWebhookSignature called with missing parameters', {
        hasSignature: !!signature,
        hasPayload: !!payload,
        hasSecret: !!secret,
      });
      return false;
    }

    try {
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(payload);
      const expectedSignature = hmac.digest('hex');

      // Handle different signature lengths
      if (signature.length !== expectedSignature.length) {
        return false;
      }

      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
    } catch (error) {
      this.logger.error('Error verifying webhook signature:', error.message);
      return false;
    }
  }

  async handleWebhookEvent(event: any, _userId?: string): Promise<WebhookEventResult> {
    try {
      const eventType = event.event_type;

      this.logger.log(`Processing webhook event: ${eventType}`);

      return {
        eventType,
        processed: true,
        data: event,
      };
    } catch (error) {
      this.logger.error('Error handling webhook:', error.message);
      return {
        eventType: event.event_type,
        processed: false,
        error: error.message,
      };
    }
  }

  // ==========================================
  // Normalization Helpers
  // ==========================================

  private normalizeMessage(message: any, conversationId: string): NormalizedMessage {
    // API returns: messageID, negotiationID, customer, from ("Customer" | "Pro"), text, attachments, sentAt
    // Attachments format: [{ url: "https://...", mimeType: "image/jpeg" }]
    // Note: 'from' field is case-sensitive, could be "Pro", "pro", "Customer", "customer"
    const fromValue = (message.from || '').toLowerCase();
    const isPro = fromValue === 'pro' || fromValue === 'business';
    this.logger.log(`Message from: "${message.from}" -> isPro: ${isPro}`);

    return {
      id: '', // Will be set by the service layer
      conversationId,
      platform: PlatformName.THUMBTACK,
      externalMessageId: message.messageID,
      sender: isPro ? MessageSender.PRO : MessageSender.CUSTOMER,
      content: message.text,
      attachments: message.attachments || [],
      isRead: true, // API doesn't provide read status
      sentAt: new Date(message.sentAt),
      deliveredAt: undefined,
      raw: message,
    };
  }

  private normalizeQuote(quote: any): NormalizedQuote {
    return {
      id: '', // Will be set by the service layer
      platform: PlatformName.THUMBTACK,
      externalQuoteId: quote.quote_id,
      leadId: quote.request_id,
      amount: parseFloat(quote.price),
      currency: 'USD',
      description: quote.message,
      status: QuoteStatus.PENDING,
      validUntil: quote.valid_until ? new Date(quote.valid_until) : undefined,
      createdAt: new Date(quote.created_at),
      updatedAt: new Date(quote.updated_at || quote.created_at),
      raw: quote,
    };
  }

  private mapThumbtackStatus(status: string): string {
    // Return the raw status from Thumbtack without interpretation
    // API returns: "Open", "Canceled", "Picked"
    return status || 'Open';
  }
}
