/**
 * Platforms Controller
 * Handles platform connection status and configuration
 */

import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PlatformService } from './platform.service';
import { PrismaService } from '../common/utils/prisma.service';

export interface HealthIssue {
  code: 'no_webhooks' | 'not_connected';
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
   * Checks each saved account individually for multi-account support
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

    // Get all saved accounts
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.userId, platform: 'thumbtack' },
    });

    // Check 2: Do any saved accounts have webhooks?
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

    // Note: We don't proactively validate tokens here.
    // Token validation happens when the user tries to import negotiations or reconnect.
    // This avoids unnecessary API calls and false positives from short-lived tokens.

    return { healthy: issues.length === 0, issues };
  }
}
