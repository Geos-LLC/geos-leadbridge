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

  // --- Wizard ↔ Settings sync ------------------------------------------
  // Lightweight config summary used by the wizard sidebar + Overview
  // progress card to derive the green tick on the four "stored-only"
  // steps (ai / pricing / automation / ai_rules) from actual data
  // instead of trusting the user clicked Continue inside the wizard.
  //
  // Existing users who configured FAQ / pricing / automation via Settings
  // should see the wizard tick green automatically; users who deleted
  // that data should see the tick disappear. Same principle the existing
  // connect / business derivations follow — data is the source of truth.
  //
  // "Configured" is read off the user's first SavedAccount (createdAt asc)
  // to match the wizard step components which all operate on
  // savedAccounts[0]. We deliberately only inspect the primary account
  // because the wizard's "save to all" cascade means once it's set there
  // it's set everywhere, and we want a single, stable signal.
  async getConfigSummary(userId: string): Promise<{
    faqConfigured: boolean;
    pricingConfigured: boolean;
    automationConfigured: boolean;
    aiRulesConfigured: boolean;
  }> {
    const primary = await this.prisma.savedAccount.findFirst({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        faqJson: true,
        servicePricingJson: true,
        followUpSettingsJson: true,
      },
    });

    if (!primary) {
      return {
        faqConfigured: false,
        pricingConfigured: false,
        automationConfigured: false,
        aiRulesConfigured: false,
      };
    }

    return {
      faqConfigured: isFaqConfigured(primary.faqJson),
      pricingConfigured: isPricingConfigured(primary.servicePricingJson),
      automationConfigured: isAutomationConfigured(primary.followUpSettingsJson),
      aiRulesConfigured: isAiRulesConfigured(primary.followUpSettingsJson),
    };
  }
}

// ─── Config "configured?" predicates ──────────────────────────────────
// These mirror the shape each wizard step writes. They MUST stay aligned
// with the step components:
//   ai         → AccountFaqForm  (frontend/src/components/AccountFaqForm.tsx)
//   pricing    → PricingSetupStep / ServicePricingForm
//   automation → AutomationLevelStep → followUpApi.saveWizardSettings
//   ai_rules   → AIRulesStep → followUpApi.saveWizardSettings
//
// Each predicate parses the Text JSON column and returns true when the
// payload looks like a user actually configured something — not just an
// empty `{}` placeholder.

function safeParse(json: string | null | undefined): any {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// FAQ is configured when at least one meaningful field has been set away
// from its default. AccountFaqForm seeds every value field with 'unset'
// so a stored object with everything still 'unset' should NOT count.
function isFaqConfigured(json: string | null | undefined): boolean {
  const f = safeParse(json);
  if (!f || typeof f !== 'object') return false;
  const valueKeys = [
    'insuredAndBonded',
    'bringsSupplies',
    'petPolicy',
    'customerMustBeHome',
    'sameCleanerForRecurring',
  ];
  for (const k of valueKeys) {
    const v = f[k]?.value;
    if (typeof v === 'string' && v && v !== 'unset') return true;
  }
  if (Array.isArray(f.paymentMethods) && f.paymentMethods.length > 0) return true;
  if (typeof f.standardScope === 'string' && f.standardScope.trim()) return true;
  if (typeof f.deepScope === 'string' && f.deepScope.trim()) return true;
  if (Array.isArray(f.customQA) && f.customQA.some((q: any) => (q?.question || q?.answer || '').toString().trim())) return true;
  return false;
}

// Pricing is configured when the table has at least one row. The wizard
// "Use recommended" path drops in a ~20-row default; any non-empty
// priceTable means the user has something usable.
function isPricingConfigured(json: string | null | undefined): boolean {
  const p = safeParse(json);
  if (!p || typeof p !== 'object') return false;
  return Array.isArray(p.priceTable) && p.priceTable.length > 0;
}

// Automation is configured when the follow-up mode is set. Wizard
// bundles (basic / recommended / advanced) all write a `mode` value into
// followUpSettingsJson, so its presence is a reliable "user picked
// something" signal.
function isAutomationConfigured(json: string | null | undefined): boolean {
  const s = safeParse(json);
  if (!s || typeof s !== 'object') return false;
  return typeof s.mode === 'string' && s.mode.length > 0;
}

// AI Rules step writes followUpStrategy (auto / price / qualify / phone)
// into followUpSettingsJson. Presence = user picked a conversation goal.
function isAiRulesConfigured(json: string | null | undefined): boolean {
  const s = safeParse(json);
  if (!s || typeof s !== 'object') return false;
  return typeof s.followUpStrategy === 'string' && s.followUpStrategy.length > 0;
}
