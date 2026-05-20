import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/utils/prisma.service';

export interface Step1Input {
  primaryLeadSource: string;
  secondaryLeadSources?: string[];
  weeklyLeadVolume: string;
  serviceType: string;
  serviceTypeOther?: string;
}

export interface Step2Input {
  responseSpeed?: string;
  missedLeadOutcome?: string;
  avgJobValue?: string;
  userGoal?: string;
}

// 8-step guided setup wizard. The wizard writes most of its data to the
// real settings tables (SavedAccount, User, etc.); only the progress
// bookkeeping lives on OnboardingProfile so the user can resume.
export const WIZARD_STEPS = [
  'welcome',
  'connect',
  'business',
  'ai',
  'pricing',
  'automation',
  'ai_rules',
  'done',
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
export type WizardStatus = 'done' | 'skipped';

export interface WizardPatchInput {
  currentStep?: WizardStep;
  // Caller passes the slug + status for the step they just finished. The
  // service merges into the existing checklist map; it does not require
  // the caller to send the full map.
  markStep?: { step: WizardStep; status: WizardStatus };
  completed?: boolean;
  // Wipes ALL wizard progress (currentStep / checklist / skipped /
  // startedAt / completedAt). Used by the "Restart setup" affordance
  // so the user can re-walk the whole flow from step 1 without
  // touching the data they configured (savedAccounts, faqJson,
  // servicePricingJson, etc. all stay).
  reset?: boolean;
}

@Injectable()
export class OnboardingService {
  private readonly logger = new Logger(OnboardingService.name);

  constructor(private prisma: PrismaService) {}

  async getProfile(userId: string) {
    const profile = await this.prisma.onboardingProfile.findUnique({
      where: { userId },
    });
    return profile;
  }

  async saveStep1(userId: string, input: Step1Input) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: {
        userId,
        primaryLeadSource: input.primaryLeadSource,
        secondaryLeadSources: input.secondaryLeadSources ?? [],
        weeklyLeadVolume: input.weeklyLeadVolume,
        serviceType: input.serviceType,
        serviceTypeOther: input.serviceTypeOther ?? null,
        step1CompletedAt: now,
      },
      update: {
        primaryLeadSource: input.primaryLeadSource,
        secondaryLeadSources: input.secondaryLeadSources ?? [],
        weeklyLeadVolume: input.weeklyLeadVolume,
        serviceType: input.serviceType,
        serviceTypeOther: input.serviceTypeOther ?? null,
        step1CompletedAt: now,
      },
    });
    this.logger.log(`[Onboarding] Step 1 saved for user ${userId} — source=${input.primaryLeadSource}, volume=${input.weeklyLeadVolume}`);
    return profile;
  }

  async saveStep2(userId: string, input: Step2Input) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: {
        userId,
        ...input,
        step2CompletedAt: now,
      },
      update: {
        ...input,
        step2CompletedAt: now,
        step2SkippedAt: null,
      },
    });
    this.logger.log(`[Onboarding] Step 2 saved for user ${userId}`);
    return profile;
  }

  async skipStep2(userId: string) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: { userId, step2SkippedAt: now },
      update: { step2SkippedAt: now },
    });
    this.logger.log(`[Onboarding] Step 2 skipped for user ${userId}`);
    return profile;
  }

  async skipStep1(userId: string) {
    const now = new Date();
    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: { userId, step1SkippedAt: now },
      update: { step1SkippedAt: now },
    });
    this.logger.log(`[Onboarding] Step 1 skipped for user ${userId}`);
    return profile;
  }

  // --- 8-step guided setup wizard ----------------------------------------

  async patchWizard(userId: string, input: WizardPatchInput) {
    const now = new Date();

    // Reset takes precedence over everything else — wipes wizard
    // progress entirely while leaving the user's actual configured
    // data (accounts, faq, pricing, etc.) alone.
    if (input.reset) {
      const profile = await this.prisma.onboardingProfile.upsert({
        where: { userId },
        create: {
          userId,
          wizardStartedAt: null,
          wizardCompletedAt: null,
          wizardCurrentStep: null,
          wizardChecklistStatus: {},
          wizardSkippedSteps: [],
        },
        update: {
          wizardStartedAt: null,
          wizardCompletedAt: null,
          wizardCurrentStep: null,
          wizardChecklistStatus: {},
          wizardSkippedSteps: [],
        },
      });
      this.logger.log(`[Wizard] user=${userId} reset wizard progress`);
      return profile;
    }

    // Read existing checklist so we can merge a single step update without
    // requiring the caller to send the whole map.
    const existing = await this.prisma.onboardingProfile.findUnique({
      where: { userId },
      select: {
        wizardStartedAt: true,
        wizardChecklistStatus: true,
        wizardSkippedSteps: true,
      },
    });

    const mergedChecklist: Record<string, WizardStatus> = {
      ...((existing?.wizardChecklistStatus as Record<string, WizardStatus> | null) ?? {}),
    };
    const skippedSet = new Set<string>(existing?.wizardSkippedSteps ?? []);

    if (input.markStep) {
      if (!WIZARD_STEPS.includes(input.markStep.step)) {
        throw new Error(`Invalid wizard step: ${input.markStep.step}`);
      }
      mergedChecklist[input.markStep.step] = input.markStep.status;
      if (input.markStep.status === 'skipped') {
        skippedSet.add(input.markStep.step);
      } else {
        skippedSet.delete(input.markStep.step);
      }
    }
    if (input.currentStep && !WIZARD_STEPS.includes(input.currentStep)) {
      throw new Error(`Invalid wizard step: ${input.currentStep}`);
    }

    const setStarted = !existing?.wizardStartedAt;
    const setCompleted = input.completed === true;

    const profile = await this.prisma.onboardingProfile.upsert({
      where: { userId },
      create: {
        userId,
        wizardStartedAt: now,
        wizardCurrentStep: input.currentStep ?? 'welcome',
        wizardChecklistStatus: mergedChecklist,
        wizardSkippedSteps: Array.from(skippedSet),
        wizardCompletedAt: setCompleted ? now : null,
      },
      update: {
        ...(setStarted ? { wizardStartedAt: now } : {}),
        ...(input.currentStep ? { wizardCurrentStep: input.currentStep } : {}),
        wizardChecklistStatus: mergedChecklist,
        wizardSkippedSteps: Array.from(skippedSet),
        ...(setCompleted ? { wizardCompletedAt: now } : {}),
      },
    });

    if (input.markStep) {
      this.logger.log(`[Wizard] user=${userId} marked ${input.markStep.step}=${input.markStep.status}`);
    }
    if (setCompleted) {
      this.logger.log(`[Wizard] user=${userId} completed setup`);
    }
    return profile;
  }
}
