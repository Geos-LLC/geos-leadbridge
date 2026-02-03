import { useState, useEffect } from 'react';
import { billingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import type { SubscriptionDetails } from '../types';
import { Link } from 'react-router-dom';

const tierNames = {
  STARTER: 'Instant Reply',
  PRO: 'Call Assist',
  ENTERPRISE: 'AI Conversations',
};

const tierPrices = {
  STARTER: 49,
  PRO: 99,
  ENTERPRISE: 129,
};

export default function BillingSettings() {
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    loadSubscription();
  }, []);

  const loadSubscription = async () => {
    try {
      setLoading(true);
      const data = await billingApi.getSubscription();
      setSubscription(data);
    } catch (error: any) {
      console.error('Failed to load subscription:', error);
      if (error.response?.status !== 404) {
        notify.error('Error', 'Failed to load subscription details');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    try {
      setPortalLoading(true);
      const { portalUrl } = await billingApi.createPortalSession();
      window.location.href = portalUrl;
    } catch (error: any) {
      console.error('Failed to open billing portal:', error);
      notify.error('Error', 'Failed to open billing portal');
      setPortalLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="billing-page">
        <div className="billing-header">
          <h1>Billing & Subscription</h1>
        </div>
        <div className="loading-state">
          <p>Loading subscription details...</p>
        </div>
      </div>
    );
  }

  // Show subscription card if there's a tier and status (including CANCELLED)
  // Only show "No Active Subscription" if there was never a subscription
  const hasSubscription = Boolean(subscription?.tier && subscription?.status);
  const isCancelled = subscription?.status === 'CANCELLED';

  return (
    <div className="billing-page">
      <div className="billing-header">
        <h1>Billing & Subscription</h1>
        <p>Manage your subscription and billing information</p>
      </div>

      {hasSubscription && subscription ? (
        <div className="billing-content">
          <div className="subscription-card">
            <div className="subscription-header">
              <div>
                <h2>{subscription.tier ? tierNames[subscription.tier] : 'Unknown'} Plan</h2>
                <div className={`subscription-status status-${subscription.status?.toLowerCase()}`}>
                  {subscription.status}
                </div>
              </div>
              <div className="subscription-price">
                ${subscription.tier ? tierPrices[subscription.tier] : 0}
                {subscription.hasOwnNumber && ' + $29'}
                <span>/month</span>
              </div>
            </div>

            {isCancelled && (
              <div className="subscription-notice cancelled-notice">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9h2v5H9V9zm0-4h2v2H9V5z" fill="currentColor"/>
                </svg>
                <div>
                  <strong>Subscription Cancelled</strong>
                  <p>Your subscription has been cancelled. {subscription.periodEnd && `Access will continue until ${new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`} You can reactivate anytime through the billing portal.</p>
                </div>
              </div>
            )}

            {!isCancelled && subscription.periodEnd && (
              <div className="subscription-detail">
                <span className="detail-label">Next billing date:</span>
                <span className="detail-value">
                  {new Date(subscription.periodEnd).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
              </div>
            )}

            {subscription.hasOwnNumber && (
              <div className="subscription-detail">
                <span className="detail-label">Add-ons:</span>
                <span className="detail-value">Own Business Number (+$29/month)</span>
              </div>
            )}

            <div className="features-section">
              <h3>Your Features</h3>
              <ul className="feature-list">
                {subscription.features.map((feature, index) => (
                  <li key={index}>
                    <svg width="16" height="16" viewBox="0 0 20 20" fill="none">
                      <path
                        d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z"
                        fill="currentColor"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>
            </div>

            <div className="subscription-actions">
              <button
                className="btn-primary"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? 'Opening...' : 'Manage Subscription'}
              </button>
              <Link to="/pricing" className="btn-secondary">
                View All Plans
              </Link>
            </div>

            <div className="billing-portal-info">
              <p>
                Use the billing portal to:
              </p>
              <ul>
                <li>Update payment method</li>
                <li>View invoice history</li>
                <li>Cancel or upgrade subscription</li>
                <li>Update billing information</li>
              </ul>
            </div>
          </div>
        </div>
      ) : (
        <div className="no-subscription">
          <div className="empty-state">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="8" width="18" height="13" rx="2" strokeWidth="2" />
              <path d="M3 10h18M7 15h.01M11 15h2" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <h2>No Active Subscription</h2>
            <p>
              Subscribe to unlock powerful features for lead management and automation
            </p>
            <Link to="/pricing" className="btn-primary">
              View Pricing Plans
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
