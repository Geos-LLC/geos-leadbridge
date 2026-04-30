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
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../common/utils/prisma.service';
import { CrmWebhookService } from '../crm-webhooks/crm-webhook.service';
import { JwtSseAuthGuard } from '../common/guards/jwt-sse-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { LeadsService } from './leads.service';
import { LeadStatusService } from './lead-status.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, merge, interval, from } from 'rxjs';
import { map, mergeMap, filter as rxFilter } from 'rxjs/operators';
import {
  parseAccountScope,
  ACCOUNT_BOUNDARY_WARNING_HEADER,
  ACCOUNT_BOUNDARY_WARNING_VALUE_MISSING,
} from '../common/account-scope/account-scope.util';
import {
  SseAccountScope,
  SseBusinessIdResolver,
  passesAccountFilter,
} from './sse-account-filter';

@Controller('v1/leads')
@UseGuards(JwtSseAuthGuard)
export class LeadsController {
  constructor(
    private leadsService: LeadsService,
    private leadStatusService: LeadStatusService,
    private eventEmitter: EventEmitter2,
    private prisma: PrismaService,
    private crmWebhookService: CrmWebhookService,
  ) {}

  /**
   * Server-Sent Events endpoint for real-time lead updates.
   *
   * @Public() skips the global JwtAuthGuard so JwtSseAuthGuard can read the
   * token from the `?token=` query param (EventSource API has no header support).
   *
   * Account-scope contract (see `parseAccountScope`):
   *   ?businessId=<id>  → only events whose owning businessId === <id>
   *   ?scope=all        → unified stream across all of the user's accounts
   *   neither           → transition: stream all events; emit a warning log so
   *                        unmigrated callers are observable
   *   both              → 400
   *
   * For account-scoped streams, every event's owning businessId is resolved
   * via `SseBusinessIdResolver`. Resolution either reads the payload directly
   * or does one Prisma `Lead.findFirst({ id, userId })` lookup, cached for the
   * connection lifetime. Events whose businessId cannot be resolved
   * (e.g. `sms.status` payloads carrying only `messageId`) are dropped from
   * account-scoped streams — they still pass through `?scope=all`.
   */
  @Public()
  @Sse('events')
  leadEvents(
    @CurrentUser() user: any,
    @Query('businessId') businessId?: string,
    @Query('scope') scope?: string,
  ): Observable<MessageEvent> {
    const userId = user.id;
    const parsed = parseAccountScope({ businessId, scope });
    const accountScope: SseAccountScope =
      parsed.kind === 'account'
        ? { kind: 'account', businessId: parsed.businessId }
        : { kind: 'all' };

    if (parsed.kind === 'all' && parsed.warn) {
      // SSE has no per-response headers we can set after streaming starts, so
      // log only. Frontend should be migrated to pass ?businessId or ?scope=all.
      console.warn(
        `[account-boundary] /v1/leads/events subscribed without businessId or scope=all (userId=${userId}) — streaming all accounts.`,
      );
    }

    // Per-connection resolver. The cache is captured in the closure for this
    // single SSE call — a new subscribe builds a fresh map.
    const resolver = new SseBusinessIdResolver(this.prisma, userId);

    /**
     * Wraps a per-event-name observable with the account-scope filter and the
     * SSE envelope. For `scope=all` we skip resolution entirely (cheap pass-
     * through). For account scope we mergeMap into resolution + filter.
     */
    const scopedStream = (
      eventName: string,
      shape: (payload: any) => any,
    ): Observable<MessageEvent> => {
      const source = fromEvent(this.eventEmitter, eventName);
      if (accountScope.kind === 'all') {
        return source.pipe(map((payload) => ({ data: shape(payload) })));
      }
      return source.pipe(
        mergeMap((payload) =>
          from(
            resolver.resolve(payload).then((resolved) => ({
              pass: passesAccountFilter(accountScope, resolved),
              payload,
            })),
          ),
        ),
        rxFilter((x) => x.pass),
        map(({ payload }) => ({ data: shape(payload) })),
      );
    };

    // Heartbeat every 30s prevents Railway's HTTP/2 proxy from killing the connection.
    return merge(
      interval(30000).pipe(
        map(() => ({ data: { type: 'heartbeat' } })),
      ),
      scopedStream(`lead.created.${userId}`, (lead) => ({ type: 'lead.created', lead })),
      scopedStream(`sms.inbound.${userId}`, (payload) => ({
        type: 'sms.inbound',
        ...(payload as any),
      })),
      scopedStream(`sms.status.${userId}`, (payload) => ({
        type: 'sms.status',
        ...(payload as any),
      })),
      scopedStream(`lead.status.conflict.${userId}`, (payload) => ({
        type: 'lead.status.conflict',
        ...(payload as any),
      })),
    );
  }

