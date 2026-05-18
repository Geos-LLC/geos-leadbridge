import { useState } from 'react';
import { Bell, Bot, Check, Loader2, Sparkles, Workflow } from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { followUpApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { getStepMeta } from '../wizardConfig';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

type LevelId = 'basic' | 'recommended' | 'advanced';

// Each automation level expands to a partial followUpSettingsJson +
// SavedAccount-column write. The backend's POST /v1/follow-ups/settings
// merges these into the existing JSON, so we only send the keys this
// bundle is opinionated about — anything the user customized later on
// the Automation page stays untouched.
//
// Bundle semantics (per the spec):
//   Basic        — instant reply + alerts. AI conversation off,
//                  follow-ups off, owner gets new-lead pings and
//                  re-engagement pings only.
//   Recommended  — adds follow-up suggestions + AI replying when a
//                  customer messages back. Default selection.
//   Advanced     — adds auto-sent follow-ups + the full handoff trigger
//                  set so the team gets pinged when the AI detects a
//                  hot lead.
//
// We deliberately don't touch templates, prompts, or quiet-hours here —
// those still live on Templates / Settings per the page-ownership rule.
const LEVEL_BUNDLES: Record<LevelId, Record<string, unknown>> = {
  basic: {
    mode: 'off',
    aiConversationEnabled: false,
    reEngagementAlertEnabled: true,
  },
  recommended: {
    mode: 'suggest',
    aiConversationEnabled: true,
    reEngagementAlertEnabled: true,
    followUpStrategy: 'hybrid',
  },
  advanced: {
    mode: 'auto_send',
    aiConversationEnabled: true,
    reEngagementAlertEnabled: true,
    followUpStrategy: 'hybrid',
    handoffTriggerAgreed: true,
    handoffTriggerWantsLiveContact: true,
    handoffTriggerProvidedPhone: true,
    handoffTriggerProvidedSquareFootage: true,
    handoffTriggerQualificationComplete: true,
  },
};

const LEVELS: { id: LevelId; title: string; subtitle: string; bullets: string[]; icon: React.ReactNode; recommended?: boolean }[] = [
  {
    id: 'basic',
    title: 'Basic',
    subtitle: 'Reply to new leads, get a heads-up when something comes in.',
    bullets: ['Instant reply', 'Alerts & notifications'],
    icon: <Bell className="w-5 h-5" />,
  },
  {
    id: 'recommended',
    title: 'Recommended',
    subtitle: "We'll keep the conversation going for you and nudge silent leads.",
    bullets: ['Instant reply', 'Follow-ups', 'Text messages', 'Alerts & notifications'],
    icon: <Sparkles className="w-5 h-5" />,
    recommended: true,
  },
  {
    id: 'advanced',
    title: 'Advanced AI',
    subtitle: 'Hand the lead off to your team the moment they show real intent.',
    bullets: ['Everything in Recommended', 'AI Conversation', 'Handoff to your team', 'Recovery flows'],
    icon: <Bot className="w-5 h-5" />,
  },
];

// Step 6 — Choose Automation Level. The user picks one of three
// preset bundles; we write the corresponding partial settings to every
// connected account. No cascade endpoint exists for follow-up settings
// (unlike pricing/FAQ), so we loop per account sequentially.
export default function AutomationLevelStep({ onSaveContinue, saving, setSaving }: Props) {
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const meta = getStepMeta('automation');
  const [selected, setSelected] = useState<LevelId>('recommended');
  const cascadeNote = savedAccounts.length > 1;

  async function apply() {
    if (saving) return;
    const bundle = LEVEL_BUNDLES[selected];
    setSaving(true);
    try {
      if (savedAccounts.length === 0) {
        // No accounts — nothing to write. Treat as done so the user
        // can return after connecting an account. The Overview card
        // keeps surfacing setup until accounts exist.
        await onSaveContinue();
        return;
      }
      // Sequential rather than Promise.all so a single failure surfaces
      // a clear partial-failure message instead of one cryptic error.
      let firstError: any = null;
      for (const acct of savedAccounts) {
        try {
          await followUpApi.saveWizardSettings(acct.id, bundle);
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (firstError) {
        const msg = firstError.response?.data?.message || 'Some accounts did not save — you can re-apply from the Automation page.';
        notify.error('Partial save', msg);
        // Still advance — the user can finish from the Automation page
        // and the level bundle is non-destructive.
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
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-6 max-w-xl">
        {meta.description}
      </p>

      <div className="space-y-3">
        {LEVELS.map(level => {
          const active = selected === level.id;
          return (
            <button
              key={level.id}
              type="button"
              onClick={() => setSelected(level.id)}
              disabled={saving}
              className={`w-full flex items-start gap-4 p-5 rounded-2xl border-2 text-left transition-all ${
                active
                  ? 'border-blue-600 bg-blue-50/40'
                  : 'border-slate-200 bg-white hover:border-slate-300'
              } disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              <span
                className={`w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
                  active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
                }`}
              >
                {level.icon}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base font-extrabold text-slate-900 tracking-tight">{level.title}</span>
                  {level.recommended && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-500 leading-relaxed mb-3">{level.subtitle}</p>
                <ul className="space-y-1">
                  {level.bullets.map(b => (
                    <li key={b} className="flex items-center gap-2 text-sm text-slate-700">
                      <Check className={`w-3.5 h-3.5 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
              <span
                className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-1 ${
                  active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'
                }`}
                aria-hidden
              >
                {active && <Check className="w-3 h-3" />}
              </span>
            </button>
          );
        })}
      </div>

      <div className="mt-8 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          className="self-start inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
        {cascadeNote && (
          <p className="text-xs text-slate-400 max-w-md">
            Applies to all connected accounts. You can customize each account later on the Automation page.
          </p>
        )}
        <p className="text-xs text-slate-400 max-w-md">
          <Workflow className="inline w-3.5 h-3.5 mr-1 align-text-bottom" />
          Templates, response timing, and per-card details stay editable on Templates and Automation.
        </p>
      </div>
    </div>
  );
}
