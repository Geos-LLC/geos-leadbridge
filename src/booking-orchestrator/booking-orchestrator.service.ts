/**
 * BookingOrchestratorService — Phase 2B PR-B2.
 *
 * State machine that owns the LB-side booking *attempt*. It's the only
 * code path that calls SfOrchestrationClient from runtime — and only
 * when BOOKING_ORCHESTRATION_ENABLED_USER_IDS includes the tenant.
 *
 * Public entry points (all flag-gated, all best-effort):
 *
 *   handleClassifiedIntent(input)
 *     Called by automation.service after intent classification. Routes:
 *       - intent=wants_to_schedule + bookingState=idle → start preference gather
 *       - intent=wants_to_schedule + bookingState=offering_slots/awaiting_slot_selection
 *         → treat as slot selection
 *       - everything else: no-op (the customer reply lands in the
 *         existing AI/handoff paths)
 *
 *   handleServiceOutcomeEvent(input)
 *     Called by the SF orchestration-event endpoint. Mirrors
 *     service_scheduled / service_rescheduled / service_cancelled /
 *     service_completed into bookingState + aiStatus + conversationState
 *     + Lead.sfJobOutcome. Idempotent on (event_id, sfJobId).
 *
 * Safety properties enforced in this service:
 *  1. No duplicate bookings — booking-request is only submitted when
 *     bookingState ∈ {gathering_preferences, awaiting_slot_selection,
 *     booking_failed}. Once in booking_requested or service_*, re-entry
 *     short-circuits.
 *  2. No retry storms — bookingAttemptCount caps at MAX_ATTEMPTS; over
 *     that, we fall back to handoff.
 *  3. No stale slot acceptance — SF returns 410 slot_token_expired which
 *     transitions to booking_failed/no_availability and re-queries.
 *  4. No cross-tenant leakage — every SF call carries sigcoreBusinessId
 *     from the SavedAccount; the feature flag is per-userId.
 *  5. No Lead.status writes — only sfJobOutcome (additive mirror) is
 *     touched by the service event handler.
 *
 * Outbound message sending (the slot offer text + the confirmation) is
 * intentionally NOT wired in PR-B2. The orchestrator computes the text
 * via SlotPhrasingService but returns it to the caller. PR-B2 ships with
 * flag OFF, so no callers actually wire the return text into the SMS
 * path. PR-B2 verification observes that no [SfOrchestration] /
 * [BookingOrchestrator] activity reaches production; tenant-2 enablement
 * is a separate explicit step.
 */

import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../common/utils/prisma.service';
import { BookingRuntimeService } from '../conversation-context/booking-runtime.service';
import { ConversationRuntimeService } from '../conversation-context/conversation-runtime.service';
import {
  AI_STATUS_REASONS,
  CONVERSATION_STATE_REASONS,
} from '../conversation-context/conversation-runtime';
import {
  BOOKING_FAILURE_REASONS,
  BOOKING_STATE_REASONS,
  isBookingActiveState,
  type BookingState,
} from '../conversation-context/booking-runtime';
import { OrchestrationFeatureFlag } from '../sf-orchestration/orchestration-feature-flag';
import { SfOrchestrationClient } from '../sf-orchestration/sf-orchestration.client';
import type { TimeSlot } from '../sf-orchestration/sf-orchestration.contracts';
import { SlotPhrasingService } from './slot-phrasing.service';

const MAX_BOOKING_ATTEMPTS = 3;
/** How recent the proposedTimeSlots must be when the customer picks one. */
const SLOT_FRESHNESS_MS = 15 * 60 * 1000;

export type OrchestratorEntryIntent =
  | 'wants_to_schedule'
  | 'customer_reply_mid_flow';

