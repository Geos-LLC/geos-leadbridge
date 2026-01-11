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
  constructor(
    private platformService: PlatformService,
    private leadsService: LeadsService,
  ) {}

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
    // Handle OAuth errors
    if (error) {
      return res.status(400).json({
        success: false,
        error,
        error_description: errorDescription,
      });
    }

    if (!code) {
      throw new BadRequestException('Authorization code is required');
    }

    try {
      // Get userId from state (stored during auth URL generation)
      const userId = await this.platformService.getUserIdFromState(state);

      if (!userId) {
        return res.status(400).json({
          success: false,
          error: 'Invalid state parameter',
          message: 'OAuth state expired or invalid. Please try connecting again.',
        });
      }

      // Exchange code for tokens
      await this.platformService.handleCallback(userId, PlatformName.THUMBTACK, code);

      // Return success response
      return res.json({
        success: true,
        message: 'Thumbtack account connected successfully!',
        userId,
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: 'Failed to complete OAuth',
        message: err.message,
      });
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

  // ==========================================
  // Leads
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
    };
  }

  @Get('leads/:id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.getLead(user.userId, id);
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
}
