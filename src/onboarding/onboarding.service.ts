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

// Guided setup wizard. The wizard writes most of its data to the
// real settings tables (SavedAccount, User, ServiceProfile, etc.); only
// the progress bookkeeping lives on OnboardingProfile so the user can
// resume.
//
// 2026-06-18 — multi-service refactor: `services` + `service_setup` are
// the new step slugs. `welcome` / `ai` / `pricing` / `ai_rules` are
// retained in this enum so existing OnboardingProfile rows that still
// carry those slugs in `wizardCurrentStep` / `wizardChecklistStatus`
// continue to round-trip through patchWizard without 400-ing. The
// frontend wizardConfig no longer renders them.
export const WIZARD_STEPS = [
  'welcome',
  'connect',
  'business',
  'services',
  'service_setup',
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
  // Per-step rollup used by the wizard sidebar + Overview progress card
  // to derive the green tick on each step from actual data, instead of
  // trusting the user clicked Continue inside the wizard.
  //
  // Existing users who configured services / FAQ / pricing / automation
  // via Settings see the wizard tick green automatically; users who
  // deleted that data see the tick disappear. Same principle the
  // existing connect / business derivations follow — data is the source
  // of truth, the stored checklist is just a UX cache.
  //
  // Backward compatibility: the four legacy booleans (faqConfigured /
  // pricingConfigured / automationConfigured / aiRulesConfigured) are
  // kept in the response shape so older frontends keep working. They are
  // still computed off the primary SavedAccount (createdAt asc) to match
  // the legacy AccountFaqForm / PricingSetupStep behaviour. The new
  // multi-service step rollups (`services`, `serviceSetup`) live in the
  // structured fields below.
  async getConfigSummary(userId: string): Promise<OnboardingConfigSummary> {
    const [accounts, profiles, primary] = await Promise.all([
      this.prisma.savedAccount.findMany({
        where: { userId },
        select: {
          id: true,
          serviceProfileAssignmentsJson: true,
        },
      }),
      this.prisma.serviceProfile.findMany({
        where: { userId, status: { in: ['active', 'draft'] } },
        select: {
          id: true,
          name: true,
          status: true,
          pricingJson: true,
          faqJson: true,
          qualificationSchemaJson: true,
        },
        orderBy: [
          // Default profile first, then active before draft, then by name.
          { isDefault: 'desc' },
          { status: 'asc' },
          { name: 'asc' },
        ],
      }),
      this.prisma.savedAccount.findFirst({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        select: {
          faqJson: true,
          servicePricingJson: true,
          followUpSettingsJson: true,
        },
      }),
    ]);

    const totalAccounts = accounts.length;
    const accountsWithAssignments = accounts.filter(
      a => a.serviceProfileAssignmentsJson !== null && a.serviceProfileAssignmentsJson !== '',
    ).length;
    const activeServices = profiles.filter(p => p.status === 'active');
    const activeServiceCount = activeServices.length;

    // Per-service completion rollup. Drafts are reported but do NOT gate
    // serviceSetup.done — they show "AI paused" badges in the UI but the
    // user can still finish the wizard with drafts in flight.
    const services = profiles.map(p => ({
      id: p.id,
      name: p.name,
      status: p.status as 'draft' | 'active' | 'archived',
      pricingConfigured: isServicePricingConfigured(p.pricingJson),
      customerAnswersConfigured: isServiceCustomerAnswersConfigured(p.faqJson),
      serviceOptionsConfigured: isServiceOptionsConfigured(p.qualificationSchemaJson),
    }));

    // Services step: at least one active service exists AND at least one
    // account has assignments configured (non-null `serviceProfileAssignmentsJson`).
    // We accept "at least one" rather than "all" so a tenant with five
    // accounts can finish the wizard after assigning the first one and
    // come back later — the rest fall through to legacy resolution.
    const servicesDone =
      activeServiceCount > 0 &&
      (accountsWithAssignments > 0 || totalAccounts === 0);

    // Service-setup step: every ACTIVE service has pricing (rows OR
    // quoteRequired=true) AND customer answers. Drafts are intentionally
    // ignored — per spec they show as incomplete but don't block Done.
    // Empty active service list short-circuits to not-done.
    const serviceSetupDone =
      activeServiceCount > 0 &&
      services
        .filter(s => s.status === 'active')
        .every(s => s.pricingConfigured && s.customerAnswersConfigured);

    // Automation reads off the primary SavedAccount's followUpSettingsJson
    // as before; the qualify-field picker (per-service required fields)
    // is a deferred follow-up.
    const followUp = primary?.followUpSettingsJson;
    const automationConfigured = isAutomationConfigured(followUp);
    const automationMode = extractAutomationMode(followUp);

    return {
      // Legacy back-compat fields. Same semantics as before — read off
      // the primary SavedAccount so older deriveDisplayChecklist code
      // paths keep working unchanged.
      faqConfigured: primary ? isFaqConfigured(primary.faqJson) : false,
      pricingConfigured: primary ? isPricingConfigured(primary.servicePricingJson) : false,
      automationConfigured,
      aiRulesConfigured: primary ? isAiRulesConfigured(primary.followUpSettingsJson) : false,

      // New multi-service rollup.
      connect: {
        done: totalAccounts > 0,
        accountCount: totalAccounts,
      },
      business: {
        // Business completion is fully driven by User.website on the
        // frontend (the OnboardingProfile doesn't store it); we leave
        // this as a stub so the response shape stays uniform.
        done: false,
        hasWebsite: false,
      },
      services: {
        done: servicesDone,
        activeServiceCount,
        totalAccounts,
        accountsWithAssignments,
      },
      serviceSetup: {
        done: serviceSetupDone,
        services,
      },
      automation: {
        done: automationConfigured,
        mode: automationMode,
      },
    };
  }
}

