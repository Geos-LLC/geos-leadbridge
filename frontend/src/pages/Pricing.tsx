import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, Star } from 'lucide-react';
import { billingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import type { SubscriptionDetails } from '../types';

const tiers = [
  {
    name: 'Starter',
    id: 'STARTER' as const,
    price: 29,
    originalPrice: 19,
    tagline: 'Never miss a lead',
    description: 'Get notified instantly and send a quick first response to every new inquiry.',
    features: [
      'Instant lead notifications (SMS alerts)',
      'Basic auto-reply (first message only)',
      '1 phone number included',
      'Manual follow-up & calls',
    ],
    cta: 'Perfect for solo operators getting started',
  },
  {
    name: 'Pro',
    id: 'PRO' as const,
    price: 99,
    originalPrice: 49,
    tagline: 'Automatically handle every lead',
    description: 'Let the system respond, follow up, and connect you with customers — automatically.',
    features: [
      'Full auto-replies (ongoing conversations)',
      '2-way messaging (SMS + calls)',
      'Call connect (instant call to new leads)',
      'Automatic follow-ups (coming soon)',
      'Handles up to 500 leads/month',
      'Everything included',
    ],
    popular: true,
    cta: 'Best for growing businesses that want more bookings with less effort',
  },
];

export default function Pricing() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);

  useEffect(() => {
    const loadSubscription = async () => {
      try {
        const data = await billingApi.getSubscription();
        setSubscription(data);
      } catch (error) {
        console.log('No active subscription');
      }
    };
    loadSubscription();
  }, []);

  const handleSubscribe = async (tierId: 'STARTER' | 'PRO' | 'ENTERPRISE') => {
    try {
      setLoading(tierId);
      const response = await billingApi.createCheckoutSession(tierId, []);
      const { sessionUrl } = response;
      window.location.href = sessionUrl;
    } catch (error: any) {
      console.error('[Pricing] Failed to create checkout session:', error);
      notify.error('Checkout Error', error.response?.data?.message || 'Failed to start checkout process');
      setLoading(null);
    }
  };

  const hasActiveSubscription = subscription?.tier &&
    ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(subscription.status || '');
  const currentTier = hasActiveSubscription ? subscription?.tier : null;

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-12">
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
          Select the perfect plan for your business. All plans include a 14-day money-back guarantee.
        </p>
      </section>

      {/* Early Access Banner */}
      <section className="flex justify-center">
        <div className="bg-amber-50 border border-amber-200 px-6 py-3 rounded-2xl text-center">
          <span className="text-amber-800 font-bold text-sm">Early Access Pricing</span>
          <span className="text-amber-600 text-sm ml-2">— Lock in lower rates before we launch publicly</span>
        </div>
      </section>

      {/* Pricing Tiers Grid */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-8 max-w-4xl mx-auto">
        {tiers.map((tier) => {
          const isCurrentPlan = currentTier === tier.id;
          const isLoading = loading === tier.id;
          const isPro = tier.id === 'PRO';

          return (
            <div
              key={tier.id}
              className={`p-8 rounded-[2.5rem] flex flex-col relative ${
                isPro
                  ? 'bg-white border-2 border-blue-600 shadow-2xl shadow-blue-100 scale-[1.02]'
                  : 'bg-white border border-slate-100 shadow-sm hover:shadow-xl transition-all'
              }`}
            >
              {isPro && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full flex items-center gap-1">
                  <Star className="w-3 h-3" />
                  Most Popular
                </div>
              )}

              <div className="mb-8">
                <div className="flex justify-between items-start">
                  <div>
                    <h3 className="text-xl font-bold text-slate-900">{tier.name}</h3>
                    <p className="text-slate-500 text-sm mt-1">{tier.tagline}</p>
                  </div>
                  {isCurrentPlan && (
                    <span className={`text-[10px] font-bold px-2 py-1 rounded ${isPro ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-600'}`}>
                      CURRENT
                    </span>
                  )}
                </div>

                <div className="mt-5 flex items-baseline gap-2">
                  <span className="text-slate-400 line-through text-lg font-medium">${tier.originalPrice}</span>
                  <span className="text-4xl font-extrabold text-slate-900">${tier.price}</span>
                  <span className="text-slate-400 font-medium">/month</span>
                </div>
                <p className="text-xs text-amber-600 font-semibold mt-1">Early Access Price</p>

                <p className="text-slate-500 text-sm mt-4 leading-relaxed">{tier.description}</p>
              </div>

              <ul className="space-y-4 mb-8 flex-1">
                {tier.features.map((feature, index) => (
                  <li key={index} className="flex items-start gap-3 text-sm text-slate-600">
                    <div className={`rounded-full p-1 shrink-0 mt-0.5 ${isPro ? 'bg-blue-600 text-white' : 'bg-emerald-100 text-emerald-600'}`}>
                      <Check className="w-3 h-3" />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>

              <p className="text-xs text-slate-400 italic mb-4">{tier.cta}</p>

              <button
                onClick={() => handleSubscribe(tier.id)}
                disabled={isLoading || isCurrentPlan}
                className={`w-full py-4 font-bold rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 ${
                  isPro
                    ? 'bg-blue-600 text-white hover:bg-blue-700'
                    : 'bg-slate-900 text-white hover:bg-slate-800'
                }`}
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
        })}
      </section>

      {/* Footer / Help */}
      <section className="bg-slate-50 rounded-3xl p-8 text-center border border-slate-100">
        <p className="text-slate-600 font-medium">Need help choosing the right plan for your business?</p>
        <div className="mt-4 flex flex-col sm:flex-row justify-center items-center gap-4">
          <a
            href="mailto:support@leadbridge360.com"
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
