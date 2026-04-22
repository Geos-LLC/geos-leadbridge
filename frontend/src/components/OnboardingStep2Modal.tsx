import { useState, useEffect, useRef } from 'react';
import { Loader2, Check, X } from 'lucide-react';
import { onboardingApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import { trackEvent, setAnalyticsUserProperties } from '../services/analytics';
import type { OnboardingProfile } from '../types';

const STEP_KEYS: Record<number, string> = {
  0: 'response_speed',
  1: 'missed_lead_outcome',
  2: 'avg_job_value',
  3: 'user_goal',
};

const RESPONSE_SPEED = [
  { value: '5min', label: 'Within 5 minutes' },
  { value: '30min', label: 'Within 30 minutes' },
  { value: 'few_hours', label: 'Within a few hours' },
  { value: 'later', label: 'Later / sometimes miss them' },
];

const MISSED_OUTCOME = [
  { value: 'hire_someone_else', label: 'Customer hires someone else' },
  { value: 'stop_replying', label: 'They stop replying' },
  { value: 'follow_up_later', label: 'I follow up later' },
  { value: 'not_sure', label: 'Not sure' },
];

const JOB_VALUE = [
  { value: 'under_100', label: 'Under $100' },
  { value: '100_200', label: '$100–$200' },
  { value: '200_500', label: '$200–$500' },
  { value: '500_plus', label: '$500+' },
];

const GOALS = [
  { value: 'respond_instantly', label: 'Respond instantly' },
  { value: 'book_more', label: 'Book more jobs' },
  { value: 'automate_follow_ups', label: 'Automate follow-ups' },
  { value: 'notifications_only', label: 'Just get notifications' },
];

type Props = {
  onComplete: (profile: OnboardingProfile | null) => void;
};

export default function OnboardingStep2Modal({ onComplete }: Props) {
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const [step, setStep] = useState<0 | 1 | 2 | 3>(0);
  const [saving, setSaving] = useState(false);

  const [responseSpeed, setResponseSpeed] = useState<string>('');
  const [missedOutcome, setMissedOutcome] = useState<string>('');
  const [jobValue, setJobValue] = useState<string>('');
  const [goal, setGoal] = useState<string>('');

  const startedAtRef = useRef<number>(Date.now());

  useEffect(() => {
    startedAtRef.current = Date.now();
    trackEvent('qualification_started', { step_group: 'step2' });
  }, []);

  useEffect(() => {
    trackEvent('qualification_step_viewed', {
      step_group: 'step2',
      question_key: STEP_KEYS[step],
    });
  }, [step]);

  const totalSteps = 4;
  const currentValue =
    step === 0 ? responseSpeed : step === 1 ? missedOutcome : step === 2 ? jobValue : goal;

  const updateCurrent = (value: string) => {
    if (step === 0) setResponseSpeed(value);
    else if (step === 1) setMissedOutcome(value);
    else if (step === 2) setJobValue(value);
    else setGoal(value);
  };

  const questions = [
    {
      label: 'How fast do you usually respond to new leads?',
      options: RESPONSE_SPEED,
    },
    {
      label: "What usually happens if you don't respond quickly?",
      options: MISSED_OUTCOME,
    },
    {
      label: "What's your average job value?",
      options: JOB_VALUE,
    },
    {
      label: 'What is your main goal with LeadBridge?',
      options: GOALS,
    },
  ];

  // Auto-advance on single-select click. On the last step, finish immediately
  // with the explicit value so we don't race React's state commit.
  const pickAnswer = (value: string) => {
    updateCurrent(value);
    trackEvent('qualification_answered', {
      step_group: 'step2',
      question_key: STEP_KEYS[step],
      answer_value: value,
    });
    if (step < totalSteps - 1) {
      setStep((step + 1) as 0 | 1 | 2 | 3);
    } else {
      void handleFinish({ goal: value });
    }
  };

  const handleFinish = async (override?: { goal?: string }) => {
    try {
      setSaving(true);
      const { profile } = await onboardingApi.saveStep2({
        responseSpeed: responseSpeed || undefined,
        missedLeadOutcome: missedOutcome || undefined,
        avgJobValue: jobValue || undefined,
        userGoal: override?.goal ?? goal ?? undefined,
      });
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: profile }, token);
      }
      trackEvent('qualification_completed', {
        step_group: 'step2',
        completion_time_sec: Math.round((Date.now() - startedAtRef.current) / 1000),
      });
      setAnalyticsUserProperties({
        response_speed: profile.responseSpeed ?? undefined,
        avg_job_value: profile.avgJobValue ?? undefined,
        user_goal: profile.userGoal ?? undefined,
      });
      notify.success('Thanks!', 'Your automation is tuned to your business.');
      onComplete(profile);
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const handleSkip = async () => {
    try {
      setSaving(true);
      const { profile } = await onboardingApi.skipStep2();
      if (user) {
        const token = localStorage.getItem('token') || '';
        setAuth({ ...user, onboardingProfile: profile }, token);
      }
      trackEvent('qualification_skipped', { step_group: 'step2' });
      onComplete(profile);
    } catch (err: any) {
      notify.error('Could not skip', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const q = questions[step];

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
      <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg p-8 relative">
        <button
          type="button"
          onClick={handleSkip}
          disabled={saving}
          aria-label="Skip"
          className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>

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
        <p className="text-xs font-bold uppercase tracking-widest text-blue-600 mb-6">
          Step {step + 1} of {totalSteps}
        </p>

        <label className="block text-sm font-bold text-slate-900 mb-3">{q.label}</label>
        <div className="space-y-2">
          {q.options.map(opt => (
            <button
              key={opt.value}
              type="button"
              onClick={() => pickAnswer(opt.value)}
              className={`w-full text-left px-4 py-3 rounded-2xl border-2 font-medium transition-all flex items-center justify-between cursor-pointer ${
                currentValue === opt.value
                  ? 'border-blue-600 bg-blue-50 text-blue-900'
                  : 'border-slate-200 bg-white text-slate-700 hover:border-slate-300'
              }`}
            >
              {opt.label}
              {currentValue === opt.value && <Check className="w-4 h-4 text-blue-600" />}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between mt-8 min-h-[48px]">
          <div className="flex items-center gap-4">
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
              onClick={handleSkip}
              disabled={saving}
              className="text-sm font-semibold text-slate-400 hover:text-slate-600 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              Skip all
            </button>
          </div>
          {saving ? (
            <span className="inline-flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-2xl text-sm font-bold shadow-lg shadow-blue-200">
              <Loader2 className="w-4 h-4 animate-spin" />
              Saving…
            </span>
          ) : (
            <span className="text-xs text-slate-400">Tap an option to continue</span>
          )}
        </div>
      </div>
    </div>
  );
}
