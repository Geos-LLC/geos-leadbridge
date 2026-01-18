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
   */
  async setupThumbtackWebhook(userId: string, businessId: string): Promise<{ webhookId: string; businessId: string }> {
    const credentials = await this.getCredentials(userId, 'thumbtack');
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
   */
  async disconnectAccountWebhook(userId: string, accountId: string): Promise<{ success: boolean }> {
    // Get the saved account
    const account = await this.prisma.savedAccount.findFirst({
      where: {
        id: accountId,
        userId,
      },
    });

    if (!account || !account.webhookId) {
      console.log(`[PlatformService] No webhook to disconnect for account ${accountId}`);
      return { success: true };
    }

    try {
      const credentials = await this.getCredentials(userId, account.platform);
      const adapter = this.platformFactory.getAdapter(account.platform) as any;

      // Delete the webhook from Thumbtack
      await adapter.deleteWebhook(credentials, account.businessId, account.webhookId);
      console.log(`[PlatformService] Deleted webhook ${account.webhookId} for business ${account.businessId}`);
    } catch (err) {
      console.warn(`[PlatformService] Could not delete webhook: ${err.message}`);
      // Continue to clear local state even if API call fails
    }

    // Clear the webhookId from saved account
    await this.prisma.savedAccount.update({
      where: { id: accountId },
      data: { webhookId: null },
    });

    return { success: true };
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
   */
  async getThumbtackWebhooks(userId: string, businessId: string): Promise<any[]> {
    const credentials = await this.getCredentials(userId, 'thumbtack');
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    return adapter.getWebhooks(credentials, businessId);
  }

  // ==========================================
  // Saved Accounts Methods
  // ==========================================

  /**
   * Save account info for multi-account switching
   */
  async saveAccount(
    userId: string,
    platform: string,
    businessId: string,
    businessName: string,
    imageUrl?: string,
    emailHint?: string,
  ): Promise<void> {
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
        lastUsedAt: new Date(),
      },
      update: {
        businessName,
        imageUrl,
        emailHint,
        lastUsedAt: new Date(),
      },
    });
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
