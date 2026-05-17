import { ArrowRight, Loader2, Zap } from 'lucide-react';

interface Props {
  onGetStarted: () => void;
  onImportExisting?: () => void;
  saving?: boolean;
}

export default function WelcomeStep({ onGetStarted, onImportExisting, saving }: Props) {
  return (
    <div className="text-center pt-6">
      <div
        className="w-16 h-16 mx-auto mb-6 rounded-2xl inline-flex items-center justify-center text-white shadow-lg shadow-blue-200"
        style={{ background: 'var(--lb-accent)' }}
      >
        <Zap className="w-9 h-9" />
      </div>
      <h1 className="text-3xl md:text-4xl font-extrabold text-slate-900 tracking-tight mb-3">
        Welcome to LeadBridge
      </h1>
      <p className="text-lg text-slate-500 leading-relaxed max-w-md mx-auto">
        Reply instantly and never miss a lead. We'll help set up your business in about 2 minutes.
      </p>

      <div className="mt-10 flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={onGetStarted}
          disabled={saving}
          className="inline-flex items-center gap-2 px-7 py-3.5 bg-blue-600 text-white text-base font-bold rounded-2xl shadow-lg shadow-blue-200 hover:bg-blue-700 disabled:opacity-60 disabled:cursor-not-allowed transition-all"
        >
          {saving ? <Loader2 className="w-5 h-5 animate-spin" /> : null}
          {saving ? 'Starting…' : 'Get Started'}
          {!saving && <ArrowRight className="w-5 h-5" />}
        </button>
        {onImportExisting && (
          <button
            type="button"
            onClick={onImportExisting}
            disabled={saving}
            className="text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 transition-colors"
          >
            Import existing settings
          </button>
        )}
      </div>
    </div>
  );
}
