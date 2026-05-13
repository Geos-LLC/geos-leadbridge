import { Lock } from 'lucide-react';
import { Link } from 'react-router-dom';

export function TierBadge({ tier }: { tier: 'respond' | 'engage' | 'convert' }) {
  const config = {
    respond: { label: 'Respond', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
    engage:  { label: 'Engage',  cls: 'bg-blue-50 text-blue-700 border-blue-200' },
    convert: { label: 'Convert', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  } as const;
  const c = config[tier];
  return (
    <span className={`inline-flex items-center text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-full border ${c.cls}`}>
      {c.label}
    </span>
  );
}

export function LockedFeatureOverlay({ ctaLabel }: { ctaLabel: string }) {
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/55 backdrop-blur-[1px] rounded-2xl">
      <Link
        to="/pricing"
        className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-semibold text-blue-600 shadow-sm hover:bg-blue-50 hover:border-blue-200 transition-colors"
      >
        <Lock className="w-3 h-3" />
        {ctaLabel}
      </Link>
    </div>
  );
}
