import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, AlertCircle } from 'lucide-react';
import { billingApi } from '../services/api';
import '../styles/TrialExpiredModal.css';

export default function TrialExpiredModal() {
  const [show, setShow] = useState(false);
  const [trialExpired, setTrialExpired] = useState(false);

  useEffect(() => {
    async function checkTrialStatus() {
      try {
        const subscription = await billingApi.getSubscription();

        // Only show if trial is expired and no active subscription
        const hasActiveSubscription = subscription.tier &&
          ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');

        if (subscription.trial?.trialExpired && !hasActiveSubscription) {
          setTrialExpired(true);

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

        <h2>Your Free Trial Has Ended</h2>

        <p className="modal-description">
          Your 14-day free trial has expired. To continue using Thumbtack Bridge and access all features, please subscribe to one of our plans.
        </p>

        <div className="modal-benefits">
          <h3>Continue enjoying:</h3>
          <ul>
            <li>✓ Automated lead responses</li>
            <li>✓ SMS notifications</li>
            <li>✓ Multi-account management</li>
            <li>✓ Message templates & automation</li>
            <li>✓ And much more...</li>
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
