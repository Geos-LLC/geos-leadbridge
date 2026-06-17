import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Clock, MessageSquare, Moon, PhoneCall, RotateCcw, Workflow, Loader2,
} from 'lucide-react';
import { useAppStore } from '../../../store/appStore';
import { followUpApi, usersApi } from '../../../services/api';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';
import { SettingCard, FieldRow, ToggleRow } from '../../../components/automation/ui';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

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

// "Everything on" trial bundle. Users start on a trial where the full
// product is available, so we don't make them pick a Basic/Recommended/
// Advanced tier — the wizard just enables the lot and lets users dial it
// back on the Automation page later if they want to. This mirrors what
// the old "advanced" bundle wrote, minus the user-chosen followUpStrategy
// (set on the next wizard step — AI Rules — so we don't pin it here).
const TRIAL_BUNDLE: Record<string, unknown> = {
  mode: 'auto_send',
  aiConversationEnabled: true,
  reEngagementAlertEnabled: true,
  handoffTriggerAgreed: true,
  handoffTriggerWantsLiveContact: true,
  handoffTriggerProvidedPhone: true,
  handoffTriggerProvidedSquareFootage: true,
  handoffTriggerQualificationComplete: true,
};

/**
 * Wizard step 6 — Fine-tune timing & follow-ups.
 *
 * The Basic/Recommended/Advanced plan picker is gone — trial users get
 * the full product enabled by default. This step now only exposes the
 * granular toggles a user would otherwise have to discover on the
 * Automation pages later:
 *
 *   - Timing (instant text + call during business hours)
 *   - Quiet hours for follow-ups
 *   - Resume follow-ups after a conversation
 *   - Check in after customer deferral
 *   - Re-engage after customer hired competitor
 *
 * The card vocabulary (SettingCard / FieldRow / ToggleRow / IconTile) is
 * imported from `components/automation/ui` so the wizard renders with the
 * SAME design system as the main Automation pages — no hand-rolled
 * Tailwind cards, no hardcoded slate-* colors, no toggle size drift.
 *
 * Save fans out across every connected SavedAccount: the TRIAL_BUNDLE
 * master switches + granular settings go through
 * `followUpApi.saveWizardSettings`, and the three SavedAccount column
 * toggles (firstMsg / call / quietHours) go through
 * `usersApi.updateAccountHours`. Failures on individual accounts surface
 * as a partial-save toast and the wizard still advances — these settings
 * remain fully editable on the Automation pages.
 */
