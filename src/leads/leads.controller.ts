/**
 * Leads Controller
 * Unified endpoint for leads from all platforms
 */

import {
  Controller,
  Get,
  Post,
  Patch,
  Query,
  Param,
  Body,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LeadsService } from './leads.service';

@Controller('v1/leads')
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(private leadsService: LeadsService) {}

  /**
   * Get all leads from all connected platforms
   */
  @Get()
  async getAllLeads(
    @CurrentUser() user: any,
    @Query('platform') platform?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
  ) {
    if (platform) {
      // Get leads from specific platform
      return this.leadsService.getLeads(user.userId, platform);
    }

    // Get cached leads from database with filters
    const leads = await this.leadsService.getCachedLeads(user.userId, {
      platform,
      status,
      limit: limit ? parseInt(limit.toString(), 10) : undefined,
    });

    return {
      count: leads.length,
      leads,
    };
  }

  /**
   * Get a specific lead by ID
   */
  @Get(':id')
  async getLead(@CurrentUser() user: any, @Param('id') id: string) {
    return this.leadsService.getLead(user.userId, id);
  }

  /**
   * Update lead status
   */
  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    return this.leadsService.updateLeadStatus(user.userId, id, status);
  }

  /**
   * Send a message to a lead
   */
  @Post(':id/message')
  async sendMessage(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('message') message: string,
  ) {
    const result = await this.leadsService.sendMessage(user.userId, id, message);

    return {
      success: true,
      message: 'Message sent successfully',
      data: result,
    };
  }

  /**
   * Send a quote to a lead
   */
  @Post(':id/quote')
  async sendQuote(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('amount') amount: number,
    @Body('description') description?: string,
  ) {
    const result = await this.leadsService.sendQuote(user.userId, id, amount, description);

    return {
      success: true,
      message: 'Quote sent successfully',
      data: result,
    };
  }

  /**
   * Sync lead status from platform (fetches fresh data)
   * Only works if connected to the lead's business account
   */
  @Post(':id/sync')
  async syncLead(@CurrentUser() user: any, @Param('id') id: string) {
    const lead = await this.leadsService.syncLeadStatus(user.userId, id);

    return {
      success: true,
      lead,
    };
  }

  /**
   * Re-sync messages for a lead
   * Cleans up duplicates and imports any missing messages from the API
   */
  @Post(':id/resync-messages')
  async resyncMessages(@CurrentUser() user: any, @Param('id') id: string) {
    console.log(`[LeadsController] POST /resync-messages called - leadId: ${id}, userId: ${user.userId}`);
    const result = await this.leadsService.resyncMessages(user.userId, id);

    return {
      success: true,
      message: `Cleaned ${result.cleaned} duplicates`,
      ...result,
    };
  }
}
