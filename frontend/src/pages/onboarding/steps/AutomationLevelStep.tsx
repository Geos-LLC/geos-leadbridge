import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Bell, Bot, Check, Clock, MessageSquare, Moon, PhoneCall, RotateCcw, Sparkles, Workflow, Loader2,
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

type LevelId = 'basic' | 'recommended' | 'advanced';

// Defaults for the granular cards. These match what the existing
// automation pages (Followups + Conversation) treat as the recommended
// state — same delay strings, same toggle defaults. Wizard parity matters
// so a user who tweaks here and later visits Settings sees the same
// values, not a wizard-only ghost set.
const DEFAULTS = {
  firstMsgDuringBusinessHours: false,
  callDuringBusinessHours: true,
  followUpsApplyQuietHours: true,
  fuReEnrollOnSilence: true,
  fuReEnrollDelay: '12 hours',
  aiDeferralCheckIn: true,
  aiDeferralDelay: '3 days',
  aiHiredCompetitorReengage: true,
  aiHiredCompetitorDelay: '3 weeks',
  followUpAvailability: 'always' as 'always' | 'active_hours',
};

const RESUME_DELAY_OPTIONS = ['6 hours', '12 hours', '24 hours', '2 days', '3 days', '1 week'];
const DEFERRAL_DELAY_OPTIONS = ['1 day', '2 days', '3 days', '5 days', '1 week', '2 weeks'];
const HIRED_DELAY_OPTIONS = ['1 week', '2 weeks', '3 weeks', '1 month', '2 months', '3 months'];

// Each level pre-fills the bundle keys the existing wizard already used.
// The granular cards (below) start at DEFAULTS — they're additive, not
// overridden by the level. We send the level bundle + the granular fields
// in a single payload to followUpApi.saveWizardSettings.
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

/**
 * Wizard step 6 — Automation level + fine-tune timing & follow-ups.
 *
 * Two sections:
 *   1. Bundle picker (Basic / Recommended / Advanced) — sets the master
 *      switches (AI on/off, follow-up mode, handoff triggers).
 *   2. Fine-tune cards — the granular toggles a user would otherwise have
 *      to discover on the Automation pages later:
 *        - Timing (instant text + call during business hours)
 *        - Quiet hours for follow-ups
 *        - Resume follow-ups after a conversation
 *        - Check in after customer deferral
 *        - Re-engage after customer hired competitor
 *        - AI Auto Reply Availability (24/7 vs outside business hours)
 *
 * Save fans out across every connected SavedAccount: the bundle + granular
 * settings go through `followUpApi.saveWizardSettings`, and the three
 * SavedAccount column toggles (firstMsg / call / quietHours) go through
 * `usersApi.updateAccountHours`. Failures on individual accounts surface
 * as a partial-save toast and the wizard still advances — these settings
 * remain fully editable on the Automation pages.
 */
