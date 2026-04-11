/**
 * Follow-Up Engine Service
 *
 * Orchestrator: evaluateThread, enrollInSequence, handleCustomerReply, stopEnrollment.
 * Reads from ThreadContext (via ConversationContextService), writes to follow-up tables.
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../common/utils/prisma.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { FollowUpStateService, FollowUpState } from './follow-up-state.service';

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
      const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'job done', 'job scheduled', 'completed', 'archived', 'lost'];
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
   */
  async enrollInSequence(
    conversationId: string,
    templateId: string,
    platform: string,
    leadId?: string,
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
    const steps = stepsData?.steps || [];
    if (steps.length === 0) throw new Error('Sequence template has no steps');

    // Smart step positioning: count ALL pro messages already sent to this conversation
    // (manual + auto-reply + follow-ups) and start from the corresponding step index.
    // This prevents re-enrollment from sending duplicate "checking in" messages.
    let startStepIndex = 0;
    let lastMessageSentAt: Date | null = null;
    if (leadId) {
      const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { threadId: true, userId: true, businessId: true } });
      if (lead?.threadId) {
        // Count all pro messages sent in this conversation
        const proMessageCount = await this.prisma.message.count({
          where: { conversationId: lead.threadId, sender: 'pro' },
        });

        // Get the last message sent (for computing next due time relative to it)
        const lastProMsg = await this.prisma.message.findFirst({
          where: { conversationId: lead.threadId, sender: 'pro' },
          orderBy: { sentAt: 'desc' },
          select: { sentAt: true },
        });
        if (lastProMsg) lastMessageSentAt = lastProMsg.sentAt;

        if (proMessageCount > 0) {
          // Map message count to step index: if 3 messages were sent, start at step 3 (0-indexed)
          // But cap at steps.length - 1 to leave at least one step to send
          const messageBasedIndex = Math.min(proMessageCount, steps.length - 1);

          // Also check re-enroll delay from account settings (minimum step delay threshold)
          const acct = lead.businessId ? await this.prisma.savedAccount.findFirst({
            where: { userId: lead.userId, businessId: lead.businessId },
            select: { followUpSettingsJson: true },
          }).catch(() => null) : null;
          let reEnrollDelayMinutes = 1440; // default 24h
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
          // Find first step with delay >= re-enroll delay
          const delayBasedIndex = steps.findIndex((s: any) => (s.delayMinutes || 0) >= reEnrollDelayMinutes);
          const delayIndex = delayBasedIndex > 0 ? delayBasedIndex : 0;

          // Use whichever starts later (more messages sent = further along)
          startStepIndex = Math.max(messageBasedIndex, delayIndex);

          this.logger.log(`[FollowUp] ${proMessageCount} pro messages sent — messageBasedIndex=${messageBasedIndex}, delayBasedIndex=${delayIndex}, startStepIndex=${startStepIndex}`);
        }
      }
    }

    // Compute first step due time relative to the last message sent (not now),
    // so step delays reflect time since last contact, not enrollment time.
    const firstStep = steps[startStepIndex];
    const fromTime = lastMessageSentAt || new Date();
    const nextDue = this.computeNextDueAt(
      fromTime,
      firstStep.delayMinutes,
      template.activeHoursStart,
      template.activeHoursEnd,
      template.activeHoursTimezone || 'America/New_York',
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

    const enrollment = await this.prisma.followUpEnrollment.create({
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
    });

    // Update ThreadContext cached fields
    await this.prisma.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeEnrollmentId: enrollment.id,
        nextFollowUpAt: effectiveNextDue,
        followUpStatus: 'active',
      },
    });

    this.logger.log(`Enrolled conversation ${conversationId} in sequence ${template.name} (${enrollment.id}), step ${startStepIndex}/${steps.length}, due: ${effectiveNextDue.toISOString()}`);
    return enrollment.id;
  }

  /**
   * Stop enrollment on customer reply. Idempotent — safe for duplicate webhooks.
   * Returns whether any enrollment was actually stopped (for re-engagement alerts).
   */
  async handleCustomerReply(conversationId: string, customerMessage?: string): Promise<{ stopped: boolean; reEngagementAlert: string | null }> {
    const result = await this.prisma.followUpEnrollment.updateMany({
      where: { conversationId, status: 'active' },
      data: {
        status: 'stopped',
        stoppedReason: 'customer_replied',
        completedAt: new Date(),
      },
    });

    if (result.count === 0) {
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
   */
  async stopEnrollment(enrollmentId: string, reason: string): Promise<void> {
    await this.prisma.followUpEnrollment.updateMany({
      where: { id: enrollmentId, status: 'active' },
      data: {
        status: 'stopped',
        stoppedReason: reason,
        completedAt: new Date(),
      },
    });

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
   * Pause/resume an enrollment.
   */
  async pauseEnrollment(enrollmentId: string): Promise<void> {
    await this.prisma.followUpEnrollment.updateMany({
      where: { id: enrollmentId, status: 'active' },
      data: { status: 'paused' },
    });
  }

  async resumeEnrollment(enrollmentId: string): Promise<void> {
    await this.prisma.followUpEnrollment.updateMany({
      where: { id: enrollmentId, status: 'paused' },
      data: { status: 'active' },
    });
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
}
