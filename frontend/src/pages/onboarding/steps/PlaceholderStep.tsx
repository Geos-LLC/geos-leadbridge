import { Construction } from 'lucide-react';
import type { WizardStep } from '../../../types';
import { getStepMeta } from '../wizardConfig';

interface Props {
  step: WizardStep;
}

// Temporary body for wizard steps whose real implementation lands in a
// later PR (Connect / Business / AI / Pricing / Automation / AI Rules).
// Renders the step's title + description plus a "coming soon" note. The
// Continue / Skip / Back actions live in WizardShell, so this component
// only needs to fill the content area — the user can still walk through
// all 8 steps end-to-end and the progress fields persist correctly.
export default function PlaceholderStep({ step }: Props) {
  const meta = getStepMeta(step);
  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-3">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-8 max-w-xl">
        {meta.description}
      </p>

      <div
        className="rounded-2xl p-6 border border-dashed flex items-start gap-4"
        style={{ borderColor: 'var(--lb-line)', background: 'var(--lb-surface)' }}
      >
        <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-500 inline-flex items-center justify-center shrink-0">
          <Construction className="w-5 h-5" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-slate-900 mb-1">Coming soon</div>
          <p className="text-sm text-slate-500 leading-relaxed">
            This step is being built. For now, use <span className="font-semibold">Skip this step</span> or
            <span className="font-semibold"> Continue</span> to keep moving — your progress saves either way and you can come back from the Dashboard at any time.
          </p>
        </div>
      </div>
    </div>
  );
}
