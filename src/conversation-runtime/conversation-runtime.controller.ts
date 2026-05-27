/**
 * Conversation Runtime Observability Controller — Phase 1.5.
 *
 * Two tenant-wide diagnostic endpoints for comparing legacy Lead.status
 * behavior against the new conversation runtime layer BEFORE we migrate
 * any decision logic in Phase 3.
 *
 * READ-ONLY. No mutations. No auto-repair. No PII (message body, customer
 * phone/email) leaves these endpoints — only state fields, leadIds, and
 * timestamps.
 *
 * Per-lead inspection is served by GET /v1/leads/:id/runtime-state on
 * LeadsController (kept there so it lives next to the existing lead routes).
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { PrismaService } from '../common/utils/prisma.service';
import {
  AI_STATUSES,
  CONVERSATION_STATES,
  type AiStatus,
  type ConversationState,
} from '../conversation-context/conversation-runtime';

/**
 * Lead.status values considered "terminal" in the legacy CRM-pipeline sense.
 * Mirrors the gate in automation.service.ts terminal-status check.
 */
const LEGACY_TERMINAL_STATUSES = new Set([
  'completed',
  'lost',
  'cancelled',
  'no_show',
  'archived',
]);

/**
 * conversationState values considered "terminal" in the new runtime model.
 * AI shouldn't continue and follow-ups should stop in any of these.
 */
const RUNTIME_TERMINAL_STATES: ReadonlySet<string> = new Set<string>([
  'opted_out',
  'hired_elsewhere',
  'booked_in_lb',
  'closed',
]);

/** conversationState values considered "active" (engagement may continue). */
const RUNTIME_ACTIVE_STATES: ReadonlySet<string> = new Set<string>([
  'new',
  'ai_engaging',
  'awaiting_customer',
  'customer_replied',
  'human_handling',
  'deferred',
]);

const STALE_WAITING_HOURS = 72;
const HANDOFF_STALE_HOURS = 24;
const CLASSIFIER_MISSING_HOURS = 1;