export interface OrchestratorClassifiedInput {
  userId: string;
  leadId: string;
  conversationId: string;
  /** The customer's latest message — used to parse slot selection. */
  customerMessage: string;
  intent: OrchestratorEntryIntent;
  /** Optional Sigcore business id (from SavedAccount). Required for actual SF calls; flag-OFF tenants skip out before this matters. */
  sigcoreBusinessId?: string | null;
  /** Service category — passed through to SF for slot filtering. */
  serviceType?: string | null;
  /** For backwards-compat handoff fall-through if booking flow can't proceed. */
  accountName?: string | null;
}

export interface OrchestratorOutcome {
  /** What the orchestrator decided to do. */
  decision:
    | 'flag_disabled'              // BOOKING_ORCHESTRATION_ENABLED_USER_IDS does not include userId
    | 'thread_missing'             // ThreadContext lookup failed
    | 'already_in_flight'          // bookingState is active, re-entry suppressed
    | 'terminal_state'             // bookingState is a service_* terminal, no action
    | 'started_gathering'          // entered gathering_preferences
    | 'awaiting_availability'      // queried SF availability
    | 'offering_slots'             // slots returned, SF AI-phrased
    | 'no_availability'            // SF returned empty slots
    | 'submitted_booking_request'  // booking-request submitted to SF
    | 'booking_accepted'           // SF 2xx for booking-request
    | 'booking_failed_retryable'   // 409/410 — re-query availability
    | 'booking_failed_terminal'    // 422 / max attempts — handoff
    | 'orchestration_disabled'     // SF returned 403 or env unset — fall back to handoff
    | 'no_op';                     // intent did not match any state action
  /** Optional message text the caller may send. Empty when there's nothing to say. */
  outboundMessage?: string;
  /** Reason tag for observability. */
  reason?: string;
}

export interface ServiceOutcomeEventInput {
  /** Unique inbound event id — used for idempotency tracking by the caller. */
  eventId: string;
  /** Which SF event we received. */
  eventType:
    | 'service_scheduled'
    | 'service_rescheduled'
    | 'service_cancelled'
    | 'service_completed';
  /** SF's job id. */
  sfJobId: string;
  /** The LB userId resolved from the inbound subscription. */
  userId: string;
  /** The LB leadId resolved by the caller. */
  leadId: string;
  /** Conversation id (== Lead.threadId). */
  conversationId: string | null;
  /** SF's reported scheduled-for time (ISO-8601). Optional. */
  scheduledFor?: string | null;
  /** Optional updated slot for service_rescheduled. */
  rescheduledSlot?: TimeSlot | null;
  /** Optional reason from SF, e.g. cancellation note. */
  reason?: string | null;
}

