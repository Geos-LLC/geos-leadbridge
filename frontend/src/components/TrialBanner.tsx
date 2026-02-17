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
    console.log('[TrialBanner] loadTrialStatus called');
    try {
      const subscription = await billingApi.getSubscription();
      console.log('[TrialBanner] subscription response:', JSON.stringify(subscription, null, 2));

      // Don't show banner if user has an active PAID subscription (not trial)
      const hasPaidSubscription = subscription.tier &&
        ['ACTIVE', 'PAST_DUE'].includes(subscription.status || '');

      console.log('[TrialBanner] hasPaidSubscription:', hasPaidSubscription);
      console.log('[TrialBanner] subscription.status:', subscription.status);
      console.log('[TrialBanner] subscription.tier:', subscription.tier);
      console.log('[TrialBanner] subscription.trial:', subscription.trial);

      if (hasPaidSubscription) {
        console.log('[TrialBanner] hiding - user has paid subscription');
        setLoading(false);
        return;
      }

      // Show trial banner if user is on trial or if trial data exists
      if (subscription.trial) {
        console.log('[TrialBanner] using subscription.trial data');
        setTrialStatus(subscription.trial);
      } else if (subscription.status === 'TRIALING') {
        console.log('[TrialBanner] TRIALING status - using fallback data');
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
        console.log('[TrialBanner] no subscription/trial - using demo data');
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

  console.log('[TrialBanner] render state:', { loading, dismissed, isVisible, trialStatus: trialStatus ? JSON.stringify(trialStatus) : null });

  if (loading || !trialStatus || dismissed) {
    console.log('[TrialBanner] returning null - loading:', loading, 'trialStatus:', !!trialStatus, 'dismissed:', dismissed);
    return null;
  }

  // Don't show if user is not on trial and trial hasn't expired
  if (!trialStatus.isOnTrial && !trialStatus.trialExpired) {
    console.log('[TrialBanner] returning null - not on trial and not expired');
    return null;
  }

  console.log('[TrialBanner] RENDERING banner - isVisible:', isVisible, 'isOnTrial:', trialStatus.isOnTrial, 'trialExpired:', trialStatus.trialExpired);

  // Trial expired - show urgent banner overlaying the page
  if (trialStatus.trialExpired) {
    return (
      <div className="fixed bottom-0 left-0 lg:left-72 right-0 z-50 px-6 py-4 bg-red-600 border-t border-red-700 shadow-2xl">
        <div className="flex items-center gap-4 max-w-7xl mx-auto">
          <div className="flex items-center justify-center w-9 h-9 bg-white/20 rounded-xl shrink-0">
            <AlertCircle className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-white">Your trial has expired</p>
            <p className="text-xs text-red-200 mt-0.5">Subscribe now to continue using all features</p>
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

  // Active trial - show countdown (both time AND usage)
  const leadsRemaining = trialStatus.trialLeadsRemaining || 0;
  const leadsUsed = trialStatus.trialLeadsHandled || 0;
  const leadsLimit = trialStatus.trialLeadsLimit || 10;

  // Determine urgency based on whichever limit is closer
  const timeUrgent = trialStatus.trialDaysRemaining <= 3;
  const usageUrgent = leadsRemaining <= 2;
  const isUrgent = timeUrgent || usageUrgent;
  const isWarning = trialStatus.trialDaysRemaining <= 7 || leadsRemaining <= 5;

  const bgColor = isUrgent ? 'bg-amber-500' : isWarning ? 'bg-blue-600' : 'bg-slate-800';
  const borderColor = isUrgent ? 'border-amber-600' : isWarning ? 'border-blue-700' : 'border-slate-700';
  const subtextColor = isUrgent ? 'text-amber-100' : isWarning ? 'text-blue-100' : 'text-slate-300';
  const btnBg = isUrgent ? 'bg-white text-amber-600 hover:bg-amber-50' : isWarning ? 'bg-white text-blue-600 hover:bg-blue-50' : 'bg-white text-slate-800 hover:bg-slate-50';

  return (
    <div
      className={`fixed bottom-0 left-0 lg:left-72 right-0 z-50 px-6 py-4 ${bgColor} border-t ${borderColor} shadow-2xl transition-all duration-300 ${
        isVisible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
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
            {trialStatus.trialDaysRemaining > 0 && ` • ${trialStatus.trialDaysRemaining} day${trialStatus.trialDaysRemaining !== 1 ? 's' : ''} remaining`}
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
