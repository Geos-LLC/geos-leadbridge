import { useState, useEffect, useRef } from 'react';
import { ArrowRight, Loader2, Check } from 'lucide-react';
import { onboardingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import { trackEvent, setAnalyticsUserProperties } from '../services/analytics';
import type { OnboardingProfile } from '../types';

const STEP_KEYS: Record<number, string> = {
  0: 'primary_lead_source',
  1: 'secondary_lead_sources',
  2: 'weekly_lead_volume',
  3: 'service_type',
};

const LEAD_SOURCES = [
  { value: 'thumbtack', label: 'Thumbtack' },
  { value: 'yelp', label: 'Yelp' },
  { value: 'google', label: 'Google (LSA / website)' },
  { value: 'facebook', label: 'Facebook / Ads' },
  { value: 'other', label: 'Other' },
];

const VOLUMES = [
  { value: '0-5', label: '0–5 / week' },
  { value: '5-15', label: '5–15 / week' },
  { value: '15-50', label: '15–50 / week' },
  { value: '50+', label: '50+ / week' },
];

const SERVICE_TYPES = [
  { value: 'house_cleaning', label: 'House Cleaning' },
  { value: 'deep_cleaning', label: 'Deep Cleaning' },
  { value: 'move_out_cleaning', label: 'Move-out Cleaning' },
  { value: 'commercial_cleaning', label: 'Commercial Cleaning' },
  { value: 'other', label: 'Other' },
];

type Props = {
  onComplete: (profile: OnboardingProfile) => void;
};

export default function OnboardingStep1Modal({ onComplete }: Props) {
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [saving, setSaving] = useState(false);

  const [primary, setPrimary] = useState<string>('');
  const [secondary, setSecondary] = useState<string[]>([]);
  const [volume, setVolume] = useState<string>('');
  const [service, setService] = useState<string>('');
  const [serviceOther, setServiceOther] = useState<string>('');

  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    startedAtRef.current = Date.now();
    trackEvent('qualification_started', { step_group: 'step1' });
  }, []);

  useEffect(() => {
    trackEvent('qualification_step_viewed', {
      step_group: 'step1',
      question_key: STEP_KEYS[step],
    });
  }, [step]);

  const totalSteps = 4;
  const canGoNext =
    (step === 0 && !!primary) ||
    step === 1 ||
    (step === 2 && !!volume) ||
    (step === 3 && !!service && (service !== 'other' || serviceOther.trim().length > 0));

  const toggleSecondary = (value: string) => {
    setSecondary(prev =>
      prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value],
    );
  };

  const handleNext = () => {
    const questionKey = STEP_KEYS[step];
    const answerValue =
      step === 0 ? primary :
      step === 1 ? secondary :
      step === 2 ? volume :
      service === 'other' ? `other:${serviceOther}` : service;
    trackEvent('qualification_answered', {
      step_group: 'step1',
      question_key: questionKey,
      answer_value: Array.isArray(answerValue) ? answerValue.join(',') : answerValue,
    });
    if (step < 3) {
      setStep((step + 1) as 0 | 1 | 2 | 3);
    } else {
      void handleFinish();
    }
  };

  const handleFinish = async () => {
    try {
      setSaving(true);
      const { profile } = await onboardingApi.saveStep1({
        primaryLeadSource: primary,
        secondaryLeadSources: secondary.filter(s => s !== primary),
        weeklyLeadVolume: volume,
        serviceType: service,
        serviceTypeOther: service === 'other' ? serviceOther.trim() : undefined,
      });
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: profile }, token);
      }
      trackEvent('qualification_completed', {
        step_group: 'step1',
        completion_time_sec: Math.round((Date.now() - startedAtRef.current) / 1000),
      });
      setAnalyticsUserProperties({
        primary_lead_source: profile.primaryLeadSource ?? undefined,
        weekly_lead_volume: profile.weeklyLeadVolume ?? undefined,
        service_type: profile.serviceType ?? undefined,
      });
      notify.success('Setup saved', 'We tailored your onboarding based on your answers.');
      onComplete(profile);
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-8 relative">
        {/* Progress */}
        <div className="flex items-center gap-2 mb-6">
          {Array.from({ length: totalSteps }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full transition-all ${
                i <= step ? 'bg-blue-600' : 'bg-slate-200'
              }`}
            />
          ))}
        </div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600 mb-2">
          Step {step + 1} of {totalSteps} · ~30 seconds
        </p>
        <h2 className="text-2xl font-extrabold text-slate-900 mb-1 tracking-tight">
          Let's set up your account
        </h2>
        <p className="text-sm text-slate-500 mb-6">
          A few quick questions so LeadBridge can tailor itself to your business.
        </p>

        {/* Step 0 — primary source */}
        {step === 0 && (
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-3">
              Where do most of your leads come from?
            </label>
            <div className="space-y-2">
              {LEAD_SOURCES.map(src => (
                <button
                  key={src.value}
                  type="button"
                  onClick={() => setPrimary(src.value)}
                  className={`w-full text-left px-4 py-3 rounded-2xl border-2 font-medium transition-all flex items-center justify-between cursor-pointer ${
                    primary === src.value
                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {src.label}
                  {primary === src.value && <Check className="w-4 h-4 text-blue-600" />}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 1 — secondary sources (optional, multi) */}
        {step === 1 && (
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-1">
              Any other sources? <span className="text-slate-400 font-normal">(optional)</span>
            </label>
            <p className="text-xs text-slate-500 mb-3">Select all that apply.</p>
            <div className="space-y-2">
              {LEAD_SOURCES.filter(s => s.value !== primary).map(src => {
                const active = secondary.includes(src.value);
                return (
                  <button
                    key={src.value}
                    type="button"
                    onClick={() => toggleSecondary(src.value)}
                    className={`w-full text-left px-4 py-3 rounded-2xl border-2 font-medium transition-all flex items-center justify-between cursor-pointer ${
                      active
                        ? 'border-blue-600 bg-blue-50 text-blue-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    {src.label}
                    {active && <Check className="w-4 h-4 text-blue-600" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Step 2 — volume */}
        {step === 2 && (
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-3">
              About how many new leads do you receive per week?
            </label>
            <div className="grid grid-cols-2 gap-2">
              {VOLUMES.map(v => (
                <button
                  key={v.value}
                  type="button"
                  onClick={() => setVolume(v.value)}
                  className={`px-4 py-4 rounded-2xl border-2 font-semibold transition-all cursor-pointer ${
                    volume === v.value
                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Step 3 — service type */}
        {step === 3 && (
          <div>
            <label className="block text-sm font-bold text-slate-900 mb-3">
              What type of service do you offer?
            </label>
            <div className="space-y-2">
              {SERVICE_TYPES.map(s => (
                <button
                  key={s.value}
                  type="button"
                  onClick={() => setService(s.value)}
                  className={`w-full text-left px-4 py-3 rounded-2xl border-2 font-medium transition-all flex items-center justify-between cursor-pointer ${
                    service === s.value
                      ? 'border-blue-600 bg-blue-50 text-blue-900'
                      : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
                  }`}
                >
                  {s.label}
                  {service === s.value && <Check className="w-4 h-4 text-blue-600" />}
                </button>
              ))}
            </div>
            {service === 'other' && (
              <input
                type="text"
                value={serviceOther}
                onChange={e => setServiceOther(e.target.value)}
                placeholder="Describe your service"
                autoFocus
                className="w-full mt-3 px-4 py-3 rounded-2xl border-2 border-slate-200 focus:border-blue-600 focus:outline-none text-slate-900"
              />
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center justify-between mt-8">
          <button
            type="button"
            onClick={() => setStep(Math.max(0, step - 1) as 0 | 1 | 2 | 3)}
            disabled={step === 0 || saving}
            className="text-sm font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
          >
            Back
          </button>
          <button
            type="button"
            onClick={handleNext}
            disabled={!canGoNext || saving}
            className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-2xl text-sm font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Saving…
              </>
            ) : step === totalSteps - 1 ? (
              <>
                Finish Setup
                <Check className="w-4 h-4" />
              </>
            ) : (
              <>
                Continue
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
