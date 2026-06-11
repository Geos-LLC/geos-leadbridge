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
import { isSfLinkedLead } from '../leads/sf-link';

/**
 * Confidence below which we pass through to generation. False-positive on a
 * terminal intent stops a legitimate follow-up. Aligned with the AI
 * Conversation gate threshold to keep classifier semantics consistent across
 * inbound-reply and scheduled-followup paths.
 */
export const GATE_CONFIDENCE_THRESHOLD = 0.7;

export type GateAction =
  | 'proceed'              // gate passed; caller may generate + send
  | 'block_terminal'       // classifier surfaced terminal intent (opt_out / hired_elsewhere / agreed / deferring / terminal_defer)
  | 'block_sf_linked'      // lead is SF-linked (customer/job linked to ServiceFlow); LB stops chasing — no Lead.status flip
  | 'pass_no_message'      // no customer message yet → nothing to classify (initial outreach)
  | 'pass_low_confidence'  // classifier returned but below threshold
  | 'pass_classifier_failed' // classifier threw or LLM unavailable → fail open
  | 'pass_re_engagement';  // re-engagement sequence on `deferring` intent (bounded pause is the recoverable case the sequence is designed for)

export type GateSideEffect = 'stop_and_lost' | 'stop_and_booked' | 'stop_only' | 'none';

export interface GateInput {
  conversationId: string;
  /** Optional — preview may have one, scheduler always does */
  enrollmentId?: string;
  /** Lead id for status flip in caller's side-effect handling */
  leadId?: string | null;
  /** Re-engagement sequences (`customer_deferred`, `customer_hired_competitor`)
   *  bypass the gate ONLY on `deferring` intent — a bounded pause is the
   *  exact case the sequence is designed for. All other terminal intents
   *  (hired_elsewhere/agreed/opt_out/terminal_defer) stop the
   *  re-engagement just like a regular sequence. */
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
        // SF-link signals must be loaded here so the short-circuit below
        // can fire BEFORE the classifier call — avoids an LLM round-trip
        // and keeps the SF-connected-mode contract clean ("no LB chase
        // on linked leads").
        select: { status: true, category: true, sfJobId: true, sfCustomerId: true, syncStatus: true },
      });
      leadStatus = lead?.status ?? undefined;
      leadCategory = lead?.category ?? undefined;

      // SF-connected mode: lead is linked to an SF customer/job. SF owns
      // the customer/job lifecycle. Stop the follow-up — LB does not chase
      // leads that have already converted to SF customers. Side effect is
      // `stop_only` (not stop_and_lost) because the customer is NOT lost;
      // they are an active SF customer. No Lead.status mutation.
      if (lead && isSfLinkedLead(lead)) {
        this.logger.log(
          `[FollowUpGate] BLOCK sf_linked_customer conversation=${input.conversationId} lead=${input.leadId} sf_job_id=${lead.sfJobId ?? 'null'} sf_customer_id=${lead.sfCustomerId ?? 'null'} sync_status=${lead.syncStatus ?? 'null'}`,
        );
        return {
          action: 'block_sf_linked',
          shouldBlock: true,
          sideEffect: 'stop_only',
          intent: null,
          confidence: 0,
          reason: 'sf_linked_customer',
          classifierReason: null,
          classifierRan: false,
        };
      }
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
    // paused/lost customers should still send when the customer's most recent
    // signal is a BOUNDED pause (`deferring`) — that's a real recoverable case
    // ("back next month") and the whole point of the sequence is to land at
    // the stated return time.
    //
    // Other terminal intents do NOT bypass — they stop the re-engagement:
    //   - opt_out: explicit unsubscribe, never recoverable.
    //   - terminal_defer: unbounded "maybe later"; sending another attempt is
    //     the creepy-follow-up anti-pattern this gate exists to prevent.
    //   - hired_elsewhere: covers both "hired a competitor" AND "we're done
    //     with it" (Savanna 2026-05-12 case where customer said "Thank you!"
    //     after a dispatcher booking confirmation — previously classified as
    //     'completed', merged into hired_elsewhere 2026-06-03). Whether the
    //     close-out is from a competitor or just job-already-done, sending
    //     more re-engagements is the same anti-pattern. Stop.
    //   - agreed: customer accepted a booking. They are NOT a re-engagement
    //     target anymore — they converted. Handoff to the operator, don't
    //     keep messaging.
    const isReEngagementSequence = input.triggerState === 'customer_deferred'
      || input.triggerState === 'customer_hired_competitor';
    const bypassableInReEngagement = intent === 'deferring';
    if (isReEngagementSequence && bypassableInReEngagement) {
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
    // Side-effect mapping:
    //   agreed / wants_live_contact / wants_to_schedule → stop_and_booked  (positive handoff)
    //   deferring      → stop_only        (bounded pause; will re-engage later)
    //   terminal_defer → stop_and_lost    (unbounded deflection ≈ soft no)
    //   opt_out / hired_elsewhere → stop_and_lost
    //
    // wants_live_contact / wants_to_schedule are POSITIVE conversions — customer
    // is asking for a call/walkthrough or naming a time slot. Mario Evans
    // 2026-06-10 incident: "Please schedule a walkthrough. So I can get a quote."
    // classified as wants_live_contact @ 0.9 and was misrouted into the else
    // branch (stop_and_lost / lostReason=hired_someone). Treat these as
    // handoff/booked so the dispatcher is paged instead of flipping the lead lost.
    const sideEffect: GateSideEffect = intent === 'agreed' || intent === 'wants_live_contact' || intent === 'wants_to_schedule'
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
