/**
 * Thumbtack Controller
 * Handles Thumbtack-specific OAuth and API endpoints
 */

import {
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
  Res,
  Body,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PlatformService } from '../platform.service';
import { LeadsService } from '../../leads/leads.service';
import { PlatformName } from '../../common/interfaces/platform.interface';

@Controller('v1/thumbtack')
@UseGuards(JwtAuthGuard)
export class ThumbtackController {
  private readonly frontendUrl: string;

  constructor(
    private platformService: PlatformService,
    private leadsService: LeadsService,
    private configService: ConfigService,
  ) {
    this.frontendUrl = this.configService.get<string>('frontendUrl') || 'http://localhost:5173';
  }

  /**
   * Automatically setup webhooks for all businesses after OAuth connection
   */
  private async autoSetupWebhooks(userId: string): Promise<void> {
    try {
      // Get all businesses for this user
      const businesses = await this.leadsService.getBusinesses(userId, PlatformName.THUMBTACK);

      if (businesses.length === 0) {
        console.log('No businesses found to setup webhooks for');
        return;
      }

      // Setup webhook for each business
      for (const business of businesses) {
        try {
          await this.platformService.setupThumbtackWebhook(userId, business.businessID);
          console.log(`Webhook setup successfully for business: ${business.name} (${business.businessID})`);
        } catch (err) {
          // Log but don't fail - webhook might already exist
          console.warn(`Failed to setup webhook for business ${business.businessID}:`, err.message);
        }
      }
    } catch (err) {
      console.error('Error in autoSetupWebhooks:', err.message);
      // Don't throw - OAuth succeeded, webhooks are just a bonus
    }
  }

  // ==========================================
  // OAuth Flow
  // ==========================================

  @Get('auth/url')
  async getAuthUrl(@CurrentUser() user: any) {
    const authUrl = await this.platformService.getAuthUrl(user.userId, PlatformName.THUMBTACK);
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
      await this.autoSetupWebhooks(userId);

      // Redirect to frontend dashboard with success
      return res.redirect(`${this.frontendUrl}/dashboard?connected=thumbtack`);
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

    await this.platformService.handleCallback(user.userId, PlatformName.THUMBTACK, code);

    return {
      success: true,
      message: 'Thumbtack account connected successfully',
    };
  }

  @Post('auth/disconnect')
  async disconnect(@CurrentUser() user: any) {
    await this.platformService.disconnect(user.userId, PlatformName.THUMBTACK);

    return {
      success: true,
      message: 'Thumbtack account disconnected',
    };
  }

  /**
   * Clear all leads for the user's Thumbtack account
   * Use this when switching accounts to start fresh
   */
  @Post('leads/clear')
  async clearLeads(@CurrentUser() user: any) {
    const result = await this.leadsService.clearLeads(user.userId, PlatformName.THUMBTACK);

    return {
      success: true,
      message: `Cleared ${result.deletedLeads} leads, ${result.deletedConversations} conversations, ${result.deletedMessages} messages`,
      ...result,
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
    const credentials = await this.platformService.getCredentials(user.userId, PlatformName.THUMBTACK);
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
    const businesses = await this.leadsService.getBusinesses(user.userId, PlatformName.THUMBTACK);

    return {
      platform: PlatformName.THUMBTACK,
      count: businesses.length,
      businesses,
    };
  }

  /**
   * Setup webhook for a business to receive leads
   * This registers your webhook URL with Thumbtack so you receive NegotiationCreatedV4 events
   */
  @Post('businesses/:businessId/webhooks/setup')
  async setupWebhook(
    @CurrentUser() user: any,
    @Param('businessId') businessId: string,
  ) {
    const result = await this.platformService.setupThumbtackWebhook(user.userId, businessId);

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
    const webhooks = await this.platformService.getThumbtackWebhooks(user.userId, businessId);

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

    const leads = await this.leadsService.getLeads(user.userId, PlatformName.THUMBTACK, options);

    return {
      platform: PlatformName.THUMBTACK,
      count: leads.length,
      leads,
      note: 'Thumbtack delivers leads via webhooks. This returns leads stored from webhook events.',
    };
  }

  @Get('leads/:id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.getLead(user.userId, id);
  }

  /**
   * Get messages for a lead/negotiation
   */
  @Get('leads/:id/messages')
  async getMessages(@CurrentUser() user: any, @Param('id') id: string) {
    console.log(`[ThumbtackController] getMessages called - userId: ${user.userId}, leadId: ${id}`);
    try {
      const messages = await this.leadsService.getMessages(user.userId, id);
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

    const result = await this.leadsService.sendMessage(user.userId, id, message);

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

    const result = await this.leadsService.sendQuote(user.userId, id, amount, description);

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
   */
  @Post('negotiations/:negotiationId/import')
  async importNegotiation(
    @CurrentUser() user: any,
    @Param('negotiationId') negotiationId: string,
  ) {
    const { lead, isNew } = await this.leadsService.importThumbtackNegotiation(user.userId, negotiationId);

    return {
      success: true,
      isNew,
      message: isNew ? 'Negotiation imported successfully' : 'Negotiation already exists (updated)',
      lead,
    };
  }

  /**
   * Import multiple negotiations at once
   */
  @Post('negotiations/import-batch')
  async importNegotiations(
    @CurrentUser() user: any,
    @Body('negotiationIds') negotiationIds: string[],
  ) {
    if (!negotiationIds || !Array.isArray(negotiationIds) || negotiationIds.length === 0) {
      throw new BadRequestException('negotiationIds array is required');
    }

    const results = await this.leadsService.importThumbtackNegotiations(user.userId, negotiationIds);

    return {
      success: true,
      message: `Imported ${results.imported} of ${negotiationIds.length} negotiations`,
      ...results,
    };
  }
}
