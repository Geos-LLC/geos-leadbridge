/**
 * Follow-Up Engine Service
 *
 * Orchestrator: evaluateThread, enrollInSequence, handleCustomerReply, stopEnrollment.
 * Reads from ThreadContext (via ConversationContextService), writes to follow-up tables.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '../../generated/prisma';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { FollowUpStateService, FollowUpState } from './follow-up-state.service';

/**
 * Audit metadata for enrollment state-change calls. All fields optional —
 * callers without retry-prone semantics may omit the entire object. When
 * `sourceEventId` is provided, the audit log dedup guard short-circuits
 * repeat calls (see writeEnrollmentAudit). Phase 1 Task 4 — 2026-05-09.
 */
export interface EnrollmentAuditOptions {
  /** Stable id for retry-dedup. e.g. WebhookEvent.id, lead.id+intent, cron run id. */
  sourceEventId?: string;
  /** Coarse classification of the actor: 'system' | 'manual' | 'webhook' | 'cron' | 'scheduler'. */
  actorType?: string;
  /** Free-form actor identifier (operator userId, webhook id, etc.). */
  actorId?: string | null;
}

@Injectable()
export class FollowUpEngineService {
  private readonly logger = new Logger(FollowUpEngineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationContext: ConversationContextService,
    private readonly stateService: FollowUpStateService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Atomically transition an enrollment's status and write an audit row.
   *
   * Pattern:
   *   1. If `sourceEventId` is provided, check for an existing audit row with
   *      that key against this enrollment. If found, no-op (returns
   *      transitioned=false, deduped=true).
   *   2. Otherwise open a transaction:
   *      a. updateMany scoped to the prior status (atomic state guard).
   *      b. If updateMany count===1, create the audit row in the same tx.
   *      c. If count===0 (already in target state), skip the audit row
   *         (no transition occurred — recording would be misleading).
   *
   * Returns whether the transition actually happened so callers can run
   * downstream side-effects (ThreadContext clear, re-engagement alert, etc.)
   * only on real transitions.
   */
  private async writeEnrollmentAudit(
    enrollmentId: string,
    fromStatus: string,
    toStatus: string,
    extraData: Record<string, unknown>,
    reason: string | null,
    opts: EnrollmentAuditOptions | undefined,
    occurredAt: Date,
  ): Promise<{ transitioned: boolean; deduped: boolean }> {
    if (opts?.sourceEventId) {
      const existing = await this.prisma.followUpEnrollmentAuditLog.findFirst({
        where: { enrollmentId, sourceEventId: opts.sourceEventId },
        select: { id: true },
      });
      if (existing) {
        return { transitioned: false, deduped: true };
      }
    }

    const transitioned = await this.prisma.$transaction(async (tx) => {
      const result = await tx.followUpEnrollment.updateMany({
        where: { id: enrollmentId, status: fromStatus },
        data: { status: toStatus, ...extraData } as any,
      });
      if (result.count === 0) return false;
      await tx.followUpEnrollmentAuditLog.create({
        data: {
          enrollmentId,
          oldStatus: fromStatus,
          newStatus: toStatus,
          reason,
          sourceEventId: opts?.sourceEventId ?? null,
          actorType: opts?.actorType ?? null,
          actorId: opts?.actorId ?? null,
          occurredAt,
        },
      });
      return true;
    });

    return { transitioned, deduped: false };
  }

  /**
   * Evaluate a thread for follow-up eligibility.
   * Derives state from ThreadContext, enrolls in appropriate sequence if eligible.
   * Called after recordMessage() when awaitingCustomerReply becomes true.
   */
  async evaluateThread(conversationId: string, platform: string): Promise<void> {
    // Skip leads with terminal/archived status — no follow-up needed
    const statusCheck = await this.prisma.lead.findFirst({
      where: { threadId: conversationId },
      select: { status: true, thumbtackStatus: true },
    });
    if (statusCheck) {
      const s = (statusCheck.status || '').toLowerCase();
      const ts = (statusCheck.thumbtackStatus || '').toLowerCase();
      const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'job done', 'job scheduled', 'completed', 'archived', 'lost', 'closed', 'not hired', 'not_hired', 'job complete', 'no response'];
      if (terminal.includes(s) || terminal.includes(ts)) return;
    }

    const threadState = await this.conversationContext.getThreadState(conversationId);
    if (!threadState) return;

    const followUpState = this.stateService.deriveFollowUpState({
      stage: threadState.stage,
      engagementLevel: threadState.engagementLevel,
      awaitingCustomerReply: threadState.awaitingCustomerReply,
      priceDiscussed: threadState.priceDiscussed,
      lastQuestionAsked: threadState.lastQuestionAsked,
      businessMessages: threadState.businessMessages,
      aiMessages: threadState.aiMessages,
      customerMessages: threadState.customerMessages,
    });

    if (!followUpState) {
      this.logger.debug(`Thread ${conversationId} not eligible for follow-up`);
      return;
    }

    // Check if already enrolled in a sequence for this state
    const existing = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
    });

    if (existing) {
      this.logger.debug(`Thread ${conversationId} already has active enrollment ${existing.id}`);
      return;
    }

    // Don't re-enroll if the customer's most recent message was a deferral phrase.
    // Re-enrolling here would generate a "just checking in" message that pesters a
    // customer who explicitly said they're paused (e.g. "I need to check with my
    // husband"). The dedicated customer_deferred sequence — enrolled by the AI
    // Conversation handler when the deferral fires — is the right path for those.
    const lastCustomerMsg = await this.prisma.message.findFirst({
      where: { conversationId, sender: 'customer' },
      orderBy: { sentAt: 'desc' },
      select: { content: true, sentAt: true },
    });
    if (lastCustomerMsg?.content) {
      const DEFERRAL_PHRASES = [
        'get back to you', 'let me think', 'let me check', 'let me look',
        "i'll think", "ill think", 'i will think',
        "i'll let you know", 'ill let you know', 'i will let you know',
        "i'll be in touch", 'ill be in touch', "we'll be in touch", 'we will be in touch',
        'need to think', 'need to discuss', 'need to talk',
        'have to think', 'have to discuss', 'have to talk',
        'thinking about it', 'thinking it over',
        'talk it over', 'discuss it with',
        'shopping around', 'comparing quotes', 'comparing prices',
        'check with my husband', 'check with my wife', 'check with my partner', 'check with my spouse',
        'check with the husband', 'check with the wife', 'check with my hubby',
        'ask my husband', 'ask my wife', 'ask my partner', 'ask my spouse',
        'talk to my husband', 'talk to my wife', 'talk to my partner', 'talk to my spouse',
        'run it by', 'run this by', 'run it past', 'run this past',
        'check with the boss', 'ask the boss', 'check with my family',
        'need to check', 'need to ask', 'will need to check', 'will need to ask',
      ];
      const msgLower = lastCustomerMsg.content.toLowerCase();
      const matched = DEFERRAL_PHRASES.find(p => msgLower.includes(p));
      if (matched) {
        this.logger.log(`[FollowUpEngine] Skipping re-enrollment for ${conversationId} — last customer message was a deferral ("${matched}")`);
        return;
      }
    }

    // Find matching sequence template
    const template = await this.prisma.followUpSequenceTemplate.findFirst({
      where: {
        platform,
        triggerState: followUpState,
        enabled: true,
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    if (!template) {
      this.logger.debug(`No sequence template for state=${followUpState}, platform=${platform}`);
      return;
    }

    // Find lead for this conversation
    const lead = await this.prisma.lead.findFirst({
      where: { threadId: conversationId },
      select: { id: true },
    });
    await this.enrollInSequence(conversationId, template.id, platform, lead?.id);
  }

  /**
   * Enroll a conversation in a follow-up sequence.
   *
   * @param firstStepDelayMinutesOverride
   *   Optional override for the first step's delay. Used when the customer
   *   stated an explicit return window in their message (e.g. "back in 2
   *   weeks" → 20160 minutes). The classifier extracts the duration; callers
   *   pass it through to anchor the first re-engagement to the customer's
   *   own timing instead of the seed template's default cadence. Only applied
   *   when startStepIndex === 0 (no prior follow-ups on this thread). Bounded
   *   by the classifier service to [1, 180] days.
   */
  async enrollInSequence(
    conversationId: string,
    templateId: string,
    platform: string,
    leadId?: string,
    firstStepDelayMinutesOverride?: number,
  ): Promise<string> {
    const template = await this.prisma.followUpSequenceTemplate.findUnique({
      where: { id: templateId },
    });

    if (!template) throw new Error(`Sequence template ${templateId} not found`);

    // Prevent duplicate enrollments — only one active enrollment per conversation
    const existing = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
    });
    if (existing) {
      this.logger.debug(`Conversation ${conversationId} already has active enrollment ${existing.id} — skipping`);
      return existing.id;
    }

    const stepsData = template.stepsJson as any;
    const templateSteps: Array<{ delayMinutes: number; [k: string]: any }> = stepsData?.steps || [];
    if (templateSteps.length === 0) throw new Error('Sequence template has no steps');

    // Prefer user-configured steps (Services UI) over the seed template delays —
    // otherwise the initial nextDue is computed off the template (e.g. 30 min
    // for "Standard — After Price") even though the user set the first step to
    // "2 min". The scheduler already honors user steps at send time; this keeps
    // enrollInSequence consistent with that.
    let userSteps: Array<{ delayMinutes: number; [k: string]: any }> | null = null;
    if (leadId) {
      const leadForSteps = await this.prisma.lead.findUnique({
        where: { id: leadId },
        select: { userId: true, businessId: true },
      });
      if (leadForSteps?.businessId) {
        const acctForSteps = await this.prisma.savedAccount.findFirst({
          where: { userId: leadForSteps.userId, businessId: leadForSteps.businessId },
          select: { followUpSettingsJson: true },
        }).catch(() => null);
        if (acctForSteps?.followUpSettingsJson) {
          try {
            const s = JSON.parse(acctForSteps.followUpSettingsJson);
            const uiSteps = s.followUpSteps || s.followUpSmartSteps || s.followUpCustomSteps;
            if (Array.isArray(uiSteps) && uiSteps.length > 0) {
              userSteps = uiSteps.map((u: any, i: number) => ({
                stepOrder: i,
                delayMinutes: this.parseDelayString(u.delay),
              }));
            }
          } catch {}
        }
      }
    }
    const steps = userSteps ?? templateSteps;

    // Smart step positioning for RE-enrollment. Count follow-up messages
    // that have actually been sent (FollowUpStepExecution, status='sent') —
    // not all pro messages, since the initial AI auto-reply is NOT a follow-up
    // and should not bump the start index.
    let startStepIndex = 0;
    let lastMessageSentAt: Date | null = null;
    if (leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: leadId },
        select: { threadId: true, userId: true, businessId: true },
      });
      if (lead?.threadId) {
        const lastProMsg = await this.prisma.message.findFirst({
          where: { conversationId: lead.threadId, sender: 'pro' },
          orderBy: { sentAt: 'desc' },
          select: { sentAt: true },
        });
        if (lastProMsg) lastMessageSentAt = lastProMsg.sentAt;

        const priorFollowUps = await this.prisma.followUpStepExecution.count({
          where: {
            status: 'sent',
            enrollment: { conversationId: lead.threadId },
          },
        });

        if (priorFollowUps > 0) {
          // Past follow-ups exist on this conversation — skip ahead so we
          // don't repeat "just checking in" after already sending it.
          const messageBasedIndex = Math.min(priorFollowUps, steps.length - 1);

          // Also honor the user's fuReEnrollDelay as a lower bound on the
          // next step's delay (e.g. "don't send anything shorter than 24h").
          const acct = lead.businessId
            ? await this.prisma.savedAccount.findFirst({
                where: { userId: lead.userId, businessId: lead.businessId },
                select: { followUpSettingsJson: true },
              }).catch(() => null)
            : null;
          let reEnrollDelayMinutes = 1440;
          if (acct?.followUpSettingsJson) {
            try {
              const s = JSON.parse(acct.followUpSettingsJson);
              if (s.fuReEnrollDelay) {
                const d = s.fuReEnrollDelay;
                if (d.endsWith('h')) reEnrollDelayMinutes = parseInt(d) * 60;
                else if (d.endsWith('d')) reEnrollDelayMinutes = parseInt(d) * 1440;
                else reEnrollDelayMinutes = parseInt(d) || 1440;
              }
            } catch {}
          }
          const delayBasedIndex = steps.findIndex((s: any) => (s.delayMinutes || 0) >= reEnrollDelayMinutes);
          const delayIndex = delayBasedIndex > 0 ? delayBasedIndex : 0;
          startStepIndex = Math.max(messageBasedIndex, delayIndex);

          this.logger.log(
            `[FollowUp] ${priorFollowUps} prior follow-up sends on ${lead.threadId} — messageBasedIndex=${messageBasedIndex}, delayBasedIndex=${delayIndex}, startStepIndex=${startStepIndex}`,
          );
        }
      }
    }

    // Compute first step due time relative to the last message sent (not now),
    // so step delays reflect time since last contact, not enrollment time.
    // Follow-ups do NOT use active hours — quiet hours are handled by scheduler.
    //
    // When the caller provides firstStepDelayMinutesOverride AND we're starting
    // from step 0 (no prior follow-ups), the override wins. This is the
    // classifier-extracted "back in 2 weeks" path: customer named a specific
    // return window, so we anchor to that instead of the configured cadence.
    // For re-enrollment (startStepIndex > 0) we keep the configured delay so
    // a stale duration from a months-old message doesn't reset progress.
    const firstStep = steps[startStepIndex];
    const useOverride = startStepIndex === 0
      && typeof firstStepDelayMinutesOverride === 'number'
      && firstStepDelayMinutesOverride > 0;
    const effectiveDelay = useOverride
      ? firstStepDelayMinutesOverride!
      : firstStep.delayMinutes;
    if (useOverride) {
      this.logger.log(`[FollowUp] First-step delay overridden to ${firstStepDelayMinutesOverride}m (configured was ${firstStep.delayMinutes}m) — customer-stated re-engage window`);
    }
    const fromTime = lastMessageSentAt || new Date();
    const nextDue = this.computeNextDueAt(
      fromTime,
      effectiveDelay,
      null,
      null,
      'America/New_York',
    );
    // If the computed due time is in the past (last message was long ago), use now + small buffer
    const now = new Date();
    const effectiveNextDue = nextDue < now ? new Date(now.getTime() + 5 * 60_000) : nextDue;

    // Determine mode from account settings (auto_send or suggest), fallback to template mode
    let enrollMode = template.mode;
    if (leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { businessId: true, userId: true } });
      if (lead?.businessId) {
        const account = await this.prisma.savedAccount.findFirst({
          where: { userId: lead.userId, businessId: lead.businessId },
          select: { followUpMode: true },
        });
        if (account?.followUpMode && account.followUpMode !== 'off') {
          enrollMode = account.followUpMode;
        }
      }
    }

    // Transactional create + ThreadContext update. The partial unique index
    // "follow_up_enrollments_conversationId_active_unique" (WHERE status='active')
    // guarantees that concurrent calls can't both succeed — the loser gets P2002
    // and we return the winner's id instead of creating a duplicate.
    try {
      const enrollmentId = await this.prisma.$transaction(async (tx) => {
        // Pre-check inside the txn short-circuits the happy path (no race).
        const existingInTx = await tx.followUpEnrollment.findFirst({
          where: { conversationId, status: 'active' },
          select: { id: true },
        });
        if (existingInTx) return existingInTx.id;

        const created = await tx.followUpEnrollment.create({
          data: {
            sequenceTemplateId: templateId,
            conversationId,
            leadId,
            platform,
            status: 'active',
            currentStepIndex: startStepIndex,
            nextStepDueAt: effectiveNextDue,
            mode: enrollMode,
          },
          select: { id: true },
        });

        await tx.threadContext.updateMany({
          where: { conversationId },
          data: {
            activeEnrollmentId: created.id,
            nextFollowUpAt: effectiveNextDue,
            followUpStatus: 'active',
          },
        });

        return created.id;
      });

      this.logger.log(`Enrolled conversation ${conversationId} in sequence ${template.name} (${enrollmentId}), step ${startStepIndex}/${steps.length}, due: ${effectiveNextDue.toISOString()}`);
      return enrollmentId;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Partial unique index hit — another concurrent caller won the race.
        // Return the winner's id so the caller sees the idempotent result.
        const winner = await this.prisma.followUpEnrollment.findFirst({
          where: { conversationId, status: 'active' },
          select: { id: true },
        });
        if (winner) {
          this.logger.warn(`[FollowUp] P2002 race on conversation ${conversationId} — returning existing enrollment ${winner.id}`);
          return winner.id;
        }
      }
      throw err;
    }
  }

  /**
   * Stop enrollment on customer reply. Idempotent — safe for duplicate webhooks.
   * Returns whether any enrollment was actually stopped (for re-engagement alerts).
   *
   * Phase 1 Task 4: writes a FollowUpEnrollmentAuditLog row per stopped
   * enrollment. Optional `auditOpts.sourceEventId` (e.g. WebhookEvent.id)
   * dedups retries — repeated calls with the same id no-op.
   */
  async handleCustomerReply(
    conversationId: string,
    customerMessage?: string,
    auditOpts?: EnrollmentAuditOptions,
  ): Promise<{ stopped: boolean; reEngagementAlert: string | null }> {
    const occurredAt = new Date();

    // Snapshot the active enrollment(s) BEFORE updateMany so we can write
    // per-row audit entries. Partial-unique-index ensures ≤1 active per
    // conversation in the normal case, but we treat it as a list defensively.
    const active = await this.prisma.followUpEnrollment.findMany({
      where: { conversationId, status: 'active' },
      select: { id: true },
    });

    if (active.length === 0) {
      return { stopped: false, reEngagementAlert: null };
    }

    let anyTransitioned = false;
    for (const e of active) {
      const r = await this.writeEnrollmentAudit(
        e.id,
        'active',
        'stopped',
        { stoppedReason: 'customer_replied', completedAt: occurredAt },
        'customer_replied',
        auditOpts,
        occurredAt,
      );
      if (r.transitioned) anyTransitioned = true;
    }

    if (!anyTransitioned) {
      // All enrollments were either deduped (sourceEventId already seen) or
      // had moved out of 'active' between snapshot and update. Treat as
      // "no transition" so re-engagement alerts don't fire on retries.
      return { stopped: false, reEngagementAlert: null };
    }

    // Cancel any pending/suggested step executions
    await this.prisma.followUpStepExecution.updateMany({
      where: {
        enrollment: { conversationId },
        status: { in: ['scheduled', 'suggested'] },
      },
      data: { status: 'cancelled' },
    });

    // Clear ThreadContext cached fields
    await this.prisma.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeEnrollmentId: null,
        nextFollowUpAt: null,
        followUpStatus: 'stopped',
        followUpState: null,
      },
    });

    this.logger.log(`Stopped follow-up for conversation ${conversationId} — customer replied`);

    // Build re-engagement alert message if enabled.
    // Skip if the account already has customer_reply notification rules — they cover the same case.
    let reEngagementAlert: string | null = null;
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { threadId: conversationId },
        select: { customerName: true, businessId: true, userId: true },
      });
      if (lead?.businessId) {
        const acct = await this.prisma.savedAccount.findFirst({
          where: { userId: lead.userId, businessId: lead.businessId },
          select: { id: true, followUpSettingsJson: true },
        });
        if (acct?.followUpSettingsJson) {
          const settings = JSON.parse(acct.followUpSettingsJson);
          if (settings.reEngagementAlertEnabled !== false) {
            // Check if customer_reply notification rules exist — if so, skip re-engagement
            // to avoid double-alerting.
            const notifSettings = await this.prisma.notificationSettings.findUnique({
              where: { savedAccountId: acct.id },
              select: {
                enabled: true,
                notificationRules: {
                  where: { triggerType: 'customer_reply', enabled: true },
                  select: { id: true },
                },
              },
            });
            const hasActiveReplyRule = notifSettings?.enabled && (notifSettings?.notificationRules?.length || 0) > 0;
            if (hasActiveReplyRule) {
              this.logger.log(`[ReEngagement] Skipped — account has active customer_reply notification rules`);
            } else {
              const template = settings.reEngagementTemplate || 'Lead {{lead.name}} replied: "{{message}}"';
              reEngagementAlert = template
                .replace(/\{\{lead\.name\}\}/g, lead.customerName || 'Unknown')
                .replace(/\{\{message\}\}/g, (customerMessage || '').substring(0, 200));
            }
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`[ReEngagement] Failed to build alert: ${err.message}`);
    }

    return { stopped: true, reEngagementAlert };
  }

  /**
   * Stop enrollment manually.
   *
   * Phase 1 Task 4: writes an audit row inside the same transaction as the
   * status update. Optional `auditOpts.sourceEventId` dedups retries.
   */
  async stopEnrollment(
    enrollmentId: string,
    reason: string,
    auditOpts?: EnrollmentAuditOptions,
  ): Promise<void> {
    const occurredAt = new Date();
    await this.writeEnrollmentAudit(
      enrollmentId,
      'active',
      'stopped',
      { stoppedReason: reason, completedAt: occurredAt },
      reason,
      auditOpts,
      occurredAt,
    );

    // ThreadContext fan-out runs regardless of transition outcome — if the
    // enrollment is in 'stopped' state at this point (whether transitioned
    // by us or already there), the cached ThreadContext fields should
    // reflect that. updateMany is idempotent.
    const enrollment = await this.prisma.followUpEnrollment.findUnique({
      where: { id: enrollmentId },
    });

    if (enrollment) {
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: {
          activeEnrollmentId: null,
          nextFollowUpAt: null,
          followUpStatus: 'stopped',
        },
      });
    }
  }

  /**
   * Advance an enrollment after a suggestion has been approved, edited, or skipped.
   * In suggest mode the scheduler does NOT auto-advance — it pauses at the current
   * step until the user acts. This handler resumes the sequence by computing the
   * next step's due time (or completing the enrollment if there are no more steps).
   *
   * Idempotent: silently no-ops if the enrollment is no longer active (e.g. the
   * customer replied between suggestion firing and approval).
   */
  async advanceAfterSuggestion(enrollmentId: string): Promise<void> {
    const enrollment = await this.prisma.followUpEnrollment.findUnique({
      where: { id: enrollmentId },
      include: {
        sequenceTemplate: true,
        lead: { select: { userId: true, businessId: true } },
      },
    });
    if (!enrollment || enrollment.status !== 'active') return;

    // Resolve steps: prefer user-configured (Services UI) over the template seed.
    let steps: Array<{ delayMinutes: number; [k: string]: any }> = [];
    if (enrollment.lead?.businessId) {
      const acct = await this.prisma.savedAccount.findFirst({
        where: { userId: enrollment.lead.userId, businessId: enrollment.lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (acct?.followUpSettingsJson) {
        try {
          const s = JSON.parse(acct.followUpSettingsJson);
          const u = s.followUpSteps || s.followUpSmartSteps || s.followUpCustomSteps;
          if (Array.isArray(u) && u.length > 0) {
            steps = u.map((x: any, i: number) => ({
              stepOrder: i,
              delayMinutes: this.parseDelayString(x.delay),
            }));
          }
        } catch {}
      }
    }
    if (steps.length === 0) {
      steps = ((enrollment.sequenceTemplate.stepsJson as any)?.steps || []) as any;
    }

    const nextIdx = enrollment.currentStepIndex + 1;
    const nextStep = steps[nextIdx];
    const now = new Date();

    if (nextStep) {
      const nextDue = this.computeNextDueAt(
        now, nextStep.delayMinutes, null, null, 'America/New_York',
      );
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollmentId },
        data: { currentStepIndex: nextIdx, nextStepDueAt: nextDue, lastExecutedAt: now },
      });
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { nextFollowUpAt: nextDue, followUpStatus: 'active' },
      });
    } else {
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollmentId },
        data: {
          currentStepIndex: nextIdx,
          status: 'completed',
          completedAt: now,
          lastExecutedAt: now,
        },
      });
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'completed' },
      });
    }
  }

  /**
   * Pause/resume an enrollment.
   *
   * Phase 1 Task 4: each transition writes a FollowUpEnrollmentAuditLog row.
   */
  async pauseEnrollment(
    enrollmentId: string,
    auditOpts?: EnrollmentAuditOptions,
  ): Promise<void> {
    const occurredAt = new Date();
    await this.writeEnrollmentAudit(
      enrollmentId,
      'active',
      'paused',
      {},
      'manual_pause',
      auditOpts,
      occurredAt,
    );
  }

  async resumeEnrollment(
    enrollmentId: string,
    auditOpts?: EnrollmentAuditOptions,
  ): Promise<void> {
    const occurredAt = new Date();
    await this.writeEnrollmentAudit(
      enrollmentId,
      'paused',
      'active',
      {},
      'manual_resume',
      auditOpts,
      occurredAt,
    );
  }

  // ──────────────────────────────────────────────────────────────────
  // Engagement-aware mode switching
  // See plans/2026-04-17-job-sync-sf-lb.md §7
  // ──────────────────────────────────────────────────────────────────

  /**
   * A conversation is engaged if ANY of:
   *  - customer has replied at least once (after the initial lead form)
   *  - price was discussed
   *  - the conversation reached a booking/scheduling stage
   *  - thread has ≥ 4 total messages (initial + 3+ back-and-forth)
   *  - engagement level is warm or hot
   *
   * Ghost = none of the above. Used to decide stop vs long-term follow-up.
   */
  async isEngaged(conversationId: string): Promise<boolean> {
    const threadState = await this.conversationContext.getThreadState(conversationId);
    if (threadState) {
      if ((threadState.customerMessages ?? 0) > 0) return true;
      if (threadState.priceDiscussed) return true;
      const stage = (threadState.stage || '').toLowerCase();
      if (['booking', 'scheduling', 'scheduled', 'booked'].includes(stage)) return true;
      const total =
        (threadState.customerMessages ?? 0) +
        (threadState.businessMessages ?? 0) +
        (threadState.aiMessages ?? 0);
      if (total >= 4) return true;
      const level = (threadState.engagementLevel || '').toLowerCase();
      if (level === 'warm' || level === 'hot') return true;
    }

    // Fallback: count messages directly
    const customerCount = await this.prisma.message.count({
      where: { conversationId, sender: 'customer' },
    });
    if (customerCount > 0) return true;

    const totalCount = await this.prisma.message.count({
      where: { conversationId },
    });
    return totalCount >= 4;
  }

  /**
   * Switch an active enrollment to long-term mode.
   * Resets the current step index to 0 and schedules the first long-term send
   * 7 days out. Idempotent — calling twice does not double the reset.
   */
  async switchToLongTermMode(enrollmentId: string, reason: string): Promise<boolean> {
    const fresh = await this.prisma.followUpEnrollment.findUnique({
      where: { id: enrollmentId },
      select: { id: true, status: true, followUpMode: true, conversationId: true },
    });
    if (!fresh || fresh.status !== 'active') return false;
    if (fresh.followUpMode === 'long_term') return false; // idempotent

    const firstDue = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // +7 days

    await this.prisma.followUpEnrollment.update({
      where: { id: enrollmentId },
      data: {
        followUpMode: 'long_term',
        modeChangedAt: new Date(),
        modeReason: reason,
        currentStepIndex: 0,
        nextStepDueAt: firstDue,
      },
    });

    await this.prisma.threadContext.updateMany({
      where: { conversationId: fresh.conversationId },
      data: { nextFollowUpAt: firstDue, followUpStatus: 'active' },
    });

    this.logger.log(`[FollowUp] switchToLongTermMode ${enrollmentId} (reason=${reason}, firstDue=${firstDue.toISOString()})`);
    return true;
  }

  /**
   * Switch an enrollment back to short-term mode.
   * Used when a ghosted lead replies and becomes engaged again.
   */
  async switchToShortTermMode(enrollmentId: string, reason: string): Promise<boolean> {
    const fresh = await this.prisma.followUpEnrollment.findUnique({
      where: { id: enrollmentId },
      select: { id: true, status: true, followUpMode: true, conversationId: true },
    });
    if (!fresh || fresh.status !== 'active') return false;
    if (fresh.followUpMode === 'short_term') return false;

    await this.prisma.followUpEnrollment.update({
      where: { id: enrollmentId },
      data: {
        followUpMode: 'short_term',
        modeChangedAt: new Date(),
        modeReason: reason,
        currentStepIndex: 0,
      },
    });

    this.logger.log(`[FollowUp] switchToShortTermMode ${enrollmentId} (reason=${reason})`);
    return true;
  }

  /**
   * React to a platform-level status signal (Yelp/Thumbtack "Not hired",
   * "Hired", "Archived"). Implements the decision tree from §7.2 of the plan:
   *
   *   explicit opt-out → stop
   *   SF status terminal → stop
   *   not engaged + Not hired/Archived → stop (ghost)
   *   engaged + Not hired → switch to long-term
   *   signal says re-activate → switch to short-term if currently long-term
   *
   * Returns the action taken for observability.
   */
  async handlePlatformSignal(
    conversationId: string,
    signal: 'Not hired' | 'Archived' | 'Hired' | string,
  ): Promise<'stopped' | 'switched_long' | 'switched_short' | 'no_change' | 'no_enrollment'> {
    const enrollment = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      select: { id: true, followUpMode: true, leadId: true },
    });
    if (!enrollment) return 'no_enrollment';

    // Check lead's SF status first — if SF already called it terminal, stop
    if (enrollment.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { status: true, statusSource: true },
      });
      const sfTerminal = ['scheduled', 'in_progress', 'completed', 'cancelled', 'lost', 'archived'];
      if (
        lead?.statusSource === 'service_flow' &&
        lead.status &&
        sfTerminal.includes(lead.status.toLowerCase())
      ) {
        await this.stopEnrollment(enrollment.id, `sf_status_${lead.status}`);
        return 'stopped';
      }
    }

    const normalized = (signal || '').toLowerCase();

    if (normalized === 'hired' || normalized === 'active') {
      // Platform signal says lead is active — if we're long-term-mode, switch back.
      if (enrollment.followUpMode === 'long_term') {
        await this.switchToShortTermMode(enrollment.id, 'platform_signal_active');
        return 'switched_short';
      }
      return 'no_change';
    }

    if (normalized === 'not hired' || normalized === 'archived') {
      const engaged = await this.isEngaged(conversationId);
      if (!engaged) {
        await this.stopEnrollment(enrollment.id, 'platform_not_hired_ghost');
        return 'stopped';
      }
      // Engaged lead — switch to long-term rather than stop
      if (enrollment.followUpMode !== 'long_term') {
        await this.switchToLongTermMode(enrollment.id, 'platform_not_hired_engaged');
        return 'switched_long';
      }
      return 'no_change';
    }

    return 'no_change';
  }

  /**
   * Compute next step due time, respecting active hours.
   * Handles day boundaries and overnight windows.
   */
  computeNextDueAt(
    fromTime: Date,
    delayMinutes: number,
    activeStart: string | null | undefined,
    activeEnd: string | null | undefined,
    timezone: string,
  ): Date {
    const rawDue = new Date(fromTime.getTime() + delayMinutes * 60_000);

    if (!activeStart || !activeEnd) return rawDue;

    // Check if rawDue falls within active hours
    if (this.isWithinActiveHours(rawDue, activeStart, activeEnd, timezone)) {
      return rawDue;
    }

    // Snap to next window opening
    return this.snapToNextWindowOpening(rawDue, activeStart, timezone);
  }

  private isWithinActiveHours(time: Date, start: string, end: string, timezone: string): boolean {
    try {
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const localTime = formatter.format(time);
      const [h, m] = localTime.split(':').map(Number);
      const [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);

      const current = h * 60 + m;
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;

      if (startMin > endMin) {
        // Overnight window (e.g., 22:00-06:00)
        return current >= startMin || current < endMin;
      }
      return current >= startMin && current < endMin;
    } catch {
      return true; // On error, allow
    }
  }

  private snapToNextWindowOpening(time: Date, activeStart: string, timezone: string): Date {
    try {
      const [sh, sm] = activeStart.split(':').map(Number);

      // Iteratively find the next time within active hours by advancing 15-min increments.
      // This handles overnight windows, DST, and any timezone correctly.
      // We search up to 48 hours ahead (2880 minutes / 15 = 192 iterations).
      let candidate = new Date(time.getTime());
      // First, try snapping to today's activeStart in the target timezone
      // by computing the offset between current time's local hour and activeStart.
      const fmt = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const [curH, curM] = fmt.format(candidate).split(':').map(Number);
      const currentMin = curH * 60 + curM;
      const targetMin = sh * 60 + sm;
      let diffMin = targetMin - currentMin;
      if (diffMin <= 0) diffMin += 24 * 60; // next day
      candidate = new Date(candidate.getTime() + diffMin * 60_000);

      // Safety: if still not within active hours (e.g., overnight edge case),
      // iterate forward in 15-min steps up to 48h.
      let iterations = 0;
      while (iterations < 192 && candidate.getTime() <= Date.now()) {
        candidate = new Date(candidate.getTime() + 15 * 60_000);
        iterations++;
      }
      return candidate;
    } catch {
      // Fallback: add 1 hour
      return new Date(time.getTime() + 60 * 60_000);
    }
  }

  /**
   * Parse the human-readable UI delay string ("2 min", "1 hour", "3 days", …)
   * into minutes. Mirror of FollowUpSchedulerService.parseDelay — kept here
   * so enrollInSequence can use user-configured delays when computing the
   * first step's nextDue instead of the seed-template defaults.
   */
  parseDelayString(delay: string | null | undefined): number {
    if (!delay) return 60;
    const d = String(delay).toLowerCase().trim();
    const num = parseFloat(d) || 1;
    if (d.includes('min')) return Math.round(num);
    if (d.includes('hour') || d.includes('hr')) return Math.round(num * 60);
    if (d.includes('day')) return Math.round(num * 1440);
    if (d.includes('week') || d.includes('wk')) return Math.round(num * 10080);
    if (d.includes('month') || d.includes('mo')) return Math.round(num * 43200);
    if (d.includes('year') || d.includes('yr')) return Math.round(num * 525600);
    return Math.round(num);
  }
}
