/**
 * Platform Service
 * Manages platform connections and credentials
 */

import { Injectable, NotFoundException, BadRequestException, Logger, Inject, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/utils/prisma.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { PlatformFactory } from './platform.factory';
import { PlatformCredentials } from '../common/interfaces/platform.interface';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class PlatformService {
  private readonly logger = new Logger(PlatformService.name);
  private readonly encryptionKey: string;

  constructor(
    private prisma: PrismaService,
    private platformFactory: PlatformFactory,
    private configService: ConfigService,
    @Inject(forwardRef(() => NotificationsService))
    private notificationsService: NotificationsService,
  ) {
    this.encryptionKey = this.configService.get<string>('encryption.key') || 'default-32-char-encryption-key';
  }

  /**
   * Get OAuth authorization URL
   * State is an encrypted token containing userId + expiry — survives server restarts.
   */
  async getAuthUrl(userId: string, platformName: string, forceLogin = false, callbackUrl?: string): Promise<string> {
    const adapter = this.platformFactory.getAdapter(platformName);

    // Encode userId + expiry into the state param itself (no in-memory Map needed)
    const statePayload = JSON.stringify({ userId, exp: Date.now() + 10 * 60 * 1000 });
    const state = encodeURIComponent(EncryptionUtil.encrypt(statePayload, this.encryptionKey));

    return adapter.getAuthUrl(userId, state, forceLogin, callbackUrl);
  }

  /**
   * Get userId from OAuth state parameter
   * Decrypts the state token — works even after server restarts/redeploys.
   */
  async getUserIdFromState(state: string): Promise<string | null> {
    try {
      const decoded = decodeURIComponent(state);
      const payload = JSON.parse(EncryptionUtil.decrypt(decoded, this.encryptionKey));

      if (!payload.userId || !payload.exp) return null;
      if (Date.now() > payload.exp) {
        this.logger.warn('OAuth state expired');
        return null;
      }

      return payload.userId;
    } catch (err) {
      this.logger.error('Failed to decrypt OAuth state:', err.message);
      return null;
    }
  }

  /**
   * Handle OAuth callback and store credentials
   */
  async handleCallback(userId: string, platformName: string, code: string, callbackUrl?: string): Promise<void> {
    const adapter = this.platformFactory.getAdapter(platformName);

    // Exchange code for tokens
    const credentials = await adapter.handleCallback(code, userId, callbackUrl);

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

    // Use updateMany to avoid P2025 when no Platform record exists (first-time users)
    await this.prisma.platform.updateMany({
      where: { userId, platformName },
      data: { connected: false },
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
   * Registers webhook URL with Thumbtack to receive NegotiationCreatedV4 and MessageCreatedV4 events
   * Uses account-specific credentials if available, falls back to platform credentials
   * Automatically cleans up any existing webhooks before creating a new one
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

    // Clean up any existing webhooks before creating a new one
    try {
      const existingWebhooks = await adapter.getWebhooks(credentials, businessId);
      if (existingWebhooks && existingWebhooks.length > 0) {
        console.log(`[PlatformService] Found ${existingWebhooks.length} existing webhooks for business ${businessId}, cleaning up...`);
        for (const webhook of existingWebhooks) {
          try {
            await adapter.deleteWebhook(credentials, businessId, webhook.webhookID);
            console.log(`[PlatformService] Deleted old webhook ${webhook.webhookID}`);
          } catch (deleteErr: any) {
            console.warn(`[PlatformService] Failed to delete old webhook ${webhook.webhookID}: ${deleteErr.message}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[PlatformService] Could not fetch existing webhooks for cleanup: ${err.message}`);
      // Continue with registration even if cleanup fails
    }

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
    console.log(`[reconnectAccountWebhook] Start: userId=${userId}, accountId=${accountId}`);

    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account) {
      console.error(`[reconnectAccountWebhook] Account not found: ${accountId}`);
      throw new Error('Account not found');
    }

    console.log(`[reconnectAccountWebhook] Found account: ${account.businessName} (businessId=${account.businessId}, current webhookId=${account.webhookId})`);

    // Setup new webhook
    const result = await this.setupThumbtackWebhook(userId, account.businessId);

    console.log(`[reconnectAccountWebhook] Done: new webhookId=${result.webhookId}`);
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

  /**
   * Delete a specific webhook from Thumbtack
   * Used for cleaning up duplicate webhooks
   */
  async deleteThumbtackWebhook(userId: string, businessId: string, webhookId: string): Promise<void> {
    // Try account-specific credentials first
    let credentials: { accessToken: string; refreshToken?: string };
    const accountCreds = await this.getAccountCredentialsByBusinessId(userId, 'thumbtack', businessId);
    if (accountCreds) {
      credentials = accountCreds;
    } else {
      credentials = await this.getCredentials(userId, 'thumbtack');
    }
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    await adapter.deleteWebhook(credentials, businessId, webhookId);
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
    credentials?: { accessToken: string; refreshToken?: string; email?: string; expiresAt?: Date },
  ): Promise<void> {
    // Check for trial abuse: If this Thumbtack business has been used before, invalidate trial
    // Skip this check for admin users to allow testing with same Thumbtack business
    if (platform === 'thumbtack' && businessId) {
      // Fetch user's role to check if they're an admin
      const currentUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { role: true },
      });

      // Only apply trial restrictions to non-admin users
      if (currentUser?.role !== 'ADMIN') {
        // Check if this business ID exists on any other user
        const existingUser = await this.prisma.user.findFirst({
          where: {
            thumbtackBusinessId: businessId,
            id: { not: userId }, // Different user
          },
          select: { id: true },
        });

        if (existingUser) {
          // This Thumbtack account has been used before - invalidate current user's trial
          await this.prisma.user.update({
            where: { id: userId },
            data: {
              trialUsed: true,
              trialStartDate: null,
              trialEndDate: null,
            },
          });
          this.logger.warn(`[PlatformService] Trial invalidated for user ${userId} - Thumbtack business ${businessId} already used by another account`);
        }

        // Store Thumbtack business ID on user to track trial usage
        await this.prisma.user.update({
          where: { id: userId },
          data: {
            thumbtackBusinessId: businessId,
            thumbtackAccountEmail: emailHint,
          },
        });
      } else {
        this.logger.log(`[PlatformService] Admin user ${userId} bypassing trial restrictions for Thumbtack business ${businessId}`);
      }
    }

    // Encrypt credentials if provided
    let encryptedCredentials: string | undefined;
    if (credentials) {
      encryptedCredentials = EncryptionUtil.encryptObject(credentials, this.encryptionKey);
    }

    const savedAccount = await this.prisma.savedAccount.upsert({
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

    // Auto-provision Sigcore workspace for this account (idempotent, non-blocking)
    this.autoProvisionSigcore(savedAccount.id, businessName).catch((err) => {
      this.logger.warn(`[saveAccount] Sigcore auto-provision failed for ${savedAccount.id}: ${err.message}`);
    });
  }

  /**
   * Auto-provision a Sigcore tenant workspace for a saved account.
   * Idempotent — skips if already provisioned.
   */
  private async autoProvisionSigcore(savedAccountId: string, displayName?: string): Promise<void> {
    // Check if already provisioned
    const existing = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId },
      select: { sigcoreTenantId: true, sigcoreApiKey: true },
    });
    if (existing?.sigcoreTenantId && existing?.sigcoreApiKey) {
      return; // already provisioned
    }

    const sigcoreUrl = this.configService.get<string>('SIGCORE_API_URL', 'https://sigcore-production.up.railway.app/api');
    const platformKey = this.configService.get<string>('SIGCORE_API_KEY');
    if (!platformKey) {
      this.logger.warn('[autoProvisionSigcore] SIGCORE_API_KEY not configured — skipping');
      return;
    }

    const resp = await fetch(`${sigcoreUrl}/tenants/provision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': platformKey },
      body: JSON.stringify({
        externalTenantId: savedAccountId,
        displayName: displayName || `Account ${savedAccountId}`,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Sigcore provision failed (${resp.status}): ${text}`);
    }

    const { data } = await resp.json();

    await this.prisma.notificationSettings.upsert({
      where: { savedAccountId },
      update: {
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
      },
      create: {
        savedAccountId,
        sigcoreApiKey: data.apiKey,
        sigcoreTenantId: data.tenantId,
        sigcoreWorkspaceId: data.tenantId,
        sigcoreProvisionedAt: new Date(),
        enabled: false,
      },
    });

    this.logger.log(`[autoProvisionSigcore] Provisioned tenant ${data.tenantId} for account ${savedAccountId}`);
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
    credentials: { accessToken: string; refreshToken?: string; email?: string; expiresAt?: Date },
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
   * Automatically refreshes expired tokens
   */
  async getAccountCredentialsByBusinessId(userId: string, platform: string, businessId: string): Promise<{ accessToken: string; refreshToken?: string; email?: string } | null> {
    const account = await this.prisma.savedAccount.findFirst({
      where: { userId, platform, businessId },
    });

    if (!account?.credentialsJson) {
      return null;
    }

    try {
      const credentials = EncryptionUtil.decryptObject<{ accessToken: string; refreshToken?: string; email?: string; expiresAt?: string }>(
        account.credentialsJson,
        this.encryptionKey,
      );

      // Check if token is expired and refresh if needed
      if (credentials.expiresAt && credentials.refreshToken) {
        const expiresAt = new Date(credentials.expiresAt);
        const bufferMs = 5 * 60 * 1000; // 5 minutes buffer
        const now = new Date();

        if (now.getTime() > (expiresAt.getTime() - bufferMs)) {
          console.log(`[PlatformService] Account token expired for business ${businessId}, refreshing...`);
          console.log(`[PlatformService] Token expires: ${expiresAt.toISOString()}, Now: ${now.toISOString()}`);

          try {
            const adapter = this.platformFactory.getAdapter(platform);
            const newCredentials = await adapter.refreshAccessToken(credentials.refreshToken);

            // Update stored credentials with new token
            await this.updateAccountCredentials(account.id, {
              accessToken: newCredentials.accessToken,
              refreshToken: newCredentials.refreshToken || credentials.refreshToken,
              email: credentials.email,
              expiresAt: newCredentials.expiresAt,
            });

            console.log(`[PlatformService] Account token refreshed successfully for business ${businessId}`);
            return {
              accessToken: newCredentials.accessToken,
              refreshToken: newCredentials.refreshToken || credentials.refreshToken,
              email: credentials.email,
            };
          } catch (refreshError: any) {
            console.error(`[PlatformService] Failed to refresh account token for business ${businessId}:`, refreshError.message);
            // Return existing credentials and let the API call fail with proper error
            return credentials;
          }
        }
      }

      return credentials;
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

    // Clean up Sigcore tenant before deleting locally (cascades phone numbers, integrations, API keys)
    try {
      await this.notificationsService.deleteSigcoreTenant(accountId);
    } catch (err: any) {
      this.logger.warn(`[removeSavedAccount] Sigcore tenant cleanup failed: ${err.message}`);
    }

    // Delete the saved account (cascades to NotificationSettings, CallConnectSettings, etc.)
    await this.prisma.savedAccount.delete({
      where: { id: accountId },
    });

    this.logger.log(`[removeSavedAccount] Removed account ${account.businessName}`);
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

  /**
   * Get user by ID with role information
   */
  async getUserById(userId: string): Promise<{ id: string; role: string } | null> {
    return this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true },
    });
  }
}