@Injectable()
export class BookingOrchestratorService {
  private readonly logger = new Logger(BookingOrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flag: OrchestrationFeatureFlag,
    private readonly sf: SfOrchestrationClient,
    private readonly bookingRuntime: BookingRuntimeService,
    private readonly conversationRuntime: ConversationRuntimeService,
    private readonly slotPhrasing: SlotPhrasingService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════
  // Entry point 1: from automation.service after classifier
  // ═══════════════════════════════════════════════════════════════════════

  async handleClassifiedIntent(input: OrchestratorClassifiedInput): Promise<OrchestratorOutcome> {
    // Hard gate — anything below this line is suppressed for non-canary tenants.
    // As of PR-C1 the gate consults SfConnectionResolver (DB → env → none),
    // so await is required.
    if (!(await this.flag.isEnabledForUser(input.userId))) {
      return { decision: 'flag_disabled' };
    }

    const ctx = await this.loadThreadContext(input.conversationId);
    if (!ctx) {
      return { decision: 'thread_missing' };
    }

    const currentState = (ctx.bookingState ?? 'idle') as BookingState;
    const log = (event: string, fields: Record<string, unknown> = {}) =>
      this.log('orchestrator', event, input.conversationId, {
        ...fields,
        lead_id: input.leadId,
        user_id: input.userId,
        current_state: currentState,
      });

    // Re-entry guard: if we're already in service_* terminal, ignore further customer messages.
    if (
      currentState === 'service_scheduled' ||
      currentState === 'service_rescheduled' ||
      currentState === 'service_completed'
    ) {
      log('terminal_state_reentry', { intent: input.intent });
      return { decision: 'terminal_state' };
    }

    // Already submitted to SF — wait for the inbound event. Do not double-submit.
    if (currentState === 'booking_requested') {
      log('already_in_flight', { intent: input.intent });
      return { decision: 'already_in_flight' };
    }

    // Max-attempts trip → handoff fallback.
    if ((ctx.bookingAttemptCount ?? 0) >= MAX_BOOKING_ATTEMPTS) {
      log('max_attempts_reached', { attempts: ctx.bookingAttemptCount });
      await this.fallBackToHandoff(input, 'max_attempts_reached');
      return { decision: 'booking_failed_terminal', reason: 'max_attempts_reached' };
    }

    // ── Branch on current state ─────────────────────────────────────────
    if (currentState === 'idle' || currentState === 'service_cancelled') {
      // Fresh entry → start gathering preferences.
      await this.bookingRuntime.setBookingState(
        input.conversationId,
        {
          state: 'gathering_preferences',
          reason: BOOKING_STATE_REASONS.CLASSIFIER_WANTS_TO_SCHEDULE,
        },
        { leadId: input.leadId, userId: input.userId },
      );
      log('started_gathering');
      return { decision: 'started_gathering' };
    }

    if (currentState === 'gathering_preferences' || currentState === 'booking_failed') {
      // Customer provided a follow-up; treat as readiness for availability.
      return this.queryAvailability(input, ctx);
    }

    if (
      currentState === 'offering_slots' ||
      currentState === 'awaiting_slot_selection'
    ) {
      // Customer picked (or re-picked) a slot.
      return this.handleSlotSelection(input, ctx);
    }

    if (currentState === 'awaiting_availability') {
      // SF call already in flight from a prior message; do nothing.
      log('awaiting_availability_reentry');
      return { decision: 'already_in_flight' };
    }

    log('no_op', { intent: input.intent });
    return { decision: 'no_op' };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Entry point 2: from /v1/integrations/service-flow/orchestration-event
  // ═══════════════════════════════════════════════════════════════════════

  async handleServiceOutcomeEvent(input: ServiceOutcomeEventInput): Promise<void> {
    // Defense-in-depth — drop events for tenants not enabled (DB or env).
    // SF dark-launch should not be sending events for non-canary tenants,
    // but we don't trust the upstream. PR-C1: gate is async.
    if (!(await this.flag.isEnabledForUser(input.userId))) {
      this.log('event_handler', 'flag_disabled', input.conversationId, {
        event_id: input.eventId,
        event_type: input.eventType,
        user_id: input.userId,
      });
      return;
    }

    const meta = {
      leadId: input.leadId,
      userId: input.userId,
      sourceEventId: input.eventId,
    };

    // Map SF event to bookingState terminal + sfJobOutcome.
    switch (input.eventType) {
      case 'service_scheduled': {
        await this.applySfOutcome(input, 'service_scheduled', 'scheduled', {
          aiStatus: 'stopped_booked',
          aiReason: AI_STATUS_REASONS.CLASSIFIER_AGREED,
          conversationState: 'booked_in_lb',
          conversationReason: CONVERSATION_STATE_REASONS.CLASSIFIER_AGREED,
          bookingReason: BOOKING_STATE_REASONS.SF_BOOKING_ACCEPTED,
        });
        break;
      }
      case 'service_rescheduled': {
        await this.applySfOutcome(input, 'service_rescheduled', 'scheduled', {
          // Do NOT restart AI — the booking is still live, just at a new time.
          // Keep aiStatus as stopped_booked (already set).
          bookingReason: BOOKING_STATE_REASONS.SF_RESCHEDULE_RECEIVED,
        });
        if (input.rescheduledSlot && input.conversationId) {
          await this.bookingRuntime.recordSlotSelected(
            input.conversationId,
            {
              slotId: input.rescheduledSlot.slotId,
              slotToken: input.rescheduledSlot.slotToken ?? null,
              start: input.rescheduledSlot.start,
              end: input.rescheduledSlot.end,
              selectedAt: new Date().toISOString(),
            },
            meta,
          );
        }
        break;
      }
      case 'service_cancelled': {
        await this.applySfOutcome(input, 'service_cancelled', 'cancelled', {
          // Per PR-B2 scope: bookingState=service_cancelled is a re-engageable
          // state. We intentionally do NOT restart AI in this PR — the
          // existing follow-up engine will continue to govern. A future PR
          // may opt customers back into a follow-up sequence here.
          bookingReason: BOOKING_STATE_REASONS.SF_CANCEL_RECEIVED,
        });
        break;
      }
      case 'service_completed': {
        await this.applySfOutcome(input, 'service_completed', 'completed', {
          aiStatus: 'stopped_terminal',
          aiReason: AI_STATUS_REASONS.CLASSIFIER_AGREED,
          // Conversation state stays booked_in_lb — the customer was a
          // customer of the service. We do not move them to a new state.
          bookingReason: BOOKING_STATE_REASONS.SF_COMPLETE_RECEIVED,
        });
        break;
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════════

  private async loadThreadContext(conversationId: string) {
    if (!conversationId) return null;
    return this.prisma.threadContext.findUnique({
      where: { conversationId },
      select: {
        bookingState: true,
        bookingAttemptCount: true,
        proposedTimeSlotsJson: true,
        bookingStateAt: true,
      },
    });
  }

  private async queryAvailability(
    input: OrchestratorClassifiedInput,
    _ctx: { bookingAttemptCount: number | null },
  ): Promise<OrchestratorOutcome> {
    if (!input.sigcoreBusinessId) {
      this.log('orchestrator', 'missing_sigcore_business_id', input.conversationId, {
        lead_id: input.leadId,
      });
      await this.fallBackToHandoff(input, 'missing_sigcore_business_id');
      return { decision: 'orchestration_disabled', reason: 'missing_sigcore_business_id' };
    }
    await this.bookingRuntime.setBookingState(
      input.conversationId,
      { state: 'awaiting_availability', reason: BOOKING_STATE_REASONS.PREFERENCES_GATHERED },
      { leadId: input.leadId, userId: input.userId },
    );

    const idem = `availability:${input.conversationId}:${Math.floor(Date.now() / 60_000)}`;
    // `requestedAt` is REQUIRED by SF (400 otherwise). Until preference
    // parsing lands, default to "now" — SF treats it as "earliest available"
    // and derives its own search_window from there. Future PR can pass a
    // customer-stated preferred time pulled out of the conversation.
    const res = await this.sf.getAvailability(
      {
        userId: input.userId,
        sigcoreBusinessId: input.sigcoreBusinessId,
        leadId: input.leadId,
        serviceType: input.serviceType ?? 'standard',
        requestedAt: new Date().toISOString(),
      },
      idem,
    );

    if (!res.ok) {
      if (res.code === 'orchestration_disabled') {
        await this.fallBackToHandoff(input, 'sf_orchestration_disabled');
        return { decision: 'orchestration_disabled', reason: res.code };
      }
      await this.bookingRuntime.recordBookingFailure(
        input.conversationId,
        {
          reason: this.mapErrorCodeToFailureReason(res.code),
          detail: res.message,
        },
        { leadId: input.leadId, userId: input.userId },
      );
      return { decision: 'booking_failed_terminal', reason: res.code };
    }

    // SF wire field is `candidate_slots[]`; the client normalizes to `candidateSlots`.
    // Reading `.slots` (pre-fix field name) would always be undefined → every probe
    // would terminate as no_availability even when SF returned real slots.
    const slots = res.data.candidateSlots ?? [];
    if (slots.length === 0) {
      await this.bookingRuntime.recordBookingFailure(
        input.conversationId,
        { reason: BOOKING_FAILURE_REASONS.NO_AVAILABILITY },
        { leadId: input.leadId, userId: input.userId },
      );
      return { decision: 'no_availability', reason: BOOKING_FAILURE_REASONS.NO_AVAILABILITY };
    }

    // Persist offer + phrase.
    const presentedAt = new Date().toISOString();
    await this.bookingRuntime.recordSlotsOffered(
      input.conversationId,
      slots.map((s) => ({
        slotId: s.slotId,
        slotToken: s.slotToken ?? null,
        start: s.start,
        end: s.end,
        cleanerId: s.cleanerId ?? null,
        providerCost: s.providerCost ?? null,
        presentedAt,
      })),
      { leadId: input.leadId, userId: input.userId },
    );

    const phrased = await this.slotPhrasing.phrase(slots, {
      accountName: input.accountName,
      serviceLabel: input.serviceType,
    });

    // Mark we are now awaiting the customer's pick. (recordSlotsOffered
    // wrote bookingState='offering_slots'; advance.)
    await this.bookingRuntime.setBookingState(
      input.conversationId,
      {
        state: 'awaiting_slot_selection',
        reason: BOOKING_STATE_REASONS.AI_OFFERED_SLOTS,
      },
      { leadId: input.leadId, userId: input.userId },
    );

    this.log('orchestrator', 'slots_offered', input.conversationId, {
      lead_id: input.leadId,
      user_id: input.userId,
      slot_count: slots.length,
      phrasing_source: phrased.source,
      fallback_reason: phrased.fallbackReason ?? 'none',
    });

    return {
      decision: 'offering_slots',
      outboundMessage: phrased.message,
      reason: `slots=${slots.length}`,
    };
  }

  private async handleSlotSelection(
    input: OrchestratorClassifiedInput,
    ctx: { proposedTimeSlotsJson: string | null; bookingStateAt: Date | null; bookingAttemptCount: number | null },
  ): Promise<OrchestratorOutcome> {
    const offered = this.parseSlots(ctx.proposedTimeSlotsJson);
    if (offered.length === 0) {
      // We don't have a fresh offer to match against — re-query.
      return this.queryAvailability(input, ctx);
    }

    // Staleness check — if offer is too old, re-query rather than risk a
    // stale slot acceptance.
    const presentedMs = ctx.bookingStateAt
      ? new Date(ctx.bookingStateAt).getTime()
      : 0;
    if (Date.now() - presentedMs > SLOT_FRESHNESS_MS) {
      this.log('orchestrator', 'offer_stale', input.conversationId, {
        lead_id: input.leadId,
        offer_age_ms: Date.now() - presentedMs,
      });
      return this.queryAvailability(input, ctx);
    }

    // Naive selection: customer typed a number ("1", "2") OR the slot's
    // labeled time. PR-B2 keeps this conservative — if we can't find a
    // confident match, fall through to handoff so we never book the
    // wrong slot.
    const picked = this.matchPickedSlot(input.customerMessage, offered);
    if (!picked) {
      this.log('orchestrator', 'no_confident_pick', input.conversationId, {
        lead_id: input.leadId,
        offered_count: offered.length,
      });
      // Don't fall back to handoff yet — just no-op so AI Conversation
      // can answer freely. The customer might be asking a clarifying
      // question rather than picking.
      return { decision: 'no_op', reason: 'no_confident_pick' };
    }

    if (!input.sigcoreBusinessId) {
      await this.fallBackToHandoff(input, 'missing_sigcore_business_id');
      return { decision: 'orchestration_disabled', reason: 'missing_sigcore_business_id' };
    }

    // Record selection + flip to booking_requested.
    await this.bookingRuntime.recordSlotSelected(
      input.conversationId,
      {
        slotId: picked.slotId,
        slotToken: picked.slotToken ?? null,
        start: picked.start,
        end: picked.end,
        selectedAt: new Date().toISOString(),
      },
      { leadId: input.leadId, userId: input.userId },
    );
    await this.bookingRuntime.recordBookingAttempt(input.conversationId, {
      leadId: input.leadId,
      userId: input.userId,
    });

    // Idempotency key includes slotId so retries for the same slot reuse
    // the same key, but a different slot pick after a 409 gets a new key.
    const idem = `booking-request:${input.conversationId}:${picked.slotId}`;
    const res = await this.sf.submitBookingRequest(
      {
        userId: input.userId,
        sigcoreBusinessId: input.sigcoreBusinessId,
        leadId: input.leadId,
        externalRequestId: input.leadId, // LB lead id doubles as the cross-system request id
        slotId: picked.slotId,
        slotToken: picked.slotToken ?? null,
        customerContact: {},
        serviceType: input.serviceType ?? 'standard',
      },
      idem,
    );

    if (res.ok) {
      // Do NOT write bookingState='service_scheduled' here — the inbound
      // event handler is the single source of truth for terminal SF
      // outcomes. We just log the synchronous SF acceptance.
      this.log('orchestrator', 'booking_accepted', input.conversationId, {
        lead_id: input.leadId,
        sf_job_id: res.data.sfJobId,
        scheduled_for: res.data.scheduledFor,
      });
      return {
        decision: 'booking_accepted',
        reason: 'sf_accepted',
      };
    }

    // SF rejected. Map to failure reason + decide retry/handoff.
    const failure = this.mapErrorCodeToFailureReason(res.code);
    await this.bookingRuntime.recordBookingFailure(
      input.conversationId,
      { reason: failure, detail: res.message },
      { leadId: input.leadId, userId: input.userId },
    );

    if (res.code === 'slot_taken' || res.code === 'slot_token_expired') {
      // Stale slot — re-query availability (still under MAX_BOOKING_ATTEMPTS).
      return this.queryAvailability(input, ctx);
    }
    if (res.code === 'orchestration_disabled') {
      await this.fallBackToHandoff(input, 'sf_orchestration_disabled');
      return { decision: 'orchestration_disabled', reason: res.code };
    }
    // validation_failed / not_found / 5xx / network/timeout → handoff.
    await this.fallBackToHandoff(input, `sf_${res.code}`);
    return { decision: 'booking_failed_terminal', reason: res.code };
  }

  private async applySfOutcome(
    input: ServiceOutcomeEventInput,
    bookingState: BookingState,
    sfJobOutcome: string,
    opts: {
      aiStatus?: string;
      aiReason?: string;
      conversationState?: string;
      conversationReason?: string;
      bookingReason: string;
    },
  ): Promise<void> {
    const meta = {
      leadId: input.leadId,
      userId: input.userId,
      correlationId: input.eventId,
      sfJobId: input.sfJobId,
    };

    // Lead.sfJobOutcome — additive mirror only (NOT Lead.status).
    // Stale-protected: only write if our recorded sfJobOutcomeAt is null
    // or older than now (defensive — SF events should arrive in order).
    const now = new Date();
    await this.prisma.lead.updateMany({
      where: {
        id: input.leadId,
        OR: [{ sfJobOutcomeAt: null }, { sfJobOutcomeAt: { lt: now } }],
      },
      data: {
        sfJobOutcome,
        sfJobOutcomeAt: now,
      },
    });

    if (!input.conversationId) {
      this.log('event_handler', 'no_conversation_id', null, {
        event_id: input.eventId,
        sf_job_id: input.sfJobId,
        sf_job_outcome: sfJobOutcome,
      });
      return;
    }

    await this.bookingRuntime.setBookingState(
      input.conversationId,
      { state: bookingState, reason: opts.bookingReason },
      meta,
    );

    if (opts.aiStatus !== undefined || opts.conversationState !== undefined) {
      await this.conversationRuntime.setState(
        input.conversationId,
        {
          aiStatus: opts.aiStatus,
          aiStatusReason: opts.aiReason,
          conversationState: opts.conversationState,
          conversationStateReason: opts.conversationReason,
        },
        meta,
      );
    }

    this.log('event_handler', 'applied', input.conversationId, {
      event_id: input.eventId,
      sf_job_id: input.sfJobId,
      sf_job_outcome: sfJobOutcome,
      booking_state: bookingState,
      ai_status: opts.aiStatus ?? 'unchanged',
      conversation_state: opts.conversationState ?? 'unchanged',
    });
  }

  private async fallBackToHandoff(
    input: OrchestratorClassifiedInput,
    reason: string,
  ): Promise<void> {
    // We do NOT fire handoff alert SMS from here — that path already runs
    // on intent='wants_to_schedule' through maybeFireHandoffAlert via the
    // classifier's handoff.reason='agreed' signal. We just mark the
    // conversation state so a dispatcher who looks at /runtime/debug sees
    // "handoff_requested" alongside the booking attempt.
    await this.conversationRuntime.setHandoffRequested(
      input.conversationId,
      `booking_fallback:${reason}`,
      { leadId: input.leadId, userId: input.userId },
    );
    this.log('orchestrator', 'handoff_fallback', input.conversationId, {
      lead_id: input.leadId,
      reason,
    });
  }

  private mapErrorCodeToFailureReason(code: string): string {
    switch (code) {
      case 'slot_taken':
        return BOOKING_FAILURE_REASONS.SLOT_TAKEN;
      case 'slot_token_expired':
        return BOOKING_FAILURE_REASONS.SLOT_TAKEN; // treat as stale-slot family for analytics
      case 'validation_failed':
        return BOOKING_FAILURE_REASONS.VALIDATION_FAILED;
      case 'orchestration_disabled':
      case 'not_found':
        return BOOKING_FAILURE_REASONS.SF_UNAVAILABLE;
      default:
        return BOOKING_FAILURE_REASONS.SF_UNAVAILABLE;
    }
  }

  private parseSlots(json: string | null): TimeSlot[] {
    if (!json) return [];
    try {
      const arr = JSON.parse(json);
      if (!Array.isArray(arr)) return [];
      return arr.filter(
        (s): s is TimeSlot =>
          s && typeof s.slotId === 'string' && typeof s.start === 'string',
      );
    } catch {
      return [];
    }
  }

  /**
   * Conservative slot matcher. We only return a slot if we're confident
   * — explicit "1" / "first" / "the 9am one" / a verbatim copy of the
   * formatted label. Ambiguity → null, which lets the AI Conversation
   * answer the customer rather than misbooking them.
   */
  private matchPickedSlot(message: string, slots: TimeSlot[]): TimeSlot | null {
    if (!message || slots.length === 0) return null;
    const lower = message.toLowerCase().trim();

    // 1-indexed numeric pick.
    const numMatch = lower.match(/(?:^|[^a-z0-9])(\d+)(?:[^a-z0-9]|$)/);
    if (numMatch) {
      const idx = parseInt(numMatch[1], 10) - 1;
      if (idx >= 0 && idx < slots.length) {
        // Sanity: number must be small (don't match a phone number etc.)
        if (numMatch[1].length <= 2) return slots[idx];
      }
    }

    // Ordinal words.
    const ordinalMap: Record<string, number> = {
      first: 0,
      second: 1,
      third: 2,
      fourth: 3,
      fifth: 4,
    };
    for (const [word, idx] of Object.entries(ordinalMap)) {
      if (lower.includes(word) && idx < slots.length) return slots[idx];
    }

    return null;
  }

  private log(
    scope: 'orchestrator' | 'event_handler',
    event: string,
    conversationId: string | null,
    fields: Record<string, unknown> = {},
  ): void {
    const parts = [
      `[BookingOrchestrator] scope=${scope} event=${event}`,
      `conversation_id=${conversationId ?? 'null'}`,
    ];
    for (const [k, v] of Object.entries(fields)) {
      parts.push(`${k}=${v === null || v === undefined ? 'null' : String(v)}`);
    }
    this.logger.log(parts.join(' '));
  }
}
