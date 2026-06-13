import { useEffect, useState } from 'react';
import {
  ArrowRight, Bot, CircleDollarSign, Loader2, Phone, Sparkles, UserCheck,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { followUpApi, usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { getStepMeta } from '../wizardConfig';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

/**
 * Wizard step 7 — AI Rules.
 *
 * Post-AI-First-Simplification (June 2026), this step owns the two
 * conversation-level controls that used to live elsewhere:
 *
 *   1. Goal — what the AI is trying to achieve in each conversation.
 *      Auto / Price / Qualify / Phone, matching the Conversation page
 *      picker. Persists to `followUpSettingsJson.followUpStrategy`.
 *
 *   2. Auto Reply Availability — when AI can reply automatically.
 *      Always (24/7) vs Outside business hours. Moved here from the
 *      wizard's Automation step because it's a conversation rule, not
 *      a timing knob. Persists to `followUpSettingsJson.followUpAvailability`.
 *
 * The legacy Stop Rules + Handoff Triggers controls are gone. Per the
 * Conversation page V2 spec, those collapsed into goal completion
 * actions ("Continue AI + Notify" / "Stop AI + Notify") which the user
 * configures on /automation/convert per goal, not at the tenant level.
 */
type GoalKey = 'auto' | 'price' | 'qualify' | 'phone';

interface GoalMeta {
  key: GoalKey;
  title: string;
  body: string;
  icon: LucideIcon;
  iconColor: string;
}

const GOALS: GoalMeta[] = [
  {
    key: 'auto',
    title: 'Auto',
    body: 'AI automatically chooses the best approach for each conversation.',
    icon: Sparkles,
    iconColor: 'text-violet-600',
  },
  {
    key: 'price',
    title: 'Price',
    body: 'Focus on pricing questions and quotes.',
    icon: CircleDollarSign,
    iconColor: 'text-emerald-600',
  },
  {
    key: 'qualify',
    title: 'Qualify',
    body: 'Focus on collecting information and moving toward booking.',
    icon: UserCheck,
    iconColor: 'text-amber-600',
  },
  {
    key: 'phone',
    title: 'Phone',
    body: 'Focus on getting the customer onto a call.',
    icon: Phone,
    iconColor: 'text-rose-600',
  },
];

export default function AIRulesStep({ onSaveContinue, saving, setSaving }: Props) {
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const meta = getStepMeta('ai_rules');

  const [goal, setGoal] = useState<GoalKey>('auto');
  const [availability, setAvailability] = useState<'always' | 'active_hours'>('always');
  const [businessHoursLabel, setBusinessHoursLabel] = useState<string>('Mon–Fri, 9:00 AM – 6:00 PM');
  const [loading, setLoading] = useState(true);

  // Hydrate from the first connected account's saved settings so a
  // returning user sees what they had. Falls back to defaults (auto,
  // always) when nothing is on file or no account is connected.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const bh = await usersApi.getBusinessHours().catch(() => null);
        if (!cancelled && bh?.schedule) {
          const mf = [bh.schedule.mon, bh.schedule.tue, bh.schedule.wed, bh.schedule.thu, bh.schedule.fri];
          const allSame = mf.every(v => v && v.start === mf[0]?.start && v.end === mf[0]?.end);
          if (allSame && mf[0]) {
            setBusinessHoursLabel(`Mon–Fri, ${fmtTime(mf[0].start)} – ${fmtTime(mf[0].end)}`);
          }
        }
        if (savedAccounts.length === 0) return;
        const res = await followUpApi.getSettings(savedAccounts[0].id).catch(() => null);
        if (cancelled) return;
        const s = (res as any)?.settings ?? {};
        const savedGoal = s?.followUpStrategy;
        // Conversation page V2 remaps legacy 'hybrid' → 'auto' and
        // 'convert' → 'qualify' for display; we do the same here.
        const remapped: GoalKey =
          savedGoal === 'price' || savedGoal === 'qualify' || savedGoal === 'phone'
            ? savedGoal
            : savedGoal === 'convert' ? 'qualify'
            : 'auto';
        setGoal(remapped);
        const a = s?.followUpAvailability;
        setAvailability(a === 'active_hours' ? 'active_hours' : 'always');
      } catch {
        /* non-fatal */
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function apply() {
    if (saving) return;
    setSaving(true);
    try {
      if (savedAccounts.length === 0) {
        await onSaveContinue();
        return;
      }
      const payload = {
        followUpStrategy: goal,
        followUpAvailability: availability,
      };
      let firstError: any = null;
      for (const acct of savedAccounts) {
        try {
          await followUpApi.saveWizardSettings(acct.id, payload);
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (firstError) {
        notify.error(
          'Partial save',
          firstError.response?.data?.message || 'Some accounts did not save — you can re-apply from AI Conversation later.',
        );
      }
      await onSaveContinue();
    } catch (err: any) {
      notify.error('Could not save', err.response?.data?.message || 'Please try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving || loading}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        {savedAccounts.length > 1 && (
          <span className="text-[11px] text-slate-500">
            Applies to all connected accounts.
          </span>
        )}
      </WizardStepActions>

      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-6 max-w-xl">
        {meta.description}
      </p>

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : (
        <div className="space-y-6">
          {/* Conversation Goal — 4 cards, Auto first as the recommended default. */}
          <section>
            <div className="mb-3">
              <h2 className="text-base font-extrabold text-slate-900 tracking-tight">Conversation Goal</h2>
              <p className="text-xs text-slate-500 mt-0.5">What AI is trying to achieve in each conversation. You can change this anytime on AI Conversation.</p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {GOALS.map(g => {
                const active = goal === g.key;
                const Icon = g.icon;
                return (
                  <button
                    key={g.key}
                    type="button"
                    onClick={() => setGoal(g.key)}
                    disabled={saving}
                    className={`flex items-start gap-3 p-4 rounded-2xl border-2 text-left transition-all ${
                      active ? 'border-blue-600 bg-blue-50/40' : 'border-slate-200 bg-white hover:border-slate-300'
                    } disabled:opacity-60 disabled:cursor-not-allowed`}
                  >
                    <span className={`w-9 h-9 rounded-xl inline-flex items-center justify-center bg-slate-100 ${g.iconColor} shrink-0`}>
                      <Icon className="w-4 h-4" />
                    </span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-extrabold text-slate-900">{g.title}</div>
                      <p className="text-xs text-slate-500 mt-0.5 leading-relaxed">{g.body}</p>
                    </div>
                    <span
                      aria-hidden
                      className={`w-4 h-4 rounded-full border-2 shrink-0 mt-1 flex items-center justify-center ${
                        active ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
                      }`}
                    >
                      {active && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Auto Reply Availability — moved here from Automation. */}
          <section>
            <div className="flex items-start gap-3 mb-3">
              <span className="w-9 h-9 rounded-xl inline-flex items-center justify-center bg-slate-100 text-slate-600 shrink-0">
                <Bot className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-extrabold text-slate-900 tracking-tight">Auto Reply Availability</h2>
                <p className="text-xs text-slate-500 mt-0.5">Choose when AI can reply automatically.</p>
              </div>
            </div>
            <div className="space-y-2">
              <RadioRow
                label="Always (24/7)"
                description="AI replies to leads at any time, day or night."
                checked={availability === 'always'}
                onSelect={() => setAvailability('always')}
              />
              <RadioRow
                label="Outside of business hours"
                description={`AI replies only outside your business hours window. (${businessHoursLabel})`}
                checked={availability === 'active_hours'}
                onSelect={() => setAvailability('active_hours')}
              />
            </div>
          </section>
        </div>
      )}

      {savedAccounts.length > 1 && (
        <p className="mt-6 text-xs text-slate-400 max-w-md">
          Applies to all connected accounts. You can customize each account later on AI Conversation.
        </p>
      )}
    </div>
  );
}

function RadioRow({
  label, description, checked, onSelect,
}: { label: string; description?: string; checked: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-3 py-3 rounded-lg border-2 transition-colors ${
        checked ? 'border-blue-600 bg-blue-50/40' : 'border-slate-200 bg-white hover:border-slate-300'
      }`}
    >
      <div className="flex items-start gap-3">
        <span className={`w-4 h-4 rounded-full border-2 shrink-0 mt-0.5 flex items-center justify-center ${
          checked ? 'border-blue-600 bg-blue-600' : 'border-slate-300 bg-white'
        }`}>
          {checked && <span className="w-1.5 h-1.5 rounded-full bg-white" />}
        </span>
        <div>
          <div className="text-sm font-semibold text-slate-900">{label}</div>
          {description && <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">{description}</div>}
        </div>
      </div>
    </button>
  );
}

function fmtTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm;
  const h = parseInt(m[1], 10);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${m[2]} ${ampm}`;
}
