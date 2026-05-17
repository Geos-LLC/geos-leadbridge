import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onboardingApi } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { notify } from '../../store/notificationStore';
import type { OnboardingProfile, WizardChecklist, WizardStep, WizardStatus } from '../../types';
import { PageSkeleton } from '../../components/PageSkeleton';
import WizardShell from './WizardShell';
import WelcomeStep from './steps/WelcomeStep';
import DoneStep from './steps/DoneStep';
import PlaceholderStep from './steps/PlaceholderStep';
import ConnectStep from './steps/ConnectStep';
import BusinessWebsiteStep from './steps/BusinessWebsiteStep';
import { WIZARD_STEP_META, getStepIndex } from './wizardConfig';

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
  const [currentStep, setCurrentStep] = useState<WizardStep>(
    (profile?.wizardCurrentStep as WizardStep | null) ?? 'welcome',
  );

  // On first mount, fetch the latest profile so we resume at the right
  // step even if authStore was hydrated from a stale persist snapshot.
  useEffect(() => {
    let cancelled = false;
    onboardingApi.getProfile()
      .then(({ profile: fresh }) => {
        if (cancelled) return;
        setProfile(fresh);
        if (fresh?.wizardCurrentStep) {
          setCurrentStep(fresh.wizardCurrentStep);
        }
        // Sync the persisted user object so the Overview progress card
        // reads the same checklist next time it mounts.
        if (user && fresh) {
          const token = localStorage.getItem('token') || '';
          setAuth({ ...user, onboardingProfile: fresh }, token);
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

  const checklist: WizardChecklist = useMemo(
    () => profile?.wizardChecklistStatus ?? {},
    [profile?.wizardChecklistStatus],
  );

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
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const currentIndex = getStepIndex(currentStep);
  const prevStep = currentIndex > 0 ? WIZARD_STEP_META[currentIndex - 1].slug : null;
  const nextStep = currentIndex < WIZARD_STEP_META.length - 1 ? WIZARD_STEP_META[currentIndex + 1].slug : null;
  const isWelcome = currentStep === 'welcome';
  const isDone = currentStep === 'done';

  function handleBack() {
    if (!prevStep) return;
    setCurrentStep(prevStep);
    // Persist the move so a refresh resumes at the right place.
    void onboardingApi.patchWizard({ currentStep: prevStep }).then(({ profile: fresh }) => {
      setProfile(fresh);
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: fresh }, token);
      }
    }).catch(() => { /* non-fatal */ });
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

  if (loading) return <PageSkeleton />;

  // Body selection. Welcome / Done / Business own their own primary
  // CTA so the wizard footer is hidden on those steps. Connect uses the
  // shared footer (Skip / Continue), and the remaining four still
  // render the PR1 placeholder until later PRs land.
  const stepOwnsActions = isWelcome || isDone || currentStep === 'business';

  let body: React.ReactNode;
  if (isWelcome) {
    body = (
      <WelcomeStep
        saving={saving}
        onGetStarted={() => {
          if (!nextStep) return;
          void advance({ finishedStep: 'welcome', status: 'done', nextStep });
        }}
      />
    );
  } else if (isDone) {
    body = <DoneStep checklist={checklist} onFinish={handleFinish} saving={saving} />;
  } else if (currentStep === 'connect') {
    body = <ConnectStep />;
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
      saving={saving}
      hideActions={stepOwnsActions}
    >
      {body}
    </WizardShell>
  );
}
