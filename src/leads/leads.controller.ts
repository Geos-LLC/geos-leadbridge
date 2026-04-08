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
  Sse,
  MessageEvent,
} from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { CrmWebhookService } from '../crm-webhooks/crm-webhook.service';
import { JwtSseAuthGuard } from '../common/guards/jwt-sse-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { LeadsService } from './leads.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, merge, interval } from 'rxjs';
import { map } from 'rxjs/operators';

@Controller('v1/leads')
@UseGuards(JwtSseAuthGuard)
export class LeadsController {
  constructor(
    private leadsService: LeadsService,
    private eventEmitter: EventEmitter2,
    private prisma: PrismaService,
    private crmWebhookService: CrmWebhookService,
  ) {}

  /**
   * Server-Sent Events endpoint for real-time lead updates
   * More efficient than polling for infrequent updates
   * @Public() skips the global JwtAuthGuard so JwtSseAuthGuard can read the token from the query param
   * (EventSource API does not support custom headers, so token must be passed as ?token=)
   */
  @Public()
  @Sse('events')
  leadEvents(@CurrentUser() user: any): Observable<MessageEvent> {
    const userId = user.id;

    // Listen for lead events, SMS events, and send keepalive heartbeat
    // Heartbeat every 30s prevents Railway's HTTP/2 proxy from killing the connection
    return merge(
      interval(30000).pipe(
        map(() => ({ data: { type: 'heartbeat' } })),
      ),
      fromEvent(this.eventEmitter, `lead.created.${userId}`).pipe(
        map((lead) => ({
          data: { type: 'lead.created', lead },
        })),
      ),
      fromEvent(this.eventEmitter, `sms.inbound.${userId}`).pipe(
        map((payload) => ({
          data: { type: 'sms.inbound', ...(payload as any) },
        })),
      ),
      fromEvent(this.eventEmitter, `sms.status.${userId}`).pipe(
        map((payload) => ({
          data: { type: 'sms.status', ...(payload as any) },
        })),
      ),
    );
  }

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
      return this.leadsService.getLeads(user.id, platform);
    }

    // Get cached leads from database with filters
    const leads = await this.leadsService.getCachedLeads(user.id, {
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
    return this.leadsService.getLead(user.id, id);
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
    return this.leadsService.updateLeadStatus(user.id, id, status);
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
    const result = await this.leadsService.sendMessage(user.id, id, message);

    return {
      success: true,
      message: 'Message sent successfully',
      data: result,
    };
  }

  /**
   * Update lead fields (e.g., customerPhone from message detection)
   */
  @Patch(':id')
  async updateLead(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { customerPhone?: string; status?: string },
  ) {
    const lead = await this.prisma.lead.findFirst({ where: { id, userId: user.id } });
    if (!lead) return { success: false, error: 'Lead not found' };

    const data: any = {};
    if (body.customerPhone) data.customerPhone = body.customerPhone;
    if (body.status) data.status = body.status;

    await this.prisma.lead.update({ where: { id }, data });

    // Emit CRM webhook on status change
    if (body.status && body.status !== lead.status) {
      this.crmWebhookService.emit(user.id, 'lead.status_changed', {
        userId: user.id, platform: lead.platform, businessId: lead.businessId,
        leadId: id, previousStatus: lead.status,
      }).catch(() => {});
    }

    return { success: true };
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
    const result = await this.leadsService.sendQuote(user.id, id, amount, description);

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
    const lead = await this.leadsService.syncLeadStatus(user.id, id);

    return {
      success: true,
      lead,
    };
  }

  /**
   * Re-sync messages for a lead
   * Cleans up duplicates and imports any missing messages from the API
   */
  /**
   * Re-fetch lead data from the platform API (fixes "Unknown" leads from token failures)
   */
  @Post(':id/refetch')
  async refetchLead(@CurrentUser() user: any, @Param('id') id: string) {
    const result = await this.leadsService.refetchLeadFromPlatform(user.id, id);
    return { success: true, ...result };
  }

  /**
   * Re-fetch ALL broken leads (customerName = 'Unknown') for the current user
   */
  @Post('refetch-broken')
  async refetchBrokenLeads(@CurrentUser() user: any) {
    const broken = await this.prisma.lead.findMany({
      where: { userId: user.id, customerName: 'Unknown' },
      select: { id: true },
    });
    const results = [];
    for (const lead of broken) {
      try {
        const r = await this.leadsService.refetchLeadFromPlatform(user.id, lead.id);
        results.push({ id: lead.id, ...r });
      } catch (err: any) {
        results.push({ id: lead.id, error: err.message });
      }
    }
    return { success: true, total: broken.length, results };
  }

  @Post(':id/resync-messages')
  async resyncMessages(@CurrentUser() user: any, @Param('id') id: string) {
    console.log(`[LeadsController] POST /resync-messages called - leadId: ${id}, userId: ${user.id}`);
    const result = await this.leadsService.resyncMessages(user.id, id);

    return {
      success: true,
      message: `Cleaned ${result.cleaned} duplicates`,
      ...result,
    };
  }

  /**
   * Preview bulk message for multiple leads
   * Returns personalized messages for each lead
   */
  @Post('bulk-message/preview')
  async previewBulkMessage(
    @CurrentUser() user: any,
    @Body('leadIds') leadIds: string[],
    @Body('templateContent') templateContent: string,
  ) {
    console.log(`[LeadsController] POST /bulk-message/preview - userId: ${user.id}, leads: ${leadIds?.length}`);

    if (!leadIds || leadIds.length === 0) {
      return {
        success: false,
        error: 'No leads provided',
        previews: [],
      };
    }

    if (!templateContent) {
      return {
        success: false,
        error: 'No template content provided',
        previews: [],
      };
    }

    const previews = await this.leadsService.previewBulkMessage(
      user.id,
      leadIds,
      templateContent,
    );

    return {
      success: true,
      previews,
    };
  }

  /**
   * Send bulk messages to multiple leads
   */
  @Post('bulk-message/send')
  async sendBulkMessages(
    @CurrentUser() user: any,
    @Body('leadIds') leadIds: string[],
    @Body('templateContent') templateContent: string,
    @Body('templateId') templateId?: string,
  ) {
    console.log(`[LeadsController] POST /bulk-message/send - userId: ${user.id}, leads: ${leadIds?.length}`);

    if (!leadIds || leadIds.length === 0) {
      return {
        success: false,
        error: 'No leads provided',
        total: 0,
        successful: 0,
        failed: 0,
        results: [],
      };
    }

    if (!templateContent) {
      return {
        success: false,
        error: 'No template content provided',
        total: 0,
        successful: 0,
        failed: 0,
        results: [],
      };
    }

    const result = await this.leadsService.sendBulkMessages(
      user.id,
      leadIds,
      templateContent,
      templateId,
    );

    return {
      success: result.failed === 0,
      message: `Sent ${result.successful} of ${result.total} messages`,
      ...result,
    };
  }

  /**
   * One-time migration endpoint to fix createdAt dates for existing leads
   * Reads the original createdAt from rawJson and updates the lead
   */
  @Post('migrate-dates')
  async migrateDates(@CurrentUser() user: any) {
    const result = await this.leadsService.migrateLeadDates(user.id);
    return result;
  }
}
