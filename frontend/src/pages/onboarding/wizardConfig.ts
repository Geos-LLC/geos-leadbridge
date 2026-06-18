import type { WizardStep } from '../../types';

// Display metadata for every wizard step. Order in the array IS the
// navigation order — keep it in sync with the backend WIZARD_STEPS enum
// (src/onboarding/onboarding.service.ts) and the frontend types
// re-export. Welcome and Done bookend the flow; the middle six are the
// real setup steps that the Overview progress card counts toward
// completion %.
export interface WizardStepMeta {
  slug: WizardStep;
  label: string;       // Short label for the sidebar / progress bar
  title: string;       // Page title shown in the step content
  description: string; // One-line subtitle under the title
  // Whether this step contributes to the Overview "X of N complete"
  // counter. Welcome + Done are flow-control, not setup tasks.
  countsTowardChecklist: boolean;
}

// Welcome is intentionally absent from this list — the Overview's
// "Start setup" card is the welcome moment, no need for a separate
// in-wizard splash. The backend keeps 'welcome' (and the legacy `ai`,
// `pricing`, `ai_rules`, `service_setup` slugs from earlier wizard
// shapes) as valid WizardStep values so historical
// wizardChecklistStatus rows continue to round-trip; the frontend just
// never navigates to them.
//
// 2026-06-18 — consolidation: account ↔ service assignment is no
// longer a wizard concern (runtime resolver handles category →
// ServiceProfile → tenant default fallback). One combined `services`
// step covers create-from-template + create-custom + per-service
// pricing/FAQ/rules editing.
//
// Step list:  connect → business → services → automation → done
export const WIZARD_STEP_META: WizardStepMeta[] = [
  {
    slug: 'connect',
    label: 'Connect',
    title: 'Connect your lead sources',
    description: 'Hook up Thumbtack, Yelp, and other places where your customers reach out.',
    countsTowardChecklist: true,
  },
  {
    slug: 'business',
    label: 'Business',
    title: 'Your business website',
    description: "We'll use this to help AI understand your business.",
    countsTowardChecklist: true,
  },
  {
    slug: 'services',
    label: 'Services',
    title: 'Set up the services you offer',
    description: 'Add services from a template or create your own. For each one set pricing, customer answers, and any service rules.',
    countsTowardChecklist: true,
  },
  {
    slug: 'automation',
    label: 'Automation',
    title: 'Fine-tune your automation',
    description: 'Your trial has the full LeadBridge experience turned on. Adjust the defaults below if you want — everything stays editable later.',
    countsTowardChecklist: true,
  },
  {
    slug: 'done',
    label: 'Done',
    title: "You're all set!",
    description: 'LeadBridge is configured and ready to handle your leads.',
    countsTowardChecklist: false,
  },
];

// Legacy step slugs no longer rendered in the active rail. Existing
// OnboardingProfile rows may still carry these in `wizardCurrentStep`
// / `wizardChecklistStatus`; we filter them out at render time so a
// returning user lands on the new flow gracefully.
//
// `service_setup` joined this list 2026-06-18 when the two-step
// services flow was consolidated back into one `services` step.
export const RETIRED_WIZARD_STEPS = new Set<WizardStep>([
  'welcome',
  'ai',
  'pricing',
  'ai_rules',
  'service_setup',
]);

// Welcome was the first step in the original 8-step flow. Removed
// because the Overview "Start setup" card is the welcome moment.
// Kept here as a no-op so any older SetupProgressCard fallback that
// references it still type-checks.
export const FIRST_ACTIONABLE_STEP = WIZARD_STEP_META[0].slug;

export const ACTIONABLE_STEPS: WizardStep[] = WIZARD_STEP_META.filter(
  m => m.countsTowardChecklist,
).map(m => m.slug);

export function getStepIndex(slug: WizardStep): number {
  return WIZARD_STEP_META.findIndex(m => m.slug === slug);
}

export function getStepMeta(slug: WizardStep): WizardStepMeta {
  const meta = WIZARD_STEP_META.find(m => m.slug === slug);
  if (!meta) throw new Error(`Unknown wizard step: ${slug}`);
  return meta;
}
