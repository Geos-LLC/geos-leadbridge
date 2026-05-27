/**
 * BookingRuntimeService — Phase 2B PR-B1 writer for the Phase 2A booking
 * fields on ThreadContext.
 *
 * Parallels ConversationRuntimeService: best-effort, never throws,
 * uses `updateMany` so a missing ThreadContext silently no-ops, never
 * mutates anything outside the 9 booking columns.
 *
 * Phase 2B PR-B1 contract: callable-but-uncalled. No runtime path
 * invokes these methods yet — PR-B2 wires them into the booking
 * orchestrator state machine. The service exists in PR-B1 so PR-B2
 * is a behavior-only PR (smaller diff, smaller blast radius).
 *
 * Field map (all on ThreadContext, all nullable, added by the Phase 2A
 * migration):
 *   bookingState           — discrete state token from BOOKING_STATES
 *   bookingStateAt         — bumped on every state write
 *   bookingStateReason     — canonical reason tag (see booking-runtime.ts)
 *   bookingRequestedAt     — when LB first submitted booking-request to SF
 *   proposedTimeSlotsJson  — JSON array of slots SF returned + we offered
 *   selectedTimeSlotJson   — JSON {slot, selectedAt} of customer pick
 *   bookingAttemptCount    — incremented on each booking-request submission
 *   lastBookingAttemptAt   — timestamp of most recent submission
 *   bookingFailureReason   — set when bookingState='booking_failed'
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import {
  isBookingState,
  type BookingState,
} from './booking-runtime';

export interface BookingStateInput {
  state: BookingState;
  reason?: string | null;
}

export interface SlotOfferedRecord {
  slotId: string;
  slotToken?: string | null;
  start: string;
  end: string;
  cleanerId?: string | null;
  providerCost?: number | null;
  /** ISO when LB presented this slot to the customer. */
  presentedAt: string;
}

export interface SlotSelectedRecord {
  slotId: string;
  slotToken?: string | null;
  start: string;
  end: string;
  /** ISO when the customer picked this slot. */
  selectedAt: string;
}

export interface BookingFailureInput {
  /** Canonical token from BOOKING_FAILURE_REASONS. */
  reason: string;
  /** Optional follow-on context to log alongside the write. */
  detail?: string | null;
}

export interface BookingWriteMeta {
  leadId?: string | null;
  userId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  sfJobId?: string | null;
}

@Injectable()
export class BookingRuntimeService {
  private readonly logger = new Logger(BookingRuntimeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Standard structured-log line. Same format as ConversationRuntimeService
   * for Grafana dashboard symmetry — operators can filter on
   * `event=booking_*` to scope to the booking runtime layer.
   */
  private logWrite(
    event: string,
    conversationId: string,
    fields: Record<string, unknown>,
    meta?: BookingWriteMeta,
  ): void {
    const parts = [
      `[BookingRuntime] event=${event}`,
      `conversation_id=${conversationId}`,
    ];
    for (const [k, v] of Object.entries(fields)) {
      const value = v === null || v === undefined ? 'null' : String(v);
      parts.push(`${k}=${value}`);
    }
    if (meta?.leadId) parts.push(`lead_id=${meta.leadId}`);
    if (meta?.userId) parts.push(`user_id=${meta.userId}`);
    if (meta?.correlationId) parts.push(`correlation_id=${meta.correlationId}`);
    if (meta?.idempotencyKey) parts.push(`idempotency_key=${meta.idempotencyKey}`);
    if (meta?.sfJobId) parts.push(`sf_job_id=${meta.sfJobId}`);
    this.logger.log(parts.join(' '));
  }

  /**
   * Write bookingState + reason. Bumps bookingStateAt. Rejects unknown
   * state strings (returns silently — never throws) so a typo in PR-B2
   * can't poison the column with garbage values.
   */
  async setBookingState(
    conversationId: string | null | undefined,
    input: BookingStateInput,
    meta?: BookingWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    if (!isBookingState(input.state)) {
      this.logger.warn(
        `[BookingRuntime] setBookingState rejected unknown state conversation_id=${conversationId} attempted_state=${input.state}`,
      );
      return;
    }
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          bookingState: input.state,
          bookingStateAt: new Date(),
          ...(input.reason !== undefined ? { bookingStateReason: input.reason } : {}),
        },
      });
      this.logWrite(
        'booking_state_write',
        conversationId,
        { new_state: input.state, reason: input.reason ?? null },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[BookingRuntime] setBookingState failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Record the slots SF returned and that LB presented to the customer.
   * Caps storage at the 5 most recent (write-side trim — schema is TEXT
   * but we don't want to bloat ThreadContext rows). Sets bookingState
   * to 'offering_slots' as a convenience.
   */
  async recordSlotsOffered(
    conversationId: string | null | undefined,
    slots: SlotOfferedRecord[],
    meta?: BookingWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    const trimmed = slots.slice(-5);
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          proposedTimeSlotsJson: JSON.stringify(trimmed),
          bookingState: 'offering_slots',
          bookingStateAt: new Date(),
        },
      });
      this.logWrite(
        'slots_offered',
        conversationId,
        { slot_count: trimmed.length },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[BookingRuntime] recordSlotsOffered failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Record the customer's slot pick. Sets bookingState to
   * 'awaiting_slot_selection' → caller transitions to 'booking_requested'
   * via setBookingState once SF submission begins.
   */
  async recordSlotSelected(
    conversationId: string | null | undefined,
    slot: SlotSelectedRecord,
    meta?: BookingWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          selectedTimeSlotJson: JSON.stringify(slot),
        },
      });
      this.logWrite(
        'slot_selected',
        conversationId,
        { slot_id: slot.slotId, start: slot.start },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[BookingRuntime] recordSlotSelected failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Record a booking-request submission. Increments bookingAttemptCount,
   * sets lastBookingAttemptAt + bookingRequestedAt (first attempt only),
   * and flips bookingState to 'booking_requested'.
   *
   * bookingRequestedAt is preserved across retries — only the FIRST
   * attempt sets it. That gives us a true "time to first attempt"
   * signal for observability.
   */
  async recordBookingAttempt(
    conversationId: string | null | undefined,
    meta?: BookingWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      const now = new Date();
      // Two-step: first preserve bookingRequestedAt iff null, then
      // increment + flip state. Single SQL would be cleaner but
      // updateMany w/ increment doesn't let us conditionally set null
      // fields. Two updates are still cheap.
      await this.prisma.threadContext.updateMany({
        where: { conversationId, bookingRequestedAt: null },
        data: { bookingRequestedAt: now },
      });
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          bookingAttemptCount: { increment: 1 },
          lastBookingAttemptAt: now,
          bookingState: 'booking_requested',
          bookingStateAt: now,
        },
      });
      this.logWrite('booking_attempt', conversationId, {}, meta);
    } catch (e: any) {
      this.logger.warn(
        `[BookingRuntime] recordBookingAttempt failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Record a terminal failure. Sets bookingState='booking_failed' and
   * writes bookingFailureReason. Idempotent — calling repeatedly with
   * the same reason is a no-op effect.
   */
  async recordBookingFailure(
    conversationId: string | null | undefined,
    input: BookingFailureInput,
    meta?: BookingWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          bookingState: 'booking_failed',
          bookingStateAt: new Date(),
          bookingFailureReason: input.reason,
        },
      });
      this.logWrite(
        'booking_failure',
        conversationId,
        { reason: input.reason, detail: input.detail ?? null },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[BookingRuntime] recordBookingFailure failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }
}
