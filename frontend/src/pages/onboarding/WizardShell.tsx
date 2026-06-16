import { ArrowRight, Check, Loader2, Sparkles, X } from 'lucide-react';
import { createContext, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { WizardChecklist, WizardStep } from '../../types';
import { WIZARD_STEP_META, getStepIndex } from './wizardConfig';

// Portal target for step-rendered action buttons. WizardStepActions
// reads this and portals its children into the shell footer so the
// Save & Continue button + siblings sit on the same row as Back, per
// the LeadBridgeDesignUpdated design. Name kept ("Header") for
// historical reasons — semantically it's "the wizard's action slot."
export const WizardHeaderSlotContext = createContext<HTMLDivElement | null>(null);

interface WizardShellProps {
  currentStep: WizardStep;
  checklist: WizardChecklist;
  children: React.ReactNode;
  onBack?: () => void;
  onSkip?: () => void;
  onContinue?: () => void;
  continueLabel?: string;
  continueDisabled?: boolean;
  saving?: boolean;
  /** Hide the default Skip/Continue in the footer. Steps that own
      their own actions use WizardStepActions to portal them into the
      same footer slot. */
  hideActions?: boolean;
  /** Legacy static slot — kept for callers that don't use the portal. */
  headerActions?: React.ReactNode;
  /** Sidebar jump. Optional — when provided, the left-rail step rows
      become clickable buttons that jump to the chosen step. */
  onStepClick?: (step: WizardStep) => void;
  /** Restart-from-scratch handler. When provided, the rail shows a
      tiny "Restart setup" link under the bottom info line. */
  onRestart?: () => void;
  /** Override the default Exit / close behavior. By default the X
      navigates to /overview — when mounted inside the in-app Setup
      modal (Layout.tsx), the parent supplies onExit so the modal
      can close in place instead of routing away. */
  onExit?: () => void;
}

/**
 * Wizard shell — matches the LeadBridgeDesignUpdated layout:
 *  - Left rail (248px) on a navy gradient with sparkles + "Setup
 *    wizard" + step counter on top, a numbered step list in the
 *    middle, and a "You can reopen this wizard…" footer line at
 *    the bottom.
 *  - Right content pane: title + description + X close in the top
 *    header, a thin 3px progress bar below it, the step body
 *    scrolling inside an `--lb-bg`-tinted region, and a bottom
 *    footer with Back (left) and Continue/Finish (right). Step
 *    bodies that need their own action buttons portal them into
 *    the same footer slot via WizardStepActions.
 *
 * The shell fills its parent (h-full + w-full). The route mount
 * wraps it in a 100dvh container; the in-app modal in Layout.tsx
 * wraps it in a 940x640 rounded dialog. Both layouts work without
 * touching the shell.
 */
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
  // "I don't have a website", "Preview default pricing", "Go to
  // Dashboard"). Lives in the bottom footer right-side; captured via
  // useState so the DOM node is available when steps mount.
  const [footerSlot, setFooterSlot] = useState<HTMLDivElement | null>(null);

  const currentIndex = getStepIndex(currentStep);
  const totalSteps = WIZARD_STEP_META.length;
  const currentMeta = WIZARD_STEP_META[currentIndex];
  // Progress bar % — counts welcome + done so the bar moves on the first
  // and last clicks too.
  const progressPct = Math.round(((currentIndex + 1) / totalSteps) * 100);

  return (
    <div className="flex overflow-hidden h-full w-full" style={{ background: 'var(--lb-surface)' }}>
      {/* ─── Left rail — navy gradient ─────────────────────────────── */}
      <aside
        className="hidden md:flex md:flex-col shrink-0 h-full"
        style={{
          width: 248,
          background: 'linear-gradient(180deg, #0a1530 0%, #1b2a52 100%)',
          padding: '22px 18px',
        }}
      >
        {/* Rail header — sparkles tile + title + step counter */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 22 }}>
          <span
            style={{
              width: 30, height: 30, borderRadius: 8,
              background: 'var(--lb-accent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <Sparkles size={16} color="#fff" />
          </span>
          <div style={{ lineHeight: 1.1 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#fff' }}>Setup wizard</div>
            <div style={{
              fontSize: 10, fontFamily: 'var(--lb-font-mono)', color: '#aeb9d6',
              textTransform: 'uppercase', letterSpacing: '0.1em', marginTop: 2,
            }}>
              Step {currentIndex + 1} of {totalSteps}
            </div>
          </div>
        </div>

        {/* Step list */}
        <nav style={{ display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
          {WIZARD_STEP_META.map((meta, i) => {
            const status = checklist[meta.slug];
            const isCurrent = meta.slug === currentStep;
            // PR-F — trust the derived checklist exclusively. Pre-PR-F this
            // also marked every step earlier than currentStep as done
            // (`i < currentIndex`), which painted the rail green even
            // when the backend's config summary said a step wasn't actually
            // configured (e.g. automation step "clicked through" without
            // saving any AutomationRules). That contradicted the center
            // summary on Done, which uses the same data-derived checklist.
            // Now the rail and the center always agree.
            const isDone = status === 'done';
            const clickable = !!onStepClick && !isCurrent && !saving;

            const rowStyle: React.CSSProperties = {
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 10px', borderRadius: 9,
              cursor: clickable ? 'pointer' : 'default',
              background: isCurrent ? 'rgba(255,255,255,0.12)' : 'transparent',
              border: 0,
              width: '100%',
              textAlign: 'left',
              fontFamily: 'inherit',
            };
            const dotStyle: React.CSSProperties = {
              width: 24, height: 24, borderRadius: 999,
              flexShrink: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 11, fontWeight: 700, fontFamily: 'var(--lb-font-mono)',
              background: isDone ? '#34d399' : isCurrent ? '#fff' : 'rgba(255,255,255,0.14)',
              color: isDone ? '#05291c' : isCurrent ? 'var(--lb-ink-1)' : '#aeb9d6',
            };
            const labelStyle: React.CSSProperties = {
              fontSize: 13,
              fontWeight: isCurrent ? 700 : 500,
              color: isCurrent || isDone ? '#fff' : '#aeb9d6',
            };

            const inner = (
              <>
                <span style={dotStyle}>
                  {isDone ? <Check size={12} strokeWidth={3} /> : i + 1}
                </span>
                <span style={labelStyle}>{meta.label}</span>
              </>
            );

            if (clickable) {
              return (
                <button
                  key={meta.slug}
                  type="button"
                  onClick={() => onStepClick!(meta.slug)}
                  style={rowStyle}
                  aria-current={isCurrent ? 'step' : undefined}
                >
                  {inner}
                </button>
              );
            }
            return (
              <div key={meta.slug} style={rowStyle} aria-current={isCurrent ? 'step' : undefined}>
                {inner}
              </div>
            );
          })}
        </nav>

        {/* Rail footer — informational text + optional restart link */}
        <div style={{ flex: 1 }} />
        <div style={{ fontSize: 11, color: '#8b94ab', lineHeight: 1.5 }}>
          You can reopen this wizard any time from the{' '}
          <strong style={{ color: '#cdd6ea' }}>Setup</strong> button in the top bar.
        </div>
        {onRestart && (
          <button
            onClick={onRestart}
            style={{
              marginTop: 10,
              background: 'transparent', border: 0, padding: 0,
              fontFamily: 'inherit', fontSize: 11, fontWeight: 600,
              color: '#aeb9d6',
              cursor: 'pointer',
              textAlign: 'left',
            }}
            title="Wipe wizard progress and start over"
          >
            ↻ Restart setup
          </button>
        )}
      </aside>

      {/* ─── Right content pane ─────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-w-0" style={{ background: 'var(--lb-surface)' }}>
        {/* Header: title + description + close button */}
        <div
          style={{
            padding: '22px 28px 16px',
            borderBottom: '1px solid var(--lb-line-soft)',
            display: 'flex', alignItems: 'flex-start', gap: 16,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <h2 style={{
              margin: 0,
              fontSize: 21, fontWeight: 700, color: 'var(--lb-ink-1)',
              letterSpacing: '-0.02em',
            }}>
              {currentMeta.title}
            </h2>
            <p style={{
              margin: '5px 0 0',
              fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.5,
            }}>
              {currentMeta.description}
            </p>
          </div>
          <button
            type="button"
            onClick={handleExit}
            title="Close"
            aria-label="Close setup"
            style={{
              width: 34, height: 34, borderRadius: 9,
              border: '1px solid var(--lb-line)',
              background: 'var(--lb-surface)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer',
              color: 'var(--lb-ink-4)',
              flexShrink: 0,
              fontFamily: 'inherit',
            }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Thin progress bar */}
        <div style={{ height: 3, background: 'var(--lb-ink-10)', flexShrink: 0 }}>
          <div
            style={{
              height: '100%',
              width: `${progressPct}%`,
              background: 'var(--lb-accent)',
              borderRadius: 99,
              transition: 'width 200ms ease',
            }}
          />
        </div>

        {/* Step body */}
        <main
          className="flex-1 overflow-y-auto"
          style={{
            minHeight: 0,
            padding: '24px 28px',
            background: 'var(--lb-bg)',
          }}
        >
          <div style={{ maxWidth: 640, margin: '0 auto' }}>
            <WizardHeaderSlotContext.Provider value={footerSlot}>
              {children}
            </WizardHeaderSlotContext.Provider>
          </div>
        </main>

        {/* Footer: Back (left) — spacer — step buttons / Skip / Continue / Finish (right) */}
        <div
          style={{
            padding: '14px 28px',
            borderTop: '1px solid var(--lb-line-soft)',
            display: 'flex', alignItems: 'center', gap: 10,
            flexShrink: 0,
            background: 'var(--lb-surface)',
          }}
        >
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              disabled={saving}
              style={{
                padding: '10px 16px',
                borderRadius: 10,
                border: '1px solid var(--lb-line)',
                background: 'var(--lb-surface)',
                color: 'var(--lb-ink-3)',
                fontSize: 13, fontWeight: 600,
                cursor: saving ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
                opacity: saving ? 0.5 : 1,
              }}
            >
              Back
            </button>
          )}
          <div style={{ flex: 1 }} />
          {/* Portal target — Save & Continue + siblings land here. When
              a step provides portal children, the shell's default
              Skip/Continue is suppressed via hideActions. */}
          <div ref={setFooterSlot} style={{ display: 'flex', alignItems: 'center', gap: 10 }} />
          {/* Legacy static headerActions (kept name for back-compat). */}
          {headerActions && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{headerActions}</div>
          )}
          {/* Default Skip + Continue when the step doesn't own actions. */}
          {!hideActions && !headerActions && (
            <>
              {onSkip && (
                <button
                  type="button"
                  onClick={onSkip}
                  disabled={saving}
                  style={{
                    padding: '10px 14px',
                    borderRadius: 10,
                    border: 0,
                    background: 'transparent',
                    color: 'var(--lb-ink-5)',
                    fontSize: 13, fontWeight: 600,
                    cursor: saving ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: saving ? 0.5 : 1,
                  }}
                >
                  Skip this step
                </button>
              )}
              {onContinue && (
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={continueDisabled || saving}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    padding: '10px 22px',
                    borderRadius: 10,
                    border: 0,
                    background: 'var(--lb-accent)',
                    color: 'var(--lb-accent-fg)',
                    fontSize: 13, fontWeight: 700,
                    cursor: (continueDisabled || saving) ? 'not-allowed' : 'pointer',
                    fontFamily: 'inherit',
                    opacity: (continueDisabled || saving) ? 0.5 : 1,
                  }}
                >
                  {saving ? <Loader2 size={14} className="animate-spin" /> : null}
                  {saving ? 'Saving…' : continueLabel}
                  {!saving && <ArrowRight size={14} />}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
