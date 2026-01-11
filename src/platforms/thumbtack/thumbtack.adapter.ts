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
  LeadStatus,
  ConversationStatus,
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
    this.apiBaseUrl = this.configService.get<string>('thumbtack.apiBaseUrl') || 'https://api.thumbtack.com/v4';

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
      scope: 'supply::messages.read supply::messages.write supply::negotiations.read supply::users.read supply::webhooks.read supply::webhooks.write offline_access',
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
    try {
      // OAuth2 token endpoint requires form-urlencoded format
      const params = new URLSearchParams();
      params.append('grant_type', 'refresh_token');
      params.append('refresh_token', refreshToken);

      // Thumbtack requires client_secret_basic authentication (credentials in header)
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');

      const response = await axios.post(`${this.authBaseUrl}/token`, params, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      });

      const { access_token, refresh_token: new_refresh_token, expires_in, scope } = response.data;

      return {
        accessToken: access_token,
        refreshToken: new_refresh_token || refreshToken, // Some providers don't return new refresh token
        expiresAt: new Date(Date.now() + expires_in * 1000),
        scope,
      };
    } catch (error) {
      this.logger.error('Token refresh error:', error.response?.data || error.message);
      throw new Error('Failed to refresh access token');
    }
  }

  async disconnect(userId: string): Promise<void> {
    // Thumbtack doesn't have a revoke endpoint, but we'll log this
    this.logger.log(`Disconnecting Thumbtack for user ${userId}`);
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
      const response = await this.httpClient.get('/businesses', {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      return response.data.businesses || [];
    } catch (error) {
      this.logger.error('Error fetching businesses:', error.response?.data || error.message);
      throw new Error('Failed to fetch businesses from Thumbtack');
    }
  }

  // ==========================================
  // Lead Management
  // Note: Thumbtack sends leads via webhooks - there's no direct fetch endpoint
  // Leads received via webhook should be stored in database
  // ==========================================

  async getLeads(
    credentials: PlatformCredentials,
    _options?: LeadFetchOptions,
  ): Promise<NormalizedLead[]> {
    // Thumbtack doesn't have a leads fetch endpoint
    // Leads are delivered via webhooks and should be stored in the database
    // Return businesses info as a placeholder for now
    this.logger.warn('Thumbtack delivers leads via webhooks. Use getBusinesses() to see connected businesses.');

    try {
      const businesses = await this.getBusinesses(credentials);
      // Return empty leads array - actual leads come from webhooks
      this.logger.log(`Found ${businesses.length} businesses. Leads are delivered via webhooks.`);
      return [];
    } catch (error) {
      this.logger.error('Error in getLeads:', error.response?.data || error.message);
      throw new Error('Failed to fetch from Thumbtack. Note: Leads are delivered via webhooks.');
    }
  }

  async getLead(_credentials: PlatformCredentials, _requestId: string): Promise<NormalizedLead> {
    // Individual leads should be retrieved from local database
    // as they come from webhooks, not API calls
    throw new Error('Thumbtack leads are delivered via webhooks and stored locally. Query your database instead.');
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
      // v4 endpoint: GET /v4/negotiations/{negotiationID}/messages
      const response = await this.httpClient.get(`/negotiations/${negotiationId}/messages`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });

      const messages = response.data.messages || response.data || [];
      return messages.map((message: any) => this.normalizeMessage(message, negotiationId));
    } catch (error) {
      this.logger.error('Error fetching messages:', error.response?.data || error.message);
      throw new Error('Failed to fetch messages from Thumbtack');
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
  // Webhook Handling
  // ==========================================

  verifyWebhookSignature(signature: string, payload: string, secret: string): boolean {
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payload);
    const expectedSignature = hmac.digest('hex');

    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
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

  private normalizeRequest(request: any): NormalizedLead {
    return {
      id: '', // Will be set by the service layer
      platform: PlatformName.THUMBTACK,
      externalRequestId: request.request_id,
      customerName: request.customer?.name || 'Unknown',
      customerPhone: request.customer?.phone,
      customerEmail: request.customer?.email,
      message: request.message || request.description || '',
      budget: request.budget ? parseFloat(request.budget) : undefined,
      postcode: request.location?.postcode,
      city: request.location?.city,
      state: request.location?.state,
      category: request.category,
      status: this.mapThumbtackStatus(request.status),
      threadId: request.thread_id,
      createdAt: new Date(request.created_at),
      updatedAt: new Date(request.updated_at || request.created_at),
      raw: request,
    };
  }

  private normalizeThread(thread: any): NormalizedConversation {
    return {
      id: '', // Will be set by the service layer
      platform: PlatformName.THUMBTACK,
      externalThreadId: thread.thread_id,
      customerName: thread.customer_name || 'Unknown',
      lastMessageAt: new Date(thread.last_message_at),
      unreadCount: thread.unread_count || 0,
      status: thread.archived ? ConversationStatus.ARCHIVED : ConversationStatus.ACTIVE,
      createdAt: new Date(thread.created_at),
      metadata: thread,
    };
  }

  private normalizeMessage(message: any, conversationId: string): NormalizedMessage {
    return {
      id: '', // Will be set by the service layer
      conversationId,
      platform: PlatformName.THUMBTACK,
      externalMessageId: message.message_id,
      sender: message.sender_type === 'pro' ? MessageSender.PRO : MessageSender.CUSTOMER,
      content: message.text || message.message,
      isRead: message.read || false,
      sentAt: new Date(message.sent_at || message.created_at),
      deliveredAt: message.delivered_at ? new Date(message.delivered_at) : undefined,
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

  private mapThumbtackStatus(status: string): LeadStatus {
    const statusMap: Record<string, LeadStatus> = {
      new: LeadStatus.NEW,
      contacted: LeadStatus.CONTACTED,
      quoted: LeadStatus.QUOTED,
      hired: LeadStatus.BOOKED,
      declined: LeadStatus.LOST,
    };

    return statusMap[status?.toLowerCase()] || LeadStatus.NEW;
  }
}
