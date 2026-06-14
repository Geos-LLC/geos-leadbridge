import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { billingApi } from '../services/api';
import { X, AlertCircle, Zap } from 'lucide-react';
import type { SubscriptionDetails } from '../types';

type Trial = SubscriptionDetails['trial'];

export default function TrialBanner() {
  const [trial, setTrial] = useState<Trial | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sub = await billingApi.getSubscription();
        if (cancelled) return;
        const hasPaid = sub.tier && ['ACTIVE', 'PAST_DUE'].includes(sub.status || '');
        if (hasPaid) return;
        setTrial(sub.trial ?? null);
      } catch (err) {
        console.error('[TrialBanner] API error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Auto-hide after 6 seconds (only the active-trial banner; ended trial banner stays)
  useEffect(() => {
    if (trial && trial.isActive && !dismissed) {
      const timer = setTimeout(() => setIsVisible(false), 6000);
      return () => clearTimeout(timer);
    }
  }, [trial, dismissed]);

  if (loading || !trial || dismissed) return null;
  // No trial yet (user hasn't connected a platform) — nothing to show
  if (!trial.type) return null;

  // Active trials moved to the sidebar (<TrialSidebarCard>) per the
  // LeadBridgeDesignUpdated layout. Only the trial-ended hard block
  // still shows here at the top so it can't be missed.
  if (!trial.isEnded) return null;

  // Trial ended — hard block banner
  if (trial.isEnded) {
    const reason =
      trial.type === 'TIME_BASED'
        ? 'Your free trial has ended'
        : trial.type === 'LEAD_BASED'
          ? `All ${trial.leadsLimit} trial leads used`
          : `Trial ended (${trial.leadsHandled}/${trial.leadsLimit} leads used)`;

    return (
      <div className="fixed top-0 left-0 lg:left-72 right-0 z-40 px-6 py-3 bg-red-600 border-b border-red-700 shadow-lg">
        <div className="flex items-center gap-4 max-w-7xl mx-auto">
          <div className="flex items-center justify-center w-8 h-8 bg-white/20 rounded-xl shrink-0">
            <AlertCircle className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white">{reason} — Subscribe to continue</p>
            <p className="text-xs text-red-200 mt-0.5">Upgrade to unlock unlimited leads + premium features</p>
          </div>
          <Link
            to="/pricing"
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-white text-red-600 rounded-xl text-sm font-semibold hover:bg-red-50 transition-all"
          >
            <Zap className="w-4 h-4" />
            View Plans
          </Link>
        </div>
      </div>
    );
  }

  // Active trial — adaptive copy per trial type
  const usageUrgent =
    (trial.type === 'LEAD_BASED' || trial.type === 'HYBRID') && trial.leadsRemaining <= 2;
  const timeUrgent =
    (trial.type === 'TIME_BASED' || trial.type === 'HYBRID') &&
    trial.daysRemaining !== null &&
    trial.daysRemaining <= 2;
  const isUrgent = usageUrgent || timeUrgent;
  const isWarning =
    !isUrgent &&
    (((trial.type === 'LEAD_BASED' || trial.type === 'HYBRID') && trial.leadsRemaining <= 5) ||
      ((trial.type === 'TIME_BASED' || trial.type === 'HYBRID') &&
        trial.daysRemaining !== null &&
        trial.daysRemaining <= 5));

  const bgColor = isUrgent ? 'bg-amber-500' : isWarning ? 'bg-blue-600' : 'bg-slate-800';
  const borderColor = isUrgent ? 'border-amber-600' : isWarning ? 'border-blue-700' : 'border-slate-700';
  const subtextColor = isUrgent ? 'text-amber-100' : isWarning ? 'text-blue-100' : 'text-slate-300';
  const btnBg = isUrgent
    ? 'bg-white text-amber-600 hover:bg-amber-50'
    : isWarning
      ? 'bg-white text-blue-600 hover:bg-blue-50'
      : 'bg-white text-slate-800 hover:bg-slate-50';

  return (
    <div
      className={`fixed top-0 left-0 lg:left-72 right-0 z-40 px-6 py-3 ${bgColor} border-b ${borderColor} shadow-lg transition-all duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div className="flex items-center gap-4 max-w-7xl mx-auto">
        <button
          onClick={() => { setIsVisible(false); setTimeout(() => setDismissed(true), 300); }}
          className="p-1.5 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center justify-center w-9 h-9 bg-white/20 rounded-xl shrink-0">
          {isUrgent ? <AlertCircle className="w-5 h-5 text-white" /> : <Zap className="w-5 h-5 text-white" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white">{trial.label}</p>
          <p className={`text-xs ${subtextColor} mt-0.5`}>
            {trial.progress} • Upgrade to unlock unlimited leads + premium features
          </p>
        </div>
        <Link
          to="/pricing"
          className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 ${btnBg} rounded-xl text-sm font-semibold transition-all`}
        >
          <Zap className="w-4 h-4" />
          Upgrade Now
        </Link>
      </div>
    </div>
  );
}
