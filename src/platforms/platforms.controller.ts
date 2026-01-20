/**
 * Platforms Controller
 * Handles platform connection status and configuration
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformService } from './platform.service';
import { PlatformFactory } from './platform.factory';
import { PrismaService } from '../common/utils/prisma.service';

export interface HealthIssue {
  code: 'token_expired' | 'no_webhooks' | 'not_connected' | 'token_invalid' | 'api_error';
  severity: 'error' | 'warning';
  title: string;
  message: string;
  action?: string;
  actionLabel?: string;
}

@Controller('v1/platforms')
@UseGuards(JwtAuthGuard)
export class PlatformsController {
  constructor(
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
    private prisma: PrismaService,
  ) {}

  /**
   * Get connection status for all platforms
   */
  @Get('status')
  async getStatus(@CurrentUser() user: any) {
    const platforms = await this.platformService.getUserPlatforms(user.userId);
    const supportedPlatforms = this.platformService.getSupportedPlatforms();

    // Build status for all supported platforms
    const platformStatus = supportedPlatforms.map((name) => {
      const connected = platforms.find((p) => p.platformName === name);
      return {
        platformName: name,
        connected: connected?.connected ?? false,
        lastSyncAt: connected?.lastSyncAt ?? null,
      };
    });

    return { platforms: platformStatus };
  }

  /**
   * Get detailed connection info including configured business
   */
  @Get('connection')
  async getConnectionDetails(@CurrentUser() user: any) {
    const platform = await this.prisma.platform.findUnique({
      where: {
        userId_platformName: {
          userId: user.userId,
          platformName: 'thumbtack',
        },
      },
      select: {
        platformName: true,
        connected: true,
        externalBusinessId: true,
        webhookId: true,
        lastSyncAt: true,
      },
    });

    return {
      thumbtack: platform
        ? {
            connected: platform.connected,
            configuredBusinessId: platform.externalBusinessId,
            webhookId: platform.webhookId,
            lastSyncAt: platform.lastSyncAt,
          }
        : {
            connected: false,
            configuredBusinessId: null,
            webhookId: null,
            lastSyncAt: null,
          },
    };
  }

  /**
   * Health check endpoint - validates token and checks for issues
   * Returns a list of issues that need user attention
   */
  @Get('health')
  async getHealth(@CurrentUser() user: any): Promise<{ healthy: boolean; issues: HealthIssue[] }> {
    const issues: HealthIssue[] = [];

    // Get platform connection
    const platform = await this.prisma.platform.findUnique({
      where: {
        userId_platformName: {
          userId: user.userId,
          platformName: 'thumbtack',
        },
      },
    });

    // Check 1: Is platform connected?
    if (!platform || !platform.connected) {
      issues.push({
        code: 'not_connected',
        severity: 'warning',
        title: 'Thumbtack Not Connected',
        message: 'Connect your Thumbtack account to start receiving leads and messages.',
        action: 'connect',
        actionLabel: 'Connect Thumbtack',
      });
      return { healthy: issues.length === 0, issues };
    }

    // Check 2: Do any saved accounts have webhooks?
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.userId, platform: 'thumbtack' },
    });

    const accountsWithWebhooks = savedAccounts.filter(a => a.webhookId);
    if (savedAccounts.length > 0 && accountsWithWebhooks.length === 0) {
      issues.push({
        code: 'no_webhooks',
        severity: 'error',
        title: 'No Active Webhooks',
        message: 'None of your Thumbtack accounts have active webhooks. You won\'t receive new leads or messages.',
        action: 'reconnect',
        actionLabel: 'Reconnect Account',
      });
    }

    // Check 3: Validate token by making a test API call
    if (platform.credentialsJson) {
      try {
        const adapter = this.platformFactory.getAdapter('thumbtack') as any;
        const credentials = JSON.parse(platform.credentialsJson);

        // Try to get businesses - this validates the token
        await adapter.getBusinesses(credentials);
      } catch (err: any) {
        const errMsg = err.message?.toLowerCase() || '';
        const statusCode = err.response?.status || err.status;

        if (statusCode === 401 || errMsg.includes('unauthorized') || errMsg.includes('token') || errMsg.includes('expired')) {
          issues.push({
            code: 'token_expired',
            severity: 'error',
            title: 'Session Expired',
            message: 'Your Thumbtack session has expired. Please reconnect to continue receiving leads and sending messages.',
            action: 'reconnect',
            actionLabel: 'Reconnect Thumbtack',
          });
        } else if (statusCode === 403 || errMsg.includes('forbidden') || errMsg.includes('revoked')) {
          issues.push({
            code: 'token_invalid',
            severity: 'error',
            title: 'Access Revoked',
            message: 'Your Thumbtack access has been revoked. Please reconnect your account.',
            action: 'reconnect',
            actionLabel: 'Reconnect Thumbtack',
          });
        } else if (!errMsg.includes('network') && !errMsg.includes('timeout')) {
          // Only report non-network errors as issues
          issues.push({
            code: 'api_error',
            severity: 'warning',
            title: 'Connection Issue',
            message: 'There was a problem connecting to Thumbtack. Some features may not work correctly.',
          });
        }
      }
    }

    return { healthy: issues.length === 0, issues };
  }
}
