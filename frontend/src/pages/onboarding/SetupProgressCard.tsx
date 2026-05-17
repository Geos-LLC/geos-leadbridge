import { ArrowRight, CheckCircle2, Circle, Rocket, SkipForward } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import type { WizardChecklist, WizardStep } from '../../types';
import { ACTIONABLE_STEPS, WIZARD_STEP_META } from './wizardConfig';

// Setup-progress card shown on Overview. Only renders when the user
// hasn't yet completed the 8-step wizard. The middle six steps
// (connect / business / ai / pricing / automation / ai_rules) are the
// ones that count toward the "X of N complete" progress bar — welcome
// and done are flow-control, not real setup tasks.
export default function SetupProgressCard() {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const profile = user?.onboardingProfile ?? null;

  const { completedCount, totalCount, percent, items, hasStarted, isComplete, nextStep } = useMemo(() => {
    const checklist: WizardChecklist = profile?.wizardChecklistStatus ?? {};
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
    // actionable step that isn't done/skipped.
    const current = profile?.wizardCurrentStep as WizardStep | undefined;
    const fallbackNext = ACTIONABLE_STEPS.find(s => checklist[s] !== 'done' && checklist[s] !== 'skipped');
    const next = current && current !== 'welcome' && current !== 'done' ? current : (fallbackNext ?? 'welcome');
    return {
      completedCount: completed,
      totalCount: total,
      percent: Math.round((completed / total) * 100),
      items: itemList,
      hasStarted: started,
      isComplete: complete,
      nextStep: next,
    };
  }, [profile]);

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
