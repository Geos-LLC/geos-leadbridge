import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { billingApi } from '../services/api';
import { X, AlertCircle, Zap } from 'lucide-react';
import '../styles/TrialBanner.css';

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

  useEffect(() => {
    loadTrialStatus();
  }, []);

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
      }
    } catch (error) {
      console.error('Failed to load trial status:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || !trialStatus || dismissed) {
    return null;
  }

  // Don't show if user is not on trial and trial hasn't expired
  if (!trialStatus.isOnTrial && !trialStatus.trialExpired) {
    return null;
  }

  // Trial expired - show urgent banner
  if (trialStatus.trialExpired) {
    return (
      <div className="trial-banner expired">
        <div className="trial-banner-content">
          <div className="trial-banner-row">
            <div className="trial-banner-icon">
              <AlertCircle size={20} />
            </div>
            <div className="trial-banner-text">
              <strong>Your trial has expired</strong>
              <span>Subscribe now to continue using all features</span>
            </div>
          </div>
          <Link to="/pricing" className="trial-banner-cta">
            <Zap size={16} />
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
  const urgency = (timeUrgent || usageUrgent) ? 'urgent' :
                  (trialStatus.trialDaysRemaining <= 7 || leadsRemaining <= 5) ? 'warning' : 'info';

  return (
    <div className={`trial-banner ${urgency}`}>
      <div className="trial-banner-content">
        <div className="trial-banner-row">
          <div className="trial-banner-icon">
            {urgency === 'urgent' ? <AlertCircle size={20} /> : <Zap size={20} />}
          </div>
          <div className="trial-banner-text">
            <strong>
              {leadsRemaining} of {leadsLimit} trial leads left
              {trialStatus.trialDaysRemaining > 0 && ` • ${trialStatus.trialDaysRemaining} day${trialStatus.trialDaysRemaining !== 1 ? 's' : ''} remaining`}
            </strong>
            <span>{leadsUsed} leads handled • Upgrade to unlock unlimited leads + premium features</span>
          </div>
          <button className="trial-banner-dismiss" onClick={() => setDismissed(true)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
        <Link to="/pricing" className="trial-banner-cta">
          <Zap size={16} />
          Upgrade Now
        </Link>
      </div>
    </div>
  );
}
