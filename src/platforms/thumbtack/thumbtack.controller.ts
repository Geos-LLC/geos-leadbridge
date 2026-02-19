/**
 * Thumbtack Controller
 * Handles Thumbtack-specific OAuth and API endpoints
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  UseGuards,
  Res,
  Body,
  Param,
  BadRequestException,
  HttpException,
  HttpStatus,
  Header,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformService } from '../platform.service';
import { PlatformFactory } from '../platform.factory';
import { LeadsService } from '../../leads/leads.service';
import { PlatformName } from '../../common/interfaces/platform.interface';
import { PrismaService } from '../../common/utils/prisma.service';

@Controller('v1/thumbtack')
@UseGuards(JwtAuthGuard)
export class ThumbtackController {
  private readonly frontendUrl: string;

  constructor(
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
    private leadsService: LeadsService,
    private configService: ConfigService,
    private prisma: PrismaService,
  ) {
    // Sanitize frontendUrl - remove trailing slashes and whitespace
    const rawUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:5173';
    this.frontendUrl = rawUrl.trim().replace(/\/+$/, '');
    console.log('[ThumbtackController] frontendUrl configured as:', this.frontendUrl);
  }

  /**
   * Automatically setup webhooks for all businesses after OAuth connection
   * Also saves each business as a saved account for multi-account switching
   * Skips businesses that already have active webhooks
   */
  private async autoSetupWebhooks(userId: string): Promise<{ skippedAlreadyConnected: string[]; webhookErrors: string[] }> {
    const skippedAlreadyConnected: string[] = [];
    const webhookErrors: string[] = [];

    try {
      // Get all businesses for this user
      const businesses = await this.leadsService.getBusinesses(userId, PlatformName.THUMBTACK);

      if (businesses.length === 0) {
        console.log('No businesses found to setup webhooks for');
        return { skippedAlreadyConnected, webhookErrors };
      }

      // Get the full credentials from stored platform (to save per-account)
      let credentials: { accessToken: string; refreshToken?: string; email?: string; expiresAt?: Date } | undefined;
      try {
        const platformCreds = await this.platformService.getCredentials(userId, PlatformName.THUMBTACK);
        credentials = {
          accessToken: platformCreds.accessToken,
          refreshToken: platformCreds.refreshToken,
          email: platformCreds.email,
          expiresAt: platformCreds.expiresAt,
        };
        console.log(`Got credentials for saving per-account (email: ${credentials.email || 'none'}, expires: ${credentials.expiresAt || 'unknown'})`);
      } catch (err) {
        console.warn('Could not fetch credentials:', err.message);
      }

      // Setup webhook and save account for each business
      for (const business of businesses) {
        try {
          // Check if current user is an admin (for testing purposes, admins can connect same business to multiple accounts)
          const currentUser = await this.platformService.getUserById(userId);
          const isAdmin = currentUser?.role === 'ADMIN';

          // Check if this business already has an active webhook (from any user)
          const existingAccount = await this.platformService.getAccountByBusinessId(
            PlatformName.THUMBTACK,
            business.businessID,
          );

          if (existingAccount && existingAccount.webhookId) {
            // Check if this account belongs to a DIFFERENT user
            if (existingAccount.userId !== userId) {
              // Block non-admin users from connecting business that belongs to another user
              if (!isAdmin) {
                console.error(`Business ${business.name} (${business.businessID}) already connected to a different user`);
                throw new BadRequestException(
                  `Thumbtack business "${business.name}" is already connected to another account. ` +
                  `Each Thumbtack business can only be connected to one LeadBridge account. ` +
                  `Please use a different Thumbtack business or log in with the account that originally connected this business.`
                );
              }
              // Admin users can proceed - they'll get a new webhook for testing
              console.log(`Admin user bypassing webhook conflict for business ${business.name} (${business.businessID})`);
            } else {
              // Same user re-authenticating — update credentials and refresh the webhook
              console.log(`Business ${business.name} (${business.businessID}) - same user reconnecting, refreshing webhook`);
              if (credentials) {
                await this.platformService.updateAccountCredentials(
                  existingAccount.id,
                  credentials,
                );
                console.log(`Updated credentials for existing account: ${business.name}`);
              }
              // Re-register the webhook so it is active with fresh credentials
              await this.platformService.setupThumbtackWebhook(userId, business.businessID);
              console.log(`Webhook refreshed for business: ${business.name} (${business.businessID})`);
              continue;
            }
          }

          // First save the account WITH credentials (so setupThumbtackWebhook can update it with webhookId)
          await this.platformService.saveAccount(
            userId,
            PlatformName.THUMBTACK,
            business.businessID,
            business.name,
            business.imageURL,
            credentials?.email, // Email from ID token
            credentials, // Store credentials per-account for multi-login support
          );
          console.log(`Account saved for business: ${business.name} (email: ${credentials?.email || 'none'}, with credentials: ${!!credentials})`);

          // Then setup webhook (this will update the saved account with webhookId)
          await this.platformService.setupThumbtackWebhook(userId, business.businessID);
          console.log(`Webhook setup successfully for business: ${business.name} (${business.businessID})`);
        } catch (err) {
          // Re-throw BadRequestException (account conflict) - these should fail the OAuth flow
          if (err instanceof BadRequestException) {
            throw err;
          }
          // Track webhook setup failures so the redirect URL can surface them
          const errMsg = err.message || 'Unknown error';
          console.error(`[autoSetupWebhooks] FAILED to setup webhook for business ${business.businessID} (${business.name}): ${errMsg}`);
          webhookErrors.push(`${business.name}: ${errMsg}`);
        }
      }
    } catch (err) {
      // Re-throw BadRequestException (account conflict) - these should fail the OAuth flow
      if (err instanceof BadRequestException) {
        throw err;
      }
      console.error('[autoSetupWebhooks] Fatal error:', err.message);
      // Don't throw - OAuth succeeded, webhooks are just a bonus
    }

    console.log(`[autoSetupWebhooks] Done. skipped=${skippedAlreadyConnected.length}, errors=${webhookErrors.length}`);
    return { skippedAlreadyConnected, webhookErrors };
  }

  // ==========================================
  // OAuth Flow
  // ==========================================

  @Get('auth/url')
  async getAuthUrl(@CurrentUser() user: any) {
    const authUrl = await this.platformService.getAuthUrl(user.id, PlatformName.THUMBTACK);
    return { authUrl };
  }

  @Public()
  @Get('auth/callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Query('error_description') errorDescription: string,
    @Res() res: Response,
  ) {
    // Handle OAuth errors - redirect to frontend with error
    if (error) {
      const errorParams = new URLSearchParams({
        error,
        error_description: errorDescription || 'OAuth authorization failed',
      });
      return res.redirect(`${this.frontendUrl}/dashboard?${errorParams.toString()}`);
    }

    if (!code) {
      return res.redirect(`${this.frontendUrl}/dashboard?error=missing_code&error_description=Authorization code is required`);
    }

    try {
      // Get userId from state (stored during auth URL generation)
      const userId = await this.platformService.getUserIdFromState(state);

      if (!userId) {
        return res.redirect(`${this.frontendUrl}/dashboard?error=invalid_state&error_description=OAuth state expired or invalid. Please try connecting again.`);
      }

      // Exchange code for tokens
      await this.platformService.handleCallback(userId, PlatformName.THUMBTACK, code);

      // Auto-setup webhooks for all businesses
      const { skippedAlreadyConnected, webhookErrors } = await this.autoSetupWebhooks(userId);

      // Build redirect URL with appropriate message
      const params = new URLSearchParams({ connected: 'thumbtack' });

      // If some accounts were skipped because they already have webhooks
      if (skippedAlreadyConnected.length > 0) {
        params.set('warning', 'already_connected');
        params.set('skipped_accounts', skippedAlreadyConnected.join(', '));
      }

      // If webhook setup failed for any business, signal the frontend to retry
      if (webhookErrors.length > 0) {
        console.error('[ThumbtackController] Webhook setup failed after OAuth:', webhookErrors);
        params.set('webhook_error', webhookErrors[0]);
        params.set('reconnect', '1'); // Auto-open reconnect modal on dashboard
      }

      const redirectUrl = `${this.frontendUrl}/dashboard?${params.toString()}`;
      console.log('[ThumbtackController] Redirecting to:', redirectUrl);
      return res.redirect(redirectUrl);
    } catch (err) {
      const errorParams = new URLSearchParams({
        error: 'oauth_failed',
        error_description: err.message || 'Failed to complete OAuth',
      });
      return res.redirect(`${this.frontendUrl}/dashboard?${errorParams.toString()}`);
    }
  }

  @Post('auth/connect')
  async connect(@CurrentUser() user: any, @Body('code') code: string) {
    if (!code) {
      throw new BadRequestException('Authorization code is required');
    }

    await this.platformService.handleCallback(user.id, PlatformName.THUMBTACK, code);

    return {
      success: true,
      message: 'Thumbtack account connected successfully',
    };
  }

  @Post('auth/disconnect')
  async disconnect(@CurrentUser() user: any) {
    await this.platformService.disconnect(user.id, PlatformName.THUMBTACK);

    return {
      success: true,
      message: 'Thumbtack account disconnected',
    };
  }

  // ==========================================
  // User Info
  // ==========================================

  /**
   * Get the current Thumbtack user info
   * Useful for debugging connection issues
   */
  @Get('user')
  async getCurrentUser(@CurrentUser() user: any) {
    const credentials = await this.platformService.getCredentials(user.id, PlatformName.THUMBTACK);
    const adapter = this.platformService['platformFactory'].getAdapter(PlatformName.THUMBTACK) as any;
    const thumbtackUser = await adapter.getCurrentUser(credentials);

    return {
      platform: PlatformName.THUMBTACK,
      user: thumbtackUser,
      tokenScope: credentials.scope,
      tokenExpiresAt: credentials.expiresAt,
    };
  }

  // ==========================================
  // Businesses & Webhook Setup
  // ==========================================

  @Get('businesses')
  async getBusinesses(@CurrentUser() user: any) {
    try {
      const businesses = await this.leadsService.getBusinesses(user.id, PlatformName.THUMBTACK);

      return {
        platform: PlatformName.THUMBTACK,
        count: businesses.length,
        businesses,
      };
    } catch (error) {
      // Token expired / refresh failed — tell frontend to re-auth instead of 500
      if (error.message?.includes('refresh') || error.message?.includes('expired') || error.message?.includes('not connected')) {
        return {
          platform: PlatformName.THUMBTACK,
          count: 0,
          businesses: [],
          needsReauth: true,
        };
      }
      throw error;
    }
  }

  /**
   * Setup webhook for a business to receive leads
   * This registers your webhook URL with Thumbtack so you receive NegotiationCreatedV4 events
   * Also saves the account for multi-account switching
   */
  @Post('businesses/:businessId/webhooks/setup')
  async setupWebhook(
    @CurrentUser() user: any,
    @Param('businessId') businessId: string,
    @Body('businessName') businessName?: string,
    @Body('imageUrl') imageUrl?: string,
    @Body('emailHint') emailHint?: string,
  ) {
    const result = await this.platformService.setupThumbtackWebhook(user.id, businessId);

    // Auto-save account for multi-account switching
    if (businessName) {
      await this.platformService.saveAccount(
        user.id,
        PlatformName.THUMBTACK,
        businessId,
        businessName,
        imageUrl,
        emailHint,
      );
    }

    return {
      success: true,
      message: 'Webhook registered successfully',
      ...result,
    };
  }

  /**
   * Get registered webhooks for a business
   */
  @Get('businesses/:businessId/webhooks')
  async getWebhooks(
    @CurrentUser() user: any,
    @Param('businessId') businessId: string,
  ) {
    const webhooks = await this.platformService.getThumbtackWebhooks(user.id, businessId);

    return {
      platform: PlatformName.THUMBTACK,
      businessId,
      count: webhooks.length,
      webhooks,
    };
  }

  // ==========================================
  // Leads (delivered via webhooks)
  // ==========================================

  @Get('leads')
  async getLeads(
    @CurrentUser() user: any,
    @Query('limit') limit?: number,
    @Query('since') since?: string,
  ) {
    const options: any = {};

    if (limit) {
      options.limit = parseInt(limit.toString(), 10);
    }

    if (since) {
      options.since = new Date(since);
    }

    const leads = await this.leadsService.getLeads(user.id, PlatformName.THUMBTACK, options);

    return {
      platform: PlatformName.THUMBTACK,
      count: leads.length,
      leads,
      note: 'Thumbtack delivers leads via webhooks. This returns leads stored from webhook events.',
    };
  }

  @Get('leads/:id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.getLead(user.id, id);
  }

  /**
   * Get messages for a lead/negotiation
   */
  @Get('leads/:id/messages')
  async getMessages(@CurrentUser() user: any, @Param('id') id: string) {
    console.log(`[ThumbtackController] getMessages called - userId: ${user.id}, leadId: ${id}`);
    try {
      const messages = await this.leadsService.getMessages(user.id, id);
      console.log(`[ThumbtackController] getMessages success - ${messages.length} messages`);

      return {
        platform: PlatformName.THUMBTACK,
        leadId: id,
        count: messages.length,
        messages,
      };
    } catch (error) {
      console.error(`[ThumbtackController] getMessages error:`, error.message);
      console.error(`[ThumbtackController] Full error:`, error);
      throw error;
    }
  }

  @Post('leads/:id/message')
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('message') message: string,
  ) {
    if (!message) {
      throw new BadRequestException('Message is required');
    }

    const result = await this.leadsService.sendMessage(user.id, id, message);

    return {
      success: true,
      message: 'Message sent successfully',
      data: result,
    };
  }

  @Post('leads/:id/quote')
  async sendQuote(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('description') description?: string,
  ) {
    if (!amount) {
      throw new BadRequestException('Quote amount is required');
    }

    const result = await this.leadsService.sendQuote(user.id, id, amount, description);

    return {
      success: true,
      message: 'Quote sent successfully',
      data: result,
    };
  }

  // ==========================================
  // Manual Lead Import (for existing leads)
  // ==========================================

  /**
   * Import an existing lead/negotiation by ID from Thumbtack
   * Use this to import leads that existed before webhook registration
   * @param accountId - Optional saved account ID to use for import (determines which business the negotiation belongs to)
   */
  @Post('negotiations/:negotiationId/import')
  async importNegotiation(
    @CurrentUser() user: any,
    @Param('negotiationId') negotiationId: string,
    @Body('accountId') accountId?: string,
  ) {
    try {
      const { lead, isNew } = await this.leadsService.importThumbtackNegotiation(user.id, negotiationId, accountId);

      return {
        success: true,
        isNew,
        message: isNew ? 'Negotiation imported successfully' : 'Negotiation already exists (updated)',
        lead,
      };
    } catch (err: any) {
      // Check if it's a login/token error and return a clear message
      const errMsg = err.message?.toLowerCase() || '';
      console.log(`[ThumbtackController] Import error - message: "${err.message}"`);

      if (errMsg.includes('login required') ||
          errMsg.includes('session expired') ||
          errMsg.includes('reconnect') ||
          errMsg.includes('token') ||
          errMsg.includes('unauthorized') ||
          errMsg.includes('invalid') ||
          errMsg.includes('not active')) {
        console.log(`[ThumbtackController] Detected auth error, throwing BadRequestException`);
        throw new BadRequestException(err.message);
      }
      // Re-throw other errors
      console.log(`[ThumbtackController] Not an auth error, re-throwing`);
      throw err;
    }
  }

  /**
   * Import multiple negotiations at once
   */
  @Post('negotiations/import-batch')
  async importNegotiations(
    @CurrentUser() user: any,
    @Body('negotiationIds') negotiationIds: string[],
    @Body('accountId') accountId?: string,
  ) {
    if (!negotiationIds || !Array.isArray(negotiationIds) || negotiationIds.length === 0) {
      throw new BadRequestException('negotiationIds array is required');
    }

    const results = await this.leadsService.importThumbtackNegotiations(user.id, negotiationIds, accountId);

    return {
      success: true,
      message: `Imported ${results.imported} of ${negotiationIds.length} negotiations`,
      ...results,
    };
  }

  // ==========================================
  // Saved Accounts (for multi-account switching)
  // ==========================================

  /**
   * Get all saved Thumbtack accounts for switching
   */
  @Get('saved-accounts')
  @Header('Cache-Control', 'no-store')
  async getSavedAccounts(@CurrentUser() user: any) {
    const accounts = await this.platformService.getSavedAccounts(user.id, PlatformName.THUMBTACK);

    return {
      platform: PlatformName.THUMBTACK,
      count: accounts.length,
      accounts,
    };
  }

  /**
   * Manually sync saved accounts from existing leads
   * Use this once to backfill accounts that existed before auto-save
   */
  @Post('saved-accounts/sync-from-leads')
  async syncSavedAccountsFromLeads(@CurrentUser() user: any) {
    const { synced } = await this.platformService.syncSavedAccountsFromLeads(user.id, PlatformName.THUMBTACK);

    return {
      success: true,
      message: `Synced ${synced} accounts from leads`,
      synced,
    };
  }

  /**
   * Save a Thumbtack account for later switching
   */
  @Post('saved-accounts')
  async saveAccount(
    @CurrentUser() user: any,
    @Body('businessId') businessId: string,
    @Body('businessName') businessName: string,
    @Body('imageUrl') imageUrl?: string,
    @Body('emailHint') emailHint?: string,
  ) {
    if (!businessId || !businessName) {
      throw new BadRequestException('businessId and businessName are required');
    }

    await this.platformService.saveAccount(
      user.id,
      PlatformName.THUMBTACK,
      businessId,
      businessName,
      imageUrl,
      emailHint,
    );

    return {
      success: true,
      message: 'Account saved successfully',
    };
  }

  /**
   * Update a saved account (e.g., email hint)
   */
  @Patch('saved-accounts/:id')
  async updateSavedAccount(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('emailHint') emailHint?: string,
  ) {
    await this.platformService.updateSavedAccount(user.id, id, { emailHint });

    return {
      success: true,
      message: 'Account updated successfully',
    };
  }

  /**
   * Get account health/diagnostics for the current user's own account.
   * Returns notification issues and connection status without requiring admin access.
   */
  @Get('saved-accounts/:id/health')
  async getAccountHealth(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id, userId: user.id },
      select: { id: true, businessId: true, businessName: true, webhookId: true, userId: true },
    });

    if (!account) {
      return {
        healthy: true,
        issues: [],
        notificationIssues: [],
        platform: { connected: false },
        account: { hasWebhook: false },
        notifications: { settingsExist: false, settingsEnabled: false, hasSigcoreApiKey: false, totalRules: 0, newLeadRules: 0, customerReplyRules: 0 },
        automation: { totalRules: 0, rules: [] },
        recentLogs: [],
      };
    }

    const platformConnection = await this.prisma.platform.findFirst({
      where: { platformName: 'thumbtack', userId: user.id, connected: true },
      select: { id: true, externalBusinessId: true, connected: true },
    });

    const notifSettings = await this.prisma.notificationSettings.findUnique({
      where: { savedAccountId: id },
      include: {
        notificationRules: {
          select: { id: true, name: true, triggerType: true, toPhone: true, fromPhone: true, enabled: true, sendToCustomer: true },
        },
      },
    });

    // Automation rules
    const automationRules = await this.prisma.automationRule.findMany({
      where: { savedAccountId: id, enabled: true },
      select: { id: true, name: true, triggerType: true },
    });

    // Recent notification logs
    const recentLogs = await this.prisma.notificationLog.findMany({
      where: {
        notificationSettingsId: notifSettings?.id,
        createdAt: { gte: new Date(Date.now() - 86400000) },
      },
      select: { id: true, status: true, ruleName: true, error: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    const connectionIssues: string[] = [];
    if (!platformConnection) connectionIssues.push('No active Thumbtack connection found for this user');
    if (!account.webhookId) connectionIssues.push('No webhook registered for this account');

    // Check notification health based on what actually matters for SMS delivery.
    // Mirror the actual sending fallback chain:
    //   fromPhone: rule.fromPhone → settings.sigcoreFromPhone → pool phone assignment
    //   toPhone:   rule.toPhone   → settings.destinationPhone
    const notificationIssues: string[] = [];
    const allNewLeadRules = (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'new_lead');
    const enabledNewLeadRules = allNewLeadRules.filter((r: any) => r.enabled);
    if (allNewLeadRules.length === 0) {
      notificationIssues.push('No "new_lead" SMS rules configured');
    } else if (enabledNewLeadRules.length === 0) {
      notificationIssues.push('Lead alert rule exists but is disabled — toggle it on in Lead Alerts');
    } else {
      // Check if at least ONE enabled rule can successfully fire.
      // Each rule fires independently — one working rule is enough for SMS delivery.
      const settingsFromPhone = notifSettings?.sigcoreFromPhone;
      const settingsDestPhone = notifSettings?.destinationPhone;

      const hasWorkingRule = enabledNewLeadRules.some((r: any) => {
        const hasTo = r.sendToCustomer || r.toPhone || settingsDestPhone;
        const hasFrom = r.fromPhone || settingsFromPhone;
        return hasTo && hasFrom;
      });

      if (!hasWorkingRule) {
        // No rule has both phones — check which piece is missing
        const anyHasTo = enabledNewLeadRules.some((r: any) => r.sendToCustomer || r.toPhone || settingsDestPhone);
        const anyHasFrom = enabledNewLeadRules.some((r: any) => r.fromPhone || settingsFromPhone);

        if (!anyHasFrom) {
          // Last fallback: check for admin-assigned pool phone
          const poolAssignment = await this.prisma.phonePoolAssignment.findFirst({
            where: { userId: account.userId, phonePool: { status: { not: 'RELEASED' } } },
            include: { phonePool: { select: { phoneNumber: true } } },
            orderBy: { assignedAt: 'desc' },
          });
          if (poolAssignment?.phonePool?.phoneNumber) {
            // Pool phone covers fromPhone — recheck with that
            if (anyHasTo) {
              // At least one rule has toPhone + pool provides fromPhone → working
            } else {
              notificationIssues.push('Lead alert rule is missing a destination phone number');
            }
          } else {
            if (!anyHasTo) notificationIssues.push('Lead alert rule is missing a destination phone number');
            notificationIssues.push('Lead alert rule is missing a sender phone number');
          }
        } else {
          // Has fromPhone but no toPhone on any rule
          notificationIssues.push('Lead alert rule is missing a destination phone number');
        }
      }
    }

    const healthy = connectionIssues.length === 0;

    // Diagnostic log — track exactly what the health check finds
    console.log(`[Health] account=${account.businessName} (${id}) | ` +
      `settings=${!!notifSettings} enabled=${notifSettings?.enabled} sigcoreFromPhone=${!!notifSettings?.sigcoreFromPhone} destPhone=${!!notifSettings?.destinationPhone} | ` +
      `allRules=${notifSettings?.notificationRules?.length || 0} newLeadAll=${allNewLeadRules.length} newLeadEnabled=${enabledNewLeadRules.length} | ` +
      `rules=${JSON.stringify(allNewLeadRules.map((r: any) => ({ name: r.name, enabled: r.enabled, fromPhone: !!r.fromPhone, toPhone: !!r.toPhone, sendToCustomer: r.sendToCustomer })))} | ` +
      `connIssues=${JSON.stringify(connectionIssues)} notifIssues=${JSON.stringify(notificationIssues)}`);

    return {
      account: {
        id: account.id,
        businessId: account.businessId,
        businessName: account.businessName,
        hasWebhook: !!account.webhookId,
      },
      platform: {
        connected: !!platformConnection,
        externalBusinessId: platformConnection?.externalBusinessId || null,
      },
      notifications: {
        settingsExist: !!notifSettings,
        settingsEnabled: notifSettings?.enabled ?? false,
        hasSigcoreApiKey: !!notifSettings?.sigcoreApiKey,
        totalRules: notifSettings?.notificationRules?.length || 0,
        newLeadRules: enabledNewLeadRules.length,
        customerReplyRules: (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'customer_reply' && r.enabled).length,
      },
      automation: {
        totalRules: automationRules.length,
        rules: automationRules.map(r => ({ name: r.name, triggerType: r.triggerType })),
      },
      recentLogs: recentLogs.map(l => ({
        status: l.status,
        ruleName: l.ruleName,
        error: l.error,
        createdAt: l.createdAt,
      })),
      healthy,
      issues: [...connectionIssues, ...notificationIssues],
      notificationIssues,
    };
  }

  /**
   * Disconnect webhooks for a saved account
   * Returns detailed status about what happened (success, warnings, errors)
   */
  @Post('saved-accounts/:id/disconnect')
  async disconnectAccountWebhook(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const result = await this.platformService.disconnectAccountWebhook(user.id, id);

    return {
      success: result.success,
      webhookDeleted: result.webhookDeleted,
      message: result.webhookDeleted
        ? 'Webhook disconnected successfully'
        : 'Webhook removed locally but may still be active on Thumbtack',
      ...(result.errorCode && { errorCode: result.errorCode }),
      ...(result.errorMessage && { errorMessage: result.errorMessage }),
      ...(result.warning && { warning: result.warning }),
    };
  }

  /**
   * Reconnect webhooks for a saved account
   */
  @Post('saved-accounts/:id/reconnect')
  async reconnectAccountWebhook(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    try {
      const result = await this.platformService.reconnectAccountWebhook(user.id, id);
      return {
        success: true,
        message: 'Webhook reconnected',
        webhookId: result.webhookId,
      };
    } catch (err: any) {
      const errMsg = (err.message || '').toLowerCase();
      let errorCode: string;
      if (errMsg.includes('expired') || errMsg.includes('token') || errMsg.includes('unauthorized') || errMsg.includes('authentication')) {
        errorCode = 'token_expired';
      } else if (errMsg.includes('permission') || errMsg.includes('access') || errMsg.includes('does not have access')) {
        errorCode = 'token_revoked';
      } else {
        errorCode = 'unknown';
      }
      throw new HttpException({ message: err.message, errorCode }, HttpStatus.UNPROCESSABLE_ENTITY);
    }
  }

  /**
   * Remove a saved account and optionally its leads
   */
  @Delete('saved-accounts/:id')
  async removeSavedAccount(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('deleteLeads') deleteLeads?: string,
  ) {
    const shouldDeleteLeads = deleteLeads === 'true';
    const result = await this.platformService.removeSavedAccount(user.id, id, shouldDeleteLeads);

    return {
      success: true,
      message: shouldDeleteLeads
        ? `Account and ${result.deletedLeads} leads removed`
        : 'Account removed (leads kept)',
      deletedLeads: result.deletedLeads,
    };
  }

  /**
   * Validate token for a saved account
   * Use this before importing to check if re-login is needed
   */
  @Get('saved-accounts/:id/validate-token')
  async validateAccountToken(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const result = await this.platformService.validateAccountToken(user.id, id);

    return {
      valid: result.valid,
      ...(result.reason && { reason: result.reason }),
    };
  }
}
