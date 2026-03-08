import { useState, useEffect, useCallback, useRef } from 'react';
import { X, ChevronRight, ChevronLeft, Sparkles } from 'lucide-react';

interface TourStep {
  target: string;          // data-tour attribute value
  title: string;
  description: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const STEPS: TourStep[] = [
  {
    target: 'bot-number',
    title: 'Bot Number',
    description: 'This is the number your customers see when they receive texts or calls from LeadBridge. It\'s automatically assigned to your account.',
    placement: 'bottom',
  },
  {
    target: 'business-phone',
    title: 'Your Business Phone',
    description: 'Enter your personal or business phone number here. This is where you\'ll receive lead alerts and notifications via SMS.',
    placement: 'bottom',
  },
  {
    target: 'test-number',
    title: 'Test Number',
    description: 'Use a separate phone number here to safely test alerts, texts, and calls without affecting real customers or your business phone.',
    placement: 'bottom',
  },
  {
    target: 'test-buttons',
    title: 'Test Your Setup',
    description: 'Use these buttons to send test alerts, test customer texts, and test calls. Make sure your test number is set first!',
    placement: 'top',
  },
  {
    target: 'notifications-card',
    title: 'Lead Notifications',
    description: 'Toggle this on to get SMS alerts every time a new lead comes in. You can also set up auto-replies so leads get an instant response.',
    placement: 'bottom',
  },
  {
    target: 'comms-card',
    title: 'Customer Communications',
    description: 'Toggle this on to automatically text customers when new leads arrive, and enable instant call connect to bridge calls between you and your leads.',
    placement: 'top',
  },
];

const STORAGE_KEY = 'lb_onboarding_complete';

interface OnboardingTourProps {
  active: boolean;
  onComplete: () => void;
}

export default function OnboardingTour({ active, onComplete }: OnboardingTourProps) {
  const [step, setStep] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number } | null>(null);

  const currentStep = STEPS[step];

  const measureTarget = useCallback(() => {
    if (!active || !currentStep) return;
    const el = document.querySelector(`[data-tour="${currentStep.target}"]`) as HTMLElement | null;
    if (!el) { setRect(null); return; }

    // Scroll into view if needed
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Small delay after scroll to get correct rect
    requestAnimationFrame(() => {
      const r = el.getBoundingClientRect();
      setRect(r);
    });
  }, [active, currentStep]);

  useEffect(() => {
    measureTarget();
    window.addEventListener('resize', measureTarget);
    window.addEventListener('scroll', measureTarget, true);
    return () => {
      window.removeEventListener('resize', measureTarget);
      window.removeEventListener('scroll', measureTarget, true);
    };
  }, [measureTarget]);

  // Position tooltip after rect updates
  useEffect(() => {
    if (!rect || !tooltipRef.current) { setTooltipPos(null); return; }
    const tt = tooltipRef.current.getBoundingClientRect();
    const placement = currentStep?.placement || 'bottom';
    const pad = 16;
    let top = 0;
    let left = 0;

    if (placement === 'bottom') {
      top = rect.bottom + pad;
      left = rect.left + rect.width / 2 - tt.width / 2;
    } else if (placement === 'top') {
      top = rect.top - tt.height - pad;
      left = rect.left + rect.width / 2 - tt.width / 2;
    } else if (placement === 'right') {
      top = rect.top + rect.height / 2 - tt.height / 2;
      left = rect.right + pad;
    } else {
      top = rect.top + rect.height / 2 - tt.height / 2;
      left = rect.left - tt.width - pad;
    }

    // Clamp to viewport
    left = Math.max(12, Math.min(left, window.innerWidth - tt.width - 12));
    top = Math.max(12, Math.min(top, window.innerHeight - tt.height - 12));

    setTooltipPos({ top, left });
  }, [rect, step]);

  const finish = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, 'true');
    setStep(0);
    setRect(null);
    setTooltipPos(null);
    onComplete();
  }, [onComplete]);

  const next = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else finish();
  };

  const prev = () => {
    if (step > 0) setStep(step - 1);
  };

  // Keyboard nav
  useEffect(() => {
    if (!active) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft') prev();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [active, step]);

  if (!active) return null;

  const pad = 8; // padding around highlighted element

  return (
    <div className="fixed inset-0 z-[9999]" style={{ pointerEvents: 'auto' }}>
      {/* Dark overlay with hole cut out for target */}
      <svg className="absolute inset-0 w-full h-full" style={{ pointerEvents: 'none' }}>
        <defs>
          <mask id="tour-mask">
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {rect && (
              <rect
                x={rect.left - pad}
                y={rect.top - pad}
                width={rect.width + pad * 2}
                height={rect.height + pad * 2}
                rx="16"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.5)"
          mask="url(#tour-mask)"
          style={{ pointerEvents: 'auto', cursor: 'default' }}
          onClick={finish}
        />
      </svg>

      {/* Highlight ring around target */}
      {rect && (
        <div
          className="absolute border-2 border-blue-400 rounded-2xl shadow-[0_0_0_4px_rgba(59,130,246,0.15)] transition-all duration-300 pointer-events-none"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
          }}
        />
      )}

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="absolute bg-white rounded-2xl shadow-2xl border border-slate-100 p-5 max-w-sm w-[340px] transition-all duration-300"
        style={{
          top: tooltipPos?.top ?? -9999,
          left: tooltipPos?.left ?? -9999,
          opacity: tooltipPos ? 1 : 0,
          pointerEvents: 'auto',
        }}
      >
        {/* Step indicator */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-500" />
            <span className="text-[11px] font-bold text-blue-500 uppercase tracking-widest">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>
          <button
            onClick={finish}
            className="p-1 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <h3 className="text-base font-bold text-slate-900 mb-1.5">{currentStep?.title}</h3>
        <p className="text-sm text-slate-500 leading-relaxed mb-4">{currentStep?.description}</p>

        {/* Progress dots */}
        <div className="flex items-center justify-between">
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <div
                key={i}
                className={`w-2 h-2 rounded-full transition-colors ${
                  i === step ? 'bg-blue-500' : i < step ? 'bg-blue-200' : 'bg-slate-200'
                }`}
              />
            ))}
          </div>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={prev}
                className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-slate-500 hover:text-slate-700 rounded-lg hover:bg-slate-100 transition-colors"
              >
                <ChevronLeft className="w-4 h-4" />
                Back
              </button>
            )}
            <button
              onClick={next}
              className="flex items-center gap-1 px-4 py-1.5 text-sm font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors"
            >
              {step === STEPS.length - 1 ? 'Done' : 'Next'}
              {step < STEPS.length - 1 && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export { STORAGE_KEY as ONBOARDING_STORAGE_KEY };
