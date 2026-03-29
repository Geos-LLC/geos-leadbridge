/**
 * Yelp Controller
 * Manages Yelp OAuth, business subscriptions, and account setup
 */

import {
  Controller,
  Post,
  Delete,
  Get,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { ConfigService } from '@nestjs/config';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../common/utils/prisma.service';
import { PlatformService } from '../platform.service';
import { YelpAdapter } from './yelp.adapter';
import { PlatformName } from '../../common/interfaces/platform.interface';
import { EncryptionUtil } from '../../common/utils/encryption.util';

@Controller('v1/yelp')
@UseGuards(JwtAuthGuard)
export class YelpController {
  private readonly logger = new Logger(YelpController.name);
  private readonly frontendUrl: string;
  private readonly encryptionKey: string;

  constructor(
    private yelpAdapter: YelpAdapter,
    private platformService: PlatformService,
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {
    const rawUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:5173';
    this.frontendUrl = rawUrl.trim().replace(/\/+$/, '');
    this.encryptionKey = this.configService.get<string>('encryptionKey') || '';
  }

  // ==========================================
  // OAuth Flow
  // ==========================================

  /**
   * Get Yelp OAuth authorization URL.
   * Flow: frontend opens biz.yelp.com/logout in popup (clears session),
   * then redirects main window to this OAuth URL → login → consent → callback.
   */
  @Get('auth/url')
  async getAuthUrl(@CurrentUser() user: any) {
    const authUrl = await this.platformService.getAuthUrl(user.id, PlatformName.YELP);
    return { url: authUrl };
  }

  /**
   * OAuth callback — Yelp redirects here after business owner authorizes.
   * Exchanges code for tokens, fetches claimed businesses, saves per-business credentials.
   */
  @Public()
  @Get('auth/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    if (error) {
      const params = new URLSearchParams({ error, error_description: errorDescription || 'Yelp OAuth failed' });
      return res.redirect(`${this.frontendUrl}/dashboard?${params.toString()}`);
    }

    if (!code) {
      return res.redirect(`${this.frontendUrl}/dashboard?error=missing_code&error_description=Authorization code is required`);
    }

    try {
      const userId = await this.platformService.getUserIdFromState(state);
      if (!userId) {
        return res.redirect(`${this.frontendUrl}/dashboard?error=invalid_state&error_description=OAuth state expired. Please try again.`);
      }

      // Exchange code for tokens
      const credentials = await this.yelpAdapter.handleCallback(code, userId);

      // Fetch claimed businesses using the new OAuth token
      const businesses = await this.yelpAdapter.getClaimedBusinesses(credentials.accessToken);

      if (businesses.length === 0) {
        // Business discovery failed — store credentials at platform level
        // so they can be associated with businesses later (manual add or webhook)
        this.logger.warn('Yelp OAuth succeeded but business discovery failed — storing credentials for later use');
        await this.platformService.storeCredentials(userId, PlatformName.YELP, credentials);
        return res.redirect(`${this.frontendUrl}/dashboard?connected=yelp&warning=no_businesses`);
      }

      // Save each business as a SavedAccount with per-business OAuth credentials
      const encryptedCreds = EncryptionUtil.encryptObject({
        accessToken: credentials.accessToken,
        refreshToken: credentials.refreshToken,
        expiresAt: credentials.expiresAt?.toISOString(),
      }, this.encryptionKey);

      for (const biz of businesses) {
        const businessId = biz.id || biz.business_id;
        const businessName = biz.name || 'Yelp Business';

        const existing = await this.prisma.savedAccount.findFirst({
          where: { userId, platform: PlatformName.YELP, businessId },
        });

        if (existing) {
          this.logger.log(`Updating credentials for existing Yelp account: ${businessName} (${businessId})`);
          await this.prisma.savedAccount.update({
            where: { id: existing.id },
            data: { businessName, credentialsJson: encryptedCreds },
          });
        } else {
          this.logger.log(`Creating new Yelp account: ${businessName} (${businessId})`);
          await this.prisma.savedAccount.create({
            data: {
              userId,
              platform: PlatformName.YELP,
              businessId,
              businessName,
              imageUrl: biz.image_url || biz.photos?.[0],
              credentialsJson: encryptedCreds,
            },
          });
        }

        // Subscribe this business to webhooks (uses API key, not OAuth)
        try {
          await this.yelpAdapter.subscribeToBusinesses([businessId]);
        } catch (err: any) {
          this.logger.error(`Failed to subscribe Yelp business ${businessId}: ${err.message}`);
        }
      }

      this.logger.log(`Yelp OAuth complete: ${businesses.length} businesses connected for user ${userId}`);
      return res.redirect(`${this.frontendUrl}/dashboard?connected=yelp&businesses=${businesses.length}`);
    } catch (err: any) {
      this.logger.error(`Yelp OAuth callback failed: ${err.message}`);
      const params = new URLSearchParams({ error: 'oauth_failed', error_description: err.message });
      return res.redirect(`${this.frontendUrl}/dashboard?${params.toString()}`);
    }
  }

  /**
   * Disconnect a Yelp business (unsubscribe from webhooks, remove account).
   */
  @Post('auth/disconnect')
  async disconnect(@CurrentUser() user: any, @Body('accountId') accountId: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: accountId, userId: user.id, platform: PlatformName.YELP },
    });

    if (!account) throw new BadRequestException('Yelp account not found');

    await this.yelpAdapter.unsubscribeFromBusinesses([account.businessId]);
    await this.prisma.savedAccount.delete({ where: { id: accountId } });

    return { success: true, message: `Yelp business "${account.businessName}" disconnected` };
  }

  // ==========================================
  // Business Management
  // ==========================================

  /**
   * Manually add a Yelp business (for cases where OAuth doesn't return it).
   */
  @Post('businesses')
  async addBusiness(
    @CurrentUser() user: any,
    @Body('businessId') businessId: string,
    @Body('businessName') businessName: string,
    @Body('imageUrl') imageUrl?: string,
  ) {
    if (!businessId || !businessName) {
      throw new BadRequestException('businessId and businessName are required');
    }

    await this.prisma.savedAccount.upsert({
      where: { userId_platform_businessId: { userId: user.id, platform: PlatformName.YELP, businessId } },
      create: { userId: user.id, platform: PlatformName.YELP, businessId, businessName, imageUrl },
      update: { businessName, imageUrl },
    });

    await this.yelpAdapter.subscribeToBusinesses([businessId]);

    return { success: true, message: `Yelp business "${businessName}" saved and subscribed` };
  }

  @Get('businesses')
  async getBusinesses(@CurrentUser() user: any) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
      orderBy: { lastUsedAt: 'desc' },
    });
    return { platform: PlatformName.YELP, count: accounts.length, businesses: accounts };
  }

  @Delete('businesses/:id')
  async removeBusiness(@CurrentUser() user: any, @Param('id') id: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id, userId: user.id, platform: PlatformName.YELP },
    });
    if (!account) throw new BadRequestException('Business not found');

    await this.yelpAdapter.unsubscribeFromBusinesses([account.businessId]);
    await this.prisma.savedAccount.delete({ where: { id } });

    return { success: true, message: 'Business removed and unsubscribed' };
  }

  /**
   * Re-subscribe all Yelp businesses to webhooks (required every 24h).
   */
  @Post('businesses/resubscribe')
  async resubscribeAll(@CurrentUser() user: any) {
    const accounts = await this.prisma.savedAccount.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
    });

    if (accounts.length === 0) return { success: true, subscribed: 0 };

    const businessIds = accounts.map((a: any) => a.businessId);
    await this.yelpAdapter.subscribeToBusinesses(businessIds);

    return { success: true, subscribed: accounts.length };
  }

  /**
   * Yelp account health check.
   * Validates OAuth token still grants access to this business by calling
   * partner-api.yelp.com/token/v1/businesses and checking if the businessId
   * is in the returned list. Also checks notification settings.
   */
  @Get('saved-accounts/:id/health')
  async getAccountHealth(@CurrentUser() user: any, @Param('id') id: string) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id, userId: user.id, platform: PlatformName.YELP },
      select: { id: true, businessId: true, businessName: true, userId: true, credentialsJson: true },
    });

    if (!account) {
      return { healthy: true, issues: [], notificationIssues: [], platform: { connected: false }, account: { hasWebhook: false }, notifications: { settingsExist: false, hasSigcoreApiKey: false, newLeadRules: 0, customerReplyRules: 0, rules: [] }, automation: { totalRules: 0 }, recentLogs: [] };
    }

    const connectionIssues: string[] = [];

    // Check OAuth token validity: does the token still grant access to this business?
    if (account.credentialsJson) {
      try {
        const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, this.encryptionKey);
        if (creds.accessToken) {
          const authorizedBusinesses = await this.yelpAdapter.getClaimedBusinesses(creds.accessToken);
          const authorizedIds = authorizedBusinesses.map((b: any) => b.id || b.business_id);
          if (!authorizedIds.includes(account.businessId)) {
            connectionIssues.push('Yelp token lacks access to this business — reconnect Yelp to re-authorize');
          }
        } else {
          connectionIssues.push('No Yelp OAuth token — reconnect Yelp account');
        }
      } catch {
        connectionIssues.push('Failed to validate Yelp credentials — reconnect Yelp account');
      }
    } else {
      connectionIssues.push('No Yelp credentials stored — reconnect Yelp account');
    }

    // Check notification settings (same pattern as Thumbtack health)
    const notifSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: id },
      include: { notificationRules: { select: { id: true, name: true, triggerType: true, toPhone: true, fromPhone: true, enabled: true, sendToCustomer: true } } },
    });

    const notificationIssues: string[] = [];
    const allNewLeadRules = (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'new_lead');
    const enabledNewLeadRules = allNewLeadRules.filter((r: any) => r.enabled);

    if (allNewLeadRules.length === 0) {
      notificationIssues.push('No "new_lead" SMS rules configured');
    } else if (enabledNewLeadRules.length === 0) {
      notificationIssues.push('Lead alert rule exists but is disabled');
    }

    const automationRules = await this.prisma.automationRule.findMany({
      where: { savedAccountId: id, enabled: true },
      select: { id: true, name: true, triggerType: true },
    });

    const healthy = connectionIssues.length === 0;

    return {
      healthy,
      issues: [...connectionIssues, ...notificationIssues],
      notificationIssues,
      platform: { connected: healthy },
      account: { id: account.id, businessId: account.businessId, businessName: account.businessName, hasWebhook: true },
      notifications: {
        settingsExist: !!notifSettings,
        settingsEnabled: notifSettings?.enabled ?? false,
        hasSigcoreApiKey: !!notifSettings?.sigcoreApiKey,
        totalRules: notifSettings?.notificationRules?.length || 0,
        newLeadRules: enabledNewLeadRules.length,
        customerReplyRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'customer_reply' && r.enabled).length,
      },
      automation: { totalRules: automationRules.length, rules: automationRules.map(r => ({ name: r.name, triggerType: r.triggerType })) },
      recentLogs: [],
    };
  }

  @Get('leads')
  async getLeads(@CurrentUser() user: any) {
    const leads = await this.prisma.lead.findMany({
      where: { userId: user.id, platform: PlatformName.YELP },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { platform: PlatformName.YELP, count: leads.length, leads };
  }
}