export default function AutomationLevelStep({ onSaveContinue, saving, setSaving }: Props) {
  const savedAccounts = useAppStore(s => s.savedAccounts);
  // Title + description live in WizardShell header (2026-06-13 redesign).

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

  // Combine the trial bundle + granular toggles into the payload for
  // followUpApi.saveWizardSettings. Granular fields take precedence — a
  // user who flipped one before saving expects that exact value to land.
  const wizardPayload = useMemo(() => ({
    ...TRIAL_BUNDLE,
    fuReEnrollOnSilence: opts.fuReEnrollOnSilence,
    fuReEnrollDelay: opts.fuReEnrollDelay,
    aiDeferralCheckIn: opts.aiDeferralCheckIn,
    aiDeferralDelay: opts.aiDeferralDelay,
    aiHiredCompetitorReengage: opts.aiHiredCompetitorReengage,
    aiHiredCompetitorDelay: opts.aiHiredCompetitorDelay,
    followUpAvailability: opts.followUpAvailability,
  }), [opts]);

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
    <div style={{ paddingTop: 8 }}>
      {/* Sticky top action row — Save & Continue stays in view through
          the long fine-tune section. Save button uses the same accent
          background as AutoPageHeader's primary action so the wizard
          shares the main Automation page's affordance vocabulary. */}
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '10px 20px', fontSize: 13.5, fontWeight: 700,
            background: 'var(--lb-accent)', color: 'white',
            border: 0, borderRadius: 10,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.6 : 1,
            fontFamily: 'inherit',
            transition: 'background 120ms',
          }}
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : null}
          {saving ? 'Saving…' : 'Save & Continue'}
          {!saving && <ArrowRight size={14} />}
        </button>
        {cascadeNote && (
          <span style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
            Applies to all connected accounts.
          </span>
        )}
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      {/* ─── Fine-tune section ──────────────────────────────────────────── */}
      <div>
        <div style={{ marginBottom: 18 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>
            Timing &amp; follow-ups
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--lb-ink-5)' }}>
            All of these are editable later on Automation. Defaults are tuned for the trial.
          </p>
        </div>

        {loading ? (
          <div style={{
            padding: '48px 0', textAlign: 'center',
            color: 'var(--lb-ink-6, #94a3b8)',
          }}>
            <Loader2 size={20} className="animate-spin" style={{ display: 'inline-block' }} />
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Timing — instant text + call gates. No master toggle: both
                rows are independent gates that share the same business-
                hours window. */}
            <SettingCard
              icon={Clock}
              iconTone="blue"
              title="Timing"
              subtitle={`Business hours: ${businessHoursLabel}`}
              contentPad="8px 24px 16px"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ToggleRow
                  icon={Clock}
                  iconTone="gray"
                  label="Only send instant text during business hours"
                  on={opts.firstMsgDuringBusinessHours}
                  onChange={v => setOpts(o => ({ ...o, firstMsgDuringBusinessHours: v }))}
                />
                <ToggleRow
                  icon={PhoneCall}
                  iconTone="gray"
                  label="Only call during business hours"
                  on={opts.callDuringBusinessHours}
                  onChange={v => setOpts(o => ({ ...o, callDuringBusinessHours: v }))}
                />
              </div>
            </SettingCard>

            {/* Quiet hours — single master toggle gates the overnight rule. */}
            <SettingCard
              icon={Moon}
              iconTone="violet"
              title="Quiet hours"
              subtitle="Don't send follow-ups overnight."
              enabled={opts.followUpsApplyQuietHours}
              onToggle={v => setOpts(o => ({ ...o, followUpsApplyQuietHours: v }))}
            />

            {/* Resume after silence — master toggle + delay picker. */}
            <SettingCard
              icon={RotateCcw}
              iconTone="teal"
              title="Resume follow-ups after a conversation"
              subtitle="When a customer replies and then goes silent again, start a new follow-up sequence."
              enabled={opts.fuReEnrollOnSilence}
              onToggle={v => setOpts(o => ({ ...o, fuReEnrollOnSilence: v }))}
              contentPad="0 24px 16px"
            >
              <FieldRow
                label="Wait before resuming"
                sublabel="How long after your last message before follow-ups start again."
                align="top"
                noBorder
              >
                <PillRow
                  value={opts.fuReEnrollDelay}
                  options={RESUME_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, fuReEnrollDelay: v }))}
                />
              </FieldRow>
            </SettingCard>

            {/* Check in after customer deferral — master toggle + delay picker. */}
            <SettingCard
              icon={MessageSquare}
              iconTone="purple"
              title="Check in after customer deferral"
              subtitle={"When customer says \"I'll get back to you\" / \"let me think\", schedule one nudge later. Cancels if they reply first."}
              enabled={opts.aiDeferralCheckIn}
              onToggle={v => setOpts(o => ({ ...o, aiDeferralCheckIn: v }))}
              contentPad="0 24px 16px"
            >
              <FieldRow
                label="Send check-in after"
                sublabel="AI generates this check-in from the conversation using your Conversation Goal."
                align="top"
                noBorder
              >
                <PillRow
                  value={opts.aiDeferralDelay}
                  options={DEFERRAL_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, aiDeferralDelay: v }))}
                />
              </FieldRow>
            </SettingCard>

            {/* Re-engage hired competitor — master toggle + delay picker. */}
            <SettingCard
              icon={PhoneCall}
              iconTone="orange"
              title="Re-engage after customer hired competitor"
              subtitle="When customer says they hired someone else, send one polite check-in later. Captures the dissatisfied ones."
              enabled={opts.aiHiredCompetitorReengage}
              onToggle={v => setOpts(o => ({ ...o, aiHiredCompetitorReengage: v }))}
              contentPad="0 24px 16px"
            >
              <FieldRow
                label="Send re-engage after"
                sublabel="AI generates this re-engage from the conversation using your Conversation Goal."
                align="top"
                noBorder
              >
                <PillRow
                  value={opts.aiHiredCompetitorDelay}
                  options={HIRED_DELAY_OPTIONS}
                  onChange={v => setOpts(o => ({ ...o, aiHiredCompetitorDelay: v }))}
                />
              </FieldRow>
            </SettingCard>

            {/* Auto Reply Availability moved to AI Rules step — it's a
                conversation-level rule about WHEN AI can reply, not a
                timing knob about how follow-ups schedule. The save merge
                here still keeps `followUpAvailability` flowing through so
                a user revisiting the wizard's Automation step doesn't
                wipe what they set on AI Rules. */}
          </div>
        )}
      </div>

      <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cascadeNote && (
          <p style={{ margin: 0, fontSize: 12, color: 'var(--lb-ink-5)', maxWidth: 440 }}>
            Applies to all connected accounts. You can customize each account later on the Automation page.
          </p>
        )}
        <p style={{ margin: 0, fontSize: 12, color: 'var(--lb-ink-5)', maxWidth: 440 }}>
          <Workflow size={13} style={{ display: 'inline-block', marginRight: 6, verticalAlign: 'text-bottom' }} />
          Templates, business-hours windows, and per-card message text stay editable on Templates and Automation.
        </p>
      </div>
    </div>
  );
}

