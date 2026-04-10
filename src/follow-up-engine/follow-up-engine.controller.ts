/**
 * Follow-Up Engine Controller
 *
 * REST endpoints for follow-up management.
 * Phase 1: list templates, enrollments, manual enroll/stop.
 * Phase 3: approve/skip/pause suggestions.
 */

import { Controller, Get, Post, Param, Body, Query, UseGuards, Inject, forwardRef, Logger } from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../common/utils/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { FollowUpEngineService } from './follow-up-engine.service';

@Controller('v1/follow-ups')
@UseGuards(JwtAuthGuard)
export class FollowUpEngineController {
  private readonly logger = new Logger(FollowUpEngineController.name);

  constructor(
    private readonly engineService: FollowUpEngineService,
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => LeadsService))
    private readonly leadsService: LeadsService,
    private readonly conversationContext: ConversationContextService,
  ) {}

  /**
   * List sequence templates for current user.
   */
  @Get('templates')
  async listTemplates(
    @CurrentUser() user: any,
    @Query('platform') platform?: string,
    @Query('triggerState') triggerState?: string,
  ) {
    const templates = await this.prisma.followUpSequenceTemplate.findMany({
      where: {
        userId: user.id,
        ...(platform && { platform }),
        ...(triggerState && { triggerState }),
      },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    return { success: true, count: templates.length, templates };
  }

  /**
   * List active enrollments for current user.
   */
  @Get('enrollments')
  async listEnrollments(
    @CurrentUser() user: any,
    @Query('status') status?: string,
  ) {
    const enrollments = await this.prisma.followUpEnrollment.findMany({
      where: {
        conversation: { userId: user.id },
        ...(status && { status }),
      },
      include: {
        sequenceTemplate: { select: { name: true, triggerState: true, preset: true } },
        lead: { select: { customerName: true, category: true } },
      },
      orderBy: { nextStepDueAt: 'asc' },
    });
    return { success: true, count: enrollments.length, enrollments };
  }

  /**
   * Get enrollment details with step executions.
   */
  @Get('enrollments/:id')
  async getEnrollment(@Param('id') id: string) {
    const enrollment = await this.prisma.followUpEnrollment.findUnique({
      where: { id },
      include: {
        sequenceTemplate: true,
        stepExecutions: { orderBy: { stepIndex: 'asc' } },
        lead: { select: { customerName: true, category: true, city: true, state: true } },
      },
    });
    return { success: true, enrollment };
  }

  /**
   * Manually enroll a conversation in a sequence.
   */
  @Post('enroll')
  async enroll(
    @Body() body: { conversationId: string; templateId: string; platform: string; leadId?: string },
  ) {
    const enrollmentId = await this.engineService.enrollInSequence(
      body.conversationId,
      body.templateId,
      body.platform,
      body.leadId,
    );
    return { success: true, enrollmentId };
  }

  /**
   * Stop an enrollment.
   */
  @Post('enrollments/:id/stop')
  async stop(@Param('id') id: string, @Body('reason') reason?: string) {
    await this.engineService.stopEnrollment(id, reason || 'manual');
    return { success: true };
  }

  /**
   * Pause an enrollment.
   */
  @Post('enrollments/:id/pause')
  async pause(@Param('id') id: string) {
    await this.engineService.pauseEnrollment(id);
    return { success: true };
  }

  /**
   * Resume a paused enrollment.
   */
  @Post('enrollments/:id/resume')
  async resume(@Param('id') id: string) {
    await this.engineService.resumeEnrollment(id);
    return { success: true };
  }

  /**
   * Get pending suggestions for current user (Phase 3: full implementation).
   */
  @Get('suggestions')
  async listSuggestions(@CurrentUser() user: any) {
    const suggestions = await this.prisma.followUpStepExecution.findMany({
      where: {
        status: 'suggested',
        enrollment: { conversation: { userId: user.id } },
      },
      include: {
        enrollment: {
          select: {
            conversationId: true,
            lead: { select: { customerName: true } },
            sequenceTemplate: { select: { name: true } },
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
    });
    return { success: true, count: suggestions.length, suggestions };
  }

  /**
   * Get follow-up settings for a saved account.
   */
  @Get('settings/:savedAccountId')
  async getSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id },
      select: {
        followUpMode: true,
        followUpPreset: true,
        followUpReplyType: true,
        followUpActiveHoursStart: true,
        followUpActiveHoursEnd: true,
        followUpTimezone: true,
        followUpSettingsJson: true,
      },
    });
    if (!account) return { success: false, error: 'Account not found' };
    // Merge extended settings from JSON into the flat response
    const extended = account.followUpSettingsJson ? JSON.parse(account.followUpSettingsJson) : {};
    return { success: true, settings: { ...account, ...extended } };
  }

  /**
   * Save follow-up settings for a saved account + seed templates if needed.
   */
  @Post('settings/:savedAccountId')
  async saveSettings(
    @CurrentUser() user: any,
    @Param('savedAccountId') savedAccountId: string,
    @Body() body: any,
  ) {
    const account = await this.prisma.savedAccount.findFirst({
      where: { id: savedAccountId, userId: user.id },
    });
    if (!account) return { success: false, error: 'Account not found' };

    // Extract extended settings into JSON
    const { mode, preset, replyType, activeHoursStart, activeHoursEnd, timezone, platform,
      steps, timing, customSteps, smartSteps, availability, strategyMode, scenarios, stopOnReply, stopOnOptOut, stopOnBooked,
      onNo, retryDays, urgentCapability, includeHistorical, ...rest } = body;

    const extendedSettings: Record<string, any> = {};
    // Unified steps array (replaces smart/custom split)
    if (steps !== undefined) extendedSettings.followUpSteps = steps;
    // Legacy compat
    if (timing !== undefined) extendedSettings.followUpTiming = timing;
    if (customSteps !== undefined) extendedSettings.followUpCustomSteps = customSteps;
    if (smartSteps !== undefined) extendedSettings.followUpSmartSteps = smartSteps;
    if (availability !== undefined) extendedSettings.followUpAvailability = availability;
    if (strategyMode !== undefined) extendedSettings.followUpStrategyMode = strategyMode;
    if (scenarios !== undefined) extendedSettings.followUpScenarios = scenarios;
    if (stopOnReply !== undefined) extendedSettings.followUpStopOnReply = stopOnReply;
    if (stopOnOptOut !== undefined) extendedSettings.followUpStopOnOptOut = stopOnOptOut;
    if (stopOnBooked !== undefined) extendedSettings.followUpStopOnBooked = stopOnBooked;
    if (onNo !== undefined) extendedSettings.followUpOnNo = onNo;
    if (retryDays !== undefined) extendedSettings.followUpRetryDays = retryDays;
    if (urgentCapability !== undefined) extendedSettings.followUpUrgentCapability = urgentCapability;
    if (body.applyToExisting !== undefined) extendedSettings.followUpApplyToExisting = body.applyToExisting;
    if (body.followUpStrategy !== undefined) extendedSettings.followUpStrategy = body.followUpStrategy;
    if (body.followUpStrategyPrompt !== undefined) extendedSettings.followUpStrategyPrompt = body.followUpStrategyPrompt;
    // Follow-up plan settings
    if (body.fuReEnrollOnSilence !== undefined) extendedSettings.fuReEnrollOnSilence = body.fuReEnrollOnSilence;
    if (body.fuQuietHoursEnabled !== undefined) extendedSettings.fuQuietHoursEnabled = body.fuQuietHoursEnabled;
    if (body.fuQuietHoursStart !== undefined) extendedSettings.fuQuietHoursStart = body.fuQuietHoursStart;
    if (body.fuQuietHoursEnd !== undefined) extendedSettings.fuQuietHoursEnd = body.fuQuietHoursEnd;
    // AI Conversation rules
    if (body.aiStopOnOptOut !== undefined) extendedSettings.aiStopOnOptOut = body.aiStopOnOptOut;
    if (body.aiStopOnBooked !== undefined) extendedSettings.aiStopOnBooked = body.aiStopOnBooked;
    if (body.aiStopOnPriceAgreed !== undefined) extendedSettings.aiStopOnPriceAgreed = body.aiStopOnPriceAgreed;
    if (body.aiMaxReplies !== undefined) extendedSettings.aiMaxReplies = body.aiMaxReplies;

    await this.prisma.savedAccount.update({
      where: { id: savedAccountId },
      data: {
        followUpMode: mode,
        followUpPreset: preset || 'standard',
        followUpReplyType: replyType,
        followUpActiveHoursStart: activeHoursStart,
        followUpActiveHoursEnd: activeHoursEnd,
        followUpTimezone: timezone,
        followUpSettingsJson: Object.keys(extendedSettings).length > 0 ? JSON.stringify(extendedSettings) : undefined,
      },
    });

    // When mode is turned off, stop all active enrollments for this account's leads
    if (mode === 'off') {
      const accountLeads = await this.prisma.lead.findMany({
        where: { userId: user.id, businessId: account.businessId },
        select: { threadId: true },
      });
      const threadIds = accountLeads.map(l => l.threadId).filter(Boolean) as string[];
      if (threadIds.length > 0) {
        const stopped = await this.prisma.followUpEnrollment.updateMany({
          where: { conversationId: { in: threadIds }, status: 'active' },
          data: { status: 'stopped', stoppedReason: 'user_disabled', completedAt: new Date() },
        });
        if (stopped.count > 0) {
          await this.prisma.threadContext.updateMany({
            where: { conversationId: { in: threadIds } },
            data: { activeEnrollmentId: null, nextFollowUpAt: null, followUpStatus: 'stopped' },
          });
        }
      }
    }

    // Seed templates if mode is not 'off' (idempotent — skips if already exist)
    let seeded = 0;
    let enrolled = 0;
    if (mode !== 'off') {
      const { seedPresetsForUser } = await import('./follow-up-seed');
      seeded = await seedPresetsForUser(
        this.prisma,
        user.id,
        body.platform || account.platform || 'yelp',
        body.activeHoursStart || '09:00',
        body.activeHoursEnd || '21:00',
        body.timezone || 'America/New_York',
        savedAccountId,
      );

      // Auto-enroll existing leads only when user explicitly opts in
      if (!includeHistorical) return { success: true, seeded, enrolled: 0 };

      // Run enrollment in background so save returns immediately
      const userId = user.id;
      const businessId = account.businessId;
      const acctPlatform = body.platform || account.platform || 'yelp';

      setImmediate(async () => {
        try {
          const template = await this.prisma.followUpSequenceTemplate.findFirst({
            where: { userId, platform: acctPlatform, enabled: true },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
          });
          if (!template) return;

          const leads = await this.prisma.lead.findMany({
            where: { userId, businessId },
            select: { id: true, threadId: true, platform: true },
          });

          let count = 0;
          for (const lead of leads) {
            if (!lead.threadId) continue;

            // Skip if already has an ACTIVE enrollment
            const existing = await this.prisma.followUpEnrollment.findFirst({
              where: { conversationId: lead.threadId, status: 'active' },
            });
            if (existing) continue;

            // Skip if a follow-up was already sent in the last 24h (prevents re-enrollment spam)
            const recentSend = await this.prisma.followUpStepExecution.findFirst({
              where: {
                enrollment: { conversationId: lead.threadId },
                status: 'sent',
                executedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            });
            if (recentSend) continue;

            // Skip if customer replied AFTER our last message (active conversation — customer engaged)
            const lastProMessage = await this.prisma.message.findFirst({
              where: { conversationId: lead.threadId, sender: 'pro' },
              orderBy: { sentAt: 'desc' },
              select: { sentAt: true },
            });
            if (lastProMessage) {
              const customerReplyAfterUs = await this.prisma.message.findFirst({
                where: { conversationId: lead.threadId, sender: 'customer', sentAt: { gt: lastProMessage.sentAt } },
              });
              if (customerReplyAfterUs) continue; // Customer responded to us — don't follow up
            }

            try {
              await this.engineService.enrollInSequence(lead.threadId, template.id, lead.platform, lead.id);
              count++;
            } catch {
              // Skip failures
            }
          }
          this.logger.log(`[FollowUp] Background enrollment complete: ${count} leads enrolled for business ${businessId}`);
        } catch (err: any) {
          this.logger.error(`[FollowUp] Background enrollment error: ${err.message}`);
        }
      });
    }

    return { success: true, seeded, enrolled: -1 }; // -1 = running in background
  }

  /**
   * Seed preset sequence templates for the current user.
   */
  @Post('seed')
  async seedPresets(
    @CurrentUser() user: any,
    @Body() body: { savedAccountId?: string; platform?: string; activeHoursStart?: string; activeHoursEnd?: string; activeHoursTimezone?: string },
  ) {
    const { seedPresetsForUser } = await import('./follow-up-seed');
    const seeded = await seedPresetsForUser(
      this.prisma,
      user.id,
      body.platform || 'yelp',
      body.activeHoursStart || '09:00',
      body.activeHoursEnd || '21:00',
      body.activeHoursTimezone || 'America/New_York',
      body.savedAccountId,
    );
    return { success: true, seeded };
  }

  /**
   * Run migration from existing AutomationRule follow-ups.
   */
  @Post('migrate')
  async migrate() {
    const { FollowUpMigrationService } = await import('./follow-up-migration.service');
    const migrationService = new FollowUpMigrationService(this.prisma);
    const result = await migrationService.migrateExistingFollowUps();
    return { success: true, ...result };
  }

  /**
   * Bulk-activate follow-ups for leads that don't have active enrollments.
   * Finds or creates enrollments, sets nextStepDueAt to now (staggered).
   */
  @Post('bulk-activate')
  async bulkActivate(
    @CurrentUser() user: any,
    @Body() body: { platform?: string; businessId?: string; leadIds?: string[] },
  ) {
    const { platform, businessId, leadIds } = body;

    // Find eligible leads: user's leads with no active enrollment
    const whereClause: any = { userId: user.id };
    if (platform) whereClause.platform = platform;
    if (businessId) whereClause.businessId = businessId;
    if (leadIds?.length) whereClause.id = { in: leadIds };

    const leads = await this.prisma.lead.findMany({
      where: whereClause,
      select: { id: true, threadId: true, platform: true, businessId: true },
    });

    if (leads.length === 0) return { success: true, activated: 0, message: 'No leads found' };

    // Get existing active/stuck enrollments
    const conversationIds = leads.map(l => l.threadId).filter(Boolean) as string[];
    const existingEnrollments = await this.prisma.followUpEnrollment.findMany({
      where: {
        conversationId: { in: conversationIds },
        status: 'active',
      },
    });

    const activeByConvo = new Map(existingEnrollments.map(e => [e.conversationId, e]));

    // Find a suitable template for this user/platform
    const templatePlatform = platform || leads[0]?.platform || 'yelp';
    const template = await this.prisma.followUpSequenceTemplate.findFirst({
      where: { userId: user.id, platform: templatePlatform, enabled: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });

    if (!template) {
      return { success: false, error: `No follow-up template found for platform ${templatePlatform}. Save follow-up settings first.` };
    }

    let activated = 0;
    let reset = 0;
    const now = new Date();

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      if (!lead.threadId) continue;

      // Check if customer already replied — skip those
      const conversation = await this.prisma.conversation.findUnique({ where: { id: lead.threadId } });
      if (!conversation) continue;

      const existing = activeByConvo.get(lead.threadId);

      if (existing) {
        // Reset stuck enrollment (nextStepDueAt = 2099 or far future)
        const isFarFuture = existing.nextStepDueAt && existing.nextStepDueAt.getTime() > Date.now() + 365 * 24 * 60 * 60 * 1000;
        if (isFarFuture) {
          // Stagger by 30 seconds to avoid blast
          const staggeredDue = new Date(now.getTime() + i * 30_000);
          await this.prisma.followUpEnrollment.update({
            where: { id: existing.id },
            data: { nextStepDueAt: staggeredDue, currentStepIndex: 0 },
          });
          // Clear any failed step executions so steps can be retried
          await this.prisma.followUpStepExecution.deleteMany({
            where: { enrollmentId: existing.id, status: 'failed' },
          });
          await this.prisma.threadContext.updateMany({
            where: { conversationId: lead.threadId },
            data: { nextFollowUpAt: staggeredDue, followUpStatus: 'active' },
          });
          reset++;
        }
      } else {
        // No active enrollment — check if there's a completed/stopped/failed one
        // Only enroll if no customer reply exists
        const customerReply = await this.prisma.message.findFirst({
          where: { conversationId: lead.threadId, sender: 'customer' },
        });
        if (customerReply) continue; // Customer already replied, skip

        try {
          const staggeredDelay = i * 30; // seconds between enrollments
          await this.engineService.enrollInSequence(lead.threadId, template.id, lead.platform, lead.id);
          // Stagger the first step
          if (staggeredDelay > 0) {
            const enrollment = await this.prisma.followUpEnrollment.findFirst({
              where: { conversationId: lead.threadId, status: 'active' },
              orderBy: { createdAt: 'desc' },
            });
            if (enrollment) {
              const staggeredDue = new Date(now.getTime() + staggeredDelay * 1000);
              await this.prisma.followUpEnrollment.update({
                where: { id: enrollment.id },
                data: { nextStepDueAt: staggeredDue },
              });
            }
          }
          activated++;
        } catch {
          // Skip failures silently
        }
      }
    }

    return { success: true, activated, reset, total: leads.length, template: template.name };
  }

  /**
   * Approve a suggestion — send the generated message.
   */
  @Post('suggestions/:id/approve')
  async approveSuggestion(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const execution = await this.prisma.followUpStepExecution.findUnique({
      where: { id },
      include: { enrollment: { include: { lead: { select: { id: true, userId: true } } } } },
    });

    if (!execution || execution.status !== 'suggested') {
      return { success: false, error: 'Suggestion not found or already processed' };
    }

    const lead = execution.enrollment.lead;
    if (!lead || lead.userId !== user.id) {
      return { success: false, error: 'Not authorized' };
    }

    // Send the message
    const message = execution.generatedMessage || '';
    let messageId: string | null = null;
    try {
      const sent = await this.leadsService.sendMessage(lead.userId, lead.id, message);
      messageId = sent?.id || null;

      // Record in thread context
      await this.conversationContext.recordMessage({
        conversationId: execution.enrollment.conversationId,
        leadId: lead.id,
        platform: execution.enrollment.platform,
        sender: 'pro',
        senderType: 'ai',
        content: message,
        aiGenerated: true,
        isAutoFollowUp: true,
      });
    } catch (err: any) {
      await this.prisma.followUpStepExecution.update({
        where: { id },
        data: { status: 'failed', metadataJson: JSON.stringify({ error: err.message }) },
      });
      return { success: false, error: err.message };
    }

    await this.prisma.followUpStepExecution.update({
      where: { id },
      data: { status: 'sent', executedAt: new Date(), finalMessage: message, messageId },
    });

    return { success: true, messageId };
  }

  /**
   * Edit and approve a suggestion — send a modified message.
   */
  @Post('suggestions/:id/edit')
  async editAndApprove(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('message') editedMessage: string,
  ) {
    const execution = await this.prisma.followUpStepExecution.findUnique({
      where: { id },
      include: { enrollment: { include: { lead: { select: { id: true, userId: true } } } } },
    });

    if (!execution || execution.status !== 'suggested') {
      return { success: false, error: 'Suggestion not found or already processed' };
    }

    const lead = execution.enrollment.lead;
    if (!lead || lead.userId !== user.id) {
      return { success: false, error: 'Not authorized' };
    }

    let messageId: string | null = null;
    try {
      const sent = await this.leadsService.sendMessage(lead.userId, lead.id, editedMessage);
      messageId = sent?.id || null;

      await this.conversationContext.recordMessage({
        conversationId: execution.enrollment.conversationId,
        leadId: lead.id,
        platform: execution.enrollment.platform,
        sender: 'pro',
        senderType: 'user',
        content: editedMessage,
        isAutoFollowUp: true,
      });
    } catch (err: any) {
      return { success: false, error: err.message };
    }

    await this.prisma.followUpStepExecution.update({
      where: { id },
      data: { status: 'approved', executedAt: new Date(), finalMessage: editedMessage, messageId },
    });

    return { success: true, messageId };
  }

  /**
   * Skip a suggestion — advance sequence without sending.
   */
  @Post('suggestions/:id/skip')
  async skipSuggestion(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    const execution = await this.prisma.followUpStepExecution.findUnique({
      where: { id },
      include: { enrollment: { include: { lead: { select: { userId: true } } } } },
    });

    if (!execution || execution.status !== 'suggested') {
      return { success: false, error: 'Suggestion not found or already processed' };
    }

    if (execution.enrollment.lead?.userId !== user.id) {
      return { success: false, error: 'Not authorized' };
    }

    await this.prisma.followUpStepExecution.update({
      where: { id },
      data: { status: 'skipped' },
    });

    return { success: true };
  }
}
