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
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { LeadsService } from '../leads/leads.service';
import { FollowUpEngineService } from './follow-up-engine.service';
import { FollowUpGeneratorService, SequenceStep } from './follow-up-generator.service';
import { LONG_TERM_STEPS } from './long-term-steps';
import { TrialService } from '../trial/trial.service';

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
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processFollowUps(): Promise<void> {
    if (!this.schedulerEnabled || this.processing) return;
    this.processing = true;

    try {
      // Use Postgres advisory lock to prevent staging + production from processing simultaneously
      // Lock ID 7001 = follow-up scheduler
      const lockResult = await this.prisma.$queryRawUnsafe<any[]>('SELECT pg_try_advisory_lock(7001) AS locked');
      const gotLock = lockResult?.[0]?.locked === true;
      if (!gotLock) {
        this.logger.debug('[FollowUpScheduler] Another instance holds the lock — skipping this cycle');
        return;
      }

      const now = new Date();
      const dueEnrollments = await this.prisma.followUpEnrollment.findMany({
        where: {
          status: 'active',
          nextStepDueAt: { lte: now },
        },
        take: 20,
        include: {
          sequenceTemplate: true,
        },
      });

      if (dueEnrollments.length === 0) {
        if (now.getMinutes() % 10 === 0 && now.getSeconds() < 60) {
          this.logger.debug('[FollowUpScheduler] Cron alive — no due enrollments');
        }
        // Release lock before returning
        await this.prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(7001)').catch(() => {});
        return;
      }

      this.logger.log(`[FollowUpScheduler] Processing ${dueEnrollments.length} due enrollments`);

      // Defense-in-depth: group by conversationId, process ONE canonical enrollment
      // per conversation per cycle. Even with the partial unique index, historical
      // data or brief races could leave sibling active rows — stop them instead of
      // letting each one fire its step.
      const byConversation = new Map<string, typeof dueEnrollments>();
      for (const e of dueEnrollments) {
        const arr = byConversation.get(e.conversationId) ?? [];
        arr.push(e);
        byConversation.set(e.conversationId, arr);
      }

      for (const [conversationId, group] of byConversation) {
        group.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        const [canonical, ...duplicates] = group;

        if (duplicates.length > 0) {
          this.logger.warn(`[FollowUpScheduler] Found ${duplicates.length} duplicate active enrollments on conversation ${conversationId} — stopping duplicates, processing ${canonical.id}`);
          await this.prisma.followUpEnrollment.updateMany({
            where: { id: { in: duplicates.map((d) => d.id) } },
            data: {
              status: 'stopped',
              stoppedReason: 'duplicate_cleanup',
              completedAt: new Date(),
            },
          });
          await this.prisma.followUpStepExecution.updateMany({
            where: {
              enrollmentId: { in: duplicates.map((d) => d.id) },
              status: { in: ['scheduled', 'suggested'] },
            },
            data: { status: 'cancelled' },
          });
        }

        // Atomic claim — only one worker processes a given enrollment per lease window.
        // Lease of 2 minutes auto-expires if processing crashes.
        const token = randomUUID();
        const leaseEnd = new Date(now.getTime() + 2 * 60_000);
        const { count } = await this.prisma.followUpEnrollment.updateMany({
          where: {
            id: canonical.id,
            status: 'active',
            OR: [
              { processingUntil: null },
              { processingUntil: { lt: now } },
            ],
          },
          data: { processingUntil: leaseEnd, processingToken: token },
        });
        if (count === 0) {
          this.logger.debug(`[FollowUpScheduler] Could not claim ${canonical.id} — another worker or already processed`);
          continue;
        }

        try {
          await this.processEnrollment(canonical, now);
        } catch (err: any) {
          this.logger.error(`[FollowUpScheduler] Error processing enrollment ${canonical.id}: ${err.message}`);
        } finally {
          // Release the lease only if WE still hold it (token match). A stale lease
          // from a crashed previous run will be reclaimed by whoever gets there next.
          await this.prisma.followUpEnrollment.updateMany({
            where: { id: canonical.id, processingToken: token },
            data: { processingUntil: null, processingToken: null },
          }).catch(() => {});
        }
      }
    } catch (err: any) {
      this.logger.error(`[FollowUpScheduler] Cron error: ${err.message}`);
    } finally {
      // Always release advisory lock and processing flag
      await this.prisma.$queryRawUnsafe('SELECT pg_advisory_unlock(7001)').catch(() => {});
      this.processing = false;
    }
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

    // Check if customer has replied SINCE the enrollment was created
    // Don't use awaitingCustomerReply — it may be false if the business hasn't
    // sent the first message yet. Instead, check if there's a customer message
    // after the enrollment was created.
    const customerRepliedSinceEnrollment = await this.prisma.message.findFirst({
      where: {
        conversationId: enrollment.conversationId,
        sender: 'customer',
        sentAt: { gt: enrollment.createdAt },
      },
    });
    if (customerRepliedSinceEnrollment) {
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
