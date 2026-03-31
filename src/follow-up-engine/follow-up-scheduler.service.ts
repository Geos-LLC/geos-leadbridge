/**
 * Follow-Up Scheduler Service
 *
 * Cron job: every 60 seconds, finds due enrollments and processes them.
 * Phase 1: skeleton only — logs due enrollments, no execution yet.
 * Phase 2: executes steps (suggest or auto-send).
 */

import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/utils/prisma.service';

@Injectable()
export class FollowUpSchedulerService {
  private readonly logger = new Logger(FollowUpSchedulerService.name);
  private processing = false;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cron: every 60 seconds, find and process due follow-up enrollments.
   * Phase 1: skeleton — finds due, logs count.
   * Phase 2: will execute steps via FollowUpGeneratorService.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async processFollowUps(): Promise<void> {
    // Prevent overlapping runs
    if (this.processing) return;
    this.processing = true;

    try {
      const now = new Date();
      const dueEnrollments = await this.prisma.followUpEnrollment.findMany({
        where: {
          status: 'active',
          nextStepDueAt: { lte: now },
        },
        take: 20, // Batch size
        include: {
          sequenceTemplate: true,
        },
      });

      if (dueEnrollments.length > 0) {
        this.logger.log(`[FollowUpScheduler] Found ${dueEnrollments.length} due enrollments`);

        for (const enrollment of dueEnrollments) {
          // Phase 1: log only. Phase 2 will add execution.
          this.logger.log(
            `[FollowUpScheduler] Due: enrollment=${enrollment.id} conversation=${enrollment.conversationId} ` +
            `step=${enrollment.currentStepIndex} template=${enrollment.sequenceTemplate.name}`
          );
        }
      }
    } catch (err: any) {
      this.logger.error(`[FollowUpScheduler] Error: ${err.message}`);
    } finally {
      this.processing = false;
    }
  }
}
