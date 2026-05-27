/**
 * ConversationRuntimeService — Phase 1 parallel-write helper.
 *
 * Every method is best-effort:
 *   - never throws to the caller (failures are logged and swallowed)
 *   - uses `updateMany` so a missing ThreadContext silently no-ops
 *     (the ThreadContext is owned by ConversationContextService and may
 *     not exist yet on the first message; that's fine — we'll start
 *     writing once it does)
 *   - never mutates fields outside the new Phase 1 columns
 *
 * Phase 1's contract: zero behavior change. These writes feed the UI and
 * future read paths only. Legacy decision logic still reads from Lead.status,
 * Message.senderType recency windows, and ephemeral classifier outputs.
 *
 * Vocabulary lives in `./conversation-runtime.ts`.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

export interface ConversationStateInput {
  state?: string | null;
  reason?: string | null;
}

export interface AiStatusInput {
  status?: string | null;
  reason?: string | null;
}

export interface ClassifierIntentInput {
  intent: string;
  confidence?: number | null;
}

/**
 * Optional context for structured logging. Callers pass what they already
 * know (no extra DB lookups) — every field is optional.
 */
export interface RuntimeWriteMeta {
  leadId?: string | null;
  userId?: string | null;
  sourceEventId?: string | null;
}

@Injectable()
export class ConversationRuntimeService {
  private readonly logger = new Logger(ConversationRuntimeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Standard structured-log line. Loki/dashboards filter on `event=` and
   * `conversation_id=`. No customer PII/message body is ever logged here —
   * only state fields, leadId/userId/sourceEventId.
   */
  private logRuntimeWrite(
    event: string,
    conversationId: string,
    fields: Record<string, any>,
    meta: RuntimeWriteMeta | undefined,
  ): void {
    const parts = [
      `[ConversationRuntime] event=${event}`,
      `conversation_id=${conversationId}`,
    ];
    for (const [k, v] of Object.entries(fields)) {
      const value = v === null || v === undefined ? 'null' : String(v);
      parts.push(`${k}=${value}`);
    }
    if (meta?.leadId) parts.push(`lead_id=${meta.leadId}`);
    if (meta?.userId) parts.push(`user_id=${meta.userId}`);
    if (meta?.sourceEventId) parts.push(`source_event_id=${meta.sourceEventId}`);
    this.logger.log(parts.join(' '));
  }

  /**
   * Write conversationState + (optionally) reason. Bumps conversationStateAt
   * on every state write. Call with `{state: null}` to clear.
   */
  async setConversationState(
    conversationId: string | null | undefined,
    input: ConversationStateInput,
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    const data: Record<string, any> = {};
    if (input.state !== undefined) {
      data.conversationState = input.state;
      data.conversationStateAt = new Date();
    }
    if (input.reason !== undefined) {
      data.conversationStateReason = input.reason;
    }
    if (Object.keys(data).length === 0) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data,
      });
      this.logRuntimeWrite(
        'conversation_state_write',
        conversationId,
        { new_state: input.state ?? null, reason: input.reason ?? null },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] setConversationState failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Write aiStatus + (optionally) reason. Bumps aiStatusAt on every write.
   */
  async setAiStatus(
    conversationId: string | null | undefined,
    input: AiStatusInput,
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    const data: Record<string, any> = {};
    if (input.status !== undefined) {
      data.aiStatus = input.status;
      data.aiStatusAt = new Date();
    }
    if (input.reason !== undefined) {
      data.aiStatusReason = input.reason;
    }
    if (Object.keys(data).length === 0) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data,
      });
      this.logRuntimeWrite(
        'ai_status_write',
        conversationId,
        { new_status: input.status ?? null, reason: input.reason ?? null },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] setAiStatus failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Convenience: write conversationState + aiStatus atomically in one
   * updateMany. Both optional. Use this when a single event drives both
   * (e.g. classifier=opt_out → state=opted_out + ai=stopped_terminal).
   */
  async setState(
    conversationId: string | null | undefined,
    input: {
      conversationState?: string | null;
      conversationStateReason?: string | null;
      aiStatus?: string | null;
      aiStatusReason?: string | null;
    },
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    const now = new Date();
    const data: Record<string, any> = {};
    if (input.conversationState !== undefined) {
      data.conversationState = input.conversationState;
      data.conversationStateAt = now;
    }
    if (input.conversationStateReason !== undefined) {
      data.conversationStateReason = input.conversationStateReason;
    }
    if (input.aiStatus !== undefined) {
      data.aiStatus = input.aiStatus;
      data.aiStatusAt = now;
    }
    if (input.aiStatusReason !== undefined) {
      data.aiStatusReason = input.aiStatusReason;
    }
    if (Object.keys(data).length === 0) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data,
      });
      this.logRuntimeWrite(
        'state_write',
        conversationId,
        {
          new_conversation_state: input.conversationState ?? null,
          conversation_reason: input.conversationStateReason ?? null,
          new_ai_status: input.aiStatus ?? null,
          ai_reason: input.aiStatusReason ?? null,
        },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] setState failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Persist the most recent classifier output. Allows the UI to surface
   * "customer asked for human 10 min ago" without re-classifying.
   */
  async recordClassifierIntent(
    conversationId: string | null | undefined,
    input: ClassifierIntentInput,
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId || !input?.intent) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          lastClassifiedIntent: input.intent,
          lastClassifiedConfidence: input.confidence ?? null,
          lastClassifiedAt: new Date(),
        },
      });
      this.logRuntimeWrite(
        'classifier_intent_write',
        conversationId,
        { intent: input.intent, confidence: input.confidence ?? null },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] recordClassifierIntent failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Mark a handoff as requested. Resets any prior resolution so the badge
   * surfaces for the new event.
   */
  async setHandoffRequested(
    conversationId: string | null | undefined,
    reason: string,
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      await this.prisma.threadContext.updateMany({
        where: { conversationId },
        data: {
          handoffRequestedAt: new Date(),
          handoffRequestedReason: reason,
          handoffResolvedAt: null,
        },
      });
      this.logRuntimeWrite(
        'handoff_write',
        conversationId,
        { action: 'requested', reason },
        meta,
      );
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] setHandoffRequested failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }

  /**
   * Resolve an outstanding handoff. WHERE clause ensures we only flip
   * conversations that actually had an open handoff — calling this
   * unconditionally on every manual reply is safe.
   */
  async resolveHandoff(
    conversationId: string | null | undefined,
    meta?: RuntimeWriteMeta,
  ): Promise<void> {
    if (!conversationId) return;
    try {
      const result = await this.prisma.threadContext.updateMany({
        where: {
          conversationId,
          handoffRequestedAt: { not: null },
          handoffResolvedAt: null,
        },
        data: { handoffResolvedAt: new Date() },
      });
      // Only log when a row actually flipped — resolveHandoff is called
      // unconditionally on every manual reply, so most invocations are no-ops.
      if (result.count > 0) {
        this.logRuntimeWrite(
          'handoff_write',
          conversationId,
          { action: 'resolved' },
          meta,
        );
      }
    } catch (e: any) {
      this.logger.warn(
        `[ConvRuntime] resolveHandoff failed conversation_id=${conversationId} err=${e?.message ?? e}`,
      );
    }
  }
}
