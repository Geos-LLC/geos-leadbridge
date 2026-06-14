import { ArrowLeft, ArrowRight, Check, Loader2, SkipForward, X } from 'lucide-react';
import { createContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WizardChecklist, WizardStep } from '../../types';
import { WIZARD_STEP_META, getStepIndex } from './wizardConfig';

// Portal target for step-rendered action buttons. WizardStepActions reads
// this and portals its children into the shell header so the buttons sit
// next to Back / Exit instead of as a sticky shelf in the step body.
export const WizardHeaderSlotContext = createContext<HTMLDivElement | null>(null);

interface WizardShellProps {
  currentStep: WizardStep;
  checklist: WizardChecklist;
  children: React.ReactNode;
  // Action bar — now rendered in the sticky top header (no bottom
  // footer). Steps that need custom action buttons (e.g. "I don't
  // have a website", "Use default pricing") pass them via
  // `headerActions` instead of relying on onSkip/onContinue.
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  saving?: boolean;
  // Hide the default Skip/Continue in the header. Steps that own
  // their own actions either pass `headerActions` (rendered next to
  // Back + Exit) or render their CTA inside the step body.
  hideActions?: boolean;
  // Step-specific action buttons rendered in the sticky top header,
  // between Back and Exit. Use this to surface a step's Save & Continue
  // (and any siblings like Skip manual / I don't have a website) at the
  // top of the screen, where the rest of the wizard navigation lives.
  headerActions?: React.ReactNode;
  // Sidebar jump. Optional — when provided, the left-rail step rows
  // become clickable buttons that jump to the chosen step. The
  // container is responsible for the actual PATCH + state update.
  onStepClick?: (step: WizardStep) => void;
  // Restart-from-scratch handler. When provided, the sidebar shows a
  // "Restart setup" link under the "Skip for later" link so users
  // can wipe their wizard progress without finding it in Settings.
  onRestart?: () => void;
  // Override the default Exit / Skip-for-later behavior. By default
  // both call navigate('/overview') — when mounted inside the in-app
  // Setup modal (Layout.tsx), the parent supplies onExit so the modal
  // can close in place instead of routing away.
  onExit?: () => void;
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
  headerActions,
  onStepClick,
  onRestart,
  onExit,
}: WizardShellProps) {
  const navigate = useNavigate();
  const handleExit = onExit ?? (() => navigate('/overview'));
  // Portal target for step-rendered action buttons (Save & Continue,
  // "I don't have a website", etc). Captured by ref-callback so the
  // first paint already has the DOM node and step children can portal
  // into it without a render delay.
  const [headerSlot, setHeaderSlot] = useState<HTMLDivElement | null>(null);
  const currentIndex = getStepIndex(currentStep);
  const totalSteps = WIZARD_STEP_META.length;
  // % shown in the header — counts welcome + done so the bar moves on the
  // first and last clicks too. The Overview card uses a separate metric
  // (actionable steps only) for "X of 6 complete".
  const progressPct = Math.round(((currentIndex + 1) / totalSteps) * 100);

  return (
    <div
      className="flex overflow-hidden h-full w-full"
      style={{ background: 'var(--lb-bg)' }}
    >
      {/* Left rail — step list. Stays put while only the main content
          scrolls, because the root is locked to viewport height and the
          aside is a flex column with its own internal scroll on .nav. */}
      <aside
        className="hidden md:flex md:flex-col shrink-0 border-r h-full"
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
        <div className="m-3 space-y-1">
          <button
            onClick={handleExit}
            className="block w-full px-3 py-2 text-xs font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors text-left"
          >
            ← Skip for later — go to Dashboard
          </button>
          {onRestart && (
            <button
              onClick={onRestart}
              className="block w-full px-3 py-2 text-xs font-semibold text-slate-400 hover:text-rose-700 hover:bg-rose-50 rounded-lg transition-colors text-left"
              title="Wipe wizard progress and start over"
            >
              ↻ Restart setup
            </button>
          )}
        </div>
      </aside>

      {/* Right pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Sticky top header — two rows: progress bar on top, then the
            action row (Back + step-specific actions + Skip/Continue +
            Exit). Bottom footer is intentionally gone so users never
            have to scroll to find Save & Continue. */}
        <header
          className="sticky top-0 z-10 px-6 md:px-10 pt-4 pb-3 border-b"
          style={{ background: 'var(--lb-surface)', borderColor: 'var(--lb-line)' }}
        >
          {/* Row 1: progress bar — full width above the buttons. */}
          <div className="mb-3">
            <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400">
              Step {currentIndex + 1} of {totalSteps}
            </div>
            <div className="mt-1.5 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-600 transition-all duration-300"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>

          {/* Row 2: action row. Back left, step / continue buttons
              center, Exit right. */}
          <div className="flex items-center gap-3">
            {/* Back — shown whenever a previous step exists, regardless
                of whether the step owns its own actions. */}
            {onBack && (
              <button
                onClick={onBack}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg hover:bg-slate-100 transition-colors"
                aria-label="Previous step"
              >
                <ArrowLeft className="w-4 h-4" />
                <span className="hidden sm:inline">Back</span>
              </button>
            )}

            {/* Step-owned action slot. Steps wrap their buttons in
                <WizardStepActions> which portals them into the
                headerSlot ref below. The headerActions prop is the
                legacy/static fallback when a step doesn't use the
                portal. The default Skip/Continue is suppressed whenever
                either a portal child or static headerActions exists. */}
            <div ref={setHeaderSlot} className="flex items-center gap-2 flex-1 min-w-0" />
            {headerActions ? (
              <div className="flex items-center gap-2 flex-1 min-w-0">{headerActions}</div>
            ) : !hideActions ? (
              <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
                {onSkip && (
                  <button
                    onClick={onSkip}
                    disabled={saving}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg hover:bg-slate-100 transition-colors"
                  >
                    <SkipForward className="w-4 h-4" />
                    <span className="hidden sm:inline">Skip this step</span>
                  </button>
                )}
                {onContinue && (
                  <button
                    onClick={onContinue}
                    disabled={continueDisabled || saving}
                    className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
                  >
                    {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                    {saving ? 'Saving…' : continueLabel}
                    {!saving && <ArrowRight className="w-4 h-4" />}
                  </button>
                )}
              </div>
            ) : null}

            <button
              onClick={handleExit}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors flex-shrink-0"
              aria-label="Exit setup"
              title="Skip for later — your progress is saved"
            >
              <X className="w-4 h-4" />
              <span className="hidden sm:inline">Exit</span>
            </button>
          </div>
        </header>

        {/* Step body */}
        <main className="flex-1 px-6 md:px-10 py-8 md:py-12 overflow-y-auto">
          <div className="max-w-2xl mx-auto">
            <WizardHeaderSlotContext.Provider value={headerSlot}>
              {children}
            </WizardHeaderSlotContext.Provider>
          </div>
        </main>
      </div>
    </div>
  );
}
