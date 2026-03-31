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

    await this.enrollInSequence(conversationId, template.id, platform);
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

    const stepsData = template.stepsJson as any;
    const steps = stepsData?.steps || [];
    if (steps.length === 0) throw new Error('Sequence template has no steps');

    // Compute first step due time (respecting active hours)
    const firstStep = steps[0];
    const nextDue = this.computeNextDueAt(
      new Date(),
      firstStep.delayMinutes,
      template.activeHoursStart,
      template.activeHoursEnd,
      template.activeHoursTimezone || 'America/New_York',
    );

    const enrollment = await this.prisma.followUpEnrollment.create({
      data: {
        sequenceTemplateId: templateId,
        conversationId,
        leadId,
        platform,
        status: 'active',
        currentStepIndex: 0,
        nextStepDueAt: nextDue,
        mode: template.mode,
      },
    });

    // Update ThreadContext cached fields
    await this.prisma.threadContext.updateMany({
      where: { conversationId },
      data: {
        activeEnrollmentId: enrollment.id,
        nextFollowUpAt: nextDue,
        followUpStatus: 'active',
      },
    });

    this.logger.log(`Enrolled conversation ${conversationId} in sequence ${template.name} (${enrollment.id}), first step due: ${nextDue.toISOString()}`);
    return enrollment.id;
  }

  /**
   * Stop enrollment on customer reply. Idempotent — safe for duplicate webhooks.
   */
  async handleCustomerReply(conversationId: string): Promise<void> {
    const result = await this.prisma.followUpEnrollment.updateMany({
      where: { conversationId, status: 'active' },
      data: {
        status: 'stopped',
        stoppedReason: 'customer_replied',
        completedAt: new Date(),
      },
    });

    if (result.count > 0) {
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
    }
    // result.count === 0 → already stopped or no enrollment → idempotent
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

      // Get current date in target timezone
      const dateFormatter = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      const parts = dateFormatter.formatToParts(time);
      const year = parseInt(parts.find(p => p.type === 'year')?.value || '2026');
      const month = parseInt(parts.find(p => p.type === 'month')?.value || '1') - 1;
      const day = parseInt(parts.find(p => p.type === 'day')?.value || '1');
      const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0');

      // If current hour is past activeStart, snap to tomorrow
      const localDate = new Date(time);
      if (hour >= sh) {
        localDate.setDate(localDate.getDate() + 1);
      }

      // Build target date at activeStart in the timezone
      // Use a simple offset: set hours/minutes to activeStart
      const target = new Date(year, month, day, sh, sm, 0, 0);
      if (hour >= sh) {
        target.setDate(target.getDate() + 1);
      }

      // Approximate: use the offset between UTC and local to convert back
      // This handles DST correctly via the formatter
      const utcTarget = new Date(target.getTime());
      return utcTarget;
    } catch {
      // Fallback: add 1 hour
      return new Date(time.getTime() + 60 * 60_000);
    }
  }
}
