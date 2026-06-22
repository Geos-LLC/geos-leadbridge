import { useEffect, useState } from 'react';
import {
  Bot, CircleDollarSign, Eye, Loader2, MoonStar, Phone, Sparkles, UserCheck, Zap,
  type LucideIcon,
} from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { followUpApi, usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

/**
 * Wizard step 7 — AI Rules.
 *
 * Two conversation-level controls, all account-wide and applied to
 * every connected SavedAccount on save:
 *
 *   1. Conversation Goal — what AI tries to achieve.
 *      auto / price / qualify / phone. Persists `followUpStrategy`.
 *
 *   2. AI Response Mode — when AI is allowed to respond automatically.
 *      Three options that fold the old "Auto Reply Availability" radio
 *      together with V2 Review Mode:
 *        Review before sending → aiConversationDeliveryMode='suggest'
 *          AI drafts replies, parks them on ThreadContext; operator
 *          approves from Lead Activity. Nothing sends automatically.
 *        Assist when unavailable → deliveryMode='auto_send' +
 *          followUpAvailability='active_hours' (sends only outside
 *          business hours).
 *        Full autopilot → deliveryMode='auto_send' +
 *          followUpAvailability='always' (sends any time).
 *
 * Goal-completion behavior is no longer user-configurable: AI always
 * stops on goal completion and hands off to the team (2026-06-18
 * simplification).
 */
type GoalKey = 'auto' | 'price' | 'qualify' | 'phone';
type ResponseMode = 'review' | 'assist' | 'autopilot';

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
  // Title + description live in WizardShell header (2026-06-13 redesign).

  const [goal, setGoal] = useState<GoalKey>('auto');
  const [responseMode, setResponseMode] = useState<ResponseMode>('autopilot');
  const [businessHoursLabel, setBusinessHoursLabel] = useState<string>('Mon–Fri, 9:00 AM – 6:00 PM');
  const [loading, setLoading] = useState(true);

  // Hydrate from the first connected account's saved settings so a
  // returning user sees what they had. Defaults: auto goal, autopilot
  // response mode. When nothing is on file (fresh tenant), the defaults
  // match what the trial bundle sets up on the Automation step.
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

        // Conversation Goal. Conversation page V2 remaps legacy
        // 'hybrid' → 'auto' and 'convert' → 'qualify' for display; we
        // do the same here.
        const savedGoal = s?.followUpStrategy;
        const remapped: GoalKey =
          savedGoal === 'price' || savedGoal === 'qualify' || savedGoal === 'phone'
            ? savedGoal
            : savedGoal === 'convert' ? 'qualify'
            : 'auto';
        setGoal(remapped);

        // AI Response Mode. Default to 'auto_send' when missing so
        // pre-V2 tenants stay autopilot — only explicit 'suggest'
        // parks replies. Mapping mirrors Conversation.tsx:290.
        const delivery = s?.aiConversationDeliveryMode === 'suggest' ? 'suggest' : 'auto_send';
        const availability = s?.followUpAvailability === 'active_hours' ? 'active_hours' : 'always';
        if (delivery === 'suggest') {
          setResponseMode('review');
        } else if (availability === 'active_hours') {
          setResponseMode('assist');
        } else {
          setResponseMode('autopilot');
        }

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
      // Map the three UI radios back to the canonical fields the
      // backend reads. Keep the shape identical to what
      // Conversation.tsx writes so a user round-tripping between the
      // two surfaces sees the same selection.
      const deliveryMode = responseMode === 'review' ? 'suggest' : 'auto_send';
      const availability = responseMode === 'assist' ? 'active_hours' : 'always';

      const payload = {
        followUpStrategy: goal,
        aiConversationDeliveryMode: deliveryMode,
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
          style={{
            padding: '10px 22px', borderRadius: 10,
            border: 0, background: 'var(--lb-accent)', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: (saving || loading) ? 'not-allowed' : 'pointer',
            opacity: (saving || loading) ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      {loading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : (
        <div className="space-y-8">
          {/* ─── 1. Conversation Goal ─────────────────────────────── */}
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

          {/* ─── 2. AI Response Mode ──────────────────────────────── */}
          <section>
            <div className="flex items-start gap-3 mb-3">
              <span className="w-9 h-9 rounded-xl inline-flex items-center justify-center bg-slate-100 text-violet-600 shrink-0">
                <Bot className="w-4 h-4" />
              </span>
              <div className="flex-1 min-w-0">
                <h2 className="text-base font-extrabold text-slate-900 tracking-tight">AI Response Mode</h2>
                <p className="text-xs text-slate-500 mt-0.5">When AI is allowed to respond to customer messages automatically.</p>
              </div>
            </div>
            <div className="space-y-2">
              <RadioRow
                icon={Eye}
                label="Review before sending"
                description="AI drafts replies and parks them for your approval. Nothing sends until you tap Send."
                checked={responseMode === 'review'}
                onSelect={() => setResponseMode('review')}
              />
              <RadioRow
                icon={MoonStar}
                label="Assist when unavailable"
                description={`AI responds automatically outside your business hours window. (${businessHoursLabel})`}
                checked={responseMode === 'assist'}
                onSelect={() => setResponseMode('assist')}
              />
              <RadioRow
                icon={Zap}
                label="Full autopilot"
                description="AI replies to leads at any time, day or night."
                checked={responseMode === 'autopilot'}
                onSelect={() => setResponseMode('autopilot')}
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
  icon: Icon, label, description, checked, onSelect,
}: {
  icon?: LucideIcon;
  label: string;
  description?: string;
  checked: boolean;
  onSelect: () => void;
}) {
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
        {Icon && (
          <span className="w-4 h-4 shrink-0 mt-0.5 text-slate-500">
            <Icon className="w-4 h-4" />
          </span>
        )}
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
