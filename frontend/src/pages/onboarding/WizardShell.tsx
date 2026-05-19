import { ArrowLeft, ArrowRight, Check, Loader2, SkipForward, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { WizardChecklist, WizardStep } from '../../types';
import { WIZARD_STEP_META, getStepIndex } from './wizardConfig';

interface WizardShellProps {
  currentStep: WizardStep;
  checklist: WizardChecklist;
  children: React.ReactNode;
  // Action bar
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  saving?: boolean;
  // Hide the entire action bar (used by Welcome / Done which roll their
  // own primary CTA).
  hideActions?: boolean;
  // Sidebar jump. Optional — when provided, the left-rail step rows
  // become clickable buttons that jump to the chosen step. The
  // container is responsible for the actual PATCH + state update.
  onStepClick?: (step: WizardStep) => void;
}

// Shared chrome for the 8-step setup wizard. Renders the left rail with
// step list + progress, a top bar with "Skip for later → exit", and the
// bottom action bar (Back / Skip this step / Continue). Step bodies
// render into `children`.
export default function WizardShell({
  currentStep,
  checklist,
  children,
  onBack,
  onSkip,
  onContinue,
  continueLabel = 'Continue',
  continueDisabled,
  saving,
  hideActions,
  onStepClick,
}: WizardShellProps) {
  const navigate = useNavigate();
  const currentIndex = getStepIndex(currentStep);
  const totalSteps = WIZARD_STEP_META.length;
  // % shown in the header — counts welcome + done so the bar moves on the
  // first and last clicks too. The Overview card uses a separate metric
  // (actionable steps only) for "X of 6 complete".
  const progressPct = Math.round(((currentIndex + 1) / totalSteps) * 100);

  return (
    <div className="min-h-screen flex" style={{ background: 'var(--lb-bg)' }}>
      {/* Left rail — step list */}
      <aside
        className="hidden md:flex md:flex-col shrink-0 border-r"
        style={{
          width: 260,
          background: 'var(--lb-surface)',
          borderColor: 'var(--lb-line)',
        }}
      >
        <div className="px-5 py-5 border-b" style={{ borderColor: 'var(--lb-line-soft)' }}>
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-1">Setup</div>
          <div className="text-base font-extrabold text-slate-900 tracking-tight">LeadBridge</div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 py-4">
          {WIZARD_STEP_META.map((meta, i) => {
            const status = checklist[meta.slug];
            const isCurrent = meta.slug === currentStep;
            const isPast = i < currentIndex;
            const isDone = status === 'done';
            const isSkipped = status === 'skipped';
            // Sidebar row is clickable when the wizard owner provides a
            // jump callback and the click would actually change the
            // current step. Saving is gated so a click can't race a
            // pending PATCH.
            const clickable = !!onStepClick && !isCurrent && !saving;
            const rowClasses = `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors w-full text-left ${
              isCurrent
                ? 'bg-blue-50 text-blue-900'
                : isPast || isDone || isSkipped
                  ? 'text-slate-500'
                  : 'text-slate-400'
            } ${clickable ? 'cursor-pointer hover:bg-slate-100' : 'cursor-default'}`;

            const inner = (
              <>
                <span
                  className={`w-6 h-6 rounded-full inline-flex items-center justify-center text-[11px] font-bold ${
                    isCurrent
                      ? 'bg-blue-600 text-white'
                      : isDone
                        ? 'bg-emerald-100 text-emerald-700'
                        : isSkipped
                          ? 'bg-slate-100 text-slate-400'
                          : 'bg-slate-100 text-slate-500'
                  }`}
                  aria-label={
                    isDone ? 'done' : isSkipped ? 'skipped' : isCurrent ? 'current' : 'pending'
                  }
                >
                  {isDone ? <Check className="w-3.5 h-3.5" /> : i + 1}
                </span>
                <span className="flex-1 truncate">{meta.label}</span>
                {isSkipped && (
                  <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                    skipped
                  </span>
                )}
              </>
            );

            if (clickable) {
              return (
                <button
                  key={meta.slug}
                  type="button"
                  onClick={() => onStepClick!(meta.slug)}
                  className={rowClasses}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={meta.slug} className={rowClasses} aria-current={isCurrent ? 'step' : undefined}>
                {inner}
              </div>
            );
          })}
        </nav>
        <button
          onClick={() => navigate('/overview')}
          className="m-3 px-3 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors text-left"
        >
          ← Skip for later — go to Dashboard
        </button>
      </aside>

      {/* Right pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar with progress + close */}
        <header
          className="sticky top-0 z-10 px-6 md:px-10 py-4 border-b flex items-center gap-4"
          style={{ background: 'var(--lb-surface)', borderColor: 'var(--lb-line)' }}
        >
          <div className="flex-1 min-w-0">
            <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
              Step {currentIndex + 1} of {totalSteps}
            </div>
            <div className="mt-1.5 h-1.5 w-full max-w-xs bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <button
            onClick={() => navigate('/overview')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
            aria-label="Exit setup"
            title="Skip for later — your progress is saved"
          >
            <X className="w-4 h-4" />
            <span className="hidden sm:inline">Exit</span>
          </button>
        </header>

        {/* Step body */}
        <main className="flex-1 px-6 md:px-10 py-8 md:py-12 overflow-y-auto">
          <div className="max-w-2xl mx-auto">{children}</div>
        </main>

        {/* Action bar */}
        {!hideActions && (
          <footer
            className="px-6 md:px-10 py-4 border-t flex items-center gap-3"
            style={{ background: 'var(--lb-surface)', borderColor: 'var(--lb-line)' }}
          >
            <button
              onClick={onBack}
              disabled={!onBack || saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg hover:bg-slate-100 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back
            </button>
            <div className="flex-1" />
            {onSkip && (
              <button
                onClick={onSkip}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg hover:bg-slate-100 transition-colors"
              >
                <SkipForward className="w-4 h-4" />
                Skip this step
              </button>
            )}
            {onContinue && (
              <button
                onClick={onContinue}
                disabled={continueDisabled || saving}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-lg shadow-blue-200 transition-all"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {saving ? 'Saving…' : continueLabel}
                {!saving && <ArrowRight className="w-4 h-4" />}
              </button>
            )}
          </footer>
        )}
      </div>
    </div>
  );
}
