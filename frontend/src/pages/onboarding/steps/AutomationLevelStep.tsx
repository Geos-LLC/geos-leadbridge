import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight, Clock, Info, MessageSquare, Moon, PhoneCall, RotateCcw,
  Sparkles, Workflow, Loader2,
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
  callDuringBusinessHours: true,
  followUpsApplyQuietHours: true,
  fuReEnrollOnSilence: true,
  fuReEnrollDelay: '12 hours',
  aiDeferralCheckIn: true,
  aiDeferralDelay: '3 days',
  aiHiredCompetitorReengage: true,
  aiHiredCompetitorDelay: '3 weeks',
  followUpAvailability: 'always' as 'always' | 'active_hours',
  // AI Conversation defaults — same as the old TRIAL_BUNDLE pinned
  // values, now user-editable. Pre-multi-service wizard hardcoded
  // these to `true`; the wizard's "AI Conversation" card now exposes
  // them as toggles so the user can opt out of individual handoff
  // triggers / re-engagement alerts during onboarding instead of
  // hunting for them in Settings → Automation.
  aiConversationEnabled: true,
  reEngagementAlertEnabled: true,
  handoffTriggerAgreed: true,
  handoffTriggerWantsLiveContact: true,
  handoffTriggerProvidedPhone: true,
  handoffTriggerProvidedSquareFootage: true,
  handoffTriggerQualificationComplete: true,
};

const RESUME_DELAY_OPTIONS = ['6 hours', '12 hours', '24 hours', '2 days', '3 days', '1 week'];
const DEFERRAL_DELAY_OPTIONS = ['1 day', '2 days', '3 days', '5 days', '1 week', '2 weeks'];
const HIRED_DELAY_OPTIONS = ['1 week', '2 weeks', '3 weeks', '1 month', '2 months', '3 months'];

