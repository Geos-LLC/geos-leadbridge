import { ArrowRight, CheckCircle2, Circle, Rocket, SkipForward } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { onboardingApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import type { OnboardingProfile, WizardChecklist, WizardStep } from '../../types';
import { ACTIONABLE_STEPS, FIRST_ACTIONABLE_STEP, WIZARD_STEP_META } from './wizardConfig';

// Derive the displayed checklist from the persisted wizard state +
// live SavedAccount state. The `connect` step's stored status can go
// stale when the user disconnects accounts: the DB still says 'done'
// because the user clicked Continue earlier, but the source of truth
// (savedAccounts.length) now contradicts it. We display 'done' only
// when there's at least one account; otherwise we drop the stored
// 'done' so the card prompts the user to reconnect. We leave
// 'skipped' alone — that was an explicit user choice and disconnects
// shouldn't silently un-skip the step.
export function deriveDisplayChecklist(
  stored: WizardChecklist,
  accountCount: number,
): WizardChecklist {
  if (accountCount > 0) return stored;
  if (stored.connect === 'done') {
    const { connect: _ignore, ...rest } = stored;
    return rest;
  }
  return stored;
}

// Setup-progress card shown on Overview. Only renders when the user
// hasn't yet completed the 8-step wizard. The middle six steps
// (connect / business / ai / pricing / automation / ai_rules) are the
// ones that count toward the "X of N complete" progress bar — welcome
// and done are flow-control, not real setup tasks.
export default function SetupProgressCard() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  // Fetch a fresh profile on mount so the card reflects whatever the
  // user did during the wizard, even when the persisted authStore
  // snapshot is stale (e.g. after a soft refresh). We seed from the
  // store so the card renders immediately and the fetch just patches
  // any drift.
  const [profile, setProfile] = useState<OnboardingProfile | null>(user?.onboardingProfile ?? null);
  useEffect(() => {
    let cancelled = false;
    onboardingApi.getProfile()
      .then(({ profile: fresh }) => {
        if (cancelled) return;
        setProfile(fresh);
        // Sync persisted auth user so other listeners (TrialBanner,
        // PR1's getProfile path, etc.) see the same checklist state.
        if (user && fresh) {
          const token = localStorage.getItem('token') || '';
          setAuth({ ...user, onboardingProfile: fresh }, token);
        }
      })
      .catch(() => { /* non-fatal — use the seeded value */ });
    return () => { cancelled = true; };
    // Intentionally not depending on user/setAuth — we only want this
    // to fire on Dashboard mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const savedAccounts = useAppStore(s => s.savedAccounts);

  const { completedCount, totalCount, percent, items, hasStarted, isComplete, nextStep } = useMemo(() => {
    const stored: WizardChecklist = profile?.wizardChecklistStatus ?? {};
    const checklist = deriveDisplayChecklist(stored, savedAccounts.length);
    const total = ACTIONABLE_STEPS.length;
    const completed = ACTIONABLE_STEPS.filter(s => checklist[s] === 'done').length;
    const itemList = WIZARD_STEP_META.filter(m => m.countsTowardChecklist).map(m => ({
      step: m.slug,
      label: m.label,
      status: checklist[m.slug],
    }));
    const started = !!profile?.wizardStartedAt;
    const complete = !!profile?.wizardCompletedAt;
    // Best step to resume at: the user's last-known current step if it
    // still maps onto something actionable; otherwise the first
    // actionable step that isn't done/skipped. 'welcome' is legacy and
    // no longer a real step — treat it as "not started yet".
    const current = profile?.wizardCurrentStep as WizardStep | undefined;
    const fallbackNext = ACTIONABLE_STEPS.find(s => checklist[s] !== 'done' && checklist[s] !== 'skipped');
    const next = current && current !== 'welcome' && current !== 'done' ? current : (fallbackNext ?? FIRST_ACTIONABLE_STEP);
    return {
      completedCount: completed,
      totalCount: total,
      percent: Math.round((completed / total) * 100),
      items: itemList,
      hasStarted: started,
      isComplete: complete,
      nextStep: next,
    };
  }, [profile, savedAccounts.length]);

  // Don't render once setup is fully complete — the card is meant as a
  // prompt to finish, not a permanent fixture.
  if (isComplete) return null;

  return (
    <div
      className="rounded-2xl border p-5 md:p-6 flex flex-col md:flex-row items-start md:items-center gap-5"
      style={{
        background: 'linear-gradient(135deg, rgba(37,99,235,0.06), rgba(37,99,235,0.02))',
        borderColor: 'rgba(37,99,235,0.18)',
      }}
    >
      <div
        className="w-12 h-12 shrink-0 rounded-2xl inline-flex items-center justify-center text-white"
        style={{ background: 'var(--lb-accent)' }}
      >
        <Rocket className="w-6 h-6" />
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-base font-extrabold text-slate-900 tracking-tight">
            {hasStarted ? 'Finish setting up LeadBridge' : 'Complete your LeadBridge setup'}
          </h3>
          <span className="text-xs font-bold text-blue-700">
            {completedCount} of {totalCount} done · {percent}%
          </span>
        </div>
        <div className="mt-2 h-1.5 w-full bg-blue-100 rounded-full overflow-hidden">
          <div className="h-full bg-blue-600 transition-all duration-300" style={{ width: `${percent}%` }} />
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          {items.map(({ step, label, status }) => {
            const done = status === 'done';
            const skipped = status === 'skipped';
            return (
              <li
                key={step}
                className={`inline-flex items-center gap-1.5 text-xs font-semibold ${
                  done ? 'text-emerald-700' : skipped ? 'text-slate-400' : 'text-slate-500'
                }`}
              >
                {done ? (
                  <CheckCircle2 className="w-3.5 h-3.5" />
                ) : skipped ? (
                  <SkipForward className="w-3.5 h-3.5" />
                ) : (
                  <Circle className="w-3.5 h-3.5" />
                )}
                {label}
              </li>
            );
          })}
        </ul>
      </div>

      <button
        onClick={() => navigate('/onboarding/setup')}
        className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl shadow-md shadow-blue-200 transition-all shrink-0"
        title={hasStarted ? `Resume at ${nextStep}` : 'Start setup'}
      >
        {hasStarted ? 'Continue setup' : 'Start setup'}
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}
