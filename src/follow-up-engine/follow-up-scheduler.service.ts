/**
 * Follow-Up Scheduler Service
 *
 * Cron job: every 60 seconds, finds due enrollments and processes them.
 * Executes steps in suggestion mode (creates suggested step executions).
 * Auto-send mode supported but gated by enrollment.mode.
 */

import { randomUUID } from 'crypto';
import { Injectable, Logger, Inject, forwardRef, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { resolveTimezone } from '../common/utils/account-timezone';
import { BusinessHoursService } from '../common/utils/business-hours.service';
import { CronLockTx, isSkipped, withCronLock } from '../common/utils/cron-lock';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { LeadsService } from '../leads/leads.service';
import { LeadStatusService } from '../leads/lead-status.service';
import { FollowUpEngineService } from './follow-up-engine.service';
import { FollowUpGeneratorService, GeneratedFollowUp, SequenceStep } from './follow-up-generator.service';
import { LONG_TERM_STEPS } from './long-term-steps';
import { TrialService } from '../trial/trial.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { IntentClassifierService, IntentClassification, CustomerIntent } from '../ai/intent-classifier.service';
import { FollowUpGateService, GateDecision } from './follow-up-gate.service';

@Injectable()
export class FollowUpSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(FollowUpSchedulerService.name);
  private processing = false;
  private readonly schedulerEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversationContext: ConversationContextService,
    @Inject(forwardRef(() => LeadsService))
    private readonly leadsService: LeadsService,
    private readonly engineService: FollowUpEngineService,
    private readonly generatorService: FollowUpGeneratorService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly trialService: TrialService,
    private readonly platformFactory: PlatformFactory,
    private readonly intentClassifier: IntentClassifierService,
    @Inject(forwardRef(() => LeadStatusService))
    private readonly leadStatusService: LeadStatusService,
    private readonly gateService: FollowUpGateService,
    private readonly businessHours: BusinessHoursService,
  ) {
    // FOLLOWUP_SCHEDULER env var: set to 'false' on staging to let production handle it.
    // Defaults to true (enabled). User controls follow-ups via per-account settings.
    const envVal = this.configService.get<string>('FOLLOWUP_SCHEDULER');
    this.schedulerEnabled = envVal !== 'false';
  }

  /**
   * On startup: reset any enrollments stuck far in the future (e.g., nextStepDueAt = 2099).
   * These are from failed sends that got parked. Reset to now with staggered timing.
   */
  async onModuleInit(): Promise<void> {
    if (!this.schedulerEnabled) {
      this.logger.log('[FollowUpScheduler] Scheduler disabled (FOLLOWUP_SCHEDULER=false)');
      return;
    }
    try {
      const farFutureCutoff = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
      const stuckEnrollments = await this.prisma.followUpEnrollment.findMany({
        where: {
          status: 'active',
          nextStepDueAt: { gt: farFutureCutoff },
        },
      });

      if (stuckEnrollments.length === 0) return;

      this.logger.log(`[FollowUpScheduler] Found ${stuckEnrollments.length} stuck enrollments — resetting to now`);

      const now = new Date();
      for (let i = 0; i < stuckEnrollments.length; i++) {
        const enrollment = stuckEnrollments[i];

        // Find the highest step that was already sent successfully — resume from next step
        const lastSentStep = await this.prisma.followUpStepExecution.findFirst({
          where: { enrollmentId: enrollment.id, status: 'sent' },
          orderBy: { stepIndex: 'desc' },
          select: { stepIndex: true },
        });
        const resumeIndex = lastSentStep ? lastSentStep.stepIndex + 1 : enrollment.currentStepIndex;

        // Clear only failed step executions (keep sent ones to prevent re-sends)
        await this.prisma.followUpStepExecution.deleteMany({
          where: { enrollmentId: enrollment.id, status: 'failed' },
        });

        // Stagger by 60 seconds each to avoid blast
        const staggeredDue = new Date(now.getTime() + i * 60_000);
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: { nextStepDueAt: staggeredDue, currentStepIndex: resumeIndex },
        });
        await this.prisma.threadContext.updateMany({
          where: { conversationId: enrollment.conversationId },
          data: { nextFollowUpAt: staggeredDue, followUpStatus: 'active' },
        });
      }

      this.logger.log(`[FollowUpScheduler] Reset ${stuckEnrollments.length} stuck enrollments — will process over next ${Math.ceil(stuckEnrollments.length)} minutes`);

      // Also re-activate enrollments that completed with ALL steps failed (token was dead)
      const allFailedEnrollments = await this.prisma.followUpEnrollment.findMany({
        where: {
          status: { in: ['completed', 'stopped'] },
          stepExecutions: { every: { status: 'failed' } },
        },
        include: { stepExecutions: { select: { id: true, status: true } } },
      });

      const trulyAllFailed = allFailedEnrollments.filter(
        e => e.stepExecutions.length > 0 && e.stepExecutions.every((s: any) => s.status === 'failed'),
      );

      if (trulyAllFailed.length > 0) {
        this.logger.log(`[FollowUpScheduler] Found ${trulyAllFailed.length} enrollments with all steps failed — re-activating`);
        const baseOffset = stuckEnrollments.length;
        let reactivated = 0;
        for (let i = 0; i < trulyAllFailed.length; i++) {
          const enrollment = trulyAllFailed[i];
          // Partial unique index enforces one active per conversation — skip
          // re-activation if a sibling active enrollment already exists.
          const sibling = await this.prisma.followUpEnrollment.findFirst({
            where: {
              conversationId: enrollment.conversationId,
              status: 'active',
              id: { not: enrollment.id },
            },
            select: { id: true },
          });
          if (sibling) {
            this.logger.log(`[FollowUpScheduler] Skipping re-activation of ${enrollment.id} — conversation already has active enrollment ${sibling.id}`);
            continue;
          }
          const staggeredDue = new Date(now.getTime() + (baseOffset + i) * 60_000);
          // Delete all failed executions and restart from step 0
          await this.prisma.followUpStepExecution.deleteMany({
            where: { enrollmentId: enrollment.id, status: 'failed' },
          });
          await this.prisma.followUpEnrollment.update({
            where: { id: enrollment.id },
            data: { status: 'active', currentStepIndex: 0, nextStepDueAt: staggeredDue, completedAt: null },
          });
          await this.prisma.threadContext.updateMany({
            where: { conversationId: enrollment.conversationId },
            data: { activeEnrollmentId: enrollment.id, nextFollowUpAt: staggeredDue, followUpStatus: 'active' },
          });
          reactivated++;
        }
        this.logger.log(`[FollowUpScheduler] Re-activated ${reactivated}/${trulyAllFailed.length} all-failed enrollments`);
      }
    } catch (err: any) {
      this.logger.error(`[FollowUpScheduler] Failed to reset stuck enrollments: ${err.message}`);
    }
  }

  /**
   * Cron: every 60 seconds, find and process due follow-up enrollments.
   *
   * Two-phase design (refactored from a single long transaction):
   *
   *   PHASE 1 — claim (inside short xact-locked transaction):
   *     - acquire advisory lock 7001
   *     - find due enrollments + dedupe duplicates by conversation
   *     - atomically claim each canonical via processingUntil/processingToken
   *     - commit (releases the lock; total runtime ~tens of ms)
   *
   *   PHASE 2 — process (outside transaction, no lock held):
   *     - for each claimed enrollment, run processEnrollment which may do
   *       external SMS/AI I/O for many seconds
   *     - release the lease only if we still hold the token
   *
   * Why split: the prior design held the lock + transaction across all
   * external I/O. Busy batches (8+ enrollments × multi-second SMS/AI calls)
   * blew the Prisma transaction timeout — observed in prod soak as
   * "Transaction already closed: timeout was 600000 ms" on the 21:33 cycle.
   * Splitting the lock window from the work window also lets the other
   * instance run its own claim phase concurrently against a disjoint set of
   * enrollments instead of waiting an entire lock-holder cycle out.
   *
   * Mutual exclusion guarantees:
   *   - Advisory lock 7001 prevents two instances from running the claim
   *     phase at the exact same moment (orphan-proof via xact scope).
   *   - The atomic UPDATE WHERE clause on `processingUntil` is the
   *     authoritative per-enrollment serializer: even if two instances did
   *     claim concurrently, only one update would match per row.
   *   - 2-minute lease TTL auto-recovers from crashes during phase 2.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processFollowUps(): Promise<void> {
    if (!this.schedulerEnabled || this.processing) return;
    this.processing = true;

    try {
      // Phase 1: short transaction guarded by xact lock — find + claim only.
      // Tx timeout is generous for safety (10s) but the path is just DB
      // queries, no I/O, so it should complete in tens of ms.
      const claimOutcome = await withCronLock(
        this.prisma,
        this.logger,
        7001,
        'FollowUpScheduler',
        tx => this.claimDueEnrollments(tx),
        { timeoutMs: 10_000 },
      );

      if (isSkipped(claimOutcome)) return;
      const claims = claimOutcome;

      if (claims.length === 0) {
        const now = new Date();
        if (now.getMinutes() % 10 === 0 && now.getSeconds() < 60) {
          this.logger.debug('[FollowUpScheduler] Cron alive — no due enrollments');
        }
        return;
      }

      this.logger.log(`[FollowUpScheduler] Processing ${claims.length} claimed enrollments`);

      // Phase 2: process each claim outside the lock and outside any
      // transaction. Failures are isolated per-enrollment so one bad row
      // never blocks the rest of the batch.
      const now = new Date();
      for (const { enrollment, token } of claims) {
        try {
          await this.processEnrollment(enrollment, now);
        } catch (err: any) {
          this.logger.error(`[FollowUpScheduler] Error processing enrollment ${enrollment.id}: ${err.message}`);
        } finally {
          // Release lease only if we still hold the token. If the 2-min lease
          // TTL expired mid-process and another worker re-claimed, this
          // updateMany matches zero rows and no-ops — that's the desired
          // outcome (the new owner's lease shouldn't be cleared by us).
          await this.prisma.followUpEnrollment
            .updateMany({
              where: { id: enrollment.id, processingToken: token },
              data: { processingUntil: null, processingToken: null },
            })
            .catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`[FollowUpScheduler] Cron error: ${err.message}`);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Phase-1 claim path. Pure DB work, no external I/O. Returns the list of
   * enrollments this instance won, paired with the lease token used to claim
   * them so phase 2 can release each lease only if it still holds it.
   */
  private async claimDueEnrollments(
    tx: CronLockTx,
  ): Promise<Array<{ enrollment: any; token: string }>> {
    const now = new Date();
    // Starvation fix: exclude enrollments whose current-step suggestion is still
    // pending user approval. The post-claim guard at processEnrollment() also
    // catches this case (defense-in-depth), but excluding here is what restores
    // throughput — otherwise stuck `suggest`-mode rows from weeks ago occupy
    // every tick's 20-row claim window and starve newer auto-send enrollments.
    //
    // Relation filter (`stepExecutions: { none: { status: 'suggested' } }`) is
    // a slight broadening of the post-claim guard (which compares step_index
    // to current_step_index exactly). In normal operation only one execution
    // per (enrollment, stepIndex) carries `suggested`, so any pending-suggested
    // anywhere means the user hasn't actioned the row and it would no-op past
    // the guard anyway. Orphan suggestions at a non-current step are treated
    // as data corruption — skipping them is safer than letting them through.
    //
    // Deterministic ordering: nextStepDueAt ASC, id ASC. Without ORDER BY,
    // Postgres returns rows in physical heap order, so the oldest blocked
    // rows always sat at the head of the result set. With FIFO ordering plus
    // the suggested-skip filter, due rows are reached in age order.
    const dueEnrollments = await tx.followUpEnrollment.findMany({
      where: {
        status: 'active',
        nextStepDueAt: { lte: now },
        stepExecutions: { none: { status: 'suggested' } },
      },
      orderBy: [{ nextStepDueAt: 'asc' }, { id: 'asc' }],
      take: 20,
      include: { sequenceTemplate: true },
    });

    if (dueEnrollments.length === 0) return [];

    // Defense-in-depth: group by conversationId, claim ONE canonical
    // enrollment per conversation per cycle. Even with the partial unique
    // index, historical data or brief races could leave sibling active rows
    // — stop them instead of letting each fire its step.
    const byConversation = new Map<string, typeof dueEnrollments>();
    for (const e of dueEnrollments) {
      const arr = byConversation.get(e.conversationId) ?? [];
      arr.push(e);
      byConversation.set(e.conversationId, arr);
    }

    const claims: Array<{ enrollment: any; token: string }> = [];

    for (const [conversationId, group] of byConversation) {
      group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const [canonical, ...duplicates] = group;

      if (duplicates.length > 0) {
        this.logger.warn(
          `[FollowUpScheduler] Found ${duplicates.length} duplicate active enrollments on conversation ${conversationId} — stopping duplicates, processing ${canonical.id}`,
        );
        await tx.followUpEnrollment.updateMany({
          where: { id: { in: duplicates.map((d) => d.id) } },
          data: {
            status: 'stopped',
            stoppedReason: 'duplicate_cleanup',
            completedAt: new Date(),
          },
        });
        await tx.followUpStepExecution.updateMany({
          where: {
            enrollmentId: { in: duplicates.map((d) => d.id) },
            status: { in: ['scheduled', 'suggested'] },
          },
          data: { status: 'cancelled' },
        });
      }

      // Atomic claim. The OR clause on processingUntil is what makes this
      // race-safe: if a second instance somehow ran the same claim
      // concurrently, only one UPDATE would match (the first sets
      // processingUntil to a future time; the second sees that and gets
      // count=0). 2-minute lease auto-expires for crash recovery.
      const token = randomUUID();
      const leaseEnd = new Date(now.getTime() + 2 * 60_000);
      const { count } = await tx.followUpEnrollment.updateMany({
        where: {
          id: canonical.id,
          status: 'active',
          OR: [{ processingUntil: null }, { processingUntil: { lt: now } }],
        },
        data: { processingUntil: leaseEnd, processingToken: token },
      });
      if (count === 0) {
        this.logger.debug(
          `[FollowUpScheduler] Could not claim ${canonical.id} — another worker or already processed`,
        );
        continue;
      }
      claims.push({ enrollment: canonical, token });
    }

    return claims;
  }

  /**
   * Cron: every 5 minutes, retry classification of Yelp webhook events that
   * failed initial fetch. Events are marked by WebhooksService with
   * `processingError='reconcile:yelp:<leadId>:<businessId>:<reason>:attempts=N'`.
   *
   * Fail-open already happened at webhook time — reconciliation is diagnostic:
   * it confirms or reclassifies the original outcome and caps attempts at 5.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcileYelpEvents(): Promise<void> {
    if (!this.schedulerEnabled) return;

    await withCronLock(
      this.prisma,
      this.logger,
      7003,
      'YelpReconcile',
      async tx => {
        const cutoff = new Date(Date.now() - 60 * 60 * 1000); // 1h window
        const rows = await tx.webhookEvent.findMany({
          where: {
            platform: 'yelp',
            processingError: { startsWith: 'reconcile:yelp:' },
            receivedAt: { gte: cutoff },
          },
          take: 10,
          orderBy: { receivedAt: 'asc' },
        });

        if (rows.length === 0) return;

        this.logger.log(`[FollowUpScheduler] reconcileYelpEvents: processing ${rows.length} pending`);

        for (const row of rows) {
          await this.reconcileOneYelpEvent(row).catch(err =>
            this.logger.warn(`[FollowUpScheduler] Reconcile failed for WebhookEvent ${row.id}: ${err.message}`),
          );
        }
      },
      { timeoutMs: 180_000 },
    );
  }

  private async reconcileOneYelpEvent(row: { id: string; payload: string; processingError: string | null }): Promise<void> {
    const marker = row.processingError ?? '';
    const parts = marker.split(':'); // reconcile, yelp, leadId, businessId, reason, attempts=N
    if (parts.length < 6 || parts[0] !== 'reconcile' || parts[1] !== 'yelp') return;
    const leadId = parts[2];
    const businessId = parts[3];
    const reason = parts[4];
    const attemptsMatch = parts[5].match(/attempts=(\d+)/);
    const attempts = attemptsMatch ? parseInt(attemptsMatch[1], 10) : 0;

    if (attempts >= 5) {
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { processingError: `reconciled:max_attempts:${reason}` },
      });
      this.logger.warn(`[FollowUpScheduler] Yelp event reconcile capped for lead=${leadId} business=${businessId}`);
      return;
    }

    const savedAccount = await this.prisma.savedAccount.findFirst({
      where: { platform: 'yelp', businessId },
      select: { credentialsJson: true },
    });
    if (!savedAccount?.credentialsJson) {
      await this.prisma.webhookEvent.update({
        where: { id: row.id },
        data: { processingError: `reconciled:no_account:${reason}` },
      });
      return;
    }

    const encryptionKey = this.configService.get<string>('encryption.key') || '';
    let accessToken = this.configService.get<string>('yelp.apiKey') || '';
    try {
      const creds: any = EncryptionUtil.decryptObject(savedAccount.credentialsJson, encryptionKey);
      if (creds?.accessToken) accessToken = creds.accessToken;
    } catch {
      // fall through with api key
    }

    let events: any[] = [];
    try {
      const yelpAdapter = this.platformFactory.getAdapter('yelp') as any;
      events = await yelpAdapter.getLeadEvents({ accessToken }, leadId);
    } catch (err: any) {
      await this.bumpReconcileAttempts(row.id, leadId, businessId, reason, attempts + 1);
      this.logger.warn(`[FollowUpScheduler] Reconcile fetch still failing lead=${leadId} attempts=${attempts + 1}: ${err.message}`);
      return;
    }

    if (!Array.isArray(events) || events.length === 0) {
      await this.bumpReconcileAttempts(row.id, leadId, businessId, reason, attempts + 1);
      return;
    }

    const sorted = events
      .slice()
      .sort((a: any, b: any) => new Date(b.time_created).getTime() - new Date(a.time_created).getTime());
    const latest = sorted[0];
    const outcome = latest?.user_type === 'BIZ' ? 'echo' : 'customer';

    await this.prisma.webhookEvent.update({
      where: { id: row.id },
      data: { processingError: `reconciled:${outcome}:${reason}` },
    });
    this.logger.log(`[FollowUpScheduler] Yelp event reconciled lead=${leadId} outcome=${outcome} (after ${attempts + 1} attempt(s))`);
  }

  private async bumpReconcileAttempts(
    eventRowId: string,
    leadId: string,
    businessId: string,
    reason: string,
    nextAttempts: number,
  ): Promise<void> {
    await this.prisma.webhookEvent.update({
      where: { id: eventRowId },
      data: { processingError: `reconcile:yelp:${leadId}:${businessId}:${reason}:attempts=${nextAttempts}` },
    });
  }

  /**
   * Classifier gate confidence threshold. Below this we pass through to
   * generation — false-positive on a terminal intent stops a legitimate
   * follow-up. Aligned with the AI Conversation gate threshold.
   */
  private static readonly CLASSIFIER_CONFIDENCE_THRESHOLD = 0.7;

  /**
   * Classifier gate for the scheduled follow-up engine.
   *
   * Reads the latest customer message in the thread, classifies it, and decides
   * whether the enrollment should fire at all. Catches the cases where:
   *   - The customer said "It's already done" / "please lose my information" /
   *     "we hired someone else" before the inbound-reply classifier was live, or
   *   - The phrase-list checks in handleCustomerReply missed an unusual phrasing
   *     and never flipped lead.status to terminal.
   *
   * Returns true when the enrollment was stopped (caller must return without
   * generating). Returns false when the gate passed through and the enrollment
   * should proceed.
   *
   * Idempotency:
   *   - stopEnrollment filters by status='active' so re-runs are no-ops.
   *   - writeStatus dedups on (leadId, source, sourceEventId). The
   *     sourceEventId here is `followup_classifier_<enrollmentId>_<intent>`
   *     so re-runs of the same gate decision write nothing.
   *
   * Re-engagement sequences (customer_deferred, customer_hired_competitor)
   * are special — those exist precisely to re-engage paused/lost customers.
   * The gate does NOT stop them on deferring/completed/hired/agreed intents
   * (those would defeat the sequence's purpose). It DOES still stop them on
   * opt_out — even paused customers who explicitly say "stop" must not get
   * re-engagement messages.
   */
  private async classifyAndMaybeStop(enrollment: any, now: Date): Promise<boolean> {
    // v8.1/Phase-1-Task-2 refactor: gate evaluation is now in FollowUpGateService
    // and shared with the controller's /preview endpoint. This method is the
    // SCHEDULER's caller — it applies the side effects (stopEnrollment +
    // writeStatus). Preview controller calls evaluate() directly with no
    // side effects, just returning the decision to the UI.
    const decision = await this.gateService.evaluate({
      conversationId: enrollment.conversationId,
      enrollmentId: enrollment.id,
      leadId: enrollment.leadId ?? null,
      triggerState: enrollment.sequenceTemplate?.triggerState ?? null,
    });

    if (!decision.shouldBlock) {
      // Preserve the re-engagement bypass log that existing tests assert on.
      if (decision.action === 'pass_re_engagement') {
        this.logger.log(`[FollowUpScheduler] classifier gate: intent=${decision.intent} conf=${(decision.confidence ?? 0).toFixed(2)} but enrollment ${enrollment.id} is re-engagement (${enrollment.sequenceTemplate?.triggerState}) — passing through`);
      }
      return false;
    }

    const intent = decision.intent as CustomerIntent;
    const conf = decision.confidence;

    // Stop the enrollment. Idempotent — only flips active enrollments.
    // SF-link block (intent=null) gets a dedicated reason so audit/Loki
    // doesn't read "classifier_null"; classifier-driven blocks keep
    // their original "classifier_<intent>" reason for back-compat with
    // existing dashboards.
    const stopReason = decision.action === 'block_sf_linked'
      ? 'sf_linked_customer'
      : `classifier_${intent}`;
    await this.engineService.stopEnrollment(enrollment.id, stopReason);
    if (decision.action === 'block_sf_linked') {
      this.logger.log(`[FollowUpScheduler] ✗ STOPPED enrollment ${enrollment.id} via sf_linked_customer (lead is converted to SF customer/job)`);
    } else {
      this.logger.log(`[FollowUpScheduler] ✗ STOPPED enrollment ${enrollment.id} via classifier intent=${intent} conf=${conf.toFixed(2)} reason="${decision.classifierReason ?? ''}"`);
    }

    // Flip lead status where appropriate. Skipped for 'deferring' (pause, not lost)
    // and for cases where the lead has no id (defensive).
    if (enrollment.leadId && decision.sideEffect !== 'stop_only' && decision.sideEffect !== 'none') {
      const sourceEventId = `followup_classifier_${enrollment.id}_${intent}`;
      const baseInput = {
        leadId: enrollment.leadId,
        source: 'lb_automation' as const,
        sourceEventId,
        actorType: 'system' as const,
        metadata: {
          classifier_intent: intent,
          classifier_confidence: conf,
          classifier_reason: decision.classifierReason,
          enrollment_id: enrollment.id,
        },
      };
      try {
        if (decision.sideEffect === 'stop_and_booked') {
          // Positive handoff to manager. Fires for `agreed` (price accepted) as
          // well as `wants_live_contact` (customer wants a call/walkthrough)
          // and `wants_to_schedule` (customer named a slot). Belt-and-suspenders
          // (handleCustomerReply already does this, but the gate is a safety
          // net for cases the inbound path missed). Reason field is dynamic so
          // the audit log reflects WHICH positive intent fired.
          await this.leadStatusService.writeStatus({
            ...baseInput,
            newStatus: 'booked',
            reason: `followup_classifier_${intent}`,
          });
        } else if (decision.sideEffect === 'stop_and_lost') {
          // opt_out / hired_elsewhere / completed → lost
          //
          // Historical reactivation guard: when the classifier triggers on
          // OLD conversation history (hired_elsewhere, completed), DO NOT
          // rewrite Lead.status to lost. Those intents reflect what the
          // customer said weeks or months ago; the recovery flow was
          // designed to re-engage them assuming circumstances may have
          // changed. Preserve Lead.status='engaged' and stop the enrollment
          // only. opt_out still flips to lost — that's a real unsubscribe
          // signal we honor regardless of mode.
          const isHistorical = enrollment.modeReason === 'historical_reactivation';
          const shouldWriteLost = !isHistorical || intent === 'opt_out';
          if (!shouldWriteLost) {
            this.logger.log(
              `[FollowUpScheduler] historical_reactivation: preserving Lead.status — skip writeStatus on intent=${intent} for enrollment ${enrollment.id}`,
            );
          } else {
            const lostReason = intent === 'opt_out' ? 'opt_out' : 'hired_someone';
            const reengageAt = intent === 'opt_out'
              ? null
              : new Date(now.getTime() + 21 * 24 * 60 * 60 * 1000);
            await this.leadStatusService.writeStatus({
              ...baseInput,
              newStatus: 'lost',
              lostReason,
              reason: `followup_classifier_${intent}`,
              reengageAt,
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(`[FollowUpScheduler] writeStatus failed for lead ${enrollment.leadId}: ${err.message}`);
      }
    }

    return true;
  }

  private async processEnrollment(enrollment: any, now: Date): Promise<void> {
    // Idempotency: re-check status
    const fresh = await this.prisma.followUpEnrollment.findUnique({
      where: { id: enrollment.id },
    });
    if (!fresh || fresh.status !== 'active') return;

    // Trial paywall: stop the enrollment outright when the trial has ended
    // (canProcessLead already accounts for the 24h grace on existing convos).
    if (enrollment.leadId) {
      const owner = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { userId: true },
      });
      if (owner) {
        const allowed = await this.trialService.canProcessLead(owner.userId, enrollment.conversationId);
        if (!allowed.allowed) {
          await this.engineService.stopEnrollment(enrollment.id, `trial_${allowed.reason}`);
          this.logger.log(`[FollowUpScheduler] Stopped enrollment ${enrollment.id} — trial ${allowed.reason}`);
          return;
        }
      }
    }

    // Conversation-level cooldown: minimum 10-minute gap between consecutive sends
    // to the SAME CONVERSATION (not just the same enrollment). ThreadContext.lastFollowUpSentAt
    // is the single source of truth — it survives duplicate enrollments being cleaned up.
    const tc = await this.prisma.threadContext.findFirst({
      where: { conversationId: enrollment.conversationId },
      select: { lastFollowUpSentAt: true },
    });
    if (tc?.lastFollowUpSentAt) {
      const sinceLastSend = now.getTime() - tc.lastFollowUpSentAt.getTime();
      if (sinceLastSend < 10 * 60_000) {
        const nextDue = new Date(tc.lastFollowUpSentAt.getTime() + 10 * 60_000);
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: { nextStepDueAt: nextDue },
        });
        this.logger.log(`[FollowUpScheduler] Conversation-level cooldown — rescheduled ${enrollment.id} to ${nextDue.toISOString()}`);
        return;
      }
    }

    // Check if lead has a terminal status (booked, done, scheduled, in progress) — no follow-up needed
    if (enrollment.leadId) {
      const lead = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { status: true, thumbtackStatus: true },
      });
      if (lead) {
        const s = (lead.status || '').toLowerCase();
        const ts = (lead.thumbtackStatus || '').toLowerCase();
        const terminalStatuses = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'job done', 'job scheduled', 'completed', 'archived', 'lost', 'closed', 'not hired', 'not_hired', 'job complete', 'no response'];
        const terminalMatch = terminalStatuses.includes(ts) ? ts : terminalStatuses.includes(s) ? s : null;
        if (terminalMatch) {
          await this.engineService.stopEnrollment(enrollment.id, `lead_status_${terminalMatch}`);
          this.logger.log(`[FollowUpScheduler] Lead status is "${terminalMatch}" — stopping enrollment ${enrollment.id}`);
          return;
        }
      }
    }

    // Check quiet hours AND active hours — don't send during nighttime / outside
    // the user-configured availability window. Originally only quiet hours were
    // honored, but the same UI exposes "Set up active time" (followUpAvailability
    // = 'active_hours' + followUpActiveHoursStart/End) that users naturally
    // expect to gate follow-ups too. Carol case: account had 18:00→09:00 active
    // hours but follow-up still fired at 15:41 EDT.
    if (enrollment.leadId) {
      const leadForQuiet = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { businessId: true, userId: true },
      });
      if (leadForQuiet?.businessId) {
        const acct = await this.prisma.savedAccount.findFirst({
          where: { userId: leadForQuiet.userId, businessId: leadForQuiet.businessId },
          select: {
            id: true,
            followUpSettingsJson: true,
            followUpTimezone: true,
            followUpActiveHoursStart: true,
            followUpActiveHoursEnd: true,
            followUpsApplyQuietHours: true,
          },
        });
        if (acct) {
          let settings: any = {};
          try { settings = JSON.parse(acct.followUpSettingsJson || '{}'); } catch {}
          // Canonical TZ resolution: SavedAccount.followUpTimezone → User.businessHoursTimezone → 'America/New_York'.
          // Same helper is used by enrollInSequence + advanceAfterSuggestion + the
          // post-send step compute below, so all four code paths agree on the wall
          // clock they're snapping to.
          const userForTz = await this.prisma.user.findUnique({
            where: { id: leadForQuiet.userId },
            select: { businessHoursTimezone: true },
          }).catch(() => null);
          const tz = resolveTimezone(acct, userForTz);
          const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
          const [h, m] = fmt.format(now).split(':').map(Number);
          const current = h * 60 + m;
          const inWindow = (start: string, end: string): boolean => {
            const [sh, sm] = start.split(':').map(Number);
            const [eh, em] = end.split(':').map(Number);
            const s = sh * 60 + sm;
            const e = eh * 60 + em;
            return s > e ? (current >= s || current < e) : (current >= s && current < e);
          };

          // Quiet hours — two sources, in order:
          //   1. User-level master quiet hours (Settings → General), when the
          //      account opts in via `followUpsApplyQuietHours` (default true).
          //   2. Legacy per-account fuQuietHours* (stored in followUpSettingsJson).
          //      Used only if the master is off or the account has opted out.
          if (acct.followUpsApplyQuietHours) {
            const inQuiet = await this.businessHours.isInQuietHours(leadForQuiet.userId);
            if (inQuiet) {
              const nextDue = new Date(now.getTime() + 60 * 60 * 1000);
              await this.prisma.followUpEnrollment.update({
                where: { id: enrollment.id },
                data: { nextStepDueAt: nextDue },
              });
              this.logger.log(`[FollowUpScheduler] Inside master quiet hours — rescheduled enrollment ${enrollment.id} to ${nextDue.toISOString()}`);
              return;
            }
          }
          if (settings.fuQuietHoursEnabled && settings.fuQuietHoursStart && settings.fuQuietHoursEnd) {
            if (inWindow(settings.fuQuietHoursStart, settings.fuQuietHoursEnd)) {
              const nextDue = this.engineService.computeNextDueAt(now, 0, settings.fuQuietHoursEnd, '23:59', tz);
              await this.prisma.followUpEnrollment.update({
                where: { id: enrollment.id },
                data: { nextStepDueAt: nextDue },
              });
              this.logger.log(`[FollowUpScheduler] Legacy quiet hours — rescheduled enrollment ${enrollment.id} to ${nextDue.toISOString()}`);
              return;
            }
          }

          // Per-account active hours (independent of business hours / quiet hours).
          // Skipped when enrollment.bypassActiveHours=true — set by operator-
          // triggered Immediate Reactivation paths that explicitly want to send
          // outside the account's active-hours window. Master quiet hours
          // (line 740) and legacy quiet hours (line 752) above still ran and
          // remain authoritative — bypassActiveHours only opts out of THIS gate.
          const isActiveHoursMode = (settings.followUpAvailability ?? settings.availability) === 'active_hours';
          const ahStart = acct.followUpActiveHoursStart;
          const ahEnd = acct.followUpActiveHoursEnd;
          if (!enrollment.bypassActiveHours && isActiveHoursMode && ahStart && ahEnd) {
            if (!inWindow(ahStart, ahEnd)) {
              const nextDue = this.engineService.computeNextDueAt(now, 0, ahStart, ahEnd, tz);
              await this.prisma.followUpEnrollment.update({
                where: { id: enrollment.id },
                data: { nextStepDueAt: nextDue },
              });
              this.logger.log(`[FollowUpScheduler] Outside active hours (${ahStart}-${ahEnd} ${tz}) — rescheduled enrollment ${enrollment.id} to ${nextDue.toISOString()}`);
              return;
            }
          } else if (enrollment.bypassActiveHours && isActiveHoursMode && ahStart && ahEnd && !inWindow(ahStart, ahEnd)) {
            // Audit log — operator override observed firing. Surfaces in Loki
            // so reviewers can spot if a bypass row fires after-hours.
            this.logger.log(`[FollowUpScheduler] bypassActiveHours=true — enrollment ${enrollment.id} firing outside active hours (${ahStart}-${ahEnd} ${tz})`);
          }
        }
      }
    }

    // Check if customer has replied SINCE the enrollment was created.
    // Two signals, OR-ed together (defense in depth for providers that may
    // fail to persist a Message row):
    //   1. Message.sender='customer' newer than enrollment.createdAt
    //   2. Lead.lastCustomerActivityAt newer than enrollment.createdAt
    // We deliberately do NOT use ThreadContext.awaitingCustomerReply — it
    // can be false if the business hasn't sent the first message yet.
    const customerRepliedSinceEnrollment = await this.prisma.message.findFirst({
      where: {
        conversationId: enrollment.conversationId,
        sender: 'customer',
        sentAt: { gt: enrollment.createdAt },
      },
      select: { id: true },
    });
    let leadActivitySinceEnrollment = false;
    if (!customerRepliedSinceEnrollment && enrollment.leadId) {
      const leadActivity = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { lastCustomerActivityAt: true },
      });
      leadActivitySinceEnrollment = !!(
        leadActivity?.lastCustomerActivityAt &&
        leadActivity.lastCustomerActivityAt > enrollment.createdAt
      );
    }
    if (customerRepliedSinceEnrollment || leadActivitySinceEnrollment) {
      await this.engineService.stopEnrollment(enrollment.id, 'customer_replied');
      return;
    }

    // Get steps:
    //   long_term mode → hardcoded LONG_TERM_STEPS (7d/14d/30d/90d)
    //   short_term mode → user-configured (if any), else seed template
    let steps: SequenceStep[] = [];
    if ((enrollment as any).followUpMode === 'long_term') {
      steps = LONG_TERM_STEPS.map(s => ({
        stepOrder: s.stepOrder,
        delayMinutes: s.delayMinutes,
        objective: s.objective,
      }));
    } else {
      const userSteps = await this.getUserConfiguredSteps(enrollment.conversationId);
      if (userSteps && userSteps.length > 0) {
        steps = userSteps;
      } else {
        const stepsData = enrollment.sequenceTemplate.stepsJson as any;
        steps = stepsData?.steps || [];
      }
    }
    const step = steps[enrollment.currentStepIndex];

    // Duplicate guard: skip if this step was already sent successfully
    const alreadySent = await this.prisma.followUpStepExecution.findFirst({
      where: { enrollmentId: enrollment.id, stepIndex: enrollment.currentStepIndex, status: 'sent' },
    });
    if (alreadySent) {
      this.logger.log(`[FollowUpScheduler] Step ${enrollment.currentStepIndex} already sent for enrollment ${enrollment.id} — skipping to next`);
      // Advance past this step
      const nextIdx = enrollment.currentStepIndex + 1;
      const nextS = steps[nextIdx];
      if (nextS) {
        // Re-resolve TZ here — the earlier quiet/active-hours block guards
        // its `tz` inside `if (leadForQuiet?.businessId)`, so it isn't in
        // scope on this rare "step already sent, advance" branch. Same
        // helper, same fallback chain, no drift.
        const tz = await this.resolveEnrollmentTimezone(enrollment);
        const nextDue = this.engineService.computeNextDueAt(
          now, nextS.delayMinutes, null, null, tz,
        );
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: { currentStepIndex: nextIdx, nextStepDueAt: nextDue },
        });
      } else {
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: { status: 'completed', completedAt: now, currentStepIndex: nextIdx },
        });
      }
      return;
    }

    // Pending-suggestion guard: in suggest mode, don't generate another card while
    // the previous one is still waiting for the user to approve/skip. Advance only
    // happens via the approve/edit/skip handlers (engineService.advanceAfterSuggestion).
    const pendingSuggestion = await this.prisma.followUpStepExecution.findFirst({
      where: { enrollmentId: enrollment.id, stepIndex: enrollment.currentStepIndex, status: 'suggested' },
    });
    if (pendingSuggestion) {
      this.logger.debug(`[FollowUpScheduler] Step ${enrollment.currentStepIndex} already pending approval for enrollment ${enrollment.id} — waiting`);
      return;
    }

    if (!step) {
      // No more steps — complete
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollment.id },
        data: { status: 'completed', completedAt: now },
      });
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'completed' },
      });
      this.logger.log(`[FollowUpScheduler] Enrollment ${enrollment.id} completed (all steps done)`);
      return;
    }

    // ── Classifier gate ─────────────────────────────────────────────────
    // Last guard before we burn an OpenAI generation + an outbound SMS.
    // Reads the latest customer message and decides whether this enrollment
    // should fire at all. Catches Lynn-class ("please lose my information")
    // and Donna-class ("the house has already been cleaned") cases that the
    // phrase lists or the inbound-reply classifier missed (or pre-dated).
    const stoppedByClassifier = await this.classifyAndMaybeStop(enrollment, now);
    if (stoppedByClassifier) return;

    // Historical reactivation: fail-closed message resolution.
    // The flow uses a dedicated re-engagement copy ("hope your cleaning went
    // well, circumstances may have changed"). Falling through to the AI
    // qualification generator on a missing template would send wrong-tone
    // messaging (we saw this in the Jun 10 smoke — generator produced
    // "can you share the square footage" instead of the reactivation copy).
    // Stop the enrollment and surface a stoppedReason an operator can grep
    // for instead of shipping bad messaging to real customers.
    let historicalReactivationMessage: string | null = null;
    if (enrollment.modeReason === 'historical_reactivation') {
      historicalReactivationMessage = await this.resolveHistoricalReactivationMessage(enrollment);
      if (!historicalReactivationMessage) {
        this.logger.warn(
          `[FollowUpScheduler] historical_reactivation: stopping enrollment ${enrollment.id} — no reactivation template/message configured`,
        );
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: {
            status: 'stopped',
            stoppedReason: 'historical_reactivation_no_template',
            completedAt: now,
          },
        });
        await this.prisma.threadContext.updateMany({
          where: { conversationId: enrollment.conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
        });
        return;
      }
    }

    // Generate message. The generator throws when AI is down AND the account
    // has no saved template text for this step — that's deliberate. We do NOT
    // send a generic "Following up on your request." placeholder; instead we
    // record the execution as failed and retry in 15 minutes, same as a send
    // failure. This keeps the customer experience clean during OpenAI outages.
    //
    // Historical reactivation skips this path entirely — its dedicated copy
    // is resolved above (no AI call, no qualification fallback).
    let generated: GeneratedFollowUp;
    if (historicalReactivationMessage) {
      generated = {
        message: historicalReactivationMessage,
        objective: 'historical_reactivation',
        strategyUsed: 'historical_reactivation',
      };
    } else try {
      generated = await this.generatorService.generateMessage(
        step,
        enrollment.conversationId,
        enrollment.sequenceTemplate.generationMode,
        enrollment.sequenceTemplate.promptTemplateId,
      );
    } catch (err: any) {
      this.logger.error(
        `[FollowUpScheduler] Generation failed for enrollment ${enrollment.id} step ${enrollment.currentStepIndex}: ${err?.message}`,
      );
      await this.prisma.followUpStepExecution.create({
        data: {
          enrollmentId: enrollment.id,
          stepIndex: enrollment.currentStepIndex,
          objective: step.objective,
          status: 'failed',
          scheduledAt: enrollment.nextStepDueAt || now,
          executedAt: now,
        },
      });
      const retryAt = new Date(now.getTime() + 15 * 60_000);
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollment.id },
        data: { nextStepDueAt: retryAt, lastExecutedAt: now },
      });
      this.logger.log(`[FollowUpScheduler] Will retry step ${enrollment.currentStepIndex} at ${retryAt.toISOString()} (generation failure)`);
      return;
    }

    if (enrollment.mode === 'suggest') {
      // Suggestion mode: create step execution with status 'suggested'
      const execution = await this.prisma.followUpStepExecution.create({
        data: {
          enrollmentId: enrollment.id,
          stepIndex: enrollment.currentStepIndex,
          objective: step.objective,
          status: 'suggested',
          scheduledAt: enrollment.nextStepDueAt || now,
          generatedMessage: generated.message,
          strategyUsed: generated.strategyUsed,
        },
      });

      // Emit SSE for real-time UI notification
      const lead = enrollment.leadId
        ? await this.prisma.lead.findUnique({ where: { id: enrollment.leadId }, select: { userId: true } })
        : null;
      if (lead) {
        this.eventEmitter.emit(`followup.suggested.${lead.userId}`, {
          enrollmentId: enrollment.id,
          conversationId: enrollment.conversationId,
          executionId: execution.id,
          objective: step.objective,
          message: generated.message,
        });
      }

      this.logger.log(`[FollowUpScheduler] Suggested step ${enrollment.currentStepIndex} for enrollment ${enrollment.id}: "${step.objective}"`);
      // In suggest mode, hold here — do NOT advance currentStepIndex or schedule
      // the next step. The approve/edit/skip handlers (which call
      // engineService.advanceAfterSuggestion) own the advance.
      return;
    } else {
      // Auto-send mode: send via platform adapter
      let messageId: string | null = null;
      let finalMessage = generated.message;
      let sendStatus = 'sent';

      if (enrollment.leadId) {
        try {
          const lead = await this.prisma.lead.findUnique({
            where: { id: enrollment.leadId },
            select: { userId: true, id: true },
          });
          if (lead) {
            const sentMsg = await this.leadsService.sendMessage(lead.userId, lead.id, generated.message, 'ai');
            // TODO: sentMsg.id is the Yelp adapter's in-memory id (often a random UUID
            // when Yelp's response omits event_id) — NOT a persisted Message.id.
            // FollowUpStepExecution.messageId therefore frequently orphans.
            // To fix, look up Message by externalMessageId (sentMsg.externalMessageId)
            // or by conversationId + finalMessage content.
            messageId = sentMsg?.id || null;

            // Record in thread context
            await this.conversationContext.recordMessage({
              conversationId: enrollment.conversationId,
              leadId: enrollment.leadId,
              platform: enrollment.platform,
              sender: 'pro',
              senderType: 'ai',
              content: generated.message,
              aiGenerated: true,
              isAutoFollowUp: true,
              strategyUsed: generated.strategyUsed || undefined,
            });
          }
        } catch (err: any) {
          this.logger.error(`[FollowUpScheduler] Auto-send failed for enrollment ${enrollment.id}: ${err.message}`);
          // Customer archived the lead — terminal per-lead state, stop the enrollment instead of retrying every 15 min
          if (err.message?.includes('archived')) {
            await this.prisma.followUpStepExecution.create({
              data: {
                enrollmentId: enrollment.id,
                stepIndex: enrollment.currentStepIndex,
                objective: step.objective,
                status: 'cancelled',
                scheduledAt: enrollment.nextStepDueAt || now,
                executedAt: now,
                metadataJson: JSON.stringify({ stoppedReason: 'lead_archived', error: err.message }),
              },
            });
            await this.prisma.followUpEnrollment.update({
              where: { id: enrollment.id },
              data: { status: 'stopped', stoppedReason: 'lead_archived', completedAt: now },
            });
            this.logger.log(`[FollowUpScheduler] Enrollment ${enrollment.id} stopped — lead archived by customer`);
            return;
          }
          // Platform returned 404 on send — the lead/thread no longer exists
          // on the platform side. Could be: TT refund + removal, customer
          // deleted account on Yelp, customer canceled on TT (closes the
          // thread), pro hired-someone-else with thread now closed. Without
          // this branch the scheduler retries every 15 min indefinitely —
          // see Spotless 2026-06-10/11 incident: 6 enrollments × 14-72
          // retries each, 0 sends.
          //
          // For Thumbtack specifically, try to fetch chargeState before
          // deciding the stop reason. chargeState='Refunded' tells us TT
          // refunded the lead — we then mark Lead.refundedAt and
          // budgetVoidedAt so analytics excludes the leadPrice from cost
          // totals (1 = mark as refunded; 2 = void the charge from the
          // lead cost including analytic — see operator spec 2026-06-11).
          //
          // chargeState fetch is best-effort: if the GET also 404s (the
          // negotiation is fully gone), or if credentials decrypt fails,
          // or any adapter exception fires, we fall through to the generic
          // 'platform_thread_unreachable' reason.
          if (err.message?.includes('status code 404')) {
            const { stopReason, refundDetected, chargeState } =
              await this.classifyPlatformUnreachable(enrollment);

            await this.prisma.followUpStepExecution.create({
              data: {
                enrollmentId: enrollment.id,
                stepIndex: enrollment.currentStepIndex,
                objective: step.objective,
                status: 'cancelled',
                scheduledAt: enrollment.nextStepDueAt || now,
                executedAt: now,
                metadataJson: JSON.stringify({
                  stoppedReason: stopReason,
                  error: err.message,
                  platformChargeState: chargeState ?? null,
                  refundDetected,
                }),
              },
            });
            await this.prisma.followUpEnrollment.update({
              where: { id: enrollment.id },
              data: { status: 'stopped', stoppedReason: stopReason, completedAt: now },
            });

            // Persist Lead-side refund signal if we observed it. Skip the
            // write entirely when refund wasn't confirmed — we don't want
            // to clobber chargeStateRaw with non-refund values mid-investigation.
            if (refundDetected && enrollment.leadId) {
              await this.prisma.lead.update({
                where: { id: enrollment.leadId },
                data: {
                  chargeStateRaw: chargeState ?? 'Refunded',
                  refundedAt: now,
                  // budgetVoidedAt mirrors refundedAt on automatic detection.
                  // Analytics queries (getTimeSeries.budget_stats,
                  // getAverageLeadPrice) filter "WHERE budgetVoidedAt IS NULL"
                  // so this single write is what voids the charge.
                  budgetVoidedAt: now,
                },
              });
              this.logger.log(`[FollowUpScheduler] Enrollment ${enrollment.id} stopped — lead refunded; Lead.refundedAt + budgetVoidedAt set`);
            } else {
              this.logger.log(`[FollowUpScheduler] Enrollment ${enrollment.id} stopped — ${stopReason}`);
            }
            return;
          }
          sendStatus = 'failed';
        }
      }

      await this.prisma.followUpStepExecution.create({
        data: {
          enrollmentId: enrollment.id,
          stepIndex: enrollment.currentStepIndex,
          objective: step.objective,
          status: sendStatus,
          scheduledAt: enrollment.nextStepDueAt || now,
          executedAt: now,
          generatedMessage: generated.message,
          finalMessage,
          messageId,
          strategyUsed: generated.strategyUsed,
        },
      });

      this.logger.log(`[FollowUpScheduler] Auto-${sendStatus} step ${enrollment.currentStepIndex} for enrollment ${enrollment.id}: "${step.objective}"`);

      // On failed send: retry the same step in 15 minutes instead of advancing
      if (sendStatus === 'failed') {
        const retryAt = new Date(now.getTime() + 15 * 60_000);
        await this.prisma.followUpEnrollment.update({
          where: { id: enrollment.id },
          data: { nextStepDueAt: retryAt, lastExecutedAt: now },
        });
        this.logger.log(`[FollowUpScheduler] Will retry step ${enrollment.currentStepIndex} at ${retryAt.toISOString()}`);
        return;
      }

      // Successful auto-send: bump conversation-level cooldown source of truth
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { lastFollowUpSentAt: now },
      });
    }

    // Historical reactivation: one-shot send, then hop into a long-term
    // post-followup enrollment +30 days out. The flow is:
    //   1. Mark THIS enrollment completed (no step 1 in the historical
    //      sequence — there is no 11-step plan continuation).
    //   2. Create a fresh `post_historical_reactivation_followup` enrollment
    //      for the same conversation. The engine call is idempotent so
    //      a duplicate scheduler tick re-entering this branch won't
    //      double-enroll.
    //   3. The engine call ALSO repoints ThreadContext at the new
    //      enrollment (`activeEnrollmentId`, `nextFollowUpAt`,
    //      `followUpStatus='active'`) — so we don't clear the cache here.
    //      If the post-followup engine call fails (no template, SF-link,
    //      etc.) we fall back to clearing the cache as before so the
    //      original enrollment's completion isn't blocked.
    if (enrollment.modeReason === 'historical_reactivation') {
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollment.id },
        data: {
          status: 'completed',
          completedAt: now,
          lastExecutedAt: now,
        },
      });

      let postFollowupEnrollmentId: string | null = null;
      try {
        const id = await this.engineService.createPostHistoricalReactivationFollowup(
          enrollment.conversationId,
          enrollment.leadId!,
          now,
        );
        postFollowupEnrollmentId = id || null;
      } catch (err: any) {
        this.logger.error(
          `[FollowUpScheduler] post_historical_reactivation_followup hop failed for ${enrollment.id}: ${err?.message}`,
        );
      }

      if (!postFollowupEnrollmentId) {
        // No post-followup created (sf_linked, missing template, error).
        // Clear ThreadContext so we don't leave a dangling pointer to the
        // now-completed historical_reactivation enrollment.
        await this.prisma.threadContext.updateMany({
          where: { conversationId: enrollment.conversationId },
          data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'completed' },
        });
        this.logger.log(
          `[FollowUpScheduler] Enrollment ${enrollment.id} completed — historical_reactivation one-shot (no post-followup hop)`,
        );
      } else {
        this.logger.log(
          `[FollowUpScheduler] Enrollment ${enrollment.id} completed — historical_reactivation one-shot; hopped to post-followup ${postFollowupEnrollmentId}`,
        );
      }
      return;
    }

    // Advance to next step (only on success or suggest).
    // Follow-ups do NOT use active hours — they use quiet hours (handled
    // at the top of processEnrollment). Pass null to skip active-hours snap.
    const nextStep = steps[enrollment.currentStepIndex + 1];
    if (nextStep) {
      const tzForAdvance = await this.resolveEnrollmentTimezone(enrollment);
      const nextDue = this.engineService.computeNextDueAt(
        now,
        nextStep.delayMinutes,
        null,
        null,
        tzForAdvance,
      );

      await this.prisma.followUpEnrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStepIndex: enrollment.currentStepIndex + 1,
          nextStepDueAt: nextDue,
          lastExecutedAt: now,
        },
      });

      // Update ThreadContext cache
      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { nextFollowUpAt: nextDue, followUpStatus: enrollment.mode === 'suggest' ? 'suggested' : 'active' },
      });
    } else {
      // Last step — complete enrollment
      await this.prisma.followUpEnrollment.update({
        where: { id: enrollment.id },
        data: {
          currentStepIndex: enrollment.currentStepIndex + 1,
          status: 'completed',
          completedAt: now,
          lastExecutedAt: now,
        },
      });

      await this.prisma.threadContext.updateMany({
        where: { conversationId: enrollment.conversationId },
        data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'completed' },
      });

      this.logger.log(`[FollowUpScheduler] Enrollment ${enrollment.id} completed after final step`);
    }
  }

  /**
   * Resolve the dedicated reactivation message for a historical_reactivation
   * enrollment. Returns null when no copy is configured — the caller must
   * fail closed in that case (no AI qualification fallback).
   *
   * Resolution order:
   *   1. enrollment.sequenceTemplate.stepsJson.steps[0].messageTemplate
   *   2. account.followUpSettingsJson.aiHiredCompetitorMessage
   *   3. null
   *
   * After resolving the raw template string, applies placeholder
   * substitution for `{{lead.name}}` and `{{name}}` so the customer sees
   * their first name instead of the literal placeholder. Missing names
   * fall back to "there" (defensive — keeps the message grammatical).
   *
   * Pure DB read — no side effects beyond template loading.
   */
  /**
   * Classify a platform-side 404 on send-time. Best-effort:
   *   - For Thumbtack, fetches the negotiation to read `chargeState`.
   *     If 'Refunded' → returns refund detection + the raw chargeState
   *     so the caller can persist Lead.refundedAt / budgetVoidedAt and
   *     stop with `platform_lead_removed_refunded`.
   *   - For Yelp (no refund concept — subscription billing) or when
   *     enrichment fails for any reason (credentials decrypt error, GET
   *     also 404s, network), returns the generic `platform_thread_unreachable`
   *     reason without touching Lead state.
   *
   * Pure read of Lead + SavedAccount + adapter; never writes here.
   * Caller writes Lead.refundedAt / budgetVoidedAt when refundDetected=true.
   */
  private async classifyPlatformUnreachable(
    enrollment: { id: string; leadId: string | null; platform: string },
  ): Promise<{ stopReason: string; refundDetected: boolean; chargeState: string | null }> {
    const FALLBACK = { stopReason: 'platform_thread_unreachable', refundDetected: false, chargeState: null };

    if (enrollment.platform !== 'thumbtack' || !enrollment.leadId) {
      // Yelp 404s on send mean the lead/conversation was deleted on the
      // platform side — no chargeState equivalent to inspect.
      return FALLBACK;
    }

    try {
      const lead = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { userId: true, businessId: true, externalRequestId: true },
      });
      if (!lead) return FALLBACK;
      const acct = await this.prisma.savedAccount.findFirst({
        where: {
          userId: lead.userId,
          ...(lead.businessId ? { businessId: lead.businessId } : {}),
          platform: 'thumbtack',
        },
        select: { credentialsJson: true },
      });
      if (!acct?.credentialsJson) return FALLBACK;
      const encryptionKey = this.configService.get<string>('encryption.key') || '';
      let credentials: any;
      try {
        credentials = EncryptionUtil.decryptObject(acct.credentialsJson, encryptionKey);
      } catch {
        return FALLBACK;
      }
      const ttAdapter = this.platformFactory.getAdapter('thumbtack') as any;
      const normalized = await ttAdapter.getLead(credentials, lead.externalRequestId);
      const chargeState: string | null = normalized?.platformChargeState ?? null;
      if (chargeState && chargeState.toLowerCase() === 'refunded') {
        return {
          stopReason: 'platform_lead_removed_refunded',
          refundDetected: true,
          chargeState,
        };
      }
      // Got chargeState, not refunded — keep the generic stop reason but
      // still surface chargeState so the step execution metadata records it.
      return { stopReason: 'platform_thread_unreachable', refundDetected: false, chargeState };
    } catch (enrichErr: any) {
      this.logger.warn(
        `[FollowUpScheduler] chargeState enrichment failed for enrollment ${enrollment.id}: ${enrichErr.message}`,
      );
      return FALLBACK;
    }
  }

  private async resolveHistoricalReactivationMessage(enrollment: any): Promise<string | null> {
    let rawMessage: string | null = null;
    let lead: { userId: string; businessId: string | null; customerName: string | null } | null = null;

    if (enrollment.leadId) {
      lead = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { userId: true, businessId: true, customerName: true },
      });
    }

    try {
      const raw = enrollment.sequenceTemplate?.stepsJson;
      const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const steps = Array.isArray(obj) ? obj : (obj?.steps || []);
      const msg = steps[0]?.messageTemplate || steps[0]?.message;
      if (typeof msg === 'string' && msg.trim().length > 0) rawMessage = msg;
    } catch {}

    if (!rawMessage && lead?.businessId) {
      const acct = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (acct?.followUpSettingsJson) {
        try {
          const settings = JSON.parse(acct.followUpSettingsJson);
          const msg = settings.aiHiredCompetitorMessage;
          if (typeof msg === 'string' && msg.trim().length > 0) rawMessage = msg;
        } catch {}
      }
    }

    if (!rawMessage) return null;

    return this.applyHistoricalReactivationPlaceholders(rawMessage, lead?.customerName ?? null);
  }

  /**
   * Render `{{lead.name}}` / `{{name}}` (with arbitrary inner whitespace)
   * against the customer's first name. Missing customerName falls back to
   * "there" so the message stays grammatical. Pure function — exposed for
   * unit testing.
   *
   * Internal only — the standard follow-up generator (AI / template) has its
   * own substitution layer and is intentionally untouched.
   */
  applyHistoricalReactivationPlaceholders(message: string, customerName: string | null): string {
    const first = (customerName ?? '').trim().split(/\s+/)[0];
    const display = first && first.length > 0 ? first : 'there';
    return message.replace(/\{\{\s*(?:lead\.name|name)\s*\}\}/gi, display);
  }

  /**
   * Load user-configured follow-up steps from account settings.
   * Converts UI format { label, delay, message } to SequenceStep { stepOrder, delayMinutes, objective, messageTemplate }.
   */
  private async getUserConfiguredSteps(conversationId: string): Promise<SequenceStep[] | null> {
    try {
      const lead = await this.prisma.lead.findFirst({
        where: { threadId: conversationId },
        select: { businessId: true, userId: true },
      });
      if (!lead?.businessId) return null;

      const account = await this.prisma.savedAccount.findFirst({
        where: { userId: lead.userId, businessId: lead.businessId },
        select: { followUpSettingsJson: true },
      });
      if (!account?.followUpSettingsJson) return null;

      const settings = JSON.parse(account.followUpSettingsJson);
      const uiSteps = settings.followUpSteps || settings.followUpSmartSteps || settings.followUpCustomSteps;
      if (!uiSteps || !Array.isArray(uiSteps) || uiSteps.length === 0) return null;

      // Sequence-level mode wins. When the account is in AI mode we drop any
      // leftover step text so the generator runs the AI path; this keeps stale
      // accounts (saved before the UI strip-on-AI logic landed) consistent
      // with the user's intent without forcing them to re-save.
      const aiMode = settings.followUpReplyType === 'ai';

      return uiSteps.map((s: any, i: number) => ({
        stepOrder: i,
        delayMinutes: this.parseDelay(s.delay),
        objective: 'follow_up',
        messageTemplate: aiMode ? null : (s.message || null),
      }));
    } catch {
      return null;
    }
  }

  /**
   * Resolve the wall-clock timezone for an enrollment via the canonical chain
   * (SavedAccount.followUpTimezone → User.businessHoursTimezone → DEFAULT).
   *
   * Used by the rare advance paths that fall outside the quiet/active-hours
   * block's local `tz` scope. Returns the DEFAULT literal when the lead has
   * no businessId or the savedAccount is missing — never throws.
   */
  private async resolveEnrollmentTimezone(enrollment: any): Promise<string> {
    if (!enrollment?.leadId) return resolveTimezone();
    const lead = await this.prisma.lead.findUnique({
      where: { id: enrollment.leadId },
      select: { userId: true, businessId: true },
    }).catch(() => null);
    if (!lead?.businessId) return resolveTimezone();
    const acct = await this.prisma.savedAccount.findFirst({
      where: { userId: lead.userId, businessId: lead.businessId },
      select: { followUpTimezone: true },
    }).catch(() => null);
    const user = await this.prisma.user.findUnique({
      where: { id: lead.userId },
      select: { businessHoursTimezone: true },
    }).catch(() => null);
    return resolveTimezone(acct, user);
  }

  /** Parse human-readable delay string to minutes */
  private parseDelay(delay: string): number {
    if (!delay) return 60;
    const d = delay.toLowerCase().trim();
    const num = parseFloat(d) || 1;
    if (d.includes('min')) return Math.round(num);
    if (d.includes('hour') || d.includes('hr')) return Math.round(num * 60);
    if (d.includes('day')) return Math.round(num * 1440);
    if (d.includes('week') || d.includes('wk')) return Math.round(num * 10080);
    if (d.includes('month') || d.includes('mo')) return Math.round(num * 43200);
    if (d.includes('year') || d.includes('yr')) return Math.round(num * 525600);
    // Default: treat as minutes
    return Math.round(num);
  }
}