// "Everything on" trial bundle baseline. Only `mode` is pinned — the
// rest of the AI Conversation flags are now user-editable via the AI
// Conversation card below, so wizardPayload composes opts on top of
// this. Pre-multi-service refactor (2026-06-18), the handoff triggers
// were hardcoded here; the wizard exposes them so users can opt out
// during onboarding instead of hunting for them later.
const TRIAL_BUNDLE: Record<string, unknown> = {
  mode: 'auto_send',
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
  // Overnight quiet-hours window — also read-only here. Lets users see
  // what "overnight" actually means before flipping the follow-ups
  // overnight toggle. Defaults to the same 9pm–7am window the backend
  // applies when the per-user setting is missing.
  const [quietHoursLabel, setQuietHoursLabel] = useState<string>('9:00 PM – 7:00 AM');

  // Granular settings — initialized to DEFAULTS, hydrated from the first
  // connected account so re-visits don't reset things the user already
  // tweaked on Automation pages.
  const [opts, setOpts] = useState({ ...DEFAULTS });

  const cascadeNote = savedAccounts.length > 1;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [bh, qh] = await Promise.all([
          usersApi.getBusinessHours().catch(() => null),
          usersApi.getQuietHours().catch(() => null),
        ]);
        if (qh && qh.start && qh.end) {
          setQuietHoursLabel(`${fmtTime(qh.start)} – ${fmtTime(qh.end)}`);
        }
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
          callDuringBusinessHours: hours?.callDuringBusinessHours ?? prev.callDuringBusinessHours,
          followUpsApplyQuietHours: hours?.followUpsApplyQuietHours ?? prev.followUpsApplyQuietHours,
          fuReEnrollOnSilence: s.fuReEnrollOnSilence ?? prev.fuReEnrollOnSilence,
          fuReEnrollDelay: s.fuReEnrollDelay || prev.fuReEnrollDelay,
          aiDeferralCheckIn: s.aiDeferralCheckIn ?? prev.aiDeferralCheckIn,
          aiDeferralDelay: s.aiDeferralDelay || prev.aiDeferralDelay,
          aiHiredCompetitorReengage: s.aiHiredCompetitorReengage ?? prev.aiHiredCompetitorReengage,
          aiHiredCompetitorDelay: s.aiHiredCompetitorDelay || prev.aiHiredCompetitorDelay,
          followUpAvailability: (s.followUpAvailability as any) || prev.followUpAvailability,
          // AI Conversation flags — hydrated so re-visits don't reset
          // anything the user already turned off.
          aiConversationEnabled: s.aiConversationEnabled ?? prev.aiConversationEnabled,
          reEngagementAlertEnabled: s.reEngagementAlertEnabled ?? prev.reEngagementAlertEnabled,
          handoffTriggerAgreed: s.handoffTriggerAgreed ?? prev.handoffTriggerAgreed,
          handoffTriggerWantsLiveContact: s.handoffTriggerWantsLiveContact ?? prev.handoffTriggerWantsLiveContact,
          handoffTriggerProvidedPhone: s.handoffTriggerProvidedPhone ?? prev.handoffTriggerProvidedPhone,
          handoffTriggerProvidedSquareFootage: s.handoffTriggerProvidedSquareFootage ?? prev.handoffTriggerProvidedSquareFootage,
          handoffTriggerQualificationComplete: s.handoffTriggerQualificationComplete ?? prev.handoffTriggerQualificationComplete,
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

  // Combine the trial bundle + granular toggles + AI Conversation
  // toggles into the payload for followUpApi.saveWizardSettings.
  // Granular fields take precedence — a user who flipped one before
  // saving expects that exact value to land.
  const wizardPayload = useMemo(() => ({
    ...TRIAL_BUNDLE,
    fuReEnrollOnSilence: opts.fuReEnrollOnSilence,
    fuReEnrollDelay: opts.fuReEnrollDelay,
    aiDeferralCheckIn: opts.aiDeferralCheckIn,
    aiDeferralDelay: opts.aiDeferralDelay,
    aiHiredCompetitorReengage: opts.aiHiredCompetitorReengage,
    aiHiredCompetitorDelay: opts.aiHiredCompetitorDelay,
    followUpAvailability: opts.followUpAvailability,
    aiConversationEnabled: opts.aiConversationEnabled,
    reEngagementAlertEnabled: opts.reEngagementAlertEnabled,
    handoffTriggerAgreed: opts.handoffTriggerAgreed,
    handoffTriggerWantsLiveContact: opts.handoffTriggerWantsLiveContact,
    handoffTriggerProvidedPhone: opts.handoffTriggerProvidedPhone,
    handoffTriggerProvidedSquareFootage: opts.handoffTriggerProvidedSquareFootage,
    handoffTriggerQualificationComplete: opts.handoffTriggerQualificationComplete,
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
          // firstMsgDuringBusinessHours intentionally omitted — the
          // wizard no longer surfaces that toggle, so we don't want to
          // overwrite whatever the account already has saved for it.
          await usersApi.updateAccountHours(acct.id, {
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

      {/* Global-scope banner — these settings cascade to every connected
          account. Per-account behavior tweaks live on
          Settings → Automation after onboarding. */}
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          padding: '10px 12px',
          background: 'rgba(37,99,235,0.06)',
          border: '1px solid rgba(37,99,235,0.18)',
          borderRadius: 12,
          fontSize: 12.5,
          color: 'var(--lb-ink-2, #1f2a44)',
          lineHeight: 1.45,
        }}
      >
        <Info size={14} style={{ color: 'var(--lb-accent)', flexShrink: 0, marginTop: 2 }} />
        <span>
          <strong>These settings apply to all your services and accounts.</strong>{' '}
          You can fine-tune behavior for each connected account later in{' '}
          <strong>Settings → Automation</strong>.
        </span>
      </div>

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
            {/* Timing — call gate + overnight follow-ups quiet-hours
                gate. Two independent toggles sharing one card, each
                covering a different time window: calls obey business
                hours, follow-ups obey the quiet-hours window. The
                instant-text-during-business-hours gate was dropped from
                the wizard (still editable later on Automation) so users
                aren't asked about it during a fast first-run setup. */}
            <SettingCard
              icon={Clock}
              iconTone="blue"
              title="Timing"
              subtitle={`Business hours: ${businessHoursLabel} · Overnight: ${quietHoursLabel}`}
              contentPad="8px 24px 16px"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ToggleRow
                  icon={PhoneCall}
                  iconTone="gray"
                  label="Only call during business hours"
                  on={opts.callDuringBusinessHours}
                  onChange={v => setOpts(o => ({ ...o, callDuringBusinessHours: v }))}
                />
                <ToggleRow
                  icon={Moon}
                  iconTone="gray"
                  label="Don't send follow-ups overnight"
                  on={opts.followUpsApplyQuietHours}
                  onChange={v => setOpts(o => ({ ...o, followUpsApplyQuietHours: v }))}
                />
              </div>
            </SettingCard>

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

            {/* AI Conversation — master switch + handoff triggers +
                re-engagement alerts. Pre 2026-06-18 these were hardcoded
                ON inside TRIAL_BUNDLE; now exposed as toggles so users
                can dial in their handoff sensitivity during onboarding
                rather than after the first surprise SMS lands. */}
            <SettingCard
              icon={Sparkles}
              iconTone="purple"
              title="AI Conversation"
              subtitle="When AI auto-replies to customers and which signals page you to take over."
              enabled={opts.aiConversationEnabled}
              onToggle={v => setOpts(o => ({ ...o, aiConversationEnabled: v }))}
              contentPad="0 24px 16px"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <ToggleRow
                  icon={MessageSquare}
                  iconTone="gray"
                  label="Send me an SMS when a customer replies"
                  on={opts.reEngagementAlertEnabled}
                  onChange={v => setOpts(o => ({ ...o, reEngagementAlertEnabled: v }))}
                />
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--lb-line, #e2e8f0)' }}>
                  <div style={{
                    fontSize: 11,
                    fontWeight: 700,
                    color: 'var(--lb-ink-5, #64748b)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    marginBottom: 6,
                  }}>
                    Hand off to me when the customer…
                  </div>
                  <ToggleRow
                    icon={PhoneCall}
                    iconTone="gray"
                    label="Agrees on price / is ready to book"
                    on={opts.handoffTriggerAgreed}
                    onChange={v => setOpts(o => ({ ...o, handoffTriggerAgreed: v }))}
                  />
                  <ToggleRow
                    icon={PhoneCall}
                    iconTone="gray"
                    label="Asks for a call or wants live contact"
                    on={opts.handoffTriggerWantsLiveContact}
                    onChange={v => setOpts(o => ({ ...o, handoffTriggerWantsLiveContact: v }))}
                  />
                  <ToggleRow
                    icon={PhoneCall}
                    iconTone="gray"
                    label="Provides their phone number"
                    on={opts.handoffTriggerProvidedPhone}
                    onChange={v => setOpts(o => ({ ...o, handoffTriggerProvidedPhone: v }))}
                  />
                  <ToggleRow
                    icon={PhoneCall}
                    iconTone="gray"
                    label="Shares square footage"
                    on={opts.handoffTriggerProvidedSquareFootage}
                    onChange={v => setOpts(o => ({ ...o, handoffTriggerProvidedSquareFootage: v }))}
                  />
                  <ToggleRow
                    icon={PhoneCall}
                    iconTone="gray"
                    label="Completes qualification questions"
                    on={opts.handoffTriggerQualificationComplete}
                    onChange={v => setOpts(o => ({ ...o, handoffTriggerQualificationComplete: v }))}
                  />
                </div>
              </div>
            </SettingCard>
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
