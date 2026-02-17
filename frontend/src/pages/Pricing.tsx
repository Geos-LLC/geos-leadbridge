import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Phone, Loader2 } from 'lucide-react';
import { billingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import type { SubscriptionDetails } from '../types';

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
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [ownNumber, setOwnNumber] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);

  useEffect(() => {
    // Fetch fresh subscription data to get current tier
    const loadSubscription = async () => {
      try {
        const data = await billingApi.getSubscription();
        setSubscription(data);
      } catch (error) {
        // Ignore errors - user might not have a subscription
        console.log('No active subscription');
      }
    };
    loadSubscription();
  }, []);

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

  // Get current tier from fresh subscription data, not cached authStore
  // Only show as "current" if subscription is active (not cancelled)
  const hasActiveSubscription = subscription?.tier &&
    ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');
  const currentTier = hasActiveSubscription ? subscription?.tier : null;

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-12">
      {/* Back Button */}
      <div>
        <button
          onClick={() => navigate('/settings')}
          className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center gap-2"
        >
          <ArrowLeft size={16} />
          Back to Settings
        </button>
      </div>

      {/* Header */}
      <section className="text-center max-w-2xl mx-auto">
        <h2 className="text-4xl lg:text-5xl font-extrabold text-slate-900 tracking-tight mb-4">
          Choose Your <span className="gradient-text">Plan</span>
        </h2>
        <p className="text-slate-500 text-lg">
          Select the perfect plan for your business needs. All plans include a 14-day money-back guarantee.
        </p>
      </section>

      {/* Add-on Toggle */}
      <section className="flex justify-center">
        <div className="bg-white border border-slate-200 p-4 rounded-2xl shadow-sm flex items-center gap-4 max-w-md w-full">
          <div className="w-12 h-12 bg-amber-50 text-amber-600 rounded-xl flex items-center justify-center shrink-0">
            <Phone className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <label className="flex items-center gap-2 cursor-pointer group">
              <input
                type="checkbox"
                checked={ownNumber}
                onChange={(e) => setOwnNumber(e.target.checked)}
                className="w-5 h-5 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">
                Add Own Business Number
              </span>
            </label>
            <p className="text-xs text-slate-500 mt-1">
              Dedicated phone line for <strong>+$29/month</strong>
            </p>
          </div>
        </div>
      </section>

      {/* Pricing Tiers Grid */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-8">
        {tiers.map((tier) => {
          const isCurrentPlan = currentTier === tier.id;
          const totalPrice = tier.price + (ownNumber ? 29 : 0);
          const isLoading = loading === tier.id;

          // Determine card styling based on tier
          if (tier.id === 'STARTER') {
            // Basic tier - white card
            return (
              <div
                key={tier.id}
                className="bg-white p-8 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-xl transition-all flex flex-col"
              >
                <div className="mb-8">
                  <h3 className="text-xl font-bold text-slate-900">{tier.name}</h3>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold text-slate-900">${totalPrice}</span>
                    <span className="text-slate-400 font-medium">/month</span>
                  </div>
                  <p className="text-slate-500 text-sm mt-4 leading-relaxed">{tier.description}</p>
                </div>

                <ul className="space-y-4 mb-10 flex-1">
                  {tier.features.map((feature, index) => (
                    <li key={index} className="flex items-center gap-3 text-slate-600 text-sm">
                      <div className="bg-emerald-100 text-emerald-600 rounded-full p-1">
                        <Check className="w-3 h-3" />
                      </div>
                      {feature}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(tier.id)}
                  disabled={isLoading || isCurrentPlan}
                  className="w-full py-4 bg-slate-50 text-slate-900 font-bold rounded-2xl hover:bg-slate-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Processing...
                    </>
                  ) : isCurrentPlan ? (
                    'Current Plan'
                  ) : (
                    'Get Started'
                  )}
                </button>
              </div>
            );
          } else if (tier.id === 'PRO') {
            // Popular tier - blue border, scaled
            return (
              <div
                key={tier.id}
                className="bg-white p-8 rounded-[2.5rem] border-2 border-blue-600 shadow-2xl shadow-blue-100 flex flex-col relative scale-105"
              >
                {tier.popular && (
                  <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full">
                    Most Popular
                  </div>
                )}
                <div className="mb-8">
                  <div className="flex justify-between items-start">
                    <h3 className="text-xl font-bold text-slate-900">{tier.name}</h3>
                    {isCurrentPlan && (
                      <span className="bg-blue-50 text-blue-600 text-[10px] font-bold px-2 py-1 rounded">
                        CURRENT PLAN
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold text-slate-900">${totalPrice}</span>
                    <span className="text-slate-400 font-medium">/month</span>
                  </div>
                  <p className="text-slate-500 text-sm mt-4 leading-relaxed">{tier.description}</p>
                </div>

                <ul className="space-y-4 mb-10 flex-1">
                  {tier.features.map((feature, index) => (
                    <li
                      key={index}
                      className={`flex items-center gap-3 text-sm ${
                        index === 0 ? 'text-slate-900 font-semibold' : 'text-slate-600'
                      }`}
                    >
                      <div
                        className={`rounded-full p-1 ${
                          index === 0 ? 'bg-blue-600 text-white' : 'bg-emerald-100 text-emerald-600'
                        }`}
                      >
                        <Check className="w-3 h-3" />
                      </div>
                      {feature}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(tier.id)}
                  disabled={isLoading || isCurrentPlan}
                  className="w-full py-4 bg-blue-600 text-white font-bold rounded-2xl hover:bg-blue-700 transition-all disabled:bg-slate-100 disabled:text-slate-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Processing...
                    </>
                  ) : isCurrentPlan ? (
                    'Current Plan'
                  ) : (
                    'Get Started'
                  )}
                </button>
              </div>
            );
          } else {
            // Enterprise tier - dark card
            return (
              <div
                key={tier.id}
                className="bg-slate-900 p-8 rounded-[2.5rem] shadow-xl text-white flex flex-col"
              >
                <div className="mb-8">
                  <div className="flex justify-between items-start">
                    <h3 className="text-xl font-bold">{tier.name}</h3>
                    {isCurrentPlan && (
                      <span className="bg-white/10 text-blue-400 text-[10px] font-bold px-2 py-1 rounded">
                        CURRENT PLAN
                      </span>
                    )}
                  </div>
                  <div className="mt-4 flex items-baseline gap-1">
                    <span className="text-4xl font-extrabold">${totalPrice}</span>
                    <span className="text-slate-400 font-medium">/month</span>
                  </div>
                  <p className="text-slate-400 text-sm mt-4 leading-relaxed">{tier.description}</p>
                </div>

                <ul className="space-y-4 mb-10 flex-1">
                  {tier.features.map((feature, index) => (
                    <li key={index} className="flex items-center gap-3 text-slate-200 text-sm">
                      <div className="bg-white/10 text-blue-400 rounded-full p-1">
                        <Check className="w-3 h-3" />
                      </div>
                      {feature}
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => handleSubscribe(tier.id)}
                  disabled={isLoading || isCurrentPlan}
                  className="w-full py-4 bg-blue-600 text-white font-bold rounded-2xl hover:bg-blue-700 shadow-lg shadow-blue-900/20 transition-all disabled:bg-white/10 disabled:text-slate-500 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {isLoading ? (
                    <>
                      <Loader2 size={16} className="animate-spin" />
                      Processing...
                    </>
                  ) : isCurrentPlan ? (
                    'Current Plan'
                  ) : (
                    'Upgrade Now'
                  )}
                </button>
              </div>
            );
          }
        })}
      </section>

      {/* Footer / Help */}
      <section className="bg-slate-50 rounded-3xl p-8 text-center border border-slate-100">
        <p className="text-slate-600 font-medium">Need help choosing the right plan for your business?</p>
        <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-4">
          <a
            href="mailto:support@leadbridge.com"
            className="text-blue-600 font-bold hover:underline"
          >
            Contact our team
          </a>
          <span className="hidden sm:block text-slate-300">|</span>
          <span className="text-slate-500 text-sm italic">
            All plans include a 14-day money-back guarantee
          </span>
        </div>
      </section>
    </div>
  );
}
