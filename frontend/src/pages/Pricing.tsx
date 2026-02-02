import { useState } from 'react';
import { billingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';

const tiers = [
  {
    name: 'Instant Reply',
    id: 'STARTER' as const,
    price: 49,
    description: 'Perfect for getting started with automated responses',
    features: [
      'Custom reply templates',
      'Unlimited leads',
      'Email notifications',
      'Basic analytics',
    ],
  },
  {
    name: 'Call Assist',
    id: 'PRO' as const,
    price: 99,
    description: 'Everything you need to handle customer calls',
    features: [
      'Everything in Instant Reply',
      'Phone call capability',
      'SMS notifications',
      'Advanced analytics',
      'Priority support',
    ],
    popular: true,
  },
  {
    name: 'AI Conversations',
    id: 'ENTERPRISE' as const,
    price: 129,
    description: 'AI-powered conversations for maximum engagement',
    features: [
      'Everything in Call Assist',
      'AI-powered follow-ups',
      'Smart conversation routing',
      'Custom integrations',
      'Dedicated support',
    ],
  },
];

export default function Pricing() {
  const [loading, setLoading] = useState<string | null>(null);
  const [ownNumber, setOwnNumber] = useState(false);
  const user = useAuthStore((state) => state.user);

  const handleSubscribe = async (tierId: 'STARTER' | 'PRO' | 'ENTERPRISE') => {
    try {
      console.log('[Pricing] handleSubscribe called with tier:', tierId);
      setLoading(tierId);
      const addOns = ownNumber ? ['ownNumber'] : [];
      console.log('[Pricing] Calling createCheckoutSession with:', { tierId, addOns });

      const response = await billingApi.createCheckoutSession(tierId, addOns);
      console.log('[Pricing] Response from createCheckoutSession:', response);

      const { sessionUrl } = response;
      console.log('[Pricing] Extracted sessionUrl:', sessionUrl);

      // Redirect to Stripe checkout
      console.log('[Pricing] Redirecting to:', sessionUrl);
      window.location.href = sessionUrl;
    } catch (error: any) {
      console.error('[Pricing] Failed to create checkout session:', error);
      console.error('[Pricing] Error details:', error.response?.data);
      notify.error('Checkout Error', error.response?.data?.message || 'Failed to start checkout process');
      setLoading(null);
    }
  };

  const currentTier = user?.subscriptionTier;

  return (
    <div className="pricing-page">
      <div className="pricing-header">
        <h1>Choose Your Plan</h1>
        <p>Select the perfect plan for your business needs</p>
      </div>

      <div className="own-number-addon">
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={ownNumber}
            onChange={(e) => setOwnNumber(e.target.checked)}
          />
          <span>
            Add Own Business Number <strong>+$29/month</strong>
          </span>
          <small>Get a dedicated phone number for your business</small>
        </label>
      </div>

      <div className="pricing-tiers">
        {tiers.map((tier) => {
          const isCurrentPlan = currentTier === tier.id;
          const totalPrice = tier.price + (ownNumber ? 29 : 0);

          return (
            <div
              key={tier.id}
              className={`pricing-tier ${tier.popular ? 'popular' : ''} ${isCurrentPlan ? 'current' : ''}`}
            >
              {tier.popular && <div className="popular-badge">Most Popular</div>}
              {isCurrentPlan && <div className="current-badge">Current Plan</div>}

              <h3>{tier.name}</h3>
              <div className="tier-price">
                <span className="price">${totalPrice}</span>
                <span className="period">/month</span>
              </div>
              <p className="tier-description">{tier.description}</p>

              <ul className="tier-features">
                {tier.features.map((feature, index) => (
                  <li key={index}>
                    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                      <path
                        d="M16.7 5.3a1 1 0 010 1.4l-8 8a1 1 0 01-1.4 0l-4-4a1 1 0 011.4-1.4L8 12.58l7.3-7.3a1 1 0 011.4 0z"
                        fill="currentColor"
                      />
                    </svg>
                    {feature}
                  </li>
                ))}
              </ul>

              <button
                className={`tier-button ${isCurrentPlan ? 'current' : ''}`}
                onClick={() => handleSubscribe(tier.id)}
                disabled={loading === tier.id || isCurrentPlan}
              >
                {loading === tier.id ? (
                  'Processing...'
                ) : isCurrentPlan ? (
                  'Current Plan'
                ) : (
                  'Get Started'
                )}
              </button>
            </div>
          );
        })}
      </div>

      <div className="pricing-footer">
        <p>All plans include a 14-day money-back guarantee</p>
        <p>Need help choosing? <a href="mailto:support@thumbtack-bridge.com">Contact our team</a></p>
      </div>
    </div>
  );
}
