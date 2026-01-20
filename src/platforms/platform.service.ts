/**
 * Platform Service
 * Manages platform connections and credentials
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { PlatformFactory } from './platform.factory';
import { PlatformCredentials } from '../common/interfaces/platform.interface';

@Injectable()
export class PlatformService {
  private readonly encryptionKey: string;
  // In-memory state storage (use Redis in production)
  private stateToUserMap: Map<string, { userId: string; expires: number }> = new Map();

  constructor(
    private prisma: PrismaService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
  ) {
    this.encryptionKey = this.configService.get<string>('encryption.key') || 'default-32-char-encryption-key';
  }

  /**
   * Get OAuth authorization URL
   */
  async getAuthUrl(userId: string, platformName: string): Promise<string> {
    const adapter = this.platformFactory.getAdapter(platformName);
    const state = EncryptionUtil.generateSecureRandom(16);

    // Store state -> userId mapping (expires in 10 minutes)
    this.stateToUserMap.set(state, {
      userId,
      expires: Date.now() + 10 * 60 * 1000,
    });

    // Clean up expired states
    this.cleanupExpiredStates();

    return adapter.getAuthUrl(userId, state);
  }

  /**
   * Get userId from OAuth state parameter
   */
  async getUserIdFromState(state: string): Promise<string | null> {
    const entry = this.stateToUserMap.get(state);

    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expires) {
      this.stateToUserMap.delete(state);
      return null;
    }

    // Remove state after use (one-time use)
    this.stateToUserMap.delete(state);

    return entry.userId;
  }

  /**
   * Clean up expired OAuth states
   */
  private cleanupExpiredStates(): void {
    const now = Date.now();
    for (const [state, entry] of this.stateToUserMap.entries()) {
      if (now > entry.expires) {
        this.stateToUserMap.delete(state);
      }
    }
  }

  /**
   * Handle OAuth callback and store credentials
   */
  async handleCallback(userId: string, platformName: string, code: string): Promise<void> {
    const adapter = this.platformFactory.getAdapter(platformName);

    // Exchange code for tokens
    const credentials = await adapter.handleCallback(code, userId);

    // Encrypt and store credentials
    await this.storeCredentials(userId, platformName, credentials);
  }

  /**
   * Store encrypted platform credentials
   */
  async storeCredentials(
    userId: string,
    platformName: string,
    credentials: PlatformCredentials,
  ): Promise<void> {
    const encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);

    await this.prisma.platform.upsert({
      where: {
        userId_platformName: {
          userId,
          platformName,
        },
      },
      create: {
        userId,
        platformName,
        connected: true,
        externalUserId: credentials.externalUserId,
        credentialsJson: encryptedCredentials,
        lastSyncAt: new Date(),
      },
      update: {
        connected: true,
        externalUserId: credentials.externalUserId,
        credentialsJson: encryptedCredentials,
        lastSyncAt: new Date(),
      },
    });
  }

  /**
   * Get decrypted platform credentials
   */
  async getCredentials(userId: string, platformName: string): Promise<PlatformCredentials> {
    const platform = await this.prisma.platform.findUnique({
      where: {
        userId_platformName: {
          userId,
          platformName,
        },
      },
    });

    if (!platform || !platform.connected) {
      throw new NotFoundException(`${platformName} not connected for this user`);
    }

    // Decrypt credentials
    const credentials = EncryptionUtil.decryptObject<PlatformCredentials>(
      platform.credentialsJson,
      this.encryptionKey,
    );

    // Convert expiresAt string to Date if needed (from JSON storage)
    const expiresAt = credentials.expiresAt
      ? new Date(credentials.expiresAt)
      : null;

    // Check if token is expired and refresh if needed
    // Add 5-minute buffer to refresh before actual expiration
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    const now = new Date();

    if (expiresAt && now.getTime() > (expiresAt.getTime() - bufferMs)) {
      console.log(`[PlatformService] Token expired or expiring soon for ${platformName}`);
      console.log(`[PlatformService] Token expires: ${expiresAt.toISOString()}, Now: ${now.toISOString()}`);
      console.log(`[PlatformService] Refreshing token...`);

      try {
        const newCredentials = await this.refreshToken(userId, platformName, credentials);
        console.log(`[PlatformService] Token refreshed successfully, new expiry: ${newCredentials.expiresAt}`);
        return newCredentials;
      } catch (error) {
        console.error(`[PlatformService] Token refresh failed:`, error.message);
        throw error;
      }
    }

    return credentials;
  }

  /**
   * Refresh access token
   */
  private async refreshToken(
    userId: string,
    platformName: string,
    credentials: PlatformCredentials,
  ): Promise<PlatformCredentials> {
    if (!credentials.refreshToken) {
      throw new BadRequestException('No refresh token available');
    }

    const adapter = this.platformFactory.getAdapter(platformName);
    const newCredentials = await adapter.refreshAccessToken(credentials.refreshToken);

    // Store updated credentials
    await this.storeCredentials(userId, platformName, newCredentials);

    return newCredentials;
  }

  /**
   * Disconnect a platform
   */
  async disconnect(userId: string, platformName: string): Promise<void> {
    const adapter = this.platformFactory.getAdapter(platformName);

    await adapter.disconnect(userId);

    await this.prisma.platform.update({
      where: {
        userId_platformName: {
          userId,
          platformName,
        },
      },
      data: {
        connected: false,
      },
    });
  }

  /**
   * Get all connected platforms for a user
   */
  async getUserPlatforms(userId: string) {
    return this.prisma.platform.findMany({
      where: { userId },
      select: {
        platformName: true,
        connected: true,
        lastSyncAt: true,
        createdAt: true,
      },
    });
  }

  /**
   * Get supported platforms
   */
  getSupportedPlatforms(): string[] {
    return this.platformFactory.getSupportedPlatforms();
  }

  // ==========================================
  // Thumbtack-specific Webhook Methods
  // ==========================================

  /**
   * Setup webhook for Thumbtack business
   * Registers webhook URL with Thumbtack to receive NegotiationCreatedV4 events
   * Uses account-specific credentials if available, falls back to platform credentials
   */
  async setupThumbtackWebhook(userId: string, businessId: string): Promise<{ webhookId: string; businessId: string }> {
    // Try account-specific credentials first, then fall back to platform credentials
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      console.log(`[PlatformService] Using account-specific credentials for webhook setup (business: ${businessId})`);
      credentials = accountCreds;
    } else {
      console.log(`[PlatformService] Using platform credentials for webhook setup (business: ${businessId})`);
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    // Get webhook URL from config
    const baseUrl = this.configService.get<string>('thumbtack.redirectUri')?.replace('/v1/thumbtack/auth/callback', '') || '';
    const webhookUrl = `${baseUrl}/webhooks/thumbtack`;

    // Register webhook with Thumbtack
    const result = await adapter.registerWebhook(credentials, businessId, webhookUrl);

    // Store businessId and webhookId in platform connection
    await this.prisma.platform.update({
      where: {
        userId_platformName: {
          userId,
          platformName: 'thumbtack',
        },
      },
      data: {
        externalBusinessId: businessId,
        webhookId: result.webhookId,
      },
    });

    // Also update the saved account with webhookId
    await this.prisma.savedAccount.updateMany({
      where: {
        userId,
        platform: 'thumbtack',
        businessId,
      },
      data: {
        webhookId: result.webhookId,
      },
    });

    return {
      webhookId: result.webhookId,
      businessId,
    };
  }

  /**
   * Disconnect webhooks for a saved account
   * Returns detailed status about what happened
   */
  async disconnectAccountWebhook(userId: string, accountId: string): Promise<{
    success: boolean;
    webhookDeleted: boolean;
    warning?: string;
    errorCode?: 'token_expired' | 'token_revoked' | 'webhook_not_found' | 'network_error' | 'permission_denied' | 'unknown';
    errorMessage?: string;
  }> {
    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account || !account.webhookId) {
      console.log(`[PlatformService] No webhook to disconnect for account ${accountId}`);
      return { success: true, webhookDeleted: true };
    }

    let webhookDeleted = false;
    let errorCode: 'token_expired' | 'token_revoked' | 'webhook_not_found' | 'network_error' | 'permission_denied' | 'unknown' | undefined;
    let errorMessage: string | undefined;
    let warning: string | undefined;

    try {
      // Try account-specific credentials first, then fall back to platform credentials
      let credentials: { accessToken: string; refreshToken?: string };
      const accountCreds = await this.getAccountCredentials(userId, accountId);
      if (accountCreds) {
        console.log(`[PlatformService] Using account-specific credentials for webhook deletion`);
        credentials = accountCreds;
      } else {
        console.log(`[PlatformService] Using platform credentials for webhook deletion`);
        credentials = await this.getCredentials(userId, account.platform);
      }
      const adapter = this.platformFactory.getAdapter(account.platform) as any;

      // Delete the webhook from Thumbtack
      await adapter.deleteWebhook(credentials, account.businessId, account.webhookId);
      console.log(`[PlatformService] Deleted webhook ${account.webhookId} for business ${account.businessId}`);
      webhookDeleted = true;
    } catch (err: any) {
      console.warn(`[PlatformService] Could not delete webhook: ${err.message}`);

      // Categorize the error
      const errMsg = err.message?.toLowerCase() || '';
      const statusCode = err.response?.status || err.status;

      if (statusCode === 401 || errMsg.includes('unauthorized') || errMsg.includes('token') || errMsg.includes('expired')) {
        errorCode = 'token_expired';
        errorMessage = 'Your Thumbtack session has expired. The webhook may still be active on Thumbtack\'s side.';
        warning = 'Thumbtack may continue sending messages until you reconnect and disconnect again, or manually remove the webhook from Thumbtack.';
      } else if (statusCode === 403 || errMsg.includes('forbidden') || errMsg.includes('permission') || errMsg.includes('revoked')) {
        errorCode = 'permission_denied';
        errorMessage = 'Access to this account was revoked or permissions changed.';
        warning = 'You may need to reconnect your Thumbtack account to manage webhooks.';
      } else if (statusCode === 404 || errMsg.includes('not found')) {
        // Webhook already deleted - this is actually fine
        errorCode = 'webhook_not_found';
        errorMessage = 'Webhook was already removed from Thumbtack.';
        webhookDeleted = true; // It's gone, so effectively deleted
      } else if (errMsg.includes('network') || errMsg.includes('timeout') || errMsg.includes('econnrefused')) {
        errorCode = 'network_error';
        errorMessage = 'Could not connect to Thumbtack. Please check your internet connection and try again.';
        warning = 'The webhook may still be active. Try disconnecting again when the connection is restored.';
      } else {
        errorCode = 'unknown';
        errorMessage = err.message || 'An unexpected error occurred while removing the webhook.';
        warning = 'The webhook may still be active on Thumbtack\'s side.';
      }
    }

    // Clear the webhookId from saved account regardless of API result
    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: { webhookId: null },
    });

    return {
      success: true,
      webhookDeleted,
      ...(errorCode && { errorCode }),
      ...(errorMessage && { errorMessage }),
      ...(warning && { warning }),
    };
  }

  /**
   * Reconnect webhooks for a saved account
   */
  async reconnectAccountWebhook(userId: string, accountId: string): Promise<{ webhookId: string }> {
    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      throw new Error('Account not found');
    }

    // Setup new webhook
    const result = await this.setupThumbtackWebhook(userId, account.businessId);

    return { webhookId: result.webhookId };
  }

  /**
   * Get Thumbtack webhooks for a business
   * Uses account-specific credentials if available, falls back to platform credentials
   */
  async getThumbtackWebhooks(userId: string, businessId: string): Promise<any[]> {
    // Try account-specific credentials first
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      credentials = accountCreds;
    } else {
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    return adapter.getWebhooks(credentials, businessId);
  }

  // ==========================================
  // Saved Accounts Methods
  // ==========================================

  /**
   * Save account info for multi-account switching
   * Now also stores credentials per-account for multi-login support
   */
  async saveAccount(
    userId: string,
    platform: string,
    businessId: string,
    businessName: string,
    imageUrl?: string,
    emailHint?: string,
    credentials?: { accessToken: string; refreshToken?: string; email?: string },
  ): Promise<void> {
    // Encrypt credentials if provided
    let encryptedCredentials: string | undefined;
    if (credentials) {
      encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);
    }

    await this.prisma.savedAccount.upsert({
      where: {
        userId_platform_businessId: {
          userId,
          platform,
          businessId,
        },
      },
      create: {
        userId,
        platform,
        businessId,
        businessName,
        imageUrl,
        emailHint,
        credentialsJson: encryptedCredentials,
        lastUsedAt: new Date(),
      },
      update: {
        businessName,
        imageUrl,
        emailHint,
        // Only update credentials if provided (don't overwrite existing with undefined)
        ...(encryptedCredentials && { credentialsJson: encryptedCredentials }),
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Get decrypted credentials for a specific saved account
   */
  async getAccountCredentials(userId: string, accountId: string): Promise<{ accessToken: string; refreshToken?: string; email?: string } | null> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account?.credentialsJson) {
      return null;
    }

    try {
      return EncryptionUtil.decryptObject(account.credentialsJson, this.encryptionKey);
    } catch {
      return null;
    }
  }

  /**
   * Update credentials for an existing saved account (e.g., after token refresh)
   */
  async updateAccountCredentials(
    accountId: string,
    credentials: { accessToken: string; refreshToken?: string; email?: string },
  ): Promise<void> {
    const encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);

    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: {
        credentialsJson: encryptedCredentials,
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Get decrypted credentials for a saved account by businessId
   */
  async getAccountCredentialsByBusinessId(userId: string, platform: string, businessId: string): Promise<{ accessToken: string; refreshToken?: string; email?: string } | null> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform, businessId },
    });

    if (!account?.credentialsJson) {
      return null;
    }

    try {
      return EncryptionUtil.decryptObject(account.credentialsJson, this.encryptionKey);
    } catch {
      return null;
    }
  }

  /**
   * Get all saved accounts for a user
   */
  async getSavedAccounts(userId: string, platform?: string) {
    return this.prisma.savedAccount.findMany({
      where: {
        userId,
        ...(platform && { platform }),
      },
      orderBy: { lastUsedAt: 'desc' },
    });
  }

  /**
   * Update a saved account
   */
  async updateSavedAccount(userId: string, accountId: string, updates: { emailHint?: string }): Promise<void> {
    await this.prisma.savedAccount.updateMany({
      where: {
        id: accountId,
        userId,
      },
      data: {
        ...(updates.emailHint !== undefined && { emailHint: updates.emailHint }),
      },
    });
  }

  /**
   * Remove a saved account and optionally its leads/messages
   */
  async removeSavedAccount(userId: string, accountId: string, deleteLeads: boolean = false): Promise<{ deletedLeads: number }> {
    // First get the account to find the businessId
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      return { deletedLeads: 0 };
    }

    let deletedLeadsCount = 0;

    if (deleteLeads) {
      // Delete all leads for this business (messages will cascade via conversation)
      const leads = await this.prisma.lead.findMany({
        where: {
          userId,
          businessId: account.businessId,
        },
        select: { id: true, threadId: true },
      });

      // Delete conversations and their messages for these leads
      const conversationIds = leads.map(l => l.threadId).filter(Boolean) as string[];
      if (conversationIds.length > 0) {
        // Messages cascade delete with conversation
        await this.prisma.conversation.deleteMany({
          where: { id: { in: conversationIds } },
        });
      }

      // Delete the leads
      await this.prisma.lead.deleteMany({
        where: {
          userId,
          businessId: account.businessId,
        },
      });

      deletedLeadsCount = leads.length;
      console.log(`[PlatformService] Deleted ${leads.length} leads for account ${account.businessName}`);
    }

    // Delete the saved account
    await this.prisma.savedAccount.delete({
      where: { id: accountId },
    });

    console.log(`[PlatformService] Removed account ${account.businessName}`);
    return { deletedLeads: deletedLeadsCount };
  }

  /**
   * Update last used time for a saved account
   */
  async updateSavedAccountLastUsed(userId: string, platform: string, businessId: string): Promise<void> {
    await this.prisma.savedAccount.updateMany({
      where: {
        userId,
        platform,
        businessId,
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Get a saved account by businessId (across all users)
   * Used to check if a business already has webhooks set up
   */
  async getAccountByBusinessId(platform: string, businessId: string) {
    return this.prisma.savedAccount.findFirst({
      where: {
        platform,
        businessId,
      },
    });
  }

  /**
   * Validate token for a saved account by making a simple API call
   * Returns { valid: true } if token works, or { valid: false, reason: string } if not
   */
  async validateAccountToken(userId: string, accountId: string): Promise<{ valid: boolean; reason?: string }> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId },
    });

    if (!account) {
      return { valid: false, reason: 'Account not found' };
    }

    // Get credentials for this account
    const credentials = await this.getAccountCredentials(userId, accountId);
    if (!credentials) {
      return { valid: false, reason: 'No credentials stored for this account. Please reconnect.' };
    }

    // Try making a simple API call to validate the token
    try {
      const adapter = this.platformFactory.getAdapter(account.platform) as any;
      // Use getBusinesses as a simple validation call - it will fail if token is expired
      await adapter.getBusinesses(credentials);
      return { valid: true };
    } catch (error: any) {
      const errMsg = error.message?.toLowerCase() || '';
      const status = error.response?.status;

      console.log(`[PlatformService] Token validation failed - status: ${status}, message: ${errMsg}`);

      if (status === 401 ||
          errMsg.includes('unauthorized') ||
          errMsg.includes('token') ||
          errMsg.includes('expired') ||
          errMsg.includes('invalid') ||
          errMsg.includes('not active')) {
        return {
          valid: false,
          reason: 'Login required to import. Please log in to Thumbtack to import old leads. (New leads still arrive automatically.)',
        };
      }

      // Other errors - still treat as invalid for safety
      return { valid: false, reason: error.message || 'Failed to validate token' };
    }
  }

  /**
   * Sync saved accounts from existing leads
   * This backfills any accounts that have leads but aren't in saved_accounts
   */
  async syncSavedAccountsFromLeads(userId: string, platform: string): Promise<{ synced: number }> {
    // Get all unique businessIds from leads for this user/platform
    const leadsWithBusinesses = await this.prisma.lead.findMany({
      where: {
        userId,
        platform,
        businessId: { not: null },
      },
      select: {
        businessId: true,
        rawJson: true, // We'll try to extract business name from raw data
      },
      distinct: ['businessId'],
    });

    // Get existing saved accounts
    const existingSavedAccounts = await this.prisma.savedAccount.findMany({
      where: {
        userId,
        platform,
      },
      select: {
        businessId: true,
      },
    });

    const existingBusinessIds = new Set(existingSavedAccounts.map(a => a.businessId));

    // Find leads with businessIds that aren't in saved_accounts
    const missingAccounts = leadsWithBusinesses.filter(
      lead => lead.businessId && !existingBusinessIds.has(lead.businessId)
    );

    // Create saved accounts for missing ones
    let synced = 0;
    for (const lead of missingAccounts) {
      if (lead.businessId) {
        // Try to extract business name from rawJson
        let businessName = `Business ${lead.businessId.slice(-6)}`;
        try {
          const rawData = JSON.parse(lead.rawJson);
          // Thumbtack stores business info in the payload
          if (rawData.business?.name) {
            businessName = rawData.business.name;
          } else if (rawData.businessName) {
            businessName = rawData.businessName;
          }
        } catch {
          // Keep default name if parsing fails
        }

        await this.saveAccount(
          userId,
          platform,
          lead.businessId,
          businessName,
          undefined,
          undefined,
        );
        synced++;
        console.log(`[PlatformService] Synced saved account from leads: ${businessName} (${lead.businessId})`);
      }
    }

    return { synced };
  }
}
