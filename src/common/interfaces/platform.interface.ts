/**
 * Core Platform Interface
 * All platform adapters (Thumbtack, Yelp, Angi, etc.) must implement this interface
 */

import { NormalizedLead, NormalizedConversation, NormalizedMessage, NormalizedQuote } from '../dto/normalized.dto';

export interface IPlatformAdapter {
  /**
   * Get the platform name (e.g., "thumbtack", "yelp")
   */
  getPlatformName(): string;

  // ==========================================
  // OAuth & Connection Management
  // ==========================================

  /**
   * Generate OAuth authorization URL for user to connect their account
   * @param userId - Internal user ID
   * @param state - CSRF protection state parameter
   * @returns Authorization URL
   */
  getAuthUrl(userId: string, state: string, forceLogin?: boolean, callbackUrl?: string, loginHint?: string): string;

  /**
   * Handle OAuth callback and exchange code for tokens
   * @param code - Authorization code from OAuth provider
   * @param userId - Internal user ID
   * @returns Platform credentials (access_token, refresh_token, etc.)
   */
  handleCallback(code: string, userId: string, callbackUrl?: string): Promise<PlatformCredentials>;

  /**
   * Refresh expired access token
   * @param refreshToken - Refresh token
   * @returns New credentials
   */
  refreshAccessToken(refreshToken: string): Promise<PlatformCredentials>;

  /**
   * Disconnect user's platform account
   * @param userId - Internal user ID
   */
  disconnect(userId: string): Promise<void>;

  // ==========================================
  // Lead Management
  // ==========================================

  /**
   * Fetch leads/requests from the platform
   * @param credentials - Platform credentials
   * @param options - Pagination and filtering options
   * @returns Normalized leads
   */
  getLeads(
    credentials: PlatformCredentials,
    options?: LeadFetchOptions,
  ): Promise<NormalizedLead[]>;

  /**
   * Fetch a single lead by ID
   * @param credentials - Platform credentials
   * @param requestId - External request/lead ID
   * @returns Normalized lead
   */
  getLead(credentials: PlatformCredentials, requestId: string): Promise<NormalizedLead>;

  // ==========================================
  // Messaging
  // ==========================================

  /**
   * Get all conversations/threads
   * @param credentials - Platform credentials
   * @param options - Pagination options
   * @returns Normalized conversations
   */
  getConversations(
    credentials: PlatformCredentials,
    options?: PaginationOptions,
  ): Promise<NormalizedConversation[]>;

  /**
   * Get messages in a specific conversation
   * @param credentials - Platform credentials
   * @param threadId - External thread/conversation ID
   * @param options - Pagination options
   * @returns Normalized messages
   */
  getConversation(
    credentials: PlatformCredentials,
    threadId: string,
    options?: PaginationOptions,
  ): Promise<NormalizedMessage[]>;

  /**
   * Send a message to a customer
   * @param credentials - Platform credentials
   * @param threadId - External thread/conversation ID
   * @param message - Message content
   * @returns Normalized message
   */
  sendMessage(
    credentials: PlatformCredentials,
    threadId: string,
    message: string,
  ): Promise<NormalizedMessage>;

  // ==========================================
  // Quotes & Negotiations
  // ==========================================

  /**
   * Send a quote to a customer
   * @param credentials - Platform credentials
   * @param requestId - External request/lead ID
   * @param quote - Quote details
   * @returns Normalized quote
   */
  sendQuote(
    credentials: PlatformCredentials,
    requestId: string,
    quote: QuoteData,
  ): Promise<NormalizedQuote>;

  // ==========================================
  // Webhook Handling
  // ==========================================

  /**
   * Verify webhook signature
   * @param signature - Signature from webhook headers
   * @param payload - Raw webhook payload
   * @param secret - Webhook secret
   * @returns True if signature is valid
   */
  verifyWebhookSignature(signature: string, payload: string, secret: string): boolean;

  /**
   * Handle incoming webhook event
   * @param event - Webhook event payload
   * @param userId - Internal user ID (if applicable)
   * @returns Processed event data
   */
  handleWebhookEvent(event: any, userId?: string): Promise<WebhookEventResult>;
}

// ==========================================
// Supporting Types
// ==========================================

export interface PlatformCredentials {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  externalUserId?: string;
  email?: string; // Email from ID token (OpenID Connect)
  metadata?: Record<string, any>;
}

export interface LeadFetchOptions {
  since?: Date;
  until?: Date;
  status?: string;
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
  cursor?: string;
}

export interface QuoteData {
  amount: number;
  currency?: string;
  description?: string;
  validUntil?: Date;
}

export interface WebhookEventResult {
  eventType: string;
  processed: boolean;
  data?: any;
  error?: string;
}

export enum PlatformName {
  THUMBTACK = 'thumbtack',
  YELP = 'yelp',
  ANGI = 'angi',
  BARK = 'bark',
  HOUZZ = 'houzz',
}