export interface OnboardingConfigSummaryService {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'archived';
  pricingConfigured: boolean;
  customerAnswersConfigured: boolean;
  serviceOptionsConfigured: boolean;
}

export interface OnboardingConfigSummary {
  // Legacy back-compat (kept so older frontends keep type-checking).
  faqConfigured: boolean;
  pricingConfigured: boolean;
  automationConfigured: boolean;
  aiRulesConfigured: boolean;
  // New per-step rollup. The frontend prefers these when present.
  connect: { done: boolean; accountCount: number };
  business: { done: boolean; hasWebsite: boolean };
  services: {
    done: boolean;
    activeServiceCount: number;
    totalAccounts: number;
    accountsWithAssignments: number;
  };
  serviceSetup: {
    done: boolean;
    services: OnboardingConfigSummaryService[];
  };
  automation: { done: boolean; mode: string | null };
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

// Return the user's chosen automation mode (e.g. 'auto_send' /
// 'suggest' / 'manual') when set, else null. Used by the new
// per-step config summary.
function extractAutomationMode(json: string | null | undefined): string | null {
  const s = safeParse(json);
  if (!s || typeof s !== 'object') return null;
  return typeof s.mode === 'string' && s.mode.length > 0 ? s.mode : null;
}

// ─── ServiceProfile predicates (multi-service refactor) ───────────────
// Each ServiceProfile carries its own pricing/FAQ/qualification JSON.
// These mirror the SavedAccount predicates above but accept the shapes
// produced by the v1 code presets, the v2 admin templates (bridged), and
// the structured forms on Settings → Services.

// Pricing is configured when the table has at least one row OR the
// pricing is explicitly marked as quote-required (in which case the
// AI gathers info and quotes manually instead of using rate cards).
// Bridged v2 shapes from admin templates land here too — they expose
// `items` / `basePrices` / `addOns` arrays alongside the legacy
// `priceTable` shape, so we accept any of them.
function isServicePricingConfigured(json: string | null | undefined): boolean {
  const p = safeParse(json);
  if (!p || typeof p !== 'object') return false;
  if (p.quoteRequired === true) return true;
  if (Array.isArray(p.priceTable) && p.priceTable.length > 0) return true;
  if (Array.isArray(p.items) && p.items.length > 0) return true;
  if (Array.isArray(p.basePrices) && p.basePrices.length > 0) return true;
  if (Array.isArray(p.addOns) && p.addOns.length > 0) return true;
  // Hourly + minimum-charge fallback — used by trade services like
  // handyman / electrical that don't ship per-room tables.
  if (typeof p.laborRate === 'number' && p.laborRate > 0) return true;
  return false;
}

// Customer answers / FAQ. Code-preset and bridged admin-template
// payloads both land as `{ customQA: [{ question, answer }, ...] }`. A
// non-empty entry counts. We also accept the legacy SavedAccount FAQ
// shape (insuredAndBonded.value, paymentMethods, etc.) for tenants
// whose ServiceProfile was hydrated from the old per-account FAQ.
function isServiceCustomerAnswersConfigured(json: string | null | undefined): boolean {
  const f = safeParse(json);
  if (!f || typeof f !== 'object') return false;
  if (Array.isArray(f.customQA) && f.customQA.some((q: any) => (q?.question || q?.answer || '').toString().trim())) {
    return true;
  }
  // v2 admin-template shape post-bridge — sometimes lands as `entries`.
  if (Array.isArray(f.entries) && f.entries.some((q: any) => (q?.question || q?.answer || '').toString().trim())) {
    return true;
  }
  // Legacy SavedAccount-style fields, in case the profile was seeded
  // from the old per-account FAQ JSON.
  const valueKeys = ['insuredAndBonded', 'bringsSupplies', 'petPolicy', 'customerMustBeHome', 'sameCleanerForRecurring'];
  for (const k of valueKeys) {
    const v = f[k]?.value;
    if (typeof v === 'string' && v && v !== 'unset') return true;
  }
  if (Array.isArray(f.paymentMethods) && f.paymentMethods.length > 0) return true;
  return false;
}

// Service options / qualification schema. Optional per spec — wizard
// completion does NOT require this to be configured. We still surface
// the boolean so the UI can show "options configured" / "options
// pending" hints next to each service in the accordion.
function isServiceOptionsConfigured(json: string | null | undefined): boolean {
  const q = safeParse(json);
  if (!q || typeof q !== 'object') return false;
  // v1 shape: { questions: [...] }
  if (Array.isArray(q.questions) && q.questions.length > 0) return true;
  // v2 shape (bridged from admin templates): { groups: [{ options: [...] }, ...] }
  if (Array.isArray(q.groups) && q.groups.some((g: any) => Array.isArray(g?.options) && g.options.length > 0)) {
    return true;
  }
  return false;
}