// ─── Subcomponents ──────────────────────────────────────────────────────

/**
 * Horizontal pill row — used for the delay pickers (6-hour, 12-hour, …).
 * Styled to match the Automation page's segmented affordances: selected
 * pill uses --lb-accent, idle pills use --lb-line border on white. Kept
 * inline because the main pages don't have a 6-option pill picker — the
 * closest equivalent is PlanSwitcher's segmented control, which has its
 * own larger sizing.
 *
 * A trailing "Custom…" pill appears when none of the presets match the
 * current value (or when a user clicks it). It reveals an inline
 * number + unit editor that serializes to the same `${val} ${unit}`
 * shape the backend parseDelay() understands.
 */
type CustomUnit = 'min' | 'hour' | 'day' | 'week' | 'month';
const PILL_CUSTOM_UNITS: { value: CustomUnit; label: string }[] = [
  { value: 'min',   label: 'minutes' },
  { value: 'hour',  label: 'hours' },
  { value: 'day',   label: 'days' },
  { value: 'week',  label: 'weeks' },
  { value: 'month', label: 'months' },
];

function parseCustomDelay(value: string): { val: number; unit: CustomUnit } {
  const d = (value || '').toLowerCase().trim();
  const val = Math.max(1, Math.round(parseFloat(d) || 1));
  if (d.includes('min')) return { val, unit: 'min' };
  if (d.includes('hour') || d.includes('hr')) return { val, unit: 'hour' };
  if (d.includes('day')) return { val, unit: 'day' };
  if (d.includes('week') || d.includes('wk')) return { val, unit: 'week' };
  if (d.includes('month') || d.includes('mo')) return { val, unit: 'month' };
  return { val: 1, unit: 'day' };
}

function PillRow({
  value, options, onChange,
}: { value: string; options: string[]; onChange: (v: string) => void }) {
  const isCustom = !options.includes(value);
  const custom = parseCustomDelay(value);
  const customLabel = (() => {
    const u = PILL_CUSTOM_UNITS.find(x => x.value === custom.unit)?.label ?? 'days';
    return `${custom.val} ${u}`;
  })();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {options.map(opt => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                padding: '7px 14px',
                fontSize: 12.5, fontWeight: 600,
                background: active ? 'var(--lb-accent)' : 'white',
                color: active ? 'white' : 'var(--lb-ink-3)',
                border: '1px solid ' + (active ? 'var(--lb-accent)' : 'var(--lb-line)'),
                borderRadius: 8,
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'background 120ms, border-color 120ms, color 120ms',
              }}
            >
              {opt}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => onChange(`${custom.val} ${custom.unit}`)}
          style={{
            padding: '7px 14px',
            fontSize: 12.5, fontWeight: 600,
            background: isCustom ? 'var(--lb-accent)' : 'white',
            color: isCustom ? 'white' : 'var(--lb-ink-3)',
            border: '1px solid ' + (isCustom ? 'var(--lb-accent)' : 'var(--lb-line)'),
            borderRadius: 8,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 120ms, border-color 120ms, color 120ms',
          }}
        >
          {isCustom ? customLabel : 'Custom…'}
        </button>
      </div>
      {isCustom && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            value={custom.val}
            onChange={e => {
              const n = parseInt(e.target.value, 10);
              const safe = Math.max(1, Number.isFinite(n) ? n : 1);
              onChange(`${safe} ${custom.unit}`);
            }}
            style={{
              width: 72, padding: '7px 10px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              background: 'white', color: 'var(--lb-ink-1)',
              outline: 'none',
            }}
          />
          <select
            value={custom.unit}
            onChange={e => onChange(`${custom.val} ${e.target.value as CustomUnit}`)}
            style={{
              padding: '7px 28px 7px 10px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 12.5, fontWeight: 500, fontFamily: 'inherit',
              background: 'white', color: 'var(--lb-ink-1)',
              appearance: 'none', cursor: 'pointer', outline: 'none',
            }}
          >
            {PILL_CUSTOM_UNITS.map(u => (
              <option key={u.value} value={u.value}>{u.label}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

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