@Controller('v1/conversation-runtime')
@UseGuards(JwtAuthGuard)
export class ConversationRuntimeController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Tenant-wide counts across the new runtime fields. Snapshot at request
   * time — no caching, no aggregation table. Cheap because every field has
   * a partial index (skip-null) added by the Phase 1 migration.
   */
  @Get('summary')
  async summary(@CurrentUser() user: any) {
    const userId = user.id;
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // by conversationState
    const byConversationState: Record<string, number> = {};
    await Promise.all(
      CONVERSATION_STATES.map(async (s) => {
        byConversationState[s] = await this.prisma.threadContext.count({
          where: { lead: { userId }, conversationState: s },
        });
      }),
    );
    const conversationStateNull = await this.prisma.threadContext.count({
      where: { lead: { userId }, conversationState: null },
    });

    // by aiStatus
    const byAiStatus: Record<string, number> = {};
    await Promise.all(
      AI_STATUSES.map(async (s) => {
        byAiStatus[s] = await this.prisma.threadContext.count({
          where: { lead: { userId }, aiStatus: s },
        });
      }),
    );
    const aiStatusNull = await this.prisma.threadContext.count({
      where: { lead: { userId }, aiStatus: null },
    });

    // by lastClassifiedIntent — group dynamically rather than enumerate
    const intentRows = await this.prisma.threadContext.groupBy({
      by: ['lastClassifiedIntent'],
      where: { lead: { userId }, lastClassifiedIntent: { not: null } },
      _count: { _all: true },
    });
    const byLastClassifiedIntent: Record<string, number> = {};
    for (const r of intentRows) {
      if (r.lastClassifiedIntent) {
        byLastClassifiedIntent[r.lastClassifiedIntent] = r._count._all;
      }
    }

    // SF outcome coverage
    const sfOutcomeRows = await this.prisma.lead.groupBy({
      by: ['sfJobOutcome'],
      where: { userId, sfJobOutcome: { not: null } },
      _count: { _all: true },
    });
    const sfJobOutcomeCounts: Record<string, number> = {};
    for (const r of sfOutcomeRows) {
      if (r.sfJobOutcome) sfJobOutcomeCounts[r.sfJobOutcome] = r._count._all;
    }
    const sfLinkedTotal = await this.prisma.lead.count({
      where: { userId, sfLastEventAt: { not: null } },
    });
    const sfOutcomePopulated = await this.prisma.lead.count({
      where: { userId, sfJobOutcome: { not: null } },
    });

    // Lead.status vs conversationState mismatch:
    //   legacy terminal but runtime active OR vice versa
    const [legacyTerminalRuntimeActive, runtimeTerminalLegacyActive] = await Promise.all([
      this.prisma.threadContext.count({
        where: {
          lead: { userId, status: { in: Array.from(LEGACY_TERMINAL_STATUSES) } },
          conversationState: { in: Array.from(RUNTIME_ACTIVE_STATES) as ConversationState[] },
        },
      }),
      this.prisma.threadContext.count({
        where: {
          lead: { userId, status: { notIn: Array.from(LEGACY_TERMINAL_STATUSES) } },
          conversationState: { in: Array.from(RUNTIME_TERMINAL_STATES) as ConversationState[] },
        },
      }),
    ]);

    // waitingSince coverage
    const waitingSinceCount = await this.prisma.threadContext.count({
      where: { lead: { userId }, waitingSince: { not: null } },
    });

    // Open handoffs (requested but not resolved)
    const handoffOpen = await this.prisma.threadContext.count({
      where: {
        lead: { userId },
        handoffRequestedAt: { not: null },
        handoffResolvedAt: null,
      },
    });

    // Stale waiting threads (waitingSince > N hours)
    const staleWaiting = await this.prisma.threadContext.count({
      where: {
        lead: { userId },
        waitingSince: { lt: new Date(Date.now() - STALE_WAITING_HOURS * 60 * 60 * 1000) },
      },
    });

    // Runtime fields updated in last 24h
    const updatedLast24h = {
      conversationState: await this.prisma.threadContext.count({
        where: { lead: { userId }, conversationStateAt: { gte: since24h } },
      }),
      aiStatus: await this.prisma.threadContext.count({
        where: { lead: { userId }, aiStatusAt: { gte: since24h } },
      }),
      classifiedIntent: await this.prisma.threadContext.count({
        where: { lead: { userId }, lastClassifiedAt: { gte: since24h } },
      }),
      handoffRequested: await this.prisma.threadContext.count({
        where: { lead: { userId }, handoffRequestedAt: { gte: since24h } },
      }),
      sfJobOutcome: await this.prisma.lead.count({
        where: { userId, sfJobOutcomeAt: { gte: since24h } },
      }),
    };

    const totalThreads = await this.prisma.threadContext.count({
      where: { lead: { userId } },
    });

    return {
      tenantUserId: userId,
      generatedAt: new Date().toISOString(),
      totals: {
        threadContexts: totalThreads,
        leadsSfLinked: sfLinkedTotal,
      },
      byConversationState: { ...byConversationState, _null: conversationStateNull },
      byAiStatus: { ...byAiStatus, _null: aiStatusNull },
      byLastClassifiedIntent,
      sfJobOutcomeCounts,
      sfOutcomeCoverage: {
        populated: sfOutcomePopulated,
        sfLinkedTotal,
        ratio: sfLinkedTotal === 0 ? null : sfOutcomePopulated / sfLinkedTotal,
      },
      mismatchCounts: {
        legacyTerminalRuntimeActive,
        runtimeTerminalLegacyActive,
      },
      waitingSinceCount,
      handoffOpen,
      staleWaiting,
      updatedLast24h,
    };
  }

  /**
   * Diagnostic report — same tenant scope, classifies threads by drift
   * category. Returns counts + up to N (default 5, max 20) example leadIds
   * per category so an operator can spot-check the underlying data without
   * exposing message bodies.
   */
  @Get('legacy-comparison')
  async legacyComparison(
    @CurrentUser() user: any,
    @Query('examplesPerCategory') examplesPerCategoryRaw?: string,
  ) {
    const userId = user.id;
    // Parse → clamp to [1, 20]. NaN (non-numeric input) falls back to 5;
    // explicit 0 or negative still gets clamped UP to 1 (not treated as
    // falsy → fallback, which would surprise callers).
    const parsed = parseInt(examplesPerCategoryRaw ?? '5', 10);
    const examplesPerCategory = Math.min(
      Math.max(Number.isFinite(parsed) ? parsed : 5, 1),
      20,
    );

    // Each category: { description, count, examples: leadId[] }.
    // Queries are deliberately separate (not joined) for clarity over
    // perf — diagnostic endpoint, not a hot path.

    const cat = async (
      description: string,
      where: any,
      ordering: any = { updatedAt: 'desc' },
    ) => {
      const count = await this.prisma.threadContext.count({ where });
      const examples = await this.prisma.threadContext.findMany({
        where,
        select: {
          leadId: true,
          lead: { select: { id: true, status: true, platform: true } },
          conversationState: true,
          conversationStateReason: true,
          aiStatus: true,
          aiStatusReason: true,
          waitingSince: true,
          handoffRequestedAt: true,
          handoffResolvedAt: true,
          lastCustomerMessageAt: true,
          lastClassifiedAt: true,
          updatedAt: true,
        },
        orderBy: ordering,
        take: examplesPerCategory,
      });
      return {
        description,
        count,
        examples: examples.map((e) => ({
          leadId: e.leadId ?? e.lead?.id ?? null,
          platform: e.lead?.platform ?? null,
          legacyStatus: e.lead?.status ?? null,
          conversationState: e.conversationState,
          conversationStateReason: e.conversationStateReason,
          aiStatus: e.aiStatus,
          aiStatusReason: e.aiStatusReason,
          waitingSince: e.waitingSince,
          handoffRequestedAt: e.handoffRequestedAt,
          handoffResolvedAt: e.handoffResolvedAt,
          lastCustomerMessageAt: e.lastCustomerMessageAt,
          lastClassifiedAt: e.lastClassifiedAt,
        })),
      };
    };

    const leadCat = async (
      description: string,
      where: any,
      ordering: any = { updatedAt: 'desc' },
    ) => {
      const count = await this.prisma.lead.count({ where });
      const examples = await this.prisma.lead.findMany({
        where,
        select: {
          id: true,
          platform: true,
          status: true,
          statusSource: true,
          sfJobOutcome: true,
          sfJobOutcomeAt: true,
          sfJobId: true,
          sfLastEventAt: true,
        },
        orderBy: ordering,
        take: examplesPerCategory,
      });
      return {
        description,
        count,
        examples: examples.map((e) => ({
          leadId: e.id,
          platform: e.platform,
          legacyStatus: e.status,
          statusSource: e.statusSource,
          sfJobOutcome: e.sfJobOutcome,
          sfJobOutcomeAt: e.sfJobOutcomeAt,
          sfJobId: e.sfJobId,
          sfLastEventAt: e.sfLastEventAt,
        })),
      };
    };

    const userScope = { lead: { userId } };
    const now = new Date();
    const handoffStaleCutoff = new Date(now.getTime() - HANDOFF_STALE_HOURS * 60 * 60 * 1000);
    const classifierCutoff = new Date(now.getTime() - CLASSIFIER_MISSING_HOURS * 60 * 60 * 1000);

    const categories = {
      legacy_status_terminal_but_runtime_active: await cat(
        'Lead.status is terminal but conversationState says active (UI would show Done/No-hire while runtime thinks conversation is alive)',
        {
          ...userScope,
          lead: { userId, status: { in: Array.from(LEGACY_TERMINAL_STATUSES) } },
          conversationState: { in: Array.from(RUNTIME_ACTIVE_STATES) as ConversationState[] },
        },
      ),
      runtime_terminal_but_legacy_active: await cat(
        'conversationState is terminal but Lead.status says active (runtime decided this is opted_out/booked_in_lb but the CRM pipeline still shows engaged)',
        {
          ...userScope,
          lead: { userId, status: { notIn: Array.from(LEGACY_TERMINAL_STATUSES) } },
          conversationState: { in: Array.from(RUNTIME_TERMINAL_STATES) as ConversationState[] },
        },
      ),
      sf_outcome_present_but_lead_status_not_sf_owned: await leadCat(
        'sfJobOutcome is populated but Lead.status was last written by a non-SF source (manual override after SF event)',
        {
          userId,
          sfJobOutcome: { not: null },
          statusSource: { not: 'service_flow' },
        },
      ),
      ai_disabled_but_runtime_active: await cat(
        'User.aiConversationEnabled=false (so AI should be disabled) but ThreadContext.aiStatus is something other than disabled — most likely a stale runtime value from before the user toggled AI off',
        {
          ...userScope,
          lead: { userId, user: { aiConversationEnabled: false } },
          aiStatus: { notIn: ['disabled', null] as any },
        },
      ),
      waiting_customer_without_waitingSince: await cat(
        'awaitingCustomerReply=true but waitingSince is null (legacy thread that pre-dates waitingSince writes and has not had a fresh pro message since deploy)',
        {
          ...userScope,
          lead: { userId },
          awaitingCustomerReply: true,
          waitingSince: null,
        },
      ),
      handoff_requested_without_resolution: await cat(
        `handoffRequestedAt > ${HANDOFF_STALE_HOURS}h ago and handoffResolvedAt is null — a human-takeover signal that no one acted on`,
        {
          ...userScope,
          lead: { userId },
          handoffRequestedAt: { not: null, lt: handoffStaleCutoff },
          handoffResolvedAt: null,
        },
      ),
      classifier_intent_missing_recent_inbound: await cat(
        `Customer sent a message in the last ${CLASSIFIER_MISSING_HOURS}h but lastClassifiedAt is null OR older than lastCustomerMessageAt (classifier didn't run or fell back to phrase list)`,
        {
          ...userScope,
          lead: { userId },
          lastCustomerMessageAt: { gte: classifierCutoff },
          OR: [
            { lastClassifiedAt: null },
            // Heuristic: classifier ran more than 5 min before the last
            // customer message → likely a different inbound or stale.
            { lastClassifiedAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) } },
          ],
        },
      ),
    };

    return {
      tenantUserId: userId,
      generatedAt: now.toISOString(),
      examplesPerCategory,
      categories,
    };
  }
}
