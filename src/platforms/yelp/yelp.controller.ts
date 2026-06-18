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
import { TrialService } from '../../trial/trial.service';
import { LeadsService } from '../../leads/leads.service';
import { parseAccountScope } from '../../common/account-scope/account-scope.util';

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
    private trialService: TrialService,
    private leadsService: LeadsService,
  ) {
    const rawUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:5173';
    this.frontendUrl = rawUrl.trim().replace(/\/+$/, '');
    this.encryptionKey = this.configService.get<string>('encryption.key') || '';
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
    this.logger.log(`[Yelp OAuth] Step 1: GET /auth/url called by user ${user.id}`);
    const authUrl = await this.platformService.getAuthUrl(user.id, PlatformName.YELP);
    this.logger.log(`[Yelp OAuth] Step 1: Returning URL → ${authUrl.substring(0, 120)}...`);
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
    this.logger.log(`[Yelp OAuth] Step 3: GET /auth/callback — code=${code?.substring(0, 10) || 'NONE'}... state=${state?.substring(0, 20) || 'NONE'}... error=${error || 'none'}`);

    if (error) {
      this.logger.error(`[Yelp OAuth] Step 3: ERROR from Yelp — error=${error} desc=${errorDescription}`);
      const params = new URLSearchParams({ error, error_description: errorDescription || 'Yelp OAuth failed' });
      const redirectUrl = `${this.frontendUrl}/overview?${params.toString()}`;
      this.logger.log(`[Yelp OAuth] Step 3: Redirecting to ${redirectUrl}`);
      return res.redirect(redirectUrl);
    }

    if (!code) {
      this.logger.error(`[Yelp OAuth] Step 3: Missing authorization code`);
      return res.redirect(`${this.frontendUrl}/overview?error=missing_code&error_description=Authorization code is required`);
    }

    try {
      const userId = await this.platformService.getUserIdFromState(state);
      this.logger.log(`[Yelp OAuth] Step 3: State decoded → userId=${userId || 'INVALID'}`);
      if (!userId) {
        this.logger.error(`[Yelp OAuth] Step 3: Invalid/expired state`);
        return res.redirect(`${this.frontendUrl}/overview?error=invalid_state&error_description=OAuth state expired. Please try again.`);
      }

      // Exchange code for tokens
      this.logger.log(`[Yelp OAuth] Step 4: Exchanging code for tokens...`);
      const credentials = await this.yelpAdapter.handleCallback(code, userId);
      this.logger.log(`[Yelp OAuth] Step 4: Token received — accessToken=${credentials.accessToken?.substring(0, 15)}... expiresAt=${credentials.expiresAt?.toISOString() || 'none'} hasRefresh=${!!credentials.refreshToken}`);

      // Fetch claimed businesses using the new OAuth token
      this.logger.log(`[Yelp OAuth] Step 5: Fetching claimed businesses...`);
      const businesses = await this.yelpAdapter.getClaimedBusinesses(credentials.accessToken);
      this.logger.log(`[Yelp OAuth] Step 5: Found ${businesses.length} businesses: ${businesses.map((b: any) => `${b.name || b.id}`).join(', ')}`);

      if (businesses.length === 0) {
        this.logger.warn(`[Yelp OAuth] Step 5: No businesses found — storing credentials at platform level`);
        await this.platformService.storeCredentials(userId, PlatformName.YELP, credentials);
        return res.redirect(`${this.frontendUrl}/overview?connected=yelp&warning=no_businesses`);
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
          this.logger.log(`[Yelp OAuth] Step 5b: Updating credentials for existing account: ${businessName} (${businessId})`);
          await this.prisma.savedAccount.update({
            where: { id: existing.id },
            // Resurrect path — clear archivedAt if the auto-archive
            // sweep had marked this account as dormant. See
            // platform.service.ts saveAccount for the rationale.
            data: { businessName, credentialsJson: encryptedCreds, archivedAt: null },
          });

          // Auto-resolve any stale errors — match by accountId, accountName, or businessId in context
          const resolved = await this.prisma.systemErrorLog.updateMany({
            where: {
              resolved: false,
              OR: [
                { accountId: existing.id },
                { accountName: businessName },
                { context: { contains: businessId } },
              ],
            },
            data: { resolved: true },
          });
          if (resolved.count > 0) {
            this.logger.log(`[Yelp OAuth] Step 5b: Auto-resolved ${resolved.count} stale errors for ${businessName}`);
          }
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
          this.trialService.onPlatformConnected(userId, PlatformName.YELP).catch((err) => {
            this.logger.warn(`[Yelp OAuth] Trial init failed for ${userId}: ${err.message}`);
          });
        }

        // Subscribe this business to webhooks (uses API key, not OAuth)
        try {
          await this.yelpAdapter.subscribeToBusinesses([businessId]);
          // Mark as subscribed — Yelp doesn't return a webhook ID, use a marker
          const acct = existing || await this.prisma.savedAccount.findFirst({ where: { userId, platform: PlatformName.YELP, businessId } });
          if (acct) {
            await this.prisma.savedAccount.update({
              where: { id: acct.id },
              data: { webhookId: `yelp-webhook-${businessId}` },
            });
          }
          this.logger.log(`[Yelp OAuth] Subscribed ${businessName} to webhooks`);
        } catch (err: any) {
          this.logger.error(`Failed to subscribe Yelp business ${businessId}: ${err.message}`);
        }
      }

      this.logger.log(`[Yelp OAuth] Step 6: Complete — ${businesses.length} businesses connected for user ${userId}`);
      const successUrl = `${this.frontendUrl}/overview?connected=yelp&businesses=${businesses.length}`;
      this.logger.log(`[Yelp OAuth] Step 6: Redirecting to ${successUrl}`);
      return res.redirect(successUrl);
    } catch (err: any) {
      this.logger.error(`[Yelp OAuth] FAILED at callback: ${err.message} stack=${err.stack?.split('\n').slice(0, 3).join(' | ')}`);
      const params = new URLSearchParams({ error: 'oauth_failed', error_description: err.message });
      const failUrl = `${this.frontendUrl}/overview?${params.toString()}`;
      this.logger.log(`[Yelp OAuth] Redirecting to error URL: ${failUrl}`);
      return res.redirect(failUrl);
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
    await this.sweepOrphanErrorLogs(accountId);
    await this.prisma.savedAccount.delete({ where: { id: accountId } });

    return { success: true, message: `Yelp business "${account.businessName}" disconnected` };
  }

  /**
   * Sweep SystemErrorLog rows referencing a SavedAccount before it's
   * deleted. SystemErrorLog.accountId is a plain string column (no FK),
   * so without this call the rows orphan and pollute the dead-token
   * sweep + tenant-health UI. Defensive — never throws.
   */
  private async sweepOrphanErrorLogs(accountId: string): Promise<void> {
    try {
      const swept = await this.prisma.systemErrorLog.deleteMany({
        where: { accountId },
      });
      if (swept.count > 0) {
        this.logger.log(
          `[yelp.disconnect] swept ${swept.count} SystemErrorLog rows for ${accountId}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `[yelp.disconnect] SystemErrorLog sweep failed (non-fatal): ${err.message}`,
      );
    }
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

    this.trialService.onPlatformConnected(user.id, PlatformName.YELP).catch((err) => {
      this.logger.warn(`[addBusiness] Trial init failed for ${user.id}: ${err.message}`);
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
    await this.sweepOrphanErrorLogs(id);
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

    // Mark all as subscribed
    for (const account of accounts) {
      await this.prisma.savedAccount.update({
        where: { id: account.id },
        data: { webhookId: `yelp-webhook-${account.businessId}` },
      });
    }

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

    // Check credentials exist
    if (!account.credentialsJson) {
      connectionIssues.push('No Yelp credentials stored — reconnect Yelp account');
    } else {
      try {
        const creds = EncryptionUtil.decryptObject<any>(account.credentialsJson, this.encryptionKey);
        if (!creds.accessToken) {
          connectionIssues.push('No Yelp OAuth token — reconnect Yelp account');
        } else {
          // Check for unresolved token errors in SystemErrorLog (same as Thumbtack tokenDead)
          const tokenError = await this.prisma.systemErrorLog.findFirst({
            where: {
              resolved: false,
              OR: [
                { accountId: account.id, category: 'token_refresh' },
                { accountId: account.id, category: 'yelp' },
                { accountId: account.id, category: 'automation', message: { contains: '401' } },
              ],
            },
            orderBy: { createdAt: 'desc' },
          });
          if (tokenError) {
            connectionIssues.push('Yelp token failed — reconnect Yelp account');
          } else {
            // No logged errors — actively test the token against the leads-scoped API
            try {
              const axios = require('axios');
              // Use the same API endpoint as lead operations
              await axios.get(`https://api.yelp.com/v3/businesses/${account.businessId}`, {
                headers: { Authorization: `Bearer ${creds.accessToken}` },
                timeout: 10000,
              });
            } catch (apiErr: any) {
              const is401 = apiErr.response?.status === 401 || apiErr.message?.includes('401');
              if (is401 && creds.refreshToken) {
                try {
                  const refreshed = await this.yelpAdapter.refreshAccessToken(creds.refreshToken);
                  const updatedCreds = { ...creds, accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken || creds.refreshToken, expiresAt: refreshed.expiresAt };
                  const encryptedFresh = EncryptionUtil.encryptObject(updatedCreds, this.encryptionKey);
                  // Sync to ALL Yelp accounts for this user — one token per user,
                  // refreshing one invalidates siblings (chain revocation)
                  await this.prisma.savedAccount.updateMany({
                    where: { userId: account.userId, platform: PlatformName.YELP },
                    data: { credentialsJson: encryptedFresh },
                  });
                  this.logger.log(`[Yelp Health] Token refreshed for ${account.businessId} — synced to all Yelp accounts`);
                } catch {
                  connectionIssues.push('Yelp token invalid and refresh failed — reconnect Yelp account');
                }
              } else if (is401) {
                connectionIssues.push('Yelp token invalid — reconnect Yelp account');
              }
            }
          }
        }
      } catch {
        connectionIssues.push('Failed to decrypt Yelp credentials — reconnect Yelp account');
      }
    }

    // Check for recent send failures (403 NO_BUSINESS_ACCESS, token errors)
    // This is the real signal — the token was tested against Yelp's API and failed.
    const recentSendError = await this.prisma.systemErrorLog.findFirst({
      where: {
        resolved: false,
        accountId: account.id,
        AND: [
          {
            OR: [
              { category: 'automation', message: { contains: 'NO_BUSINESS_ACCESS' } },
              { category: 'automation', message: { contains: '403' } },
              { category: 'yelp' },
            ],
          },
          // Per-lead state errors (customer archived a project) are NOT account-level auth failures
          { NOT: { message: { contains: 'archived' } } },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recentSendError) {
      connectionIssues.push('Yelp message send failed — reconnect Yelp to re-authorize');
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

  /**
   * Yelp leads list — platform-scoped (Yelp only, never merged with Thumbtack).
   *
   * Account-scope contract:
   *   ?businessId=<yelpBusinessId>  → only that account's leads
   *   ?scope=all                    → all of the user's Yelp leads (no cap)
   *   neither                       → 400
   *   both                          → 400
   *
   * Response: `{ platform, count, leads: NormalizedLead[] }` — same shape as
   * `/v1/thumbtack/leads` and `/v1/leads`. `leads[]` includes the SF-sync
   * required fields: id, platform, businessId, businessName, customerName,
   * customerPhone, customerEmail, status, createdAt, updatedAt, lastMessageAt.
   *
   * No default limit — full Yelp dataset is returned for SF sync. Pass `?limit`
   * to cap. Pre-fix, this endpoint hard-coded `take: 100` and returned raw
   * Prisma rows, masking the true dataset size (e.g. Spotless Yelp = 323 leads,
   * showed as 100).
   */
  @Get('leads')
  async getLeads(
    @CurrentUser() user: any,
    @Query('businessId') businessId?: string,
    @Query('scope') scope?: string,
    @Query('limit') limitRaw?: string,
  ) {
    const accountScope = parseAccountScope({ businessId, scope });

    const options: { businessId?: string; scope?: 'all'; limit?: number } = {};
    if (limitRaw) {
      const parsed = parseInt(limitRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) options.limit = parsed;
    }

    if (accountScope.kind === 'account') {
      // Verify the businessId is one of this user's Yelp accounts before querying.
      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: user.id, platform: PlatformName.YELP, businessId: accountScope.businessId },
        select: { id: true },
      });
      if (!account) {
        throw new BadRequestException(
          `businessId '${accountScope.businessId}' is not a Yelp saved account for this user`,
        );
      }
      options.businessId = accountScope.businessId;
    } else {
      options.scope = 'all';
    }

    const leads = await this.leadsService.getLeads(user.id, PlatformName.YELP, options);
    const enriched = await this.leadsService.enrichLeadsWithAccountInfo(user.id, leads);
    return { platform: PlatformName.YELP, count: enriched.length, leads: enriched };
  }
}
