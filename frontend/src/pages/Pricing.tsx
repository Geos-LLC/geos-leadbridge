import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, Star, Plus } from 'lucide-react';
import { billingApi, notificationsApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import type { SubscriptionDetails } from '../types';

type TierId = 'STARTER' | 'PRO' | 'ENTERPRISE';

interface Tier {
  label: string;
  /**
   * Short name used inside button copy ("Upgrade to <shortLabel>"). Lets the
   * decorative header label keep punctuation/icons that read fine in big type
   * but look awkward inside a button. Falls back to `label` when omitted.
   */
  shortLabel?: string;
  id: TierId;
  price: number;
  tagline: string;
  dotColor: string;
  labelColor: string;
  features: string[];
  bestFor: string;
  popular?: boolean;
}

const tiers: Tier[] = [
  {
    label: 'Respond',
    id: 'STARTER',
    price: 39,
    tagline: 'Instant Reply (sent on Yelp/Thumbtack)',
    dotColor: 'bg-emerald-500',
    labelColor: 'text-emerald-700',
    features: [
      'Automatically respond to every new lead',
      'Get lead details + phone (when available)',
      'Instant SMS / call alerts',
    ],
    bestFor: 'You continue the conversation manually',
  },
  {
    label: 'Engage',
    id: 'PRO',
    price: 89,
    tagline: 'Follow up, react faster, and capture more leads',
    dotColor: 'bg-blue-500',
    labelColor: 'text-blue-700',
    features: [
      'Everything in Respond',
      'Automated follow-ups',
      'Re-engagement alerts',
      'Instant call (Thumbtack)',
      'Call when phone appears (Yelp)',
      'SMS communication',
      'Advanced analytics',
    ],
    bestFor: 'Serious operators & growing teams',
    popular: true,
  },
  {
    label: 'Convert · AI',
    shortLabel: 'Convert',
    id: 'ENTERPRISE',
    price: 139,
    tagline: 'Let AI handle conversations and convert leads',
    dotColor: 'bg-violet-500',
    labelColor: 'text-violet-700',
    features: [
      'Everything in Engage',
      'AI-powered conversation (not just first message)',
      'Adaptive replies based on customer responses',
      'AI pricing & qualification logic',
      'Smart conversation summaries',
      'Full analytics',
    ],
    bestFor: 'High-volume & scaling businesses',
  },
];

export default function Pricing() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState<string | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);
  const [extraNumberPrice, setExtraNumberPrice] = useState<number | null>(null);
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const hasEngageOrConvert = subscription?.tier === 'PRO' || subscription?.tier === 'ENTERPRISE';

  const handleBuyExtraNumber = () => {
    if (!isAuthenticated) {
      navigate('/register?intent=extra_number');
    } else if (hasEngageOrConvert) {
      navigate('/settings');
    } else {
      // Tier 1 / no plan → scroll to Engage tier card to upgrade
      const engageCard = document.getElementById('tier-PRO');
      if (engageCard) engageCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

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
    notificationsApi.getPhonePricing()
      .then(r => { if (r.success) setExtraNumberPrice(r.data.priceMonthly); })
      .catch(() => {});
  }, []);

  const handleSubscribe = async (tierId: TierId) => {
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
  // Ordered for upgrade/switch label decisions. Higher index = higher tier.
  const TIER_RANK: Record<string, number> = { STARTER: 0, PRO: 1, ENTERPRISE: 2 };
  const trialUsed = subscription?.trialUsed === true;

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
          Choose how much <span className="gradient-text">LeadBridge</span> should handle for you
        </h2>
        <p className="text-slate-500 text-lg">
          Flat monthly pricing. No per-lead fees. Cancel anytime.
        </p>
      </section>

      {/* Pricing Tiers Grid */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {tiers.map((tier) => {
          const isCurrentPlan = currentTier === tier.id;
          const isLoading = loading === tier.id;
          const isPopular = tier.popular;

          return (
            <div
              key={tier.id}
              id={`tier-${tier.id}`}
              className={`p-8 rounded-3xl bg-white flex flex-col relative transition-all ${
                isPopular
                  ? 'border-2 border-blue-600 shadow-2xl shadow-blue-100 md:-my-3'
                  : 'border border-slate-200 hover:shadow-xl'
              }`}
            >
              {isPopular && (
                <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full flex items-center gap-1.5">
                  <Star className="w-3 h-3" />
                  Most Popular
                </div>
              )}

              <div className="flex items-center gap-2 mb-4">
                <span className={`w-3 h-3 rounded-full ${tier.dotColor}`} />
                <p className={`text-xs font-bold uppercase tracking-widest ${tier.labelColor}`}>{tier.label}</p>
                {isCurrentPlan && (
                  <span className="ml-auto text-[10px] font-bold px-2 py-1 rounded bg-slate-100 text-slate-600">
                    CURRENT
                  </span>
                )}
              </div>

              <h3 className="text-xl font-bold text-slate-900 mb-1 leading-tight">{tier.tagline}</h3>

              <div className="flex items-baseline gap-1.5 mt-5 mb-8">
                <span className="text-5xl font-extrabold text-slate-900">${tier.price}</span>
                <span className="text-slate-400">/mo</span>
              </div>

              <ul className="space-y-3 flex-1 mb-8">
                {tier.features.map((feature, index) => (
                  <li key={index} className="flex items-start gap-3 text-sm text-slate-700">
                    <div
                      className={`w-5 h-5 rounded-full flex items-center justify-center shrink-0 mt-0.5 ${
                        isPopular
                          ? 'bg-blue-600 text-white'
                          : tier.id === 'ENTERPRISE'
                            ? 'bg-violet-100 text-violet-600'
                            : 'bg-emerald-100 text-emerald-600'
                      }`}
                    >
                      <Check className="w-3 h-3" />
                    </div>
                    {feature}
                  </li>
                ))}
              </ul>

              <p className="text-xs text-slate-500 mb-5">
                <span className="font-semibold text-slate-700">Best for:</span> {tier.bestFor}
              </p>

              <button
                onClick={() => handleSubscribe(tier.id)}
                disabled={isLoading || isCurrentPlan}
                className={`w-full py-3.5 font-bold rounded-2xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer ${
                  isPopular
                    ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200'
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
                ) : hasActiveSubscription && currentTier ? (
                  // Has an existing subscription — upgrade / downgrade / switch.
                  TIER_RANK[tier.id] > TIER_RANK[currentTier]
                    ? `Upgrade to ${tier.shortLabel ?? tier.label}`
                    : `Switch to ${tier.shortLabel ?? tier.label}`
                ) : trialUsed ? (
                  // Trial already consumed; this is a paid subscription.
                  `Subscribe to ${tier.shortLabel ?? tier.label}`
                ) : (
                  'Start Free Trial'
                )}
              </button>
            </div>
          );
        })}
      </section>

      {/* Add-ons */}
      <section className="bg-white rounded-3xl border border-slate-200 p-6 sm:p-8">
        <div className="flex items-start gap-5 flex-col sm:flex-row sm:items-center">
          <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center shrink-0">
            <Plus className="w-7 h-7 text-slate-600" />
          </div>
          <div className="flex-1">
            <div className="flex items-baseline gap-3 flex-wrap mb-1">
              <h3 className="text-lg font-bold text-slate-900">Extra Numbers / Locations</h3>
              <span className="text-sm font-bold text-blue-600">
                +${extraNumberPrice != null ? extraNumberPrice.toFixed(0) : '20'} per number
              </span>
            </div>
            <p className="text-sm text-slate-500 leading-relaxed">
              Separate communication per business · Multi-location setup · Team routing{' '}
              <span className="text-slate-400">(coming soon)</span>
            </p>
            <p className="text-xs text-slate-400 mt-1">Your first number is included with Engage and Convert plans.</p>
          </div>
          <button
            onClick={handleBuyExtraNumber}
            className="shrink-0 px-5 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 whitespace-nowrap"
          >
            {!isAuthenticated ? 'Get started' : hasEngageOrConvert ? 'Manage numbers' : 'Upgrade to Engage'}
          </button>
        </div>
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
        </div>
      </section>
    </div>
  );
}
