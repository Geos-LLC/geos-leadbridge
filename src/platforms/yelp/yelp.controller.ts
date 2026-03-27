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
   * Business owner clicks this to authorize LeadBridge to access their leads.
   */
  @Get('auth/url')
  async getAuthUrl(@CurrentUser() user: any) {
    const authUrl = await this.platformService.getAuthUrl(user.id, PlatformName.YELP);
    return { url: authUrl };
  }

  /**
   * Logout from Yelp then redirect to OAuth.
   * Serves an HTML page that:
   * 1. Fetches biz.yelp.com logout to clear cookies
   * 2. Redirects to Yelp OAuth login page
   */
  @Public()
  @Get('auth/logout-and-connect')
  async logoutAndConnect(
    @Query('authUrl') authUrl: string,
    @Res() res: Response,
  ) {
    if (!authUrl) {
      return res.redirect(`${this.frontendUrl}/dashboard?error=missing_auth_url`);
    }

    // Serve an HTML page that chains: biz.yelp.com logout → consumer logout → OAuth
    // Step 1: Navigate an iframe to biz.yelp.com/logout (clears biz session)
    // Step 2: Navigate another iframe to www.yelp.com/logout (clears consumer session)
    // Step 3: Redirect to OAuth URL (user sees fresh login)
    // Iframes may be blocked by X-Frame-Options, so we also use fetch as fallback
    const escapedUrl = authUrl.replace(/"/g, '&quot;').replace(/\\/g, '\\\\');
    res.type('html').send(`<!DOCTYPE html>
<html><head><title>Connecting to Yelp...</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc">
  <div style="text-align:center">
    <div style="width:40px;height:40px;border:3px solid #e2e8f0;border-top-color:#dc2626;border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 20px"></div>
    <p style="color:#64748b;font-size:18px;margin:0 0 8px">Connecting to Yelp...</p>
    <p style="color:#94a3b8;font-size:14px;margin:0">Clearing previous session and redirecting to login</p>
  </div>
  <style>@keyframes spin{to{transform:rotate(360deg)}}</style>
  <script>
    // Try multiple logout methods - at least one should clear the session
    // 1. Fetch with credentials (may work for same-site cookies)
    fetch('https://biz.yelp.com/logout', { credentials: 'include', mode: 'no-cors', redirect: 'follow' }).catch(function(){});
    fetch('https://www.yelp.com/logout', { credentials: 'include', mode: 'no-cors', redirect: 'follow' }).catch(function(){});
    // 2. Open logout in a new window (user click not required from server-rendered page)
    var w = window.open('https://biz.yelp.com/logout', 'yelp_biz_logout', 'width=1,height=1,left=-100,top=-100');
    // 3. After enough time for logouts to process, close popup and redirect to OAuth
    setTimeout(function(){
      try { if(w) w.close(); } catch(e){}
      window.location.href = "${escapedUrl}";
    }, 3000);
  </script>
</body></html>`);
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
