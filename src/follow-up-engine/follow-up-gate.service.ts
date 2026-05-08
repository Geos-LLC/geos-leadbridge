/**
 * Follow-Up Gate Service
 *
 * Single source of truth for "should this follow-up fire?" decisions, shared
 * between the scheduler (cron path) and the preview controller (UI path).
 * Without this, the two paths drift — the preview endpoint historically called
 * the generator directly, bypassing the classifier gate, so users could see
 * AI-generated follow-up text for customers who had explicitly opted out.
 *
 * This service is PURE EVALUATION:
 *   - Reads latest customer message + recent history + lead context
 *   - Calls the LLM classifier
 *   - Returns a decision { action, intent, confidence, ... }
 *
 * Side effects (stopEnrollment + writeStatus) live with the caller. Scheduler
 * applies them; preview just returns the decision to the UI.
 *
 * Determinism guarantee:
 *   For the same (conversationId, leadId, triggerState) + same DB state,
 *   evaluate() returns the same decision modulo classifier non-determinism
 *   (LLM returns ≥0.85 typically, so practical drift is small). The
 *   `recentHistory` window is fixed at 5 turns so context is identical.
 */

import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';
import {
  IntentClassifierService,
  IntentClassification,
  CustomerIntent,
} from '../ai/intent-classifier.service';

/**
 * Confidence below which we pass through to generation. False-positive on a
 * terminal intent stops a legitimate follow-up. Aligned with the AI
 * Conversation gate threshold to keep classifier semantics consistent across
 * inbound-reply and scheduled-followup paths.
 */
export const GATE_CONFIDENCE_THRESHOLD = 0.7;

export type GateAction =
  | 'proceed'              // gate passed; caller may generate + send
  | 'block_terminal'       // classifier surfaced terminal intent (opt_out / hired_elsewhere / completed / agreed / deferring)
  | 'pass_no_message'      // no customer message yet → nothing to classify (initial outreach)
  | 'pass_low_confidence'  // classifier returned but below threshold
  | 'pass_classifier_failed' // classifier threw or LLM unavailable → fail open
  | 'pass_re_engagement';  // re-engagement sequence on non-opt_out terminal intent (sequence purpose IS to message paused/lost customers)

export type GateSideEffect = 'stop_and_lost' | 'stop_and_booked' | 'stop_only' | 'none';

export interface GateInput {
  conversationId: string;
  /** Optional — preview may have one, scheduler always does */
  enrollmentId?: string;
  /** Lead id for status flip in caller's side-effect handling */
  leadId?: string | null;
  /** Re-engagement sequences (`customer_deferred`, `customer_hired_competitor`)
   *  bypass the gate for non-opt_out terminal intents because their entire
   *  purpose is to message paused/lost customers. */
  triggerState?: string | null;
}

export interface GateDecision {
  action: GateAction;
  /** True only when the caller should NOT proceed to generation */
  shouldBlock: boolean;
  /** Side effect the caller should apply — scheduler does these, preview does not */
  sideEffect: GateSideEffect;
  /** Intent surfaced by classifier; null if classifier didn't run or failed */
  intent: CustomerIntent | null;
  confidence: number;
  /** Human-readable summary suitable for logs + UI display */
  reason: string;
  /** Raw classifier output (for audit logs) */
  classifierReason: string | null;
  /** True if the classifier was actually invoked (false on no-message / no-conversation) */
  classifierRan: boolean;
}

@Injectable()
export class FollowUpGateService {
  private readonly logger = new Logger(FollowUpGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly intentClassifier: IntentClassifierService,
  ) {}