export default function AutomationLevelStep({ onSaveContinue, saving, setSaving }: Props) {
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const meta = getStepMeta('automation');

  const [level, setLevel] = useState<LevelId>('recommended');
  const [loading, setLoading] = useState(true);

  // Master business-hours window — read-only label so users see what
  // "during business hours" actually means before flipping the toggles.
  const [businessHoursLabel, setBusinessHoursLabel] = useState<string>('Mon–Fri, 9:00 AM – 6:00 PM');

  // Granular settings — initialized to DEFAULTS, hydrated from the first
  // connected account so re-visits don't reset things the user already
  // tweaked on Automation pages.
  const [opts, setOpts] = useState({ ...DEFAULTS });

  const cascadeNote = savedAccounts.length > 1;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const bh = await usersApi.getBusinessHours().catch(() => null);
        if (bh && bh.schedule) {
          // Compact label — show the typical weekday window if the
          // schedule is the standard Mon-Fri 9-6 pattern; otherwise use
          // the first non-null day's hours as a representative example.
          const mf: Array<['mon' | 'tue' | 'wed' | 'thu' | 'fri', { start: string; end: string } | null]> = [
            ['mon', bh.schedule.mon],
            ['tue', bh.schedule.tue],
            ['wed', bh.schedule.wed],
            ['thu', bh.schedule.thu],
            ['fri', bh.schedule.fri],
          ];
          const allSame = mf.every(([, v]) => v && v.start === mf[0][1]?.start && v.end === mf[0][1]?.end);
          if (allSame && mf[0][1]) {
            setBusinessHoursLabel(`Mon–Fri, ${fmtTime(mf[0][1].start)} – ${fmtTime(mf[0][1].end)}`);
          }
        }
        if (savedAccounts.length === 0) return;
        const primary = savedAccounts[0];
        const [settings, hours] = await Promise.all([
          followUpApi.getSettings(primary.id).catch(() => null),
          usersApi.getAccountHours(primary.id).catch(() => null),
        ]);
        if (cancelled) return;
        const s = (settings as any)?.settings ?? {};
        setOpts(prev => ({
          ...prev,
          firstMsgDuringBusinessHours: hours?.firstMsgDuringBusinessHours ?? prev.firstMsgDuringBusinessHours,
          callDuringBusinessHours: hours?.callDuringBusinessHours ?? prev.callDuringBusinessHours,
          followUpsApplyQuietHours: hours?.followUpsApplyQuietHours ?? prev.followUpsApplyQuietHours,
          fuReEnrollOnSilence: s.fuReEnrollOnSilence ?? prev.fuReEnrollOnSilence,
          fuReEnrollDelay: s.fuReEnrollDelay || prev.fuReEnrollDelay,
          aiDeferralCheckIn: s.aiDeferralCheckIn ?? prev.aiDeferralCheckIn,
          aiDeferralDelay: s.aiDeferralDelay || prev.aiDeferralDelay,
          aiHiredCompetitorReengage: s.aiHiredCompetitorReengage ?? prev.aiHiredCompetitorReengage,
          aiHiredCompetitorDelay: s.aiHiredCompetitorDelay || prev.aiHiredCompetitorDelay,
          followUpAvailability: (s.followUpAvailability as any) || prev.followUpAvailability,
        }));
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

  // Combine the level bundle + granular toggles into the payload for
  // followUpApi.saveWizardSettings. Granular fields take precedence — a
  // user who flipped one before saving expects that exact value to land.
  const wizardPayload = useMemo(() => ({
    ...LEVEL_BUNDLES[level],
    fuReEnrollOnSilence: opts.fuReEnrollOnSilence,
    fuReEnrollDelay: opts.fuReEnrollDelay,
    aiDeferralCheckIn: opts.aiDeferralCheckIn,
    aiDeferralDelay: opts.aiDeferralDelay,
    aiHiredCompetitorReengage: opts.aiHiredCompetitorReengage,
    aiHiredCompetitorDelay: opts.aiHiredCompetitorDelay,
    followUpAvailability: opts.followUpAvailability,
  }), [level, opts]);

  async function apply() {
    if (saving) return;
    setSaving(true);
    try {
      if (savedAccounts.length === 0) {
        await onSaveContinue();
        return;
      }
      let firstError: any = null;
      for (const acct of savedAccounts) {
        try {
          await followUpApi.saveWizardSettings(acct.id, wizardPayload);
          await usersApi.updateAccountHours(acct.id, {
            firstMsgDuringBusinessHours: opts.firstMsgDuringBusinessHours,
            callDuringBusinessHours: opts.callDuringBusinessHours,
            followUpsApplyQuietHours: opts.followUpsApplyQuietHours,
          });
        } catch (err) {
          if (!firstError) firstError = err;
        }
      }
      if (firstError) {
        const msg = firstError.response?.data?.message || 'Some accounts did not save — you can re-apply from Automation later.';
        notify.error('Partial save', msg);
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
      {/* Sticky top action row — Save & Continue stays in view through
          the long bundle picker + fine-tune section. */}
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        {cascadeNote && (
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

      {/* ─── Bundle picker ──────────────────────────────────────────────── */}
      <div className="space-y-3">
        {LEVELS.map(L => {
          const active = level === L.id;
          return (
            <button
              key={L.id}
              type="button"
              onClick={() => setLevel(L.id)}
              disabled={saving}
              className={`w-full flex items-start gap-4 p-5 rounded-2xl border-2 text-left transition-all ${
                active ? 'border-blue-600 bg-blue-50/40' : 'border-slate-200 bg-white hover:border-slate-300'
              } disabled:opacity-60 disabled:cursor-not-allowed`}
            >
              <span className={`w-10 h-10 rounded-xl inline-flex items-center justify-center shrink-0 ${
                active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'
              }`}>{L.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-base font-extrabold text-slate-900 tracking-tight">{L.title}</span>
                  {L.recommended && (
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-blue-600 text-white text-[10px] font-bold uppercase tracking-widest">
                      Recommended
                    </span>
                  )}
                </div>
                <p className="text-sm text-slate-500 leading-relaxed mb-3">{L.subtitle}</p>
                <ul className="space-y-1">
                  {L.bullets.map(b => (
                    <li key={b} className="flex items-center gap-2 text-sm text-slate-700">
                      <Check className={`w-3.5 h-3.5 ${active ? 'text-blue-600' : 'text-slate-400'}`} />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>
              <span className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 mt-1 ${
                active ? 'border-blue-600 bg-blue-600 text-white' : 'border-slate-300 bg-white'
              }`} aria-hidden>{active && <Check className="w-3 h-3" />}</span>
            </button>
          );
        })}
      </div>

      {/* ─── Fine-tune section ──────────────────────────────────────────── */}
      <div className="mt-10">
        <div className="mb-4">
          <h2 className="text-lg font-extrabold text-slate-900 tracking-tight">Fine-tune timing &amp; follow-ups</h2>
          <p className="text-sm text-slate-500 mt-1">All of these are editable later on Automation. Defaults shown match the recommended setup.</p>
        </div>

        {loading ? (
          <div className="py-12 text-center text-sm text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin mx-auto" />
          </div>
        ) : (
          <div className="space-y-3">
            {/* Timing — instant text + call gates */}
            <FinetuneCard icon={Clock} title="Timing" subtitle={`Business hours: ${businessHoursLabel}`}>
              <ToggleRow
                label="Only send instant text during business hours"
                checked={opts.firstMsgDuringBusinessHours}
                onChange={v => setOpts(o => ({ ...o, firstMsgDuringBusinessHours: v }))}
              />
              <ToggleRow
                label="Only call during business hours"
                checked={opts.callDuringBusinessHours}
                onChange={v => setOpts(o => ({ ...o, callDuringBusinessHours: v }))}
              />
            </FinetuneCard>

            {/* Quiet hours — follow-up overnight gate */}
            <FinetuneCard icon={Moon} title="Quiet hours" subtitle="Don't send follow-ups overnight.">
              <ToggleRow
                label="Apply quiet hours to follow-ups"
                checked={opts.followUpsApplyQuietHours}
                onChange={v => setOpts(o => ({ ...o, followUpsApplyQuietHours: v }))}
              />
            </FinetuneCard>

            {/* Resume after silence */}
            <FinetuneCard
              icon={RotateCcw}
              title="Resume follow-ups after a conversation"
              subtitle="When a customer replies and then goes silent again, start a new follow-up sequence."
            >
              <ToggleRow
                label="Resume after silence"
                checked={opts.fuReEnrollOnSilence}
                onChange={v => setOpts(o => ({ ...o, fuReEnrollOnSilence: v }))}
              />
              {opts.fuReEnrollOnSilence && (
                <DelayPicker
                  label="Wait before resuming"
                  value={opts.fuReEnrollDelay}
                  options={RESUME_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, fuReEnrollDelay: v }))}
                  hint="How long to wait after your last message before starting follow-ups again."
                />
              )}
            </FinetuneCard>

            {/* Check in after customer deferral */}
            <FinetuneCard
              icon={MessageSquare}
              title="Check in after customer deferral"
              subtitle={"When customer says \"I'll get back to you\" / \"let me think\", schedule one nudge later. Cancels if they reply first."}
            >
              <ToggleRow
                label="Send a check-in"
                checked={opts.aiDeferralCheckIn}
                onChange={v => setOpts(o => ({ ...o, aiDeferralCheckIn: v }))}
              />
              {opts.aiDeferralCheckIn && (
                <DelayPicker
                  label="Send check-in after"
                  value={opts.aiDeferralDelay}
                  options={DEFERRAL_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, aiDeferralDelay: v }))}
                  hint="AI generates this check-in from the conversation using your Conversation Goal."
                />
              )}
            </FinetuneCard>

            {/* Re-engage hired competitor */}
            <FinetuneCard
              icon={PhoneCall}
              title="Re-engage after customer hired competitor"
              subtitle="When customer says they hired someone else, send one polite check-in later. Captures the dissatisfied ones."
            >
              <ToggleRow
                label="Send a re-engage"
                checked={opts.aiHiredCompetitorReengage}
                onChange={v => setOpts(o => ({ ...o, aiHiredCompetitorReengage: v }))}
              />
              {opts.aiHiredCompetitorReengage && (
                <DelayPicker
                  label="Send re-engage after"
                  value={opts.aiHiredCompetitorDelay}
                  options={HIRED_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, aiHiredCompetitorDelay: v }))}
                  hint="AI generates this re-engage from the conversation using your Conversation Goal."
                />
              )}
            </FinetuneCard>

            {/* Auto Reply Availability moved to AI Rules step — it's a
                conversation-level rule about WHEN AI can reply, not a
                timing knob about how follow-ups schedule. The save merge
                here still keeps `followUpAvailability` flowing through so
                a user revisiting the wizard's Automation step doesn't
                wipe what they set on AI Rules. */}
          </div>
        )}
      </div>

      <div className="mt-8 space-y-2">
        {cascadeNote && (
          <p className="text-xs text-slate-400 max-w-md">
            Applies to all connected accounts. You can customize each account later on the Automation page.
          </p>
        )}
        <p className="text-xs text-slate-400 max-w-md">
          <Workflow className="inline w-3.5 h-3.5 mr-1 align-text-bottom" />
          Templates, business-hours windows, and per-card message text stay editable on Templates and Automation.
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────

function FinetuneCard({
  icon: Icon, title, subtitle, children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex items-start gap-3 mb-3">
        <span className="w-9 h-9 rounded-lg inline-flex items-center justify-center bg-slate-100 text-slate-600 shrink-0">
          <Icon className="w-4 h-4" />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-extrabold text-slate-900">{title}</div>
          {subtitle && <p className="text-xs text-slate-500 leading-relaxed mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ToggleRow({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-lg border border-slate-100 bg-slate-50 cursor-pointer">
      <span className="text-sm text-slate-800">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
          checked ? 'bg-blue-600' : 'bg-slate-300'
        }`}
      >
        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-1'}`} />
      </button>
    </label>
  );
}

function DelayPicker({
  label, value, options, onChange, hint,
}: { label: string; value: string; options: string[]; onChange: (v: string) => void; hint?: string }) {
  return (
    <div className="pl-2 pt-1">
      <div className="text-[11px] uppercase tracking-widest text-slate-400 font-bold mb-1">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {options.map(opt => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                active ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
            >
              {opt}
            </button>
          );
        })}
      </div>
      {hint && <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">{hint}</p>}
    </div>
  );
}

// RadioRow moved to AIRulesStep with the Auto Reply Availability card.

// Convert a 24h "HH:MM" string into a friendlier "9:00 AM" label. Used
// only for the read-only business-hours line; the full hours picker
// lives on Settings → Hours.
function fmtTime(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm || '');
  if (!m) return hhmm;
  const h = parseInt(m[1], 10);
  const mins = m[2];
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${mins} ${ampm}`;
}
