import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, AlertCircle } from 'lucide-react';
import { billingApi } from '../services/api';
import '../styles/TrialExpiredModal.css';

export default function TrialExpiredModal() {
  const [show, setShow] = useState(false);
  const [trialExpired, setTrialExpired] = useState(false);
  const [trialStats, setTrialStats] = useState<{
    leadsHandled: number;
    expiredByUsage: boolean;
    expiredByTime: boolean;
  } | null>(null);

  useEffect(() => {
    async function checkTrialStatus() {
      try {
        const subscription = await billingApi.getSubscription();

        // Only show if trial is expired and no active subscription
        const hasActiveSubscription = subscription.tier &&
          ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');

        if (subscription.trial?.trialExpired && !hasActiveSubscription) {
          setTrialExpired(true);
          setTrialStats({
            leadsHandled: subscription.trial.trialLeadsHandled || 0,
            expiredByUsage: subscription.trial.trialExpiredByUsage || false,
            expiredByTime: subscription.trial.trialExpiredByTime || false,
          });

          // Check if user has dismissed the modal in this session
          const dismissed = sessionStorage.getItem('trialExpiredModalDismissed');
          if (!dismissed) {
            setShow(true);
          }
        }
      } catch (error) {
        console.error('Failed to check trial status:', error);
      }
    }

    checkTrialStatus();
  }, []);

  const handleDismiss = () => {
    setShow(false);
    sessionStorage.setItem('trialExpiredModalDismissed', 'true');
  };

  if (!trialExpired || !show) {
    return null;
  }

  return (
    <>
      <div className="modal-overlay" onClick={handleDismiss}></div>
      <div className="trial-expired-modal">
        <button className="modal-close" onClick={handleDismiss} aria-label="Close">
          <X size={24} />
        </button>

        <div className="modal-icon">
          <AlertCircle size={64} />
        </div>

        <h2>
          {trialStats?.expiredByUsage
            ? '🎉 You hit your trial limit!'
            : 'Your Free Trial Has Ended'}
        </h2>

        {trialStats && trialStats.leadsHandled > 0 ? (
          <>
            <p className="modal-description" style={{ fontSize: '1.1rem', fontWeight: '600', color: '#2c3e50' }}>
              You handled <strong style={{ color: '#3498db', fontSize: '1.3rem' }}>{trialStats.leadsHandled}</strong> lead{trialStats.leadsHandled !== 1 ? 's' : ''} during your trial!
            </p>
            <p className="modal-description">
              {trialStats.expiredByUsage
                ? "You've used all your trial leads - that's great engagement! Upgrade now to keep responding to unlimited leads."
                : "Upgrade now to keep this momentum going and never miss another lead."}
            </p>
          </>
        ) : (
          <p className="modal-description">
            Your trial has expired. To continue using Thumbtack Bridge and access all features, please subscribe to one of our plans.
          </p>
        )}

        <div className="modal-benefits">
          <h3>Upgrade to unlock:</h3>
          <ul>
            <li>✓ Unlimited leads & responses</li>
            <li>✓ Auto-call customers instantly</li>
            <li>✓ AI-powered follow-ups</li>
            <li>✓ Your own business number</li>
            <li>✓ SMS & email notifications</li>
          </ul>
        </div>

        <div className="modal-actions">
          <Link to="/pricing" className="btn-primary modal-cta" onClick={handleDismiss}>
            View Pricing Plans
          </Link>
          <button className="btn-secondary" onClick={handleDismiss}>
            Maybe Later
          </button>
        </div>
      </div>
    </>
  );
}
