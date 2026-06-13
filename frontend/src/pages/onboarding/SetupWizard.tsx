import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, onboardingApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/notificationStore';
import type { OnboardingConfigSummary, OnboardingProfile, WizardChecklist, WizardStep, WizardStatus } from '../../types';
import { PageSkeleton } from '../../components/PageSkeleton';
import { deriveDisplayChecklist } from './SetupProgressCard';
import WizardShell from './WizardShell';
import DoneStep from './steps/DoneStep';
import PlaceholderStep from './steps/PlaceholderStep';
import ConnectStep from './steps/ConnectStep';
import BusinessWebsiteStep from './steps/BusinessWebsiteStep';
import AIKnowledgeStep from './steps/AIKnowledgeStep';
import PricingSetupStep from './steps/PricingSetupStep';
import AutomationLevelStep from './steps/AutomationLevelStep';
import AIRulesStep from './steps/AIRulesStep';
import { FIRST_ACTIONABLE_STEP, WIZARD_STEP_META, getStepIndex } from './wizardConfig';

// The 8-step guided setup wizard. The container owns the current step,
// the checklist, and the calls to the backend wizard endpoint; each
// individual step component is a presentational body that asks the
// container to advance via the action bar in WizardShell.
//
// Step content for connect / business / ai / pricing / automation /
// ai_rules is intentionally a placeholder in PR 1 — the wizard is
// navigable end-to-end so we can validate the shell + the resume
// behavior before the real step bodies land.
export default function SetupWizard() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);

  const [profile, setProfile] = useState<OnboardingProfile | null>(user?.onboardingProfile ?? null);
  const [loading, setLoading] = useState(!profile);
  const [saving, setSaving] = useState(false);
  // Backend rollup for the four stored-only steps. Refreshed alongside
  // the profile + after every advance so the sidebar tick reflects
  // whatever the user just saved (e.g. AI Knowledge step saves FAQ via
  // AccountFaqForm — the next paint should show the green tick).
  const [configSummary, setConfigSummary] = useState<OnboardingConfigSummary | null>(null);

  // Pick the right starting step: prefer the user's last-known
  // currentStep, but skip legacy 'welcome' (it's no longer in the
  // wizard) and never land on 'done' on initial mount.
  function resolveInitialStep(p: OnboardingProfile | null): WizardStep {
    const stored = p?.wizardCurrentStep as WizardStep | null | undefined;
    if (stored && stored !== 'welcome' && stored !== 'done') return stored;
    return FIRST_ACTIONABLE_STEP;
  }
  const [currentStep, setCurrentStep] = useState<WizardStep>(resolveInitialStep(profile));

  // On first mount, fetch the latest profile AND the latest auth user
  // so we resume at the right step and any step that reads from
  // user.* (website, businessPhone, etc.) sees live data instead of a
  // stale authStore snapshot. The first time a user logs in after a
  // schema change, the persisted authStore lacks the new fields — a
  // refresh here is the cheapest way to backfill them.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      onboardingApi.getProfile(),
      authApi.getProfile().catch(() => null),
      onboardingApi.getConfigSummary().catch(() => null),
    ])
      .then(([profileRes, freshUser, summaryRes]) => {
        if (cancelled) return;
        if (profileRes?.profile) {
          setProfile(profileRes.profile);
          setCurrentStep(resolveInitialStep(profileRes.profile));
        }
        if (summaryRes?.summary) setConfigSummary(summaryRes.summary);
        // Sync the persisted user object so subsequent steps + the
        // Overview progress card both read the same fresh state.
        if (user) {
          const token = localStorage.getItem('token') || '';
          setAuth(
            {
              ...user,
              ...(profileRes?.profile ? { onboardingProfile: profileRes.profile } : {}),
              ...(freshUser ? {
                website: freshUser.website ?? null,
                websiteMetadataJson: freshUser.websiteMetadataJson ?? null,
                businessPhone: freshUser.businessPhone ?? user.businessPhone ?? null,
              } : {}),
            },
            token,
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
    // We only want this once on mount; deliberately not re-running on
    // user/setAuth identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive checklist for display: data wins over the stored stamp.
  // When the data behind a step is gone (no accounts → AI / Pricing /
  // Automation / AI Rules, no website → Business, no FAQ → AI, etc.)
  // we drop the stored `done` so the sidebar tick + Overview card
  // both reflect live state instead of a stamp from earlier. Inverse
  // is also true — configuring something from Settings flips the tick
  // green without the user having to re-walk the wizard.
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const hasWebsite = !!(user?.website && user.website.trim().length > 0);
  const checklist: WizardChecklist = useMemo(
    () => deriveDisplayChecklist(profile?.wizardChecklistStatus ?? {}, {
      accountCount: savedAccounts.length,
      hasWebsite,
      configSummary,
    }),
    [profile?.wizardChecklistStatus, savedAccounts.length, hasWebsite, configSummary],
  );

  // Pull a fresh config summary. Used after every advance so the
  // sidebar tick updates as the user saves through each step (e.g.
  // AI Knowledge writes faqJson via AccountFaqForm and we want that
  // green tick to land before the user even reaches Pricing).
  async function refreshConfigSummary() {
    try {
      const res = await onboardingApi.getConfigSummary();
      if (res?.summary) setConfigSummary(res.summary);
    } catch {
      /* non-fatal — sidebar will catch up on the next navigation. */
    }
  }

  // Advance helper — sends a patch with the step we just finished + the
  // next currentStep, then updates local state from the response.
  async function advance(opts: {
    finishedStep: WizardStep;
    status: WizardStatus;
    nextStep: WizardStep | null;
    complete?: boolean;
  }) {
    setSaving(true);
    try {
      const { profile: fresh } = await onboardingApi.patchWizard({
        currentStep: opts.nextStep ?? undefined,
        markStep: { step: opts.finishedStep, status: opts.status },
        completed: opts.complete,
      });
      setProfile(fresh);
      if (opts.nextStep) setCurrentStep(opts.nextStep);
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: fresh }, token);
      }
      // Each step writes user-visible data (faq / pricing / follow-up
      // settings). Re-pull the rollup so the sidebar tick reflects what
      // just landed — without this, a user who saves the Pricing step
      // wouldn't see Pricing turn green until the next page mount.
      void refreshConfigSummary();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const currentIndex = getStepIndex(currentStep);
  const prevStep = currentIndex > 0 ? WIZARD_STEP_META[currentIndex - 1].slug : null;
  const nextStep = currentIndex < WIZARD_STEP_META.length - 1 ? WIZARD_STEP_META[currentIndex + 1].slug : null;
  const isDone = currentStep === 'done';

  // Direct navigation to any step in the rail. Used by both the
  // footer Back button and the now-clickable sidebar — same persistence
  // semantics in both cases. Don't change checklist status here: the
  // user is just moving around, not declaring a step done/skipped.
  function goToStep(target: WizardStep) {
    if (target === currentStep) return;
    setCurrentStep(target);
    void onboardingApi.patchWizard({ currentStep: target }).then(({ profile: fresh }) => {
      setProfile(fresh);
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: fresh }, token);
      }
    }).catch(() => { /* non-fatal — local state already updated */ });
  }

  function handleBack() {
    if (!prevStep) return;
    goToStep(prevStep);
  }

  function handleSkip() {
    if (!nextStep) return;
    void advance({ finishedStep: currentStep, status: 'skipped', nextStep });
  }

  function handleContinue() {
    if (!nextStep) return;
    void advance({ finishedStep: currentStep, status: 'done', nextStep });
  }

  function handleFinish() {
    void advance({ finishedStep: 'done', status: 'done', nextStep: null, complete: true })
      .then(() => navigate('/overview'));
  }

  // Wipe wizard progress and snap back to the first actionable step.
  // The user's actual data (SavedAccounts, website, faq, pricing, etc.)
  // is intentionally untouched — only the bookkeeping resets so they
  // can re-walk the flow if they want to retest or reconfigure.
  function handleRestart() {
    if (!window.confirm('Restart setup from the first step? Your connected accounts and saved settings stay; only the wizard progress is cleared.')) return;
    setSaving(true);
    onboardingApi.patchWizard({ reset: true })
      .then(({ profile: fresh }) => {
        setProfile(fresh);
        setCurrentStep(FIRST_ACTIONABLE_STEP);
        if (user) {
          const token = localStorage.getItem('token') || '';
          setAuth({ ...user, onboardingProfile: fresh }, token);
        }
      })
      .catch((err: any) => notify.error('Could not restart setup', err.response?.data?.message || 'Please try again.'))
      .finally(() => setSaving(false));
  }

  if (loading) return <PageSkeleton />;

  // Body selection. Steps that own their own primary CTA hide the
  // wizard footer (the wizard's shared Continue/Skip would just be
  // redundant). Connect uses the shared footer; the remaining steps
  // each manage their own save+advance.
  const stepOwnsActions =
    isDone ||
    currentStep === 'business' ||
    currentStep === 'ai' ||
    currentStep === 'pricing' ||
    currentStep === 'automation' ||
    currentStep === 'ai_rules';

  let body: React.ReactNode;
  if (isDone) {
    body = <DoneStep checklist={checklist} onFinish={handleFinish} saving={saving} />;
  } else if (currentStep === 'connect') {
    body = (
      <ConnectStep
        alreadyDone={checklist.connect === 'done'}
        // Marks connect=done in the checklist WITHOUT advancing
        // currentStep. The user still has to click Continue in the
        // wizard footer to move on — auto-marking just turns the
        // sidebar tick green when an account is already connected.
        onMarkDone={async () => {
          await advance({ finishedStep: 'connect', status: 'done', nextStep: null });
        }}
      />
    );
  } else if (currentStep === 'business') {
    body = (
      <BusinessWebsiteStep
        saving={saving}
        setSaving={setSaving}
        // BusinessWebsiteStep already persisted the website value; the
        // wizard just records "done" / "skipped" + advances. nextStep
        // is guaranteed non-null here because Business is never last.
        onSaveContinue={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'business', status: 'done', nextStep });
        }}
        onNoWebsite={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'business', status: 'skipped', nextStep });
        }}
      />
    );
  } else if (currentStep === 'ai') {
    body = (
      <AIKnowledgeStep
        saving={saving}
        setSaving={setSaving}
        onSaveContinue={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'ai', status: 'done', nextStep });
        }}
      />
    );
  } else if (currentStep === 'pricing') {
    body = (
      <PricingSetupStep
        saving={saving}
        setSaving={setSaving}
        onSaveContinue={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'pricing', status: 'done', nextStep });
        }}
        onSkipManual={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'pricing', status: 'skipped', nextStep });
        }}
      />
    );
  } else if (currentStep === 'automation') {
    body = (
      <AutomationLevelStep
        saving={saving}
        setSaving={setSaving}
        onSaveContinue={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'automation', status: 'done', nextStep });
        }}
      />
    );
  } else if (currentStep === 'ai_rules') {
    body = (
      <AIRulesStep
        saving={saving}
        setSaving={setSaving}
        onSaveContinue={async () => {
          if (!nextStep) return;
          await advance({ finishedStep: 'ai_rules', status: 'done', nextStep });
        }}
      />
    );
  } else {
    body = <PlaceholderStep step={currentStep} />;
  }

  return (
    <WizardShell
      currentStep={currentStep}
      checklist={checklist}
      onBack={prevStep ? handleBack : undefined}
      onSkip={stepOwnsActions ? undefined : handleSkip}
      onContinue={stepOwnsActions ? undefined : handleContinue}
      onStepClick={goToStep}
      onRestart={handleRestart}
      saving={saving}
      hideActions={stepOwnsActions}
    >
      {body}
    </WizardShell>
  );
}