  /**
   * Get leads for the user.
   *
   * Account-scope contract (see `src/common/account-scope/account-scope.util.ts`):
   *   ?businessId=<id>  → scope to one saved account (preferred)
   *   ?scope=all        → explicit unified across all accounts
   *   neither           → transition: returns all + warning header
   *   both              → 400
   *
   * `?platform=` may be combined with either: it filters the result to one
   * platform AFTER the account scope is applied. Pre-fix the platform branch
   * silently dropped `businessId`; that bug is fixed here by always running
   * through `getCachedLeads` with the full filter shape.
   */
  @Get()
  async getAllLeads(
    @CurrentUser() user: any,
    @Res({ passthrough: true }) res: Response,
    @Query('platform') platform?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('businessId') businessId?: string,
    @Query('scope') scope?: string,
  ) {
    const accountScope = parseAccountScope({ businessId, scope });

    if (accountScope.kind === 'all' && accountScope.warn) {
      res.setHeader(ACCOUNT_BOUNDARY_WARNING_HEADER, ACCOUNT_BOUNDARY_WARNING_VALUE_MISSING);
      console.warn(
        `[account-boundary] GET /v1/leads called without businessId or scope=all (userId=${user.id}) — defaulting to all accounts.`,
      );
    }

    // Get cached leads from database with filters.
    // The service partitions cache keys by businessId (cache-keys.ts) so
    // per-account responses can never bleed into the unified cache slot.
    const leads = await this.leadsService.getCachedLeads(user.id, {
      platform,
      status,
      businessId: accountScope.kind === 'account' ? accountScope.businessId : undefined,
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
   * Update lead status manually (operator clicked in UI).
   *
   * Runs through LeadStatusService.writeStatus with source='manual' so the
   * conflict-detection rules fire:
   *  - If SF is integrated (lead.sfJobId set) → returns a `conflict` payload
   *    of kind 'sf_push_needed' that the frontend renders as a modal asking
   *    the operator to push to SF.
   *  - Else if the platform's last-known status (platformStatus /
   *    thumbtackStatus) disagrees with the new LB status → returns a
   *    conflict of kind 'platform_nudge_needed' so the frontend can prompt
   *    the operator to also update status on Thumbtack/Yelp.
   *
   * The write itself ALWAYS succeeds (LB is the source of truth for its own
   * state); the conflict is just advisory.
   */
  @Patch(':id/status')
  async updateStatus(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('status') status: string,
  ) {
    // Guard: user must own the lead.
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { id: true, status: true, platform: true, businessId: true },
    });
    if (!lead) return { success: false, error: 'Lead not found' };

    const result = await this.leadStatusService.writeStatus({
      leadId: id,
      source: 'manual',
      newStatus: status,
      actorType: 'user',
      actorId: user.id,
      actorName: user.email || user.name || null,
    });

    // Keep emitting the CRM webhook the UI listens for.
    if (result.applied) {
      this.crmWebhookService
        .emit(user.id, 'lead.status_changed', {
          userId: user.id,
          platform: lead.platform,
          businessId: lead.businessId ?? null,
          leadId: id,
          previousStatus: lead.status,
        })
        .catch(() => {});
    }

    const refreshed = await this.leadsService.getLead(user.id, id);
    return {
      success: true,
      lead: refreshed,
      conflict: result.conflict,
    };
  }

  /**
   * List unresolved status conflicts for a lead — polled by the Messages /
   * Lead detail page after a manual status change or on page load.
   */
  @Get(':id/status-conflicts')
  async listStatusConflicts(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!lead) return { success: false, error: 'Lead not found' };
    const conflicts = await this.leadStatusService.listConflicts(id);
    return { success: true, conflicts };
  }

  /**
   * Lead Activity timeline — every status transition that touched this lead.
   *
   * Reads from LeadStatusAuditLog. Tenant-scoped: 404-equivalent (empty
   * activity[] + success=false) when the lead doesn't belong to the caller,
   * matching the listStatusConflicts shape so the frontend can use one
   * common error path.
   *
   * `limit` defaults to 50 and is hard-capped at 200 so a malicious caller
   * can't sweep the whole audit table for one lead.
   */
  @Get(':id/activity')
  async getLeadActivity(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Query('limit') limitRaw?: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!lead) return { success: false, error: 'Lead not found', activity: [] };

    const parsed = limitRaw ? parseInt(limitRaw, 10) : 50;
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 50;

    const rows = await this.prisma.leadStatusAuditLog.findMany({
      where: { leadId: id },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        activityType: true,
        oldStatus: true,
        newStatus: true,
        source: true,
        reason: true,
        metadata: true,
        actorType: true,
        actorName: true,
        occurredAt: true,
        createdAt: true,
      },
    });

    return {
      success: true,
      activity: rows.map((r) => ({
        id: r.id,
        type: r.activityType,
        fromStatus: r.oldStatus,
        toStatus: r.newStatus,
        source: r.source,
        reason: r.reason,
        metadata: r.metadata,
        actorType: r.actorType,
        actorName: r.actorName,
        occurredAt: r.occurredAt,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Resolve a status conflict (operator clicked "Keep mine" / "Accept upstream"
   * / "Pushed to SF" in the modal). resolveNote records the operator's choice.
   */
  @Post(':id/status-conflicts/:auditId/resolve')
  async resolveStatusConflict(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Param('auditId') auditId: string,
    @Body('resolveNote') resolveNote: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { id: true },
    });
    if (!lead) return { success: false, error: 'Lead not found' };
    await this.leadStatusService.resolveConflict(auditId, resolveNote || 'resolved');
    return { success: true };
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