  /**
   * Evaluate whether a follow-up should be allowed to fire.
   *
   * Reads ONLY — no DB mutations. Caller is responsible for stopEnrollment +
   * writeStatus per the returned `sideEffect`.
   */
  async evaluate(input: GateInput): Promise<GateDecision> {
    if (!input.conversationId) {
      return this.passDecision('pass_no_message', 'no conversation id');
    }

    // Latest customer message — single source of truth for intent.
    // Production-scheduler and preview MUST select the same message via
    // identical query. Any divergence here is a path-drift bug.
    const lastCustomer = await this.prisma.message.findFirst({
      where: { conversationId: input.conversationId, sender: 'customer' },
      orderBy: { createdAt: 'desc' },
      select: { content: true, createdAt: true },
    });
    if (!lastCustomer || !lastCustomer.content) {
      return this.passDecision('pass_no_message', 'no customer message in thread');
    }

    // Tight 5-turn window — the classifier only needs the recent shape of the
    // conversation to disambiguate things like "already done" (booking that
    // ran successfully vs hired-someone vs canceled).
    const recent = await this.prisma.message.findMany({
      where: { conversationId: input.conversationId },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { sender: true, content: true },
    });
    const recentHistory = recent.reverse().map((m: any) => ({
      role: (m.sender === 'customer' ? 'customer' : 'pro') as 'customer' | 'pro',
      content: m.content || '',
    }));

    let leadStatus: string | undefined;
    let leadCategory: string | undefined;
    if (input.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: input.leadId },
        select: { status: true, category: true },
      });
      leadStatus = lead?.status ?? undefined;
      leadCategory = lead?.category ?? undefined;
    }

    let classification: IntentClassification;
    try {
      classification = await this.intentClassifier.classify({
        message: lastCustomer.content,
        recentHistory,
        leadStatus,
        leadCategory,
      });
    } catch (err: any) {
      // Classifier failure is non-fatal — fall through to generation. The
      // existing follow-up engine guards (terminal status, customer-replied-
      // since-enrollment) are the safety net on the scheduler side. Preview
      // path will still attempt generation but will surface the failure
      // reason in logs.
      this.logger.warn(`[FollowUpGate] Classifier threw — passing through (${err.message})`);
      return {
        action: 'pass_classifier_failed',
        shouldBlock: false,
        sideEffect: 'none',
        intent: null,
        confidence: 0,
        reason: `classifier_failed: ${err.message}`,
        classifierReason: null,
        classifierRan: false,
      };
    }

    if (!classification.fromLlm) {
      return {
        action: 'pass_classifier_failed',
        shouldBlock: false,
        sideEffect: 'none',
        intent: null,
        confidence: 0,
        reason: `classifier_fallback: ${classification.reason}`,
        classifierReason: classification.reason,
        classifierRan: false,
      };
    }

    if (classification.confidence < GATE_CONFIDENCE_THRESHOLD) {
      return {
        action: 'pass_low_confidence',
        shouldBlock: false,
        sideEffect: 'none',
        intent: classification.intent,
        confidence: classification.confidence,
        reason: `low_confidence: ${classification.intent} @ ${classification.confidence.toFixed(2)}`,
        classifierReason: classification.reason,
        classifierRan: true,
      };
    }

    const intent = classification.intent;

    // Pass-through for non-terminal intents — customer is engaged or asking.
    if (intent === 'asking' || intent === 'engaged') {
      return {
        action: 'proceed',
        shouldBlock: false,
        sideEffect: 'none',
        intent,
        confidence: classification.confidence,
        reason: `non_terminal: ${intent}`,
        classifierReason: classification.reason,
        classifierRan: true,
      };
    }

    // Re-engagement bypass: sequences whose entire purpose is to message
    // paused/lost customers must NOT be stopped on deferring/completed/hired/
    // agreed intents. They DO still stop on opt_out (explicit unsubscribe).
    const isReEngagementSequence = input.triggerState === 'customer_deferred'
      || input.triggerState === 'customer_hired_competitor';
    if (isReEngagementSequence && intent !== 'opt_out') {
      this.logger.log(`[FollowUpGate] re-engagement bypass: intent=${intent} conf=${classification.confidence.toFixed(2)} triggerState=${input.triggerState}`);
      return {
        action: 'pass_re_engagement',
        shouldBlock: false,
        sideEffect: 'none',
        intent,
        confidence: classification.confidence,
        reason: `re_engagement_bypass: ${intent} on ${input.triggerState}`,
        classifierReason: classification.reason,
        classifierRan: true,
      };
    }

    // Terminal-state intent on a non-re-engagement sequence — block.
    const sideEffect: GateSideEffect = intent === 'agreed'
      ? 'stop_and_booked'
      : intent === 'deferring'
        ? 'stop_only'
        : 'stop_and_lost';

    this.logger.log(`[FollowUpGate] BLOCK intent=${intent} conf=${classification.confidence.toFixed(2)} reason="${classification.reason}" sideEffect=${sideEffect}`);

    return {
      action: 'block_terminal',
      shouldBlock: true,
      sideEffect,
      intent,
      confidence: classification.confidence,
      reason: `terminal_${intent}`,
      classifierReason: classification.reason,
      classifierRan: true,
    };
  }

  private passDecision(action: GateAction, reason: string): GateDecision {
    return {
      action,
      shouldBlock: false,
      sideEffect: 'none',
      intent: null,
      confidence: 0,
      reason,
      classifierReason: null,
      classifierRan: false,
    };
  }
}
