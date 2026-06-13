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
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import { CrmWebhookService } from '../crm-webhooks/crm-webhook.service';
import { JwtSseAuthGuard } from '../common/guards/jwt-sse-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/public.decorator';
import { LeadsService } from './leads.service';
import { LeadStatusService } from './lead-status.service';
import { ConversationRuntimeService } from '../conversation-context/conversation-runtime.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Observable, fromEvent, merge, interval, from } from 'rxjs';
import { map, mergeMap, filter as rxFilter } from 'rxjs/operators';
import { parseAccountScope } from '../common/account-scope/account-scope.util';
import {
  SseAccountScope,
  SseBusinessIdResolver,
  passesAccountFilter,
} from './sse-account-filter';
import {
  labelConversationState,
  labelAiStatus,
  labelClassifierIntent,
  labelSfJobOutcome,
  labelFollowUp,
  labelHandoff,
} from '../conversation-context/conversation-runtime-display';

@Controller('v1/leads')
@UseGuards(JwtSseAuthGuard)
export class LeadsController {
  constructor(
    private leadsService: LeadsService,
    private leadStatusService: LeadStatusService,
    private eventEmitter: EventEmitter2,
    private prisma: PrismaService,
    private crmWebhookService: CrmWebhookService,
    // Wired 2026-06-12 for the V2 AI Conversation Review Mode endpoints —
    // get / send / discard pending AI suggestions on a thread. ThreadContext
    // is owned by ConversationContextService; the runtime helper exposes
    // a typed read/write API over the stateJson bag.
    private conversationRuntime: ConversationRuntimeService,
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
      // Fired by LeadCacheService.invalidateLeadMessagesAndList — every inbound
      // webhook, outbound send, or resync that mutates a lead's message thread
      // emits this. Frontend uses it to refetch the active lead so the user
      // sees new messages immediately, without waiting for the Redis TTL.
      scopedStream(`lead.messages.changed.${userId}`, (payload) => ({
        type: 'lead.messages.changed',
        ...(payload as any),
      })),
    );
  }

  /**
   * Get leads for the user — CANONICAL CROSS-PLATFORM ENDPOINT.
   *
   * This is the endpoint Service Flow (and any future external consumer)
   * should call for a full inventory of the user's leads. The platform
   * endpoints (`/v1/thumbtack/leads`, `/v1/yelp/leads`) are platform-scoped;
   * the historical cross-platform merge on `/v1/thumbtack/leads?scope=all` is
   * deprecated and emits `X-LeadBridge-Deprecated: cross-platform-merge`.
   *
   * Account-scope contract (see `src/common/account-scope/account-scope.util.ts`):
   *   ?businessId=<id>  → scope to one saved account
   *   ?scope=all        → explicit unified across all accounts
   *   neither           → 400
   *   both              → 400
   *
   * `?platform=` may be combined with either: it filters the result to one
   * platform AFTER the account scope is applied.
   *
   * Response shape (per lead, NormalizedLead):
   *   id, externalRequestId, platform, businessId, businessName,
   *   customerName, customerPhone, customerEmail, message, status,
   *   thumbtackStatus, threadId, createdAt, updatedAt, lastMessageAt,
   *   lastMessage (latest sender+content+sentAt for sidebar previews).
   *
   * No default limit — pass `?limit=N` to cap. Tested counts are in the
   * low thousands; if the dataset grows past ~10k revisit with cursor
   * pagination.
   */
  @Get()
  async getAllLeads(
    @CurrentUser() user: any,
    @Query('platform') platform?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: number,
    @Query('businessId') businessId?: string,
    @Query('scope') scope?: string,
  ) {
    const accountScope = parseAccountScope({ businessId, scope });

    // Get cached leads from database with filters.
    // The service partitions cache keys by businessId (cache-keys.ts) so
    // per-account responses can never bleed into the unified cache slot.
    const leads = await this.leadsService.getCachedLeads(user.id, {
      platform,
      status,
      businessId: accountScope.kind === 'account' ? accountScope.businessId : undefined,
      limit: limit ? parseInt(limit.toString(), 10) : undefined,
    });

    const enriched = await this.leadsService.enrichLeadsWithAccountInfo(
      user.id,
      leads,
    );

    return {
      count: enriched.length,
      leads: enriched,
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
   * Phase 1.5 — per-lead runtime-state diagnostic.
   *
   * Returns the legacy Lead.status fields side-by-side with the new
   * conversation runtime (conversationState / aiStatus / classifier
   * intent / handoff lifecycle / sfJobOutcome / waitingSince) so the
   * future UI and operators can compare them BEFORE we migrate decision
   * logic in Phase 3.
   *
   * READ-ONLY. Tenant-scoped: 404 if the lead doesn't belong to the
   * caller. No PII (message body, customer phone/email) is included —
   * only state fields, timestamps, and the legacy lead fields the UI
   * already shows on the lead detail page.
   */
  @Get(':id/runtime-state')
  async getLeadRuntimeState(@CurrentUser() user: any, @Param('id') id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: {
        id: true,
        userId: true,
        platform: true,
        externalRequestId: true,
        status: true,
        statusSource: true,
        statusUpdatedAt: true,
        sfJobId: true,
        sfJobOutcome: true,
        sfJobOutcomeAt: true,
        sfLastEventAt: true,
        threadId: true,
      },
    });
    if (!lead) {
      return { success: false, error: 'Lead not found', leadId: id };
    }

    // ThreadContext (1:1 with Conversation by threadId). Skip if the lead
    // has no thread yet (e.g. brand-new lead before first message).
    const tc = lead.threadId
      ? await this.prisma.threadContext.findUnique({
          where: { conversationId: lead.threadId },
          select: {
            conversationState: true,
            conversationStateAt: true,
            conversationStateReason: true,
            aiStatus: true,
            aiStatusAt: true,
            aiStatusReason: true,
            lastClassifiedIntent: true,
            lastClassifiedConfidence: true,
            lastClassifiedAt: true,
            handoffRequestedAt: true,
            handoffRequestedReason: true,
            handoffResolvedAt: true,
            waitingSince: true,
            lastCustomerMessageAt: true,
            lastBusinessMessageAt: true,
            lastAiMessageAt: true,
            awaitingCustomerReply: true,
            followUpStatus: true,
            nextFollowUpAt: true,
            activeEnrollmentId: true,
          },
        })
      : null;

    // Pull the active follow-up enrollment for the canonical (non-cached)
    // nextStepDueAt + currentStepIndex. ThreadContext.nextFollowUpAt is the
    // cache; the enrollment is the source of truth.
    const enrollment = lead.threadId
      ? await this.prisma.followUpEnrollment.findFirst({
          where: { conversationId: lead.threadId, status: 'active' },
          select: {
            id: true,
            status: true,
            stoppedReason: true,
            currentStepIndex: true,
            nextStepDueAt: true,
            followUpMode: true,
            modeReason: true,
          },
        })
      : null;

    return {
      success: true,
      leadId: lead.id,
      lead: {
        status: lead.status,
        statusSource: lead.statusSource,
        statusUpdatedAt: lead.statusUpdatedAt,
        platform: lead.platform,
        externalRequestId: lead.externalRequestId,
        sfJobId: lead.sfJobId,
        sfJobOutcome: lead.sfJobOutcome,
        sfJobOutcomeAt: lead.sfJobOutcomeAt,
        sfLastEventAt: lead.sfLastEventAt,
      },
      threadContext: tc ?? null,
      followUp: enrollment
        ? {
            enrollmentId: enrollment.id,
            status: enrollment.status,
            stoppedReason: enrollment.stoppedReason,
            currentStepIndex: enrollment.currentStepIndex,
            nextFollowUpAt: enrollment.nextStepDueAt,
            followUpMode: enrollment.followUpMode,
            modeReason: enrollment.modeReason,
          }
        : tc?.followUpStatus
        ? {
            // No active enrollment; expose whatever the cache says
            enrollmentId: tc.activeEnrollmentId,
            status: tc.followUpStatus,
            stoppedReason: null,
            currentStepIndex: null,
            nextFollowUpAt: tc.nextFollowUpAt,
            followUpMode: null,
            modeReason: null,
          }
        : null,
      displayLabels: {
        conversationState: labelConversationState(tc?.conversationState ?? null),
        aiStatus: labelAiStatus(tc?.aiStatus ?? null),
        lastClassifiedIntent: labelClassifierIntent(tc?.lastClassifiedIntent ?? null),
        sfJobOutcome: labelSfJobOutcome(lead.sfJobOutcome ?? null),
        followUp: labelFollowUp(
          enrollment?.status ?? tc?.followUpStatus ?? null,
          enrollment?.nextStepDueAt ?? tc?.nextFollowUpAt ?? null,
        ),
        handoff: labelHandoff(
          tc?.handoffRequestedAt ?? null,
          tc?.handoffResolvedAt ?? null,
        ),
      },
    };
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

  // ─── V2 AI Conversation Review Mode endpoints (2026-06-12) ───────────────
  //
  // When the per-account followUpSettingsJson.aiConversationDeliveryMode is
  // 'suggest', incoming customer replies trigger AI generation but park the
  // body as a pending suggestion on ThreadContext.stateJson.pendingAiSuggestion
  // instead of dispatching. These three endpoints let Lead Activity inspect,
  // approve (send), or discard the pending draft.
  //
  // Sender type on send is 'ai' so the outbound Message row + downstream
  // observability look identical to an auto-sent AI reply. Clearing the
  // suggestion is unconditional — once an operator acts on a draft, the
  // next customer reply is eligible to generate a fresh one.

  @Get(':id/ai-suggestion')
  async getAiSuggestion(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { threadId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!lead.threadId) return { success: true, suggestion: null };
    const suggestion = await this.conversationRuntime.getAiSuggestion(lead.threadId);
    return { success: true, suggestion };
  }

  @Post(':id/ai-suggestion/send')
  async sendAiSuggestion(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('message') overrideMessage?: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { threadId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!lead.threadId) {
      throw new NotFoundException('Lead has no conversation thread');
    }
    const suggestion = await this.conversationRuntime.getAiSuggestion(lead.threadId);
    if (!suggestion) {
      throw new NotFoundException('No pending AI suggestion for this lead');
    }
    // Body override supports the "Edit & Send" path — the operator tweaked
    // the wording in Lead Activity before approving. Fall back to the
    // generated body when no override is sent.
    const body = (typeof overrideMessage === 'string' && overrideMessage.trim())
      ? overrideMessage.trim()
      : suggestion.message;
    const result = await this.leadsService.sendMessage(user.id, id, body, 'ai');
    await this.conversationRuntime.clearAiSuggestion(lead.threadId, {
      leadId: id,
      userId: user.id,
    });
    return { success: true, sent: true, suggestionId: suggestion.id, message: body, data: result };
  }

  @Post(':id/ai-suggestion/discard')
  async discardAiSuggestion(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, userId: user.id },
      select: { threadId: true },
    });
    if (!lead) throw new NotFoundException('Lead not found');
    if (!lead.threadId) {
      return { success: true, sent: false, cleared: false };
    }
    const existing = await this.conversationRuntime.getAiSuggestion(lead.threadId);
    if (!existing) {
      return { success: true, sent: false, cleared: false };
    }
    await this.conversationRuntime.clearAiSuggestion(lead.threadId, {
      leadId: id,
      userId: user.id,
    });
    return { success: true, sent: false, cleared: true, suggestionId: existing.id };
  }

  /**
   * Update lead fields (e.g., customerPhone from message detection).
   *
   * IMPORTANT: any status field on this route is routed through
   * `LeadStatusService.writeStatus` so the full guard chain applies
   * (sf_managed / pipeline_downgrade / hard_terminal / dedup / etc.).
   * Previously this method did a direct prisma.lead.update that bypassed
   * every guard — see SfHistoricalSync rollout (2026-05-30) for why.
   */
  @Patch(':id')
  async updateLead(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { customerPhone?: string; status?: string },
  ) {
    const lead = await this.prisma.lead.findFirst({ where: { id, userId: user.id } });
    if (!lead) return { success: false, error: 'Lead not found' };

    // Status changes go through the guarded write path. We hand them off
    // FIRST so a sf_managed / pipeline_downgrade rejection short-circuits
    // before the non-status mutations land.
    if (body.status && body.status !== lead.status) {
      const statusResult = await this.leadStatusService.writeStatus({
        leadId: id,
        newStatus: body.status,
        source: 'manual',
        actorType: 'user',
        actorId: user.id,
      });
      if (!statusResult.applied) {
        return {
          success: false,
          error: 'status_write_rejected',
          skipReason: statusResult.skipReason ?? null,
          currentStatus: statusResult.status,
        };
      }
    }

    // Non-status fields write directly (no guards needed).
    const data: any = {};
    if (body.customerPhone) data.customerPhone = body.customerPhone;
    if (Object.keys(data).length > 0) {
      await this.prisma.lead.update({ where: { id }, data });
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
