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

export const WIZARD_STEP_META: WizardStepMeta[] = [
  {
    slug: 'welcome',
    label: 'Welcome',
    title: 'Welcome to LeadBridge',
    description: "Reply instantly and never miss a lead. We'll help set up your business in about 2 minutes.",
    countsTowardChecklist: false,
  },
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
    slug: 'ai',
    label: 'AI',
    title: 'Teach AI about your business',
    description: 'A few facts AI uses when replying to leads.',
    countsTowardChecklist: true,
  },
  {
    slug: 'pricing',
    label: 'Pricing',
    title: 'Set your pricing',
    description: 'Start from a recommended template or build it yourself later.',
    countsTowardChecklist: true,
  },
  {
    slug: 'automation',
    label: 'Automation',
    title: 'Choose your automation level',
    description: 'Pick how much LeadBridge handles automatically. You can change this anytime.',
    countsTowardChecklist: true,
  },
  {
    slug: 'ai_rules',
    label: 'AI Rules',
    title: 'AI stop & handoff rules',
    description: 'When AI should stop replying and when to alert your team.',
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
