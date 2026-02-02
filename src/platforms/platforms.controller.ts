/**
 * Platforms Controller
 * Handles platform connection status and configuration
 */

import { Controller, Get, Post, UseGuards } from '@nestjs/common';
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
    const platforms = await this.platformService.getUserPlatforms(user.id);
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
          userId: user.id,
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
   * Diagnostic endpoint - verify actual webhook status on Thumbtack
   * Fetches webhooks from Thumbtack API for each saved account
   */
  @Get('webhooks/verify')
  async verifyWebhooks(@CurrentUser() user: any) {
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: 'thumbtack' },
    });

    const results: any[] = [];

    for (const account of savedAccounts) {
      try {
        const webhooks = await this.platformService.getThumbtackWebhooks(user.id, account.businessId);
        results.push({
          accountId: account.id,
          businessId: account.businessId,
          businessName: account.businessName,
          storedWebhookId: account.webhookId,
          actualWebhooks: webhooks.map((w: any) => ({
            webhookId: w.webhookID,
            webhookURL: w.webhookURL,
            eventTypes: w.eventTypes,
            enabled: w.enabled,
          })),
          status: webhooks.length > 0 ? 'active' : 'no_webhooks',
          match: webhooks.some((w: any) => w.webhookID === account.webhookId),
        });
      } catch (error: any) {
        results.push({
          accountId: account.id,
          businessId: account.businessId,
          businessName: account.businessName,
          storedWebhookId: account.webhookId,
          error: error.message,
          status: 'error',
        });
      }
    }

    return { accounts: results };
  }

  /**
   * Diagnostic endpoint - show recent webhook events received
   * Useful for debugging which events are being received from Thumbtack
   */
  @Get('webhooks/recent')
  async getRecentWebhookEvents(@CurrentUser() user: any) {
    // Get all saved accounts for this user
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: 'thumbtack' },
    });
    const businessIds = savedAccounts.map(a => a.businessId);

    // Get recent webhook events (last 50)
    const events = await this.prisma.webhookEvent.findMany({
      where: { platform: 'thumbtack' },
      orderBy: { receivedAt: 'desc' },
      take: 50,
    });

    // Parse and summarize events
    const summary = events.map(e => {
      try {
        const payload = JSON.parse(e.payload);
        const businessId = payload?.data?.business?.businessID;
        return {
          id: e.id,
          eventType: e.eventType,
          businessId,
          negotiationId: payload?.data?.negotiationID,
          messageId: payload?.data?.messageID,
          isYourAccount: businessIds.includes(businessId),
          receivedAt: e.receivedAt,
          processed: e.processed,
          error: e.processingError,
        };
      } catch {
        return {
          id: e.id,
          eventType: e.eventType,
          receivedAt: e.receivedAt,
          processed: e.processed,
          error: e.processingError,
        };
      }
    });

    // Group by event type for quick overview
    const byEventType = summary.reduce((acc: any, e) => {
      const type = e.eventType || 'unknown';
      if (!acc[type]) acc[type] = { count: 0, yourAccount: 0 };
      acc[type].count++;
      if (e.isYourAccount) acc[type].yourAccount++;
      return acc;
    }, {});

    return {
      totalEvents: events.length,
      byEventType,
      yourBusinessIds: businessIds,
      recentEvents: summary.slice(0, 20),
    };
  }

  /**
   * Cleanup endpoint - removes duplicate webhooks for each account
   * Keeps only the current webhook (storedWebhookId), deletes all others
   */
  @Post('webhooks/cleanup')
  async cleanupDuplicateWebhooks(@CurrentUser() user: any) {
    const savedAccounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: 'thumbtack' },
    });

    const results: any[] = [];

    for (const account of savedAccounts) {
      const accountResult: any = {
        accountId: account.id,
        businessId: account.businessId,
        businessName: account.businessName,
        currentWebhookId: account.webhookId,
        deleted: [] as string[],
        errors: [] as string[],
      };

      try {
        // Get all webhooks for this account
        const webhooks = await this.platformService.getThumbtackWebhooks(user.id, account.businessId);

        // Find webhooks to delete (all except the current one)
        const webhooksToDelete = webhooks.filter((w: any) => w.webhookID !== account.webhookId);

        accountResult.totalWebhooks = webhooks.length;
        accountResult.toDelete = webhooksToDelete.length;

        // Delete each duplicate webhook
        for (const webhook of webhooksToDelete) {
          try {
            await this.platformService.deleteThumbtackWebhook(user.id, account.businessId, webhook.webhookID);
            accountResult.deleted.push(webhook.webhookID);
          } catch (err: any) {
            accountResult.errors.push(`${webhook.webhookID}: ${err.message}`);
          }
        }

        accountResult.status = accountResult.errors.length === 0 ? 'success' : 'partial';
      } catch (error: any) {
        accountResult.status = 'error';
        accountResult.error = error.message;
      }

      results.push(accountResult);
    }

    const totalDeleted = results.reduce((sum, r) => sum + (r.deleted?.length || 0), 0);
    const totalErrors = results.reduce((sum, r) => sum + (r.errors?.length || 0), 0);

    return {
      success: totalErrors === 0,
      totalDeleted,
      totalErrors,
      accounts: results,
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
          userId: user.id,
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
      where: { userId: user.id, platform: 'thumbtack' },
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
