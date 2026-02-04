import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, X } from 'lucide-react';
import { billingApi } from '../services/api';
import '../styles/TrialBanner.css';

export default function CancelledSubscriptionBanner() {
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadSubscriptionStatus();
  }, []);

  const loadSubscriptionStatus = async () => {
    try {
      const subscription = await billingApi.getSubscription();

      // Show banner only if subscription is cancelled
      if (subscription.status === 'CANCELLED') {
        setShow(true);
      }
    } catch (error) {
      console.error('Failed to load subscription status:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading || !show) {
    return null;
  }

  return (
    <div className="trial-banner expired" style={{ backgroundColor: '#fee', borderColor: '#fcc' }}>
      <div className="trial-banner-content">
        <div className="trial-banner-icon">
          <AlertCircle size={20} color="#c33" />
        </div>
        <div className="trial-banner-text">
          <strong style={{ color: '#c33' }}>Subscription Cancelled</strong>
          <span style={{ color: '#c33' }}>Your subscription has been cancelled. Subscribe to continue using features.</span>
        </div>
        <Link to="/pricing" className="trial-banner-cta" style={{ backgroundColor: '#c33', borderColor: '#c33' }}>
          View Plans
        </Link>
        <button className="trial-banner-dismiss" onClick={() => setShow(false)} aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
