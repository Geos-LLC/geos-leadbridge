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

      // Don't show banner if user has an active subscription
      const hasActiveSubscription = subscription.tier &&
        ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');

      if (hasActiveSubscription) {
        setLoading(false);
        return;
      }

      if (subscription.trial) {
        setTrialStatus(subscription.trial);
      } else {
        // Show demo trial banner for testing when no trial data exists
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
      console.error('Failed to load trial status:', error);
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

  // Trial expired - show urgent banner (doesn't auto-hide)
  if (trialStatus.trialExpired) {
    return (
      <div className="px-6 py-4 bg-red-50 border-b border-red-100">
        <div className="flex items-center gap-4 max-w-7xl mx-auto">
          <div className="flex items-center justify-center w-10 h-10 bg-red-100 rounded-xl shrink-0">
            <AlertCircle className="w-5 h-5 text-red-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-red-900">Your trial has expired</p>
            <p className="text-xs text-red-700 mt-0.5">Subscribe now to continue using all features</p>
          </div>
          <Link
            to="/pricing"
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-all"
          >
            <Zap className="w-4 h-4" />
            View Plans
          </Link>
        </div>
      </div>
    );
  }

  // Active trial - show countdown (both time AND usage)
  const leadsRemaining = trialStatus.trialLeadsRemaining || 0;
  const leadsUsed = trialStatus.trialLeadsHandled || 0;
  const leadsLimit = trialStatus.trialLeadsLimit || 10;

  // Determine urgency based on whichever limit is closer
  const timeUrgent = trialStatus.trialDaysRemaining <= 3;
  const usageUrgent = leadsRemaining <= 2;
  const isUrgent = timeUrgent || usageUrgent;
  const isWarning = trialStatus.trialDaysRemaining <= 7 || leadsRemaining <= 5;

  const bgColor = isUrgent ? 'bg-amber-50' : isWarning ? 'bg-blue-50' : 'bg-slate-50';
  const borderColor = isUrgent ? 'border-amber-100' : isWarning ? 'border-blue-100' : 'border-slate-100';
  const iconBgColor = isUrgent ? 'bg-amber-100' : isWarning ? 'bg-blue-100' : 'bg-slate-100';
  const iconColor = isUrgent ? 'text-amber-600' : isWarning ? 'text-blue-600' : 'text-slate-600';
  const textColor = isUrgent ? 'text-amber-900' : isWarning ? 'text-blue-900' : 'text-slate-900';
  const subtextColor = isUrgent ? 'text-amber-700' : isWarning ? 'text-blue-700' : 'text-slate-700';
  const btnColor = isUrgent ? 'bg-amber-600 hover:bg-amber-700' : isWarning ? 'bg-blue-600 hover:bg-blue-700' : 'bg-slate-600 hover:bg-slate-700';

  return (
    <div
      className={`px-6 py-4 ${bgColor} border-b ${borderColor} transition-all duration-300 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'
      }`}
      style={{ display: isVisible ? 'block' : 'none' }}
    >
      <div className="flex items-center gap-4 max-w-7xl mx-auto relative">
        <button
          onClick={handleDismiss}
          className="absolute -right-2 -top-2 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-white/50 rounded-lg transition-all"
          aria-label="Dismiss"
        >
          <X className="w-4 h-4" />
        </button>
        <div className={`flex items-center justify-center w-10 h-10 ${iconBgColor} rounded-xl shrink-0`}>
          {isUrgent ? <AlertCircle className={`w-5 h-5 ${iconColor}`} /> : <Zap className={`w-5 h-5 ${iconColor}`} />}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-bold ${textColor}`}>
            {leadsRemaining} of {leadsLimit} trial leads left
            {trialStatus.trialDaysRemaining > 0 && ` • ${trialStatus.trialDaysRemaining} day${trialStatus.trialDaysRemaining !== 1 ? 's' : ''} remaining`}
          </p>
          <p className={`text-xs ${subtextColor} mt-0.5`}>
            {leadsUsed} leads handled • Upgrade to unlock unlimited leads + premium features
          </p>
        </div>
        <Link
          to="/pricing"
          className={`shrink-0 inline-flex items-center gap-2 px-4 py-2 ${btnColor} text-white rounded-xl text-sm font-semibold transition-all`}
        >
          <Zap className="w-4 h-4" />
          Upgrade Now
        </Link>
      </div>
    </div>
  );
}
