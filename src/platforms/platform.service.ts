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

    // Check if token is expired and refresh if needed
    if (credentials.expiresAt && new Date() > credentials.expiresAt) {
      return await this.refreshToken(userId, platformName, credentials);
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

    return {
      webhookId: result.webhookId,
      businessId,
    };
  }

  /**
   * Get Thumbtack webhooks for a business
   */
  async getThumbtackWebhooks(userId: string, businessId: string): Promise<any[]> {
    const credentials = await this.getCredentials(userId, 'thumbtack');
    const adapter = this.platformFactory.getAdapter('thumbtack') as any;

    return adapter.getWebhooks(credentials, businessId);
  }
}
