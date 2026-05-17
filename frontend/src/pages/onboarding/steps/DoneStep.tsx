import { ArrowRight, Check, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { WizardChecklist, WizardStep } from '../../../types';
import { WIZARD_STEP_META } from '../wizardConfig';

interface Props {
  checklist: WizardChecklist;
  onFinish: () => void;
  saving?: boolean;
}

// Display labels for the completion checklist. These map onto the
// actionable middle-six wizard steps (welcome + done are excluded).
const COMPLETION_ITEMS: { step: WizardStep; label: string }[] = [
  { step: 'connect', label: 'Accounts connected' },
  { step: 'business', label: 'Business website' },
  { step: 'ai', label: 'AI trained' },
  { step: 'pricing', label: 'Pricing added' },
  { step: 'automation', label: 'Automation enabled' },
  { step: 'ai_rules', label: 'AI rules configured' },
];

export default function DoneStep({ checklist, onFinish, saving }: Props) {
  const navigate = useNavigate();

  // Pull the human title from the shared config to avoid drift.
  const meta = WIZARD_STEP_META.find(m => m.slug === 'done')!;

  return (
    <div className="text-center pt-6">
      <div className="w-16 h-16 mx-auto mb-6 rounded-2xl inline-flex items-center justify-center bg-emerald-100 text-emerald-600 shadow-sm">
        <Check className="w-9 h-9" />
      </div>
      <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight mb-3">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed max-w-md mx-auto">
        {meta.description}
      </p>

      <ul className="mt-10 mx-auto max-w-sm text-left space-y-2">
        {COMPLETION_ITEMS.map(({ step, label }) => {
          const status = checklist[step];
          const done = status === 'done';
          const skipped = status === 'skipped';
          return (
            <li
              key={step}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border"
              style={{
                background: done ? 'rgba(16,185,129,0.06)' : 'var(--lb-surface)',
                borderColor: done ? 'rgba(16,185,129,0.2)' : 'var(--lb-line-soft)',
              }}
            >
              <span
                className={`w-6 h-6 rounded-full inline-flex items-center justify-center ${
                  done
                    ? 'bg-emerald-500 text-white'
                    : skipped
                      ? 'bg-slate-200 text-slate-500'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
              </span>
              <span className={`flex-1 text-sm font-semibold ${done ? 'text-slate-900' : 'text-slate-500'}`}>
                {label}
              </span>
              {skipped && (
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  skipped
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-10 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onFinish}
          disabled={saving}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-blue-600 text-white text-base font-bold rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          {saving ? 'Finishing…' : 'Go to Dashboard'}
          {!saving && <ArrowRight className="w-5 h-5" />}
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="inline-flex items-center gap-1.5 text-sm font-semibold text-slate-500 hover:text-slate-700 transition-colors"
        >
          <SettingsIcon className="w-4 h-4" />
          Explore settings
        </button>
      </div>
    </div>
  );
}
