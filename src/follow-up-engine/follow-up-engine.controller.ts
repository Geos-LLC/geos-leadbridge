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
import { TenancyService } from '../common/tenancy/tenancy.service';
import { LeadsService } from '../leads/leads.service';
import { ConversationContextService } from '../conversation-context/conversation-context.service';
import { FollowUpEngineService } from './follow-up-engine.service';
import { FollowUpGeneratorService, SequenceStep } from './follow-up-generator.service';
import { FollowUpGateService } from './follow-up-gate.service';
import { TrialService } from '../trial/trial.service';
import { ensureCustomerReplyPresets } from './follow-up-seed';

@Controller('v1/follow-ups')
@UseGuards(JwtAuthGuard)
export class FollowUpEngineController {
  private readonly logger = new Logger(FollowUpEngineController.name);

  constructor(
    private readonly engineService: FollowUpEngineService,
    private readonly prisma: PrismaService,
    private readonly tenancyService: TenancyService,
    @Inject(forwardRef(() => LeadsService))
    private readonly leadsService: LeadsService,
    private readonly conversationContext: ConversationContextService,
    private readonly generatorService: FollowUpGeneratorService,
    private readonly trialService: TrialService,
    private readonly gateService: FollowUpGateService,
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
  async getEnrollment(@CurrentUser() user: any, @Param('id') id: string) {
    await this.tenancyService.requireEnrollmentAccess(id, user.id);
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
   * Get rich enrollment info for a conversation (used by Messages right panel).
   * Returns: step progress, next due time, next message preview, enrollment ID.
   */
  @Get('enrollment-info/:conversationId')
  async getEnrollmentInfo(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    const startedAt = Date.now();

    // Round 1: enrollment + lead are independent — fetch together.
    const [enrollment, lead] = await Promise.all([
      this.prisma.followUpEnrollment.findFirst({
        where: { conversationId, status: 'active' },
        include: { sequenceTemplate: true },
      }),
      this.prisma.lead.findFirst({
        where: { threadId: conversationId },
        select: { businessId: true, userId: true },
      }),
    ]);
    const afterRound1 = Date.now();

    const savedAccountPromise = lead?.businessId
      ? this.prisma.savedAccount.findFirst({
          where: { userId: lead.userId, businessId: lead.businessId },
          select: { aiConversationEnabled: true, followUpMode: true, followUpActiveHoursStart: true, followUpActiveHoursEnd: true, followUpTimezone: true, followUpSettingsJson: true },
        })
      : Promise.resolve(null);

    if (!enrollment) {
      // Round 2: savedAccount + lastEnrollment.
      const [acct, lastEnrollment] = await Promise.all([
        savedAccountPromise,
        this.prisma.followUpEnrollment.findFirst({
          where: { conversationId },
          orderBy: { createdAt: 'desc' },
          select: { status: true, stoppedReason: true, completedAt: true, currentStepIndex: true },
        }),
      ]);

      let aiConversationOn = false;
      let followUpMode: string | null = null;
      let aiAvailability: string | null = null;
      let aiActiveHoursStart: string | null = null;
      let aiActiveHoursEnd: string | null = null;
      let aiTimezone: string | null = null;
      let aiExtraWindows: any[] | null = null;
      if (acct) {
        aiConversationOn = acct.aiConversationEnabled ?? false;
        followUpMode = acct.followUpMode || null;
        aiActiveHoursStart = acct.followUpActiveHoursStart || null;
        aiActiveHoursEnd = acct.followUpActiveHoursEnd || null;
        aiTimezone = acct.followUpTimezone || null;
        if (acct.followUpSettingsJson) {
          try {
            const s = JSON.parse(acct.followUpSettingsJson);
            aiAvailability = s.followUpAvailability || null;
            if (s.fuExtraWindows) aiExtraWindows = s.fuExtraWindows;
          } catch {}
        }
        if (!aiAvailability) {
          aiAvailability = aiActiveHoursStart ? 'active_hours' : 'always';
        }
      }

      this.logger.log(`[enrollment-info] convId=${conversationId} branch=no-enrollment r1=${afterRound1 - startedAt}ms total=${Date.now() - startedAt}ms`);

      return {
        success: true,
        enrollment: null,
        aiConversationOn,
        aiAvailability,
        aiActiveHoursStart,
        aiActiveHoursEnd,
        aiTimezone,
        aiExtraWindows,
        followUpMode,
        lastEnrollment: lastEnrollment ? {
          status: lastEnrollment.status,
          stoppedReason: lastEnrollment.stoppedReason,
          completedAt: lastEnrollment.completedAt,
          stepReached: lastEnrollment.currentStepIndex,
        } : null,
      };
    }

    const currentStep = enrollment.currentStepIndex;

    // Round 2: savedAccount + pendingSuggestion + sentCount.
    const [acct, pendingSuggestion, sentCount] = await Promise.all([
      savedAccountPromise,
      this.prisma.followUpStepExecution.findFirst({
        where: { enrollmentId: enrollment.id, stepIndex: currentStep, status: 'suggested' },
        select: { id: true, generatedMessage: true, strategyUsed: true },
      }),
      this.prisma.followUpStepExecution.count({
        where: { enrollmentId: enrollment.id, status: 'sent' },
      }),
    ]);

    let aiConversationOn = false;
    let aiAvailability: string = 'always';
    let aiActiveHoursStart: string | null = null;
    let aiActiveHoursEnd: string | null = null;
    let aiTimezone: string | null = null;
    let aiExtraWindows: any[] | null = null;
    let userSteps: SequenceStep[] | null = null;
    if (acct) {
      aiConversationOn = acct.aiConversationEnabled ?? false;
      aiActiveHoursStart = acct.followUpActiveHoursStart || null;
      aiActiveHoursEnd = acct.followUpActiveHoursEnd || null;
      aiTimezone = acct.followUpTimezone || null;
      if (acct.followUpSettingsJson) {
        try {
          const s = JSON.parse(acct.followUpSettingsJson);
          aiAvailability = s.followUpAvailability || (aiActiveHoursStart ? 'active_hours' : 'always');
          if (s.fuExtraWindows) aiExtraWindows = s.fuExtraWindows;
          const uiSteps = s.followUpSteps || s.followUpSmartSteps || s.followUpCustomSteps;
          if (Array.isArray(uiSteps) && uiSteps.length > 0) {
            userSteps = uiSteps.map((step: any, i: number) => ({
              stepOrder: i,
              delayMinutes: this.parseDelay(step.delay),
              objective: 'follow_up',
              messageTemplate: step.message || null,
            }));
          }
        } catch {}
      }
    }

    // Prefer user-configured steps, fall back to template.
    let steps: SequenceStep[] = [];
    if (userSteps && userSteps.length > 0) {
      steps = userSteps;
    } else {
      const stepsData = enrollment.sequenceTemplate.stepsJson as any;
      steps = stepsData?.steps || [];
    }

    const totalSteps = steps.length;
    const nextStep = steps[currentStep];

    let nextMessagePreview: string | null = null;
    let nextMessageMode: 'template' | 'ai' = 'ai';
    if (nextStep?.messageTemplate) {
      nextMessagePreview = nextStep.messageTemplate;
      nextMessageMode = 'template';
    }
    if (pendingSuggestion?.generatedMessage) {
      nextMessagePreview = pendingSuggestion.generatedMessage;
    }

    this.logger.log(`[enrollment-info] convId=${conversationId} branch=active enrollmentId=${enrollment.id} r1=${afterRound1 - startedAt}ms total=${Date.now() - startedAt}ms`);

    return {
      success: true,
      enrollment: {
        id: enrollment.id,
        status: enrollment.status,
        mode: enrollment.mode,
        currentStepIndex: currentStep,
        totalSteps,
        sentCount,
        nextStepDueAt: enrollment.nextStepDueAt,
        nextStepObjective: nextStep?.objective || null,
        nextStepDelayMinutes: nextStep?.delayMinutes || null,
        nextMessagePreview,
        nextMessageMode,
        pendingSuggestionId: pendingSuggestion?.id || null,
        aiConversationOn,
        aiAvailability,
        aiActiveHoursStart,
        aiActiveHoursEnd,
        aiTimezone,
        aiExtraWindows,
      },
    };
  }

  /**
   * Generate a preview of the next follow-up message (on-demand for AI mode).
   */
  @Post('enrollment-info/:conversationId/preview')
  async generatePreview(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    const enrollment = await this.prisma.followUpEnrollment.findFirst({
      where: { conversationId, status: 'active' },
      include: { sequenceTemplate: true },
    });
    if (!enrollment) return { success: false, error: 'No active enrollment' };

    let steps: SequenceStep[] = [];
    const userSteps = await this.getUserConfiguredSteps(conversationId);
    if (userSteps && userSteps.length > 0) {
      steps = userSteps;
    } else {
      const stepsData = enrollment.sequenceTemplate.stepsJson as any;
      steps = stepsData?.steps || [];
    }

    const step = steps[enrollment.currentStepIndex];
    if (!step) return { success: false, error: 'No more steps' };

    // v8.1/Phase-1-Task-2: gate the preview path with the same classifier
    // logic the scheduler uses. Without this, the preview can render AI text
    // for a customer who has opted out / completed / hired elsewhere — exactly
    // the "creepy follow-up" symptom we're closing. Pure-decision; no DB
    // mutations here. The next scheduler tick will apply side effects.
    const decision = await this.gateService.evaluate({
      conversationId,
      enrollmentId: enrollment.id,
      leadId: enrollment.leadId ?? null,
      triggerState: enrollment.sequenceTemplate?.triggerState ?? null,
    });

    if (decision.shouldBlock) {
      this.logger.warn(`[FollowUpController] Preview BLOCKED enrollment=${enrollment.id} intent=${decision.intent} conf=${decision.confidence.toFixed(2)} reason="${decision.classifierReason ?? ''}"`);
      return {
        success: false,
        blocked: true,
        reason: decision.reason,
        intent: decision.intent,
        confidence: decision.confidence,
        classifierReason: decision.classifierReason,
        // UI hint: scheduler will stop this enrollment + flip lead status on
        // next tick. Caller may show "won't fire — customer said X".
        nextAction: decision.sideEffect,
      };
    }

    const generated = await this.generatorService.generateMessage(
      step,
      conversationId,
      enrollment.sequenceTemplate.generationMode,
      enrollment.sequenceTemplate.promptTemplateId,
    );

    return {
      success: true,
      message: generated.message,
      strategyUsed: generated.strategyUsed,
      // Echo the gate metadata even on pass — useful for UI badges
      // ("classifier: engaged @ 0.9") and for path-divergence diagnostics.
      gate: {
        action: decision.action,
        intent: decision.intent,
        confidence: decision.confidence,
      },
    };
  }

  /**
   * Restart follow-ups for a conversation. Creates a new enrollment
   * using smart step positioning (skips steps based on messages already sent).
   */
  @Post('restart/:conversationId')
  async restartFollowUp(
    @CurrentUser() user: any,
    @Param('conversationId') conversationId: string,
  ) {
    // Find the lead
    const lead = await this.prisma.lead.findFirst({
      where: { threadId: conversationId },
      select: { id: true, platform: true, businessId: true, userId: true },
    });
    if (!lead || lead.userId !== user.id) {
      return { success: false, error: 'Lead not found' };
    }

    // Stop any existing active enrollment first
    await this.prisma.followUpEnrollment.updateMany({
      where: { conversationId, status: 'active' },
      data: { status: 'stopped', stoppedReason: 'restart', completedAt: new Date() },
    });

    // Find a template
    const template = await this.prisma.followUpSequenceTemplate.findFirst({
      where: { userId: user.id, platform: lead.platform, enabled: true },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    if (!template) {
      return { success: false, error: 'No follow-up template found. Save follow-up settings first.' };
    }

    // Enroll with smart step positioning
    const enrollmentId = await this.engineService.enrollInSequence(
      conversationId, template.id, lead.platform, lead.id,
    );

    return { success: true, enrollmentId };
  }

  /**
   * Load user-configured follow-up steps from account settings.
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

  private parseDelay(delay: string): number {
    if (!delay) return 60;
    const d = delay.toLowerCase().trim();
    const num = parseFloat(d) || 1;
    if (d.includes('min')) return Math.round(num);
    if (d.includes('hour') || d.includes('hr')) return Math.round(num * 60);
    if (d.includes('day')) return Math.round(num * 1440);
    if (d.includes('week') || d.includes('wk')) return Math.round(num * 10080);
    return Math.round(num);
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
  async stop(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body('reason') reason?: string,
  ) {
    await this.tenancyService.requireEnrollmentAccess(id, user.id);
    await this.engineService.stopEnrollment(id, reason || 'manual');
    return { success: true };
  }

  /**
   * Pause an enrollment.
   */
  @Post('enrollments/:id/pause')
  async pause(@CurrentUser() user: any, @Param('id') id: string) {
    await this.tenancyService.requireEnrollmentAccess(id, user.id);
    await this.engineService.pauseEnrollment(id);
    return { success: true };
  }

  /**
   * Resume a paused enrollment.
   */
  @Post('enrollments/:id/resume')
  async resume(@CurrentUser() user: any, @Param('id') id: string) {
    await this.tenancyService.requireEnrollmentAccess(id, user.id);
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
        aiConversationEnabled: true,
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

    // Diagnostic — log the fields users care most about so toggle bugs are
    // visible in Loki without DB inspection.
    this.logger.log(
      `[follow-up.saveSettings] acct=${savedAccountId} ` +
      `aiConversationEnabled=${body.aiConversationEnabled === undefined ? '(omitted)' : body.aiConversationEnabled} ` +
      `mode=${body.mode === undefined ? '(omitted)' : body.mode} ` +
      `followUpStrategy=${body.followUpStrategy === undefined ? '(omitted)' : body.followUpStrategy} ` +
      `followUpStrategyPrompt=${body.followUpStrategyPrompt === undefined ? '(omitted)' : (body.followUpStrategyPrompt === null ? 'null' : (body.followUpStrategyPrompt + '').length + ' chars')} ` +
      `availability=${body.availability ?? '(omitted)'} ` +
      `keys=[${Object.keys(body).join(',')}]`
    );

    // Extract extended settings into JSON
    const { mode, preset, replyType, activeHoursStart, activeHoursEnd, timezone, platform,
      steps, timing, customSteps, smartSteps, availability, strategyMode, scenarios, stopOnReply, stopOnOptOut, stopOnBooked,
      onNo, retryDays, urgentCapability, includeHistorical, ...rest } = body;

    // Merge with existing followUpSettingsJson so partial saves (e.g. only the
    // strategy from the central AI Strategy panel) don't wipe out other
    // fields (quiet hours, AI rules, re-engagement settings, etc.).
    let extendedSettings: Record<string, any> = {};
    if (account.followUpSettingsJson) {
      try { extendedSettings = JSON.parse(account.followUpSettingsJson) || {}; } catch { extendedSettings = {}; }
    }
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
    if (body.fuExtraWindows !== undefined) extendedSettings.fuExtraWindows = body.fuExtraWindows;
    if (body.fuReEnrollOnSilence !== undefined) extendedSettings.fuReEnrollOnSilence = body.fuReEnrollOnSilence;
    if (body.fuReEnrollDelay !== undefined) extendedSettings.fuReEnrollDelay = body.fuReEnrollDelay;
    if (body.fuQuietHoursEnabled !== undefined) extendedSettings.fuQuietHoursEnabled = body.fuQuietHoursEnabled;
    if (body.fuQuietHoursStart !== undefined) extendedSettings.fuQuietHoursStart = body.fuQuietHoursStart;
    if (body.fuQuietHoursEnd !== undefined) extendedSettings.fuQuietHoursEnd = body.fuQuietHoursEnd;
    // AI Conversation rules
    if (body.aiStopOnOptOut !== undefined) extendedSettings.aiStopOnOptOut = body.aiStopOnOptOut;
    if (body.aiStopOnBooked !== undefined) extendedSettings.aiStopOnBooked = body.aiStopOnBooked;
    if (body.aiStopOnPriceAgreed !== undefined) extendedSettings.aiStopOnPriceAgreed = body.aiStopOnPriceAgreed;
    if (body.aiMaxReplies !== undefined) extendedSettings.aiMaxReplies = body.aiMaxReplies;
    // Customer-reply trigger follow-ups (deferral / hired-competitor)
    if (body.aiDeferralCheckIn !== undefined) extendedSettings.aiDeferralCheckIn = body.aiDeferralCheckIn;
    if (body.aiDeferralDelay !== undefined) extendedSettings.aiDeferralDelay = body.aiDeferralDelay;
    if (body.aiDeferralMessage !== undefined) extendedSettings.aiDeferralMessage = body.aiDeferralMessage;
    if (body.aiHiredCompetitorReengage !== undefined) extendedSettings.aiHiredCompetitorReengage = body.aiHiredCompetitorReengage;
    if (body.aiHiredCompetitorDelay !== undefined) extendedSettings.aiHiredCompetitorDelay = body.aiHiredCompetitorDelay;
    if (body.aiHiredCompetitorMessage !== undefined) extendedSettings.aiHiredCompetitorMessage = body.aiHiredCompetitorMessage;
    // Re-engagement alerts
    if (body.reEngagementAlertEnabled !== undefined) extendedSettings.reEngagementAlertEnabled = body.reEngagementAlertEnabled;
    if (body.reEngagementTemplate !== undefined) extendedSettings.reEngagementTemplate = body.reEngagementTemplate;

    // Use `undefined` (not nullish-coalesce-default) for fields that weren't
    // sent so partial saves from the central AI Strategy panel don't reset
    // unrelated columns to defaults.
    await this.prisma.savedAccount.update({
      where: { id: savedAccountId },
      data: {
        followUpMode: mode ?? undefined,
        aiConversationEnabled: body.aiConversationEnabled ?? undefined,
        followUpPreset: preset ?? undefined,
        followUpReplyType: replyType ?? undefined,
        followUpActiveHoursStart: activeHoursStart ?? undefined,
        followUpActiveHoursEnd: activeHoursEnd ?? undefined,
        followUpTimezone: timezone ?? undefined,
        followUpSettingsJson: Object.keys(extendedSettings).length > 0 ? JSON.stringify(extendedSettings) : undefined,
      },
    });

    // Propagate the customer-reply trigger settings to the corresponding
    // FollowUpSequenceTemplate. The templates are the source of truth for
    // the enrollment engine, so delay + message edits in the UI need to
    // land there too. Lazy-seed them first if they don't exist yet.
    const triggerSettingsTouched =
      body.aiDeferralCheckIn !== undefined || body.aiDeferralDelay !== undefined || body.aiDeferralMessage !== undefined ||
      body.aiHiredCompetitorReengage !== undefined || body.aiHiredCompetitorDelay !== undefined || body.aiHiredCompetitorMessage !== undefined ||
      replyType !== undefined; // flipping AI/Template mode also rewrites the deferral/hired template steps
    if (triggerSettingsTouched) {
      const platformForTemplates = platform || account.platform;
      try {
        await ensureCustomerReplyPresets(
          this.prisma,
          user.id,
          platformForTemplates,
          savedAccountId,
          activeHoursStart || account.followUpActiveHoursStart || '09:00',
          activeHoursEnd || account.followUpActiveHoursEnd || '21:00',
          timezone || account.followUpTimezone || 'America/New_York',
        );
      } catch (err: any) {
        this.logger.warn(`[saveSettings] ensureCustomerReplyPresets failed: ${err.message}`);
      }

      const parseShortDelay = (d: string): number => {
        const s = String(d || '').toLowerCase().trim();
        const num = parseInt(s) || 0;
        if (s.endsWith('h')) return num * 60;
        if (s.endsWith('d')) return num * 1440;
        if (s.endsWith('w')) return num * 10080;
        return num || 4320; // safety fallback: 3 days
      };

      // When the user picked AI mode for the follow-up plan, the deferral
      // and hired-competitor messages should also be AI-generated. The
      // engine takes the AI path when step.messageTemplate is null/empty,
      // so we clear it on AI mode. The user's edited literal message stays
      // in followUpSettingsJson so flipping back to Template mode restores
      // it without retyping.
      const aiMode = (replyType ?? account.followUpReplyType) === 'ai';

      const propagate = async (
        triggerState: 'customer_deferred' | 'customer_hired_competitor',
        enabled: boolean | undefined,
        delay: string | undefined,
        message: string | undefined,
      ) => {
        const tmpl = await this.prisma.followUpSequenceTemplate.findFirst({
          where: { savedAccountId, platform: platformForTemplates, triggerState },
        });
        if (!tmpl) return;
        const stepsJson = (tmpl.stepsJson as any) || { schemaVersion: 1, steps: [] };
        const nextLiteralMessage = aiMode
          ? null
          : message !== undefined
            ? message
            : (stepsJson.steps?.[0]?.messageTemplate ?? null);
        const updatedSteps = (stepsJson.steps || []).map((s: any, i: number) => {
          if (i !== 0) return s;
          return {
            ...s,
            delayMinutes: delay !== undefined ? parseShortDelay(delay) : s.delayMinutes,
            messageTemplate: nextLiteralMessage,
          };
        });
        await this.prisma.followUpSequenceTemplate.update({
          where: { id: tmpl.id },
          data: {
            stepsJson: { ...stepsJson, steps: updatedSteps },
            generationMode: aiMode ? 'ai' : 'template',
            ...(enabled !== undefined ? { enabled } : {}),
          },
        });
      };

      // Always propagate when triggerSettingsTouched fires — covers the
      // replyType-only flip case where delay/message/toggle are unchanged
      // but the literal message still needs to be cleared (or restored).
      await propagate('customer_deferred', body.aiDeferralCheckIn, body.aiDeferralDelay, body.aiDeferralMessage).catch((err: any) => {
        this.logger.warn(`[saveSettings] customer_deferred template propagation failed: ${err.message}`);
      });
      await propagate('customer_hired_competitor', body.aiHiredCompetitorReengage, body.aiHiredCompetitorDelay, body.aiHiredCompetitorMessage).catch((err: any) => {
        this.logger.warn(`[saveSettings] customer_hired_competitor template propagation failed: ${err.message}`);
      });
    }

    // When the global AI Strategy is saved, fan out to this user's AutomationRules
    // so legacy per-rule overrides don't silently shadow the global setting.
    // Why: strategy-resolution priority chain in automation.service has 3 legacy
    // override fields (replyMode='price', promptTemplateId, aiSystemPrompt) ahead
    // of STRATEGY_PROMPTS[followUpStrategy]. Old rule rows from the pre-unified-UI
    // era (before commit a1510ca) carry stale values that win the priority chain.
    if (body.followUpStrategy !== undefined) {
      const cleared = await this.prisma.automationRule.updateMany({
        where: {
          userId: user.id,
          useAi: true,
          OR: [
            { replyMode: 'price' },
            { promptTemplateId: { not: null } },
            { aiSystemPrompt: { not: null } },
          ],
        },
        data: {
          replyMode: 'auto',
          promptTemplateId: null,
          aiSystemPrompt: null,
        },
      });
      if (cleared.count > 0) {
        this.logger.log(`[strategy-save] cleared legacy overrides on ${cleared.count} rule(s) for user ${user.id} (strategy=${body.followUpStrategy})`);
      }
    }

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
          let skipped = { noThread: 0, active: 0, recentSend: 0, customerTurn: 0, error: 0, terminal: 0 };
          for (const lead of leads) {
            if (!lead.threadId) { skipped.noThread++; continue; }

            // Skip if already has an ACTIVE enrollment
            const existing = await this.prisma.followUpEnrollment.findFirst({
              where: { conversationId: lead.threadId, status: 'active' },
            });
            if (existing) { skipped.active++; continue; }

            // Skip if a follow-up was sent from an ACTIVE enrollment in the last 24h.
            // Stopped/completed enrollment sends don't count — user may be re-enrolling intentionally.
            const recentSend = await this.prisma.followUpStepExecution.findFirst({
              where: {
                enrollment: { conversationId: lead.threadId, status: 'active' },
                status: 'sent',
                executedAt: { gt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
              },
            });
            if (recentSend) { skipped.recentSend++; continue; }

            // Skip terminal lead statuses
            const leadStatus = await this.prisma.lead.findUnique({
              where: { id: lead.id },
              select: { status: true, thumbtackStatus: true },
            });
            if (leadStatus) {
              const s = (leadStatus.status || '').toLowerCase();
              const ts = (leadStatus.thumbtackStatus || '').toLowerCase();
              const terminal = ['done', 'scheduled', 'in_progress', 'in progress', 'booked', 'hired', 'job done', 'job scheduled', 'completed', 'archived', 'lost', 'closed', 'not hired', 'not_hired', 'job complete', 'no response'];
              if (terminal.includes(s) || terminal.includes(ts)) { skipped.terminal++; continue; }
            }

            // Skip if the last message is from the customer — it's the manager's turn to reply.
            // Exception: if AI conversation is enabled, the system handles replies automatically.
            const lastMessage = await this.prisma.message.findFirst({
              where: { conversationId: lead.threadId },
              orderBy: { sentAt: 'desc' },
              select: { sender: true },
            });
            if (lastMessage?.sender === 'customer') {
              // Check if AI conversation is on for this account
              const leadForAi = await this.prisma.lead.findUnique({
                where: { id: lead.id },
                select: { businessId: true, userId: true },
              });
              let aiOn = false;
              if (leadForAi?.businessId) {
                const acct = await this.prisma.savedAccount.findFirst({
                  where: { userId: leadForAi.userId, businessId: leadForAi.businessId },
                  select: { aiConversationEnabled: true },
                });
                aiOn = acct?.aiConversationEnabled ?? false;
              }
              if (!aiOn) { skipped.customerTurn++; continue; }
            }

            try {
              await this.engineService.enrollInSequence(lead.threadId, template.id, lead.platform, lead.id);
              count++;
            } catch (err: any) {
              this.logger.warn(`[FollowUp] Enrollment failed for lead ${lead.id}: ${err.message}`);
              skipped.error++;
            }
          }
          this.logger.log(`[FollowUp] Background enrollment for business ${businessId}: ${leads.length} leads, ${count} enrolled, skipped: ${JSON.stringify(skipped)}`);
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

    // Trial paywall: AI-approval send is automation, not a manual reply.
    const allowed = await this.trialService.canProcessLead(user.id, execution.enrollment.conversationId);
    if (!allowed.allowed) {
      return { success: false, error: 'trial_ended', reason: allowed.reason };
    }

    // Send the message
    const message = execution.generatedMessage || '';
    let messageId: string | null = null;
    try {
      const sent = await this.leadsService.sendMessage(lead.userId, lead.id, message, 'ai');
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

    const sentAt = new Date();
    await this.prisma.followUpStepExecution.update({
      where: { id },
      data: { status: 'sent', executedAt: sentAt, finalMessage: message, messageId },
    });

    // Bump conversation-level cooldown source of truth
    await this.prisma.threadContext.updateMany({
      where: { conversationId: execution.enrollment.conversationId },
      data: { lastFollowUpSentAt: sentAt },
    });

    await this.engineService.advanceAfterSuggestion(execution.enrollmentId);

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

    const sentAt = new Date();
    await this.prisma.followUpStepExecution.update({
      where: { id },
      data: { status: 'approved', executedAt: sentAt, finalMessage: editedMessage, messageId },
    });

    // Bump conversation-level cooldown source of truth
    await this.prisma.threadContext.updateMany({
      where: { conversationId: execution.enrollment.conversationId },
      data: { lastFollowUpSentAt: sentAt },
    });

    await this.engineService.advanceAfterSuggestion(execution.enrollmentId);

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

    await this.engineService.advanceAfterSuggestion(execution.enrollmentId);

    return { success: true };
  }
}
