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
import { CronLockTx, isSkipped, withCronLock } from '../common/utils/cron-lock';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { LeadsService } from '../leads/leads.service';
import { FollowUpEngineService } from './follow-up-engine.service';
import { FollowUpGeneratorService, SequenceStep } from './follow-up-generator.service';
import { LONG_TERM_STEPS } from './long-term-steps';
import { TrialService } from '../trial/trial.service';
import { PlatformFactory } from '../platforms/platform.factory';
import { EncryptionUtil } from '../common/utils/encryption.util';

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
    const dueEnrollments = await tx.followUpEnrollment.findMany({
      where: {
        status: 'active',
        nextStepDueAt: { lte: now },
      },
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

    // Check quiet hours — don't send during nighttime
    if (enrollment.leadId) {
      const leadForQuiet = await this.prisma.lead.findUnique({
        where: { id: enrollment.leadId },
        select: { businessId: true, userId: true },
      });
      if (leadForQuiet?.businessId) {
        const acct = await this.prisma.savedAccount.findFirst({
          where: { userId: leadForQuiet.userId, businessId: leadForQuiet.businessId },
          select: { followUpSettingsJson: true, followUpTimezone: true },
        });
        if (acct?.followUpSettingsJson) {
          try {
            const settings = JSON.parse(acct.followUpSettingsJson);
            if (settings.fuQuietHoursEnabled && settings.fuQuietHoursStart && settings.fuQuietHoursEnd) {
              const tz = acct.followUpTimezone || 'America/New_York';
              const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
              const localTime = formatter.format(now);
              const [h, m] = localTime.split(':').map(Number);
              const [qsH, qsM] = settings.fuQuietHoursStart.split(':').map(Number);
              const [qeH, qeM] = settings.fuQuietHoursEnd.split(':').map(Number);
              const current = h * 60 + m;
              const quietStart = qsH * 60 + qsM;
              const quietEnd = qeH * 60 + qeM;
              // Overnight quiet: e.g. 22:00-08:00
              const inQuiet = quietStart > quietEnd
                ? (current >= quietStart || current < quietEnd)
                : (current >= quietStart && current < quietEnd);
              if (inQuiet) {
                // Reschedule to quiet hours end
                const nextDue = this.engineService.computeNextDueAt(now, 0, settings.fuQuietHoursEnd, '23:59', tz);
                await this.prisma.followUpEnrollment.update({
                  where: { id: enrollment.id },
                  data: { nextStepDueAt: nextDue },
                });
                this.logger.log(`[FollowUpScheduler] Quiet hours — rescheduled enrollment ${enrollment.id} to ${nextDue.toISOString()}`);
                return;
              }
            }
          } catch {}
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
        const nextDue = this.engineService.computeNextDueAt(
          now, nextS.delayMinutes, null, null, 'America/New_York',
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

    // Generate message
    const generated = await this.generatorService.generateMessage(
      step,
      enrollment.conversationId,
      enrollment.sequenceTemplate.generationMode,
      enrollment.sequenceTemplate.promptTemplateId,
    );

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

    // Advance to next step (only on success or suggest).
    // Follow-ups do NOT use active hours — they use quiet hours (handled
    // at the top of processEnrollment). Pass null to skip active-hours snap.
    const nextStep = steps[enrollment.currentStepIndex + 1];
    if (nextStep) {
      const nextDue = this.engineService.computeNextDueAt(
        now,
        nextStep.delayMinutes,
        null,
        null,
        'America/New_York',
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

      return uiSteps.map((s: any, i: number) => ({
        stepOrder: i,
        delayMinutes: this.parseDelay(s.delay),
        objective: 'follow_up',
        messageTemplate: s.message || null,
      }));
    } catch {
      return null;
    }
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
