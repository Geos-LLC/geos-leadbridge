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
  Logger,
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
import { parseAccountScope } from '../../common/account-scope/account-scope.util';
import { ConversationRuntimeService } from '../../conversation-context/conversation-runtime.service';

@Controller('v1/thumbtack')
@UseGuards(JwtAuthGuard)
export class ThumbtackController {
  private readonly logger = new Logger(ThumbtackController.name);
  private readonly frontendUrl: string;

  constructor(
    private platformService: PlatformService,
    private platformFactory: PlatformFactory,
    private leadsService: LeadsService,
    private configService: ConfigService,
    private prisma: PrismaService,
    private conversationRuntime: ConversationRuntimeService,
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
      this.logger.log(`[oauth-trace] autoSetupWebhooks calling leadsService.getBusinesses user=${userId}`);
      const businesses = await this.leadsService.getBusinesses(userId, PlatformName.THUMBTACK);
      this.logger.log(`[oauth-trace] autoSetupWebhooks getBusinesses returned count=${businesses.length} ids=${businesses.map((b: any) => b?.businessID ?? '?').join(',')} user=${userId}`);

      if (businesses.length === 0) {
        this.logger.warn(`[oauth-trace] autoSetupWebhooks NO_BUSINESSES TT returned empty list for user=${userId} — credentials are valid but the token's user identity has no businesses attached`);
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
        this.logger.log(`[oauth-trace] autoSetupWebhooks LOOP business=${business?.businessID ?? '?'} name="${business?.name ?? '?'}" user=${userId}`);
        try {
          // Check if current user is an admin (for testing purposes, admins can connect same business to multiple accounts)
          const currentUser = await this.platformService.getUserById(userId);
          const isAdmin = currentUser?.role === 'ADMIN';

          // Check if another user already owns this business
          const otherUserAccount = await this.platformService.getAccountByBusinessIdExcludingUser(
            PlatformName.THUMBTACK,
            business.businessID,
            userId,
          );

          if (otherUserAccount) {
            this.logger.warn(`[oauth-trace] autoSetupWebhooks business=${business.businessID} OWNED_BY_OTHER otherUserId=${otherUserAccount.userId} isAdmin=${isAdmin}`);
            if (!isAdmin) {
              console.error(`Business ${business.name} (${business.businessID}) already connected to user ${otherUserAccount.userId}`);
              // Pass structured payload so handleCallback can emit a specific
              // error code (business_already_connected) for the frontend to
              // elevate to a blocking modal instead of an easily-missed banner.
              throw new BadRequestException({
                code: 'business_already_connected',
                businessName: business.name,
                businessId: business.businessID,
                message:
                  `This Thumbtack business "${business.name}" is already connected to another LeadBridge account. ` +
                  `Each business can only be linked to one account. ` +
                  `If you own this business, please contact support or log in with the original account.`,
              });
            }
            console.log(`Admin user bypassing ownership conflict for business ${business.name} (${business.businessID})`);
          }

          // Check if same user is reconnecting
          const ownAccount = await this.platformService.getAccountByBusinessId(
            PlatformName.THUMBTACK,
            business.businessID,
          );

          if (ownAccount && ownAccount.userId === userId) {
            this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} EXISTING_ACCOUNT accountId=${ownAccount.id} — refreshing creds + webhook`);
            console.log(`Business ${business.name} (${business.businessID}) - same user reconnecting, refreshing webhook`);
            if (credentials) {
              await this.platformService.updateAccountCredentials(
                ownAccount.id,
                credentials,
              );
              console.log(`Updated credentials for existing account: ${business.name}`);
            }
            this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} calling setupThumbtackWebhook (existing path)`);
            await this.platformService.setupThumbtackWebhook(userId, business.businessID);
            this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} setupThumbtackWebhook OK (existing path)`);
            // Clear stale token errors — fresh OAuth means token is alive
            await this.prisma.systemErrorLog.updateMany({
              where: {
                category: 'token_refresh',
                resolved: false,
                OR: [
                  { accountId: ownAccount.id },
                  { accountName: business.name, userId },
                  { accountName: null, userId, message: { contains: 'thumbtack', mode: 'insensitive' } },
                ],
              },
              data: { resolved: true },
            }).catch(() => {});
            console.log(`Webhook refreshed for business: ${business.name} (${business.businessID})`);
            continue;
          }

          // First save the account WITH credentials (so setupThumbtackWebhook can update it with webhookId)
          this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} NEW_ACCOUNT calling saveAccount`);
          await this.platformService.saveAccount(
            userId,
            PlatformName.THUMBTACK,
            business.businessID,
            business.name,
            business.imageURL,
            credentials?.email, // Email from ID token
            credentials, // Store credentials per-account for multi-login support
          );
          this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} saveAccount OK`);
          console.log(`Account saved for business: ${business.name} (email: ${credentials?.email || 'none'}, with credentials: ${!!credentials})`);

          // Then setup webhook (this will update the saved account with webhookId)
          this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} calling setupThumbtackWebhook (new path)`);
          await this.platformService.setupThumbtackWebhook(userId, business.businessID);
          this.logger.log(`[oauth-trace] autoSetupWebhooks business=${business.businessID} setupThumbtackWebhook OK (new path)`);
          console.log(`Webhook setup successfully for business: ${business.name} (${business.businessID})`);
        } catch (err) {
          this.logger.error(`[oauth-trace] autoSetupWebhooks business=${business?.businessID ?? '?'} ERROR errName=${err?.constructor?.name ?? 'unknown'} msg=${err?.message ?? 'unknown'}`);
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
      this.logger.error(`[oauth-trace] autoSetupWebhooks FATAL errName=${err?.constructor?.name ?? 'unknown'} msg=${err?.message ?? 'unknown'}`);
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
  async getAuthUrl(@CurrentUser() user: any, @Query('forceLogin') forceLogin?: string) {
    // [oauth-trace] — diagnostic, enables full-path tracing from
    // "user clicks Connect" → frontend hits /auth/url → callback fires →
    // businesses iterate. Logs presence/absence + lengths/IDs only, never
    // tokens or full URLs.
    this.logger.log(`[oauth-trace] getAuthUrl ENTRY user=${user?.id ?? 'NULL'} forceLogin=${forceLogin === 'true'}`);
    const authUrl = await this.platformService.getAuthUrl(user.id, PlatformName.THUMBTACK, forceLogin === 'true');
    this.logger.log(`[oauth-trace] getAuthUrl returning urlLen=${authUrl?.length ?? 0} user=${user?.id ?? 'NULL'}`);
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
    // [oauth-trace] callback ENTRY — log every query param's presence
    // (not the values themselves; the code+state are sensitive).
    this.logger.log(
      `[oauth-trace] callback ENTRY code=${code ? 'present' : 'MISSING'} ` +
      `state=${state ? `present(len=${state.length})` : 'MISSING'} ` +
      `error=${error || 'none'} errorDescription=${errorDescription || 'none'}`,
    );

    // Handle OAuth errors - redirect to frontend with error
    if (error) {
      this.logger.warn(`[oauth-trace] callback OAuth provider returned error=${error} description=${errorDescription || 'none'}`);
      const errorParams = new URLSearchParams({
        error,
        error_description: errorDescription || 'OAuth authorization failed',
      });
      return res.redirect(`${this.frontendUrl}/overview?${errorParams.toString()}`);
    }

    if (!code) {
      this.logger.warn(`[oauth-trace] callback MISSING_CODE — redirecting with error`);
      return res.redirect(`${this.frontendUrl}/overview?error=missing_code&error_description=Authorization code is required`);
    }

    try {
      // Get userId from state (stored during auth URL generation)
      const userId = await this.platformService.getUserIdFromState(state);
      this.logger.log(`[oauth-trace] callback state resolved userId=${userId ?? 'NULL'}`);

      if (!userId) {
        this.logger.warn(`[oauth-trace] callback INVALID_STATE — state token expired or unknown`);
        return res.redirect(`${this.frontendUrl}/overview?error=invalid_state&error_description=OAuth state expired or invalid. Please try connecting again.`);
      }

      // Exchange code for tokens
      this.logger.log(`[oauth-trace] callback exchanging code → tokens user=${userId}`);
      await this.platformService.handleCallback(userId, PlatformName.THUMBTACK, code);
      this.logger.log(`[oauth-trace] callback code exchange COMPLETE user=${userId}`);

      // Auto-setup webhooks for all businesses
      this.logger.log(`[oauth-trace] callback calling autoSetupWebhooks user=${userId}`);
      const { skippedAlreadyConnected, webhookErrors } = await this.autoSetupWebhooks(userId);
      this.logger.log(`[oauth-trace] callback autoSetupWebhooks returned skipped=${skippedAlreadyConnected.length} errors=${webhookErrors.length} user=${userId}`);

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

      const redirectUrl = `${this.frontendUrl}/overview?${params.toString()}`;
      console.log('[ThumbtackController] Redirecting to:', redirectUrl);
      this.logger.log(`[oauth-trace] callback SUCCESS redirecting paramKeys=${Array.from(params.keys()).join(',')}`);
      return res.redirect(redirectUrl);
    } catch (err) {
      this.logger.error(`[oauth-trace] callback CAUGHT_ERROR message=${err?.message ?? 'unknown'} name=${err?.constructor?.name ?? 'unknown'}`);
      // If the error carries a structured payload (e.g. BadRequestException
      // thrown by autoSetupWebhooks for the duplicate-business case), surface
      // its `code` so the frontend can render a blocking modal instead of an
      // inline banner. The shape comes from `new BadRequestException({code,...})`.
      let errCode = 'oauth_failed';
      let errDescription = err?.message || 'Failed to complete OAuth';
      let claimedBusinessName: string | undefined;
      try {
        const response = typeof err?.getResponse === 'function' ? err.getResponse() : err?.response;
        if (response && typeof response === 'object') {
          if (typeof response.code === 'string') errCode = response.code;
          if (typeof response.message === 'string') errDescription = response.message;
          if (typeof response.businessName === 'string') claimedBusinessName = response.businessName;
        }
      } catch {
        /* ignore — fall through to defaults */
      }
      const errorParams = new URLSearchParams({
        error: errCode,
        error_description: errDescription,
      });
      if (claimedBusinessName) errorParams.set('claimed_business_name', claimedBusinessName);
      return res.redirect(`${this.frontendUrl}/overview?${errorParams.toString()}`);
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
    this.logger.log(`[oauth-trace] /auth/disconnect ENTRY user=${user?.id ?? 'NULL'}`);
    await this.platformService.disconnect(user.id, PlatformName.THUMBTACK);
    this.logger.log(`[oauth-trace] /auth/disconnect COMPLETE user=${user?.id ?? 'NULL'}`);
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

      // Flag businesses that are already owned by another user
      const enriched = await Promise.all(
        businesses.map(async (b: any) => {
          const otherAccount = await this.platformService.getAccountByBusinessIdExcludingUser(
            PlatformName.THUMBTACK,
            b.businessID,
            user.id,
          );
          return {
            ...b,
            ownedByOtherUser: !!otherAccount,
          };
        }),
      );

      return {
        platform: PlatformName.THUMBTACK,
        count: enriched.length,
        businesses: enriched,
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
    // Block if another user already owns this business
    const otherUserAccount = await this.platformService.getAccountByBusinessIdExcludingUser(
      PlatformName.THUMBTACK,
      businessId,
      user.id,
    );
    if (otherUserAccount) {
      const currentUser = await this.platformService.getUserById(user.id);
      if (currentUser?.role !== 'ADMIN') {
        throw new BadRequestException(
          `This Thumbtack business is already connected to another LeadBridge account. ` +
          `Each business can only be linked to one account. ` +
          `If you own this business, please contact support or log in with the original account.`
        );
      }
    }

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

  /**
   * DEPRECATED CROSS-PLATFORM BEHAVIOR — see header `X-LeadBridge-Deprecated`.
   *
   * Despite living under `/v1/thumbtack`, the `scope=all` branch of this
   * endpoint currently serves a unified inbox (Thumbtack + Yelp merged) for
   * back-compat with the LB frontend Messages page. The platform-correct
   * cross-platform endpoint is `GET /v1/leads?scope=all`.
   *
   * Migration plan:
   *   1. (this commit) Add deprecation header + warn log on cross-platform
   *      branch. Behavior unchanged.
   *   2. Frontend `leadsApi.getLeads` migrates to `/v1/leads?scope=all`.
   *   3. External callers (Service Flow sync) migrate.
   *   4. Strip the Yelp merge — endpoint becomes Thumbtack-only.
   *
   * Account-scope contract:
   *   ?businessId=<id>   → only leads for that saved account (one platform —
   *                        no deprecation header, this branch is stable)
   *   ?scope=all         → CROSS-PLATFORM merge (deprecated; will become
   *                        Thumbtack-only). Header emitted to flag callers.
   *   neither            → 400
   *   both               → 400
   */
  @Get('leads')
  async getLeads(
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
    @Query('limit') limit?: number,
    @Query('since') since?: string,
    @Query('businessId') businessId?: string,
    @Query('scope') scope?: string,
  ) {
    const accountScope = parseAccountScope({ businessId, scope });

    const options: { limit?: number; since?: Date; businessId?: string; scope?: 'all' } = {};
    if (limit) options.limit = parseInt(limit.toString(), 10);
    if (since) options.since = new Date(since);

    if (accountScope.kind === 'account') {
      // Resolve businessId → savedAccount to discover which platform owns it.
      // A businessId is unique within a platform; calling the wrong adapter
      // would return zero leads or, worse, leak across platforms in some
      // future code path. Fail loud if the businessId doesn't belong to this
      // user — better than silently returning [].
      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: user.id, businessId: accountScope.businessId },
        select: { platform: true, businessId: true },
      });
      if (!account) {
        throw new BadRequestException(
          `businessId '${accountScope.businessId}' is not a saved account for this user`,
        );
      }
      const leads = await this.leadsService.getLeads(user.id, account.platform, {
        ...options,
        businessId: account.businessId!,
      });
      const enriched = await this.leadsService.enrichLeadsWithAccountInfo(user.id, leads);
      return { count: enriched.length, leads: enriched };
    }

    // ----- DEPRECATED cross-platform merge branch -----
    // Flag callers so we can drive the SF + frontend migration.
    res.setHeader('X-LeadBridge-Deprecated', 'cross-platform-merge');
    res.setHeader(
      'X-LeadBridge-Deprecation-Replacement',
      '/v1/leads?scope=all',
    );
    // Structured warn log — picked up by Loki, grep for this string to find
    // unmigrated callers via service_name + ip/userAgent.
    this.logger.warn(
      `[LeadBridge API Deprecated] endpoint=/v1/thumbtack/leads scope=all behavior=cross_platform_merge replacement=/v1/leads?scope=all userId=${user.id}`,
    );

    const unifiedOptions = { ...options, scope: 'all' as const };
    const [thumbtackLeads, yelpLeads] = await Promise.all([
      this.leadsService.getLeads(user.id, PlatformName.THUMBTACK, unifiedOptions),
      this.leadsService.getLeads(user.id, PlatformName.YELP, unifiedOptions).catch(() => []),
    ]);
    const leads = [...thumbtackLeads, ...yelpLeads].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const enriched = await this.leadsService.enrichLeadsWithAccountInfo(user.id, leads);

    return { count: enriched.length, leads: enriched };
  }

  @Get('leads/:id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.getLead(user.id, id);
  }

  /**
   * Get messages for a lead/negotiation.
   *
   * `?fresh=1` (or `?fresh=true`) bypasses the Redis cache for this call. The
   * frontend passes it on lead-click so the first paint after opening a lead is
   * never served from a 5-min-stale snapshot. Subsequent reads (without the
   * param) hit cache as usual.
   */
  @Get('leads/:id/messages')
  async getMessages(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('fresh') fresh?: string,
  ) {
    const skipCache = fresh === '1' || fresh === 'true';
    console.log(`[ThumbtackController] getMessages called - userId: ${user.id}, leadId: ${id}, skipCache: ${skipCache}`);
    try {
      const messages = await this.leadsService.getMessages(user.id, id, skipCache);
      console.log(`[ThumbtackController] getMessages success - ${messages.length} messages`);

      // V2 Review Mode (2026-06-12): piggyback the pending AI suggestion on the
      // existing messages payload so Lead Activity does not need a second RTT
      // per thread open. Cost is one ThreadContext.findUnique on the per-lead
      // hot path — negligible vs the messages list assembly. Returns null when
      // the lead has no thread yet or no draft is parked.
      let pendingAiSuggestion: Awaited<
        ReturnType<ConversationRuntimeService['getAiSuggestion']>
      > = null;
      try {
        const leadRow = await this.prisma.lead.findFirst({
          where: { id, userId: user.id },
          select: { threadId: true },
        });
        if (leadRow?.threadId) {
          pendingAiSuggestion = await this.conversationRuntime.getAiSuggestion(
            leadRow.threadId,
          );
        }
      } catch (e: any) {
        // Suggestion lookup never blocks the messages payload — Lead Activity
        // can still render the thread, the banner just won't appear this paint.
        console.warn(`[ThumbtackController] pendingAiSuggestion lookup failed for lead ${id}: ${e?.message ?? e}`);
      }

      return {
        platform: PlatformName.THUMBTACK,
        leadId: id,
        count: messages.length,
        messages,
        pendingAiSuggestion,
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

      if (err.message?.startsWith('THUMBTACK_SERVICE_DELETED')) {
        console.log(`[ThumbtackController] Thumbtack service deleted — skipping gracefully`);
        return {
          success: false,
          skipped: true,
          reason: 'service_deleted',
          message: 'Thumbtack service was deleted — negotiation skipped',
        };
      }

      // Cross-account skips: already-imported under a different SavedAccount
      // (DB hit, no API call) or Partner API 403 (token can't fetch this lead).
      // The leads.service has already marked the ThumbtackLeadId row
      // imported=true so it stops appearing as pending. Surface a soft-success
      // shape so the operator UI can render "skipped, belongs to other account"
      // instead of "failed".
      if (err?.code === 'THUMBTACK_OTHER_ACCOUNT' || err?.code === 'THUMBTACK_WRONG_SCOPE') {
        console.log(`[ThumbtackController] ${err.code} — skipping ${negotiationId}`);
        return {
          success: false,
          skipped: true,
          reason: err.code === 'THUMBTACK_OTHER_ACCOUNT' ? 'other_account' : 'wrong_scope',
          message: err.message,
          ownerBusinessName: err.ownerBusinessName ?? null,
        };
      }

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

  /**
   * PATCH /api/v1/thumbtack/leads/:thumbtackId/patch-details
   * Update a lead's details with data scraped from the Thumbtack page.
   * Called by the extension after scraping an individual lead page.
   */
  @Patch('leads/:thumbtackId/patch-details')
  async patchLeadDetails(
    @CurrentUser() user: any,
    @Param('thumbtackId') thumbtackId: string,
    @Body() body: { budget?: number; city?: string; state?: string; postcode?: string; message?: string },
  ) {
    return this.leadsService.patchLeadDetails(user.id, thumbtackId, body);
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
    @Body('agentPhoneOverride') agentPhoneOverride?: string | null,
    @Body('additionalAssociatePhones') additionalAssociatePhones?: Array<{ id?: string; phoneNumber: string; label?: string }>,
  ) {
    await this.platformService.updateSavedAccount(user.id, id, {
      emailHint,
      agentPhoneOverride,
      additionalAssociatePhones,
    });

    return {
      success: true,
      message: 'Account updated successfully',
    };
  }

  /**
   * Register the agent's phone as a Thumbtack associate phone for a business.
   * Allows the agent to call customers via Thumbtack proxy without an access code.
   */
  @Post('saved-accounts/:id/register-phone')
  async registerAssociatePhone(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const accounts = await this.platformService.getSavedAccounts(user.id, 'thumbtack');
    const account = accounts.find(a => a.id === id);
    if (!account) {
      throw new BadRequestException('Thumbtack account not found');
    }
    await this.platformService.syncAccountPhonesToThumbtack(user.id, account.businessId);
    return { success: true, message: 'Phones registered with Thumbtack' };
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
    console.log(`[health] getAccountHealth called for account ${id}, user ${user.id}`);
    const account = await this.prisma.savedAccount.findFirst({
      where: { id, userId: user.id },
      select: { id: true, businessId: true, businessName: true, webhookId: true, userId: true, platform: true },
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

    // NOTE: Platform.connected is a stale legacy flag (set to false on disconnect,
    // never re-set on per-account reconnect). Don't use it — webhookId on the
    // individual SavedAccount is the real connection signal.

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
    if (!account.webhookId) connectionIssues.push('No webhook registered — tap Reconnect to fix');

    // Check notification health based on what actually matters for SMS delivery.
    // Mirror the actual sending chain in sendNotificationWithRule:
    //   fromPhone: dedicated TenantPhoneNumber via resolveBotPhone → rule.fromPhone
    //   toPhone:   rule.toPhone → settings.destinationPhone
    const notificationIssues: string[] = [];
    const allNewLeadRules = (notifSettings?.notificationRules || []).filter((r: any) => r.triggerType === 'new_lead');
    const enabledNewLeadRules = allNewLeadRules.filter((r: any) => r.enabled);
    if (allNewLeadRules.length === 0) {
      notificationIssues.push('No "new_lead" SMS rules configured');
    } else if (enabledNewLeadRules.length === 0) {
      notificationIssues.push('Lead alert rule exists but is disabled — toggle it on in Lead Alerts');
    } else {
      const settingsDestPhone = notifSettings?.destinationPhone;

      const dedicatedPhone = await this.prisma.tenantPhoneNumber.findFirst({
        where: { userId: account.userId, status: 'ACTIVE', OR: [{ savedAccountId: account.id }, { savedAccountId: null }] },
        select: { phoneNumber: true },
      }) || await this.prisma.tenantPhoneNumber.findFirst({
        where: { userId: account.userId, status: 'ACTIVE' },
        select: { phoneNumber: true },
      });

      const hasWorkingRule = enabledNewLeadRules.some((r: any) => {
        const hasTo = r.sendToCustomer || r.toPhone || settingsDestPhone;
        const hasFrom = dedicatedPhone?.phoneNumber || r.fromPhone;
        return hasTo && hasFrom;
      });

      if (!hasWorkingRule) {
        const anyHasTo = enabledNewLeadRules.some((r: any) => r.sendToCustomer || r.toPhone || settingsDestPhone);
        const anyHasFrom = dedicatedPhone?.phoneNumber || enabledNewLeadRules.some((r: any) => r.fromPhone);

        if (!anyHasFrom) {
          if (!anyHasTo) notificationIssues.push('Lead alert rule is missing a destination phone number');
          notificationIssues.push('Lead alert rule is missing a sender phone number');
        } else {
          notificationIssues.push('Lead alert rule is missing a destination phone number');
        }
      }
    }

    // Token health is determined by tokenDead flag in getSavedAccounts (from SystemErrorLog).
    // No proactive API call here — too slow and causes race conditions.

    const healthy = connectionIssues.length === 0;

    // Diagnostic log — track exactly what the health check finds
    console.log(`[Health] account=${account.businessName} (${id}) | ` +
      `settings=${!!notifSettings} enabled=${notifSettings?.enabled} destPhone=${!!notifSettings?.destinationPhone} | ` +
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
        connected: !!account.webhookId,
        externalBusinessId: account.businessId || null,
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
    this.logger.log(`[oauth-trace] /saved-accounts/:id/disconnect ENTRY accountId=${id} user=${user?.id ?? 'NULL'}`);
    const result = await this.platformService.disconnectAccountWebhook(user.id, id);
    this.logger.log(`[oauth-trace] /saved-accounts/:id/disconnect COMPLETE accountId=${id} success=${result.success} webhookDeleted=${result.webhookDeleted} errorCode=${result.errorCode ?? 'none'}`);
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
