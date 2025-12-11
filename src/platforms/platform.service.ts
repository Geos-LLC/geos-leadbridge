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

    // Store state for verification during callback
    // In production, use Redis or session storage
    // For now, we'll include userId in the state

    return adapter.getAuthUrl(userId, state);
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
}
