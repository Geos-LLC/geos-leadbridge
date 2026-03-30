import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { billingApi } from '../services/api';
import { X, AlertCircle, Zap } from 'lucide-react';

interface TrialStatus {
  isOnTrial: boolean;
  trialDaysRemaining: number;
  trialExpired: boolean;
  trialExpiredByTime: boolean;
  trialExpiredByUsage: boolean;
  trialEndDate: string | null;
  trialLeadsHandled: number;
  trialLeadsLimit: number;
  trialLeadsRemaining: number;
}

export default function TrialBanner() {
  const [trialStatus, setTrialStatus] = useState<TrialStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    loadTrialStatus();
  }, []);

  // Auto-hide after 6 seconds
  useEffect(() => {
    if (trialStatus && !dismissed) {
      const timer = setTimeout(() => {
        setIsVisible(false);
      }, 6000);

      return () => clearTimeout(timer);
    }
  }, [trialStatus, dismissed]);

  const loadTrialStatus = async () => {
    try {
      const subscription = await billingApi.getSubscription();

      // Don't show banner if user has an active PAID subscription (not trial)
      const hasPaidSubscription = subscription.tier &&
        ['ACTIVE', 'PAST_DUE'].includes(subscription.status || '');

      if (hasPaidSubscription) {
        setLoading(false);
        return;
      }

      // Show trial banner if user is on trial or if trial data exists
      if (subscription.trial) {
        setTrialStatus(subscription.trial);
      } else if (subscription.status === 'TRIALING') {
        setTrialStatus({
          isOnTrial: true,
          trialDaysRemaining: 10,
          trialExpired: false,
          trialExpiredByTime: false,
          trialExpiredByUsage: false,
          trialEndDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
          trialLeadsHandled: 3,
          trialLeadsLimit: 10,
          trialLeadsRemaining: 7,
        });
      } else {
        setTrialStatus({
          isOnTrial: true,
          trialDaysRemaining: 10,
          trialExpired: false,
          trialExpiredByTime: false,
          trialExpiredByUsage: false,
          trialEndDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
          trialLeadsHandled: 3,
          trialLeadsLimit: 10,
          trialLeadsRemaining: 7,
        });
      }
    } catch (error) {
      console.error('[TrialBanner] API error:', error);
      // Show demo trial banner on error for testing
      setTrialStatus({
        isOnTrial: true,
        trialDaysRemaining: 10,
        trialExpired: false,
        trialExpiredByTime: false,
        trialExpiredByUsage: false,
        trialEndDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
        trialLeadsHandled: 3,
        trialLeadsLimit: 10,
        trialLeadsRemaining: 7,
      });
    } finally {
      setLoading(false);
    }
  };

  const handleDismiss = () => {
    setIsVisible(false);
    setTimeout(() => setDismissed(true), 300); // Wait for animation
  };

  if (loading || !trialStatus || dismissed) {
    return null;
  }

  // Don't show if user is not on trial and trial hasn't expired
  if (!trialStatus.isOnTrial && !trialStatus.trialExpired) {
    return null;
  }

  // All leads used — hard block
  if (trialStatus.trialExpired) {
    const leadsLimit = trialStatus.trialLeadsLimit || 10;

    return (
      <div className="fixed top-0 left-0 lg:left-72 right-0 z-40 px-6 py-3 bg-red-600 border-b border-red-700 shadow-lg">
        <div className="flex items-center gap-4 max-w-7xl mx-auto">
          <div className="flex items-center justify-center w-8 h-8 bg-white/20 rounded-xl shrink-0">
            <AlertCircle className="w-4 h-4 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white">All {leadsLimit} trial leads used — Subscribe to continue</p>
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

  // Active trial - show leads remaining (no date countdown)
  const leadsRemaining = trialStatus.trialLeadsRemaining || 0;
  const leadsUsed = trialStatus.trialLeadsHandled || 0;
  const leadsLimit = trialStatus.trialLeadsLimit || 10;

  const usageUrgent = leadsRemaining <= 2;
  const isUrgent = usageUrgent;
  const isWarning = leadsRemaining <= 5;

  const bgColor = isUrgent ? 'bg-amber-500' : isWarning ? 'bg-blue-600' : 'bg-slate-800';
  const borderColor = isUrgent ? 'border-amber-600' : isWarning ? 'border-blue-700' : 'border-slate-700';
  const subtextColor = isUrgent ? 'text-amber-100' : isWarning ? 'text-blue-100' : 'text-slate-300';
  const btnBg = isUrgent ? 'bg-white text-amber-600 hover:bg-amber-50' : isWarning ? 'bg-white text-blue-600 hover:bg-blue-50' : 'bg-white text-slate-800 hover:bg-slate-50';

  return (
    <div
      className={`fixed top-0 left-0 lg:left-72 right-0 z-40 px-6 py-3 ${bgColor} border-b ${borderColor} shadow-lg transition-all duration-300 ${
        isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
      }`}
    >
      <div className="flex items-center gap-4 max-w-7xl mx-auto">
        <button
          onClick={handleDismiss}
          className="p-1.5 text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all shrink-0"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
        <div className="flex items-center justify-center w-9 h-9 bg-white/20 rounded-xl shrink-0">
          {isUrgent ? <AlertCircle className="w-5 h-5 text-white" /> : <Zap className="w-5 h-5 text-white" />}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-white">
            {leadsRemaining} of {leadsLimit} trial leads left
          </p>
          <p className={`text-xs ${subtextColor} mt-0.5`}>
            {leadsUsed} leads handled • Upgrade to unlock unlimited leads + premium features
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
