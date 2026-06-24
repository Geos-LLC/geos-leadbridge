import { useEffect, useMemo, useState, type CSSProperties, type ComponentType } from 'react';
import {
  CalendarCheck, ChevronDown, ChevronRight, CircleDollarSign, Clock,
  Info, MessageCircle, MessageSquare, MessageSquareText, Phone,
  PhoneCall, Plus, RotateCcw, Sparkles, UserCheck, Workflow, Loader2, X,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import {
  automationApi, callConnectApi, followUpApi, notificationsApi, usersApi,
} from '../../../services/api';
import type { AutomationRule, NotificationRule } from '../../../types';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';
// Card vocabulary (SettingCard / FieldRow / ToggleRow) was used for the
// pre-2026-06-22 Follow-ups & AI section; canonical now uses custom
// inline FollowupCard / ConversationGoalCard / AiResponseModeCard below.
import { InfoDot, InfoTip } from '../../../components/InfoPopover';
import { FirstReplyCard, ModePill, Toggle, Checkbox } from '../../../components/automation/wizard-cards';

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
type ConversationGoal = 'auto' | 'price' | 'qualify' | 'booking' | 'phone';
type AiResponseMode = 'suggest' | 'assist' | 'autopilot';

type QualifyField = 'bedrooms' | 'bathrooms' | 'sqft' | 'frequency' | 'zip' | 'phone';
const QUALIFY_FIELD_DEFS: Array<{ key: QualifyField; label: string }> = [
  { key: 'bedrooms',  label: 'Bedrooms' },
  { key: 'bathrooms', label: 'Bathrooms' },
  { key: 'sqft',      label: 'Square Footage' },
  { key: 'frequency', label: 'Frequency' },
  { key: 'zip',       label: 'Zip Code' },
  { key: 'phone',     label: 'Phone Number' },
];

type BookingDay = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const BOOKING_DAYS: Array<{ key: BookingDay; label: string }> = [
  { key: 'mon', label: 'MON' },
  { key: 'tue', label: 'TUE' },
  { key: 'wed', label: 'WED' },
  { key: 'thu', label: 'THU' },
  { key: 'fri', label: 'FRI' },
  { key: 'sat', label: 'SAT' },
  { key: 'sun', label: 'SUN' },
];
type BookingWindows = Record<BookingDay, { morning: boolean; afternoon: boolean }>;
const DEFAULT_BOOKING_WINDOWS: BookingWindows = {
  mon: { morning: true,  afternoon: true  },
  tue: { morning: true,  afternoon: true  },
  wed: { morning: true,  afternoon: true  },
  thu: { morning: true,  afternoon: true  },
  fri: { morning: true,  afternoon: true  },
  sat: { morning: false, afternoon: false },
  sun: { morning: false, afternoon: false },
};

type PriceMode = 'range' | 'exact';

const DEFAULTS = {
  instantReplyDuringBusinessHours: true,
  firstMsgDuringBusinessHours: true,
  callDuringBusinessHours: true,
  followUpsApplyQuietHours: true,
  fuReEnrollOnSilence: true,
  fuReEnrollDelay: '12 hours',
  aiDeferralCheckIn: true,
  aiDeferralDelay: '3 days',
  aiHiredCompetitorReengage: true,
  aiHiredCompetitorDelay: '3 weeks',
  followUpAvailability: 'always' as 'always' | 'active_hours',
  // AI Conversation defaults — mirror Settings → Automation → AI
  // Conversation. The wizard exposes a small subset (Goal +
  // Response Mode); AI always hands off on goal completion.
  conversationGoal: 'auto' as ConversationGoal,
  aiResponseMode: 'autopilot' as AiResponseMode,
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
  // 2d — write the 3 default-ON keys the wizard doesn't otherwise
  // expose so a brand-new SavedAccount has them explicit on first
  // save. After 2c, the runtime treats absent keys as `false`, so
  // omitting them here would silently leave the opt-out / booked /
  // re-engagement features OFF for fresh tenants. (aiDeferralCheckIn
  // and aiHiredCompetitorReengage are written below from the
  // user-editable opts, so they're already explicit.)
  aiStopOnOptOut: true,
  aiStopOnBooked: true,
  reEngagementAlertEnabled: true,
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

  // First-reply state — the wizard exposes only the three master
  // toggles (Instant Reply / Instant Text / Instant Call). AI vs
  // Template message generation, Connection Mode, and per-account
  // business-hours flags live on Settings → Automation. Hydrated
  // from the primary SavedAccount; save() never touches the
  // companion fields so existing values are preserved.
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [instantTextOn, setInstantTextOn] = useState(true);
  const [instantCallOn, setInstantCallOn] = useState(true);
  // Message-generation expand state for Instant Reply (AI vs Template).
  const [respAdvOpen, setRespAdvOpen] = useState(false);
  // AI vs Template for Instant Reply — maps to `useAi` on the new_lead
  // automation rule. Default to AI to match the existing Respond.tsx
  // defaults so a fresh account behaves the same after wizard save.
  const [replyUseAi, setReplyUseAi] = useState(true);

  // Strategy-specific configuration. These are wizard-local visual
  // affordances that match the canonical "Wizard Automation (standalone)"
  // expand panels. Backend wiring for fine-grained qualify fields /
  // booking windows / price mode lives on Settings → Automation;
  // saving here cascades them through wizardPayload so they round-trip.
  const [qualifyFields, setQualifyFields] = useState<Set<QualifyField>>(
    () => new Set<QualifyField>(QUALIFY_FIELD_DEFS.map(f => f.key)),
  );
  const [customQualifyFields, setCustomQualifyFields] = useState<Array<{ label: string; checked: boolean }>>([]);
  const [bookingWindows, setBookingWindows] = useState<BookingWindows>(DEFAULT_BOOKING_WINDOWS);
  const [priceMode, setPriceMode] = useState<PriceMode>('range');

  const navigate = useNavigate();

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
        const [settings, hours, autoRes, notifRes, callRes] = await Promise.all([
          followUpApi.getSettings(primary.id).catch(() => null),
          usersApi.getAccountHours(primary.id).catch(() => null),
          automationApi.getRulesForAccount(primary.id).catch(() => ({ rules: [] as AutomationRule[] })),
          notificationsApi.getRules(primary.id).catch(() => ({ rules: [] as NotificationRule[] })),
          callConnectApi.getSettings(primary.id).catch(() => ({ settings: null })),
        ]);
        if (cancelled) return;
        const s = (settings as any)?.settings ?? {};

        // First-reply hydration — only the three master switches. AI
        // mode + Connection Mode + textMode live on Settings.
        const newLeadRule = (autoRes.rules || []).find(
          r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0),
        );
        const customerTextRule = (notifRes.rules || []).find(
          r => r.triggerType === 'new_lead' && r.sendToCustomer,
        );
        const callSettings: any = (callRes as any)?.settings ?? null;
        if (newLeadRule) {
          setInstantReplyOn(!!newLeadRule.enabled);
          setReplyUseAi((newLeadRule as any).useAi !== false);
        }
        if (customerTextRule) setInstantTextOn(!!customerTextRule.enabled);
        if (callSettings) setInstantCallOn(callSettings.enabled !== false);
        setOpts(prev => ({
          ...prev,
          instantReplyDuringBusinessHours: hours?.instantReplyDuringBusinessHours ?? prev.instantReplyDuringBusinessHours,
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
          // AI Conversation — derive the two wizard controls from
          // the raw backend fields (followUpStrategy /
          // aiConversationDeliveryMode / followUpAvailability).
          // Mirrors the parseSettings logic in Settings → Automation
          // → Conversation.
          conversationGoal: deriveConversationGoal(s.followUpStrategy),
          aiResponseMode: deriveAiResponseMode(
            s.aiConversationDeliveryMode,
            s.followUpAvailability,
          ),
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

  // AI Response Mode → split into the two backend fields. Mirrors the
  // mapping Settings → Automation → Conversation uses:
  //   review   → deliveryMode='suggest'   (availability irrelevant)
  //   assist   → deliveryMode='auto_send' + availability='active_hours'
  //   autopilot → deliveryMode='auto_send' + availability='always'
  const responseModeBackend = useMemo(() => {
    if (opts.aiResponseMode === 'suggest') {
      return { aiConversationDeliveryMode: 'suggest' as const, followUpAvailability: opts.followUpAvailability };
    }
    if (opts.aiResponseMode === 'assist') {
      return { aiConversationDeliveryMode: 'auto_send' as const, followUpAvailability: 'active_hours' as const };
    }
    return { aiConversationDeliveryMode: 'auto_send' as const, followUpAvailability: 'always' as const };
  }, [opts.aiResponseMode, opts.followUpAvailability]);

  // Combine the trial bundle + granular toggles + AI Conversation
  // controls into the payload for followUpApi.saveWizardSettings.
  // The AI Conversation slice writes:
  //   - followUpStrategy (Conversation Goal)
  //   - aiConversationDeliveryMode + followUpAvailability (Response Mode)
  const wizardPayload = useMemo(() => ({
    ...TRIAL_BUNDLE,
    fuReEnrollOnSilence: opts.fuReEnrollOnSilence,
    fuReEnrollDelay: opts.fuReEnrollDelay,
    aiDeferralCheckIn: opts.aiDeferralCheckIn,
    aiDeferralDelay: opts.aiDeferralDelay,
    aiHiredCompetitorReengage: opts.aiHiredCompetitorReengage,
    aiHiredCompetitorDelay: opts.aiHiredCompetitorDelay,
    followUpStrategy: opts.conversationGoal,
    aiConversationDeliveryMode: responseModeBackend.aiConversationDeliveryMode,
    followUpAvailability: responseModeBackend.followUpAvailability,
  }), [opts, responseModeBackend]);

  // Per-account save fan-out — mirrors the rule-update logic in
  // Settings → Automation → Respond. Each account independently
  // gets its automation rule (Instant Reply), notification rule
  // (Instant Text), and call-connect settings (Instant Call) patched.
  // When a rule doesn't exist on a given account we seed one with
  // sensible defaults (Instant Reply only — Instant Text + Call rules
  // are auto-created server-side when the account is first wired).
  async function saveFirstReplyToAccount(accountId: string): Promise<void> {
    const ops: Promise<unknown>[] = [];

    // Account-hours fan-out. The wizard's First reply section now
    // exposes per-card biz-hours checkboxes (canonical 2026-06-22),
    // so we write both firstMsg + call gates here. followUpsApplyQuietHours
    // is the overnight gate driven by the Timing card further down.
    ops.push(
      usersApi.updateAccountHours(accountId, {
        instantReplyDuringBusinessHours: opts.instantReplyDuringBusinessHours,
        firstMsgDuringBusinessHours: opts.firstMsgDuringBusinessHours,
        callDuringBusinessHours: opts.callDuringBusinessHours,
        followUpsApplyQuietHours: opts.followUpsApplyQuietHours,
      }).catch(() => undefined),
    );

    // Instant Reply — automation rule. Patches enabled + useAi (Message
    // generation: AI vs Template, surfaced as a radio inside the card).
    ops.push((async () => {
      const r = await automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] }));
      const nl = (r.rules || []).find(
        x => x.triggerType === 'new_lead' && (!x.delayMinutes || x.delayMinutes === 0),
      );
      if (nl) {
        await automationApi.updateRule(nl.id, { enabled: instantReplyOn, useAi: replyUseAi } as any);
      } else {
        await automationApi.createRule({
          savedAccountId: accountId,
          name: 'Instant Reply',
          triggerType: 'new_lead',
          enabled: instantReplyOn,
          useAi: replyUseAi,
          delayMinutes: 0,
        } as any);
      }
    })().catch(() => undefined));

    // Instant Text — notification rule (only patch when the rule
    // exists; rule auto-provisioning is the platform connect's job).
    ops.push((async () => {
      const r = await notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] }));
      const ct = (r.rules || []).find(x => x.triggerType === 'new_lead' && (x as any).sendToCustomer);
      if (ct) await notificationsApi.updateRule(accountId, ct.id, { enabled: instantTextOn });
    })().catch(() => undefined));

    // Instant Call — only the enabled flag. Connection Mode stays
    // whatever the account has from Settings.
    ops.push(
      callConnectApi.saveSettings(accountId, {
        enabled: instantCallOn,
      } as any).catch(() => undefined),
    );

    await Promise.all(ops);
  }

  async function apply() {
    if (saving) return;
    setSaving(true);
    try {
      if (savedAccounts.length === 0) {
        await onSaveContinue();
        return;
      }
      // Parallel fan-out: each account's saves run concurrently, and
      // within an account the wizard-settings + first-reply paths also
      // run in parallel. This drops save time from O(N × 5 round-trips
      // sequentially) to O(max-account round-trip), so a 5-account
      // tenant goes from ~15s to ~3s on a typical network.
      const results = await Promise.all(savedAccounts.map(acct =>
        Promise.all([
          followUpApi.saveWizardSettings(acct.id, wizardPayload),
          saveFirstReplyToAccount(acct.id),
        ]).then(
          () => ({ ok: true as const }),
          (err: any) => ({ ok: false as const, err }),
        )
      ));
      const firstError = results.find(r => !r.ok);
      if (firstError && !firstError.ok) {
        const msg = firstError.err?.response?.data?.message || 'Some accounts did not save — you can re-apply from Automation later.';
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
            padding: '10px 22px', borderRadius: 10,
            border: 0, background: 'var(--lb-accent)', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {saving ? 'Saving…' : 'Continue'}
        </button>
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

      {/* ─── First reply section ──────────────────────────────────── */}
      {/* Mirrors Settings → Automation → Respond. Three master toggles
          for what happens the moment a new lead arrives. Advanced bits
          (Agent Whisper, Voicemail TTS, custom AI prompts) deliberately
          omitted — those live behind the AdvancedExpand on the full
          settings page; the wizard's footer banner points there. */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 12 }}>
          <h2 className="lb-wiz-section-h2" style={{
            margin: 0, fontSize: 16, fontWeight: 800,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>
            First reply
          </h2>
        </div>

        {/* First-reply cards — canonical 2026-06-22 chrome (1.5px border,
            14 radius, shadow, 40×40 icon tile, 15px/700 title). Each
            card opens an inline biz-hours checkbox; Instant Reply also
            opens a Message generation expand with AI / Custom template
            radio buttons. Master toggles plus useAi + firstMsg /
            callDuringBusinessHours are saved per-account in
            saveFirstReplyToAccount. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <FirstReplyCard
            icon={MessageSquareText}
            iconBg="#dbeafe"
            iconColor="#2563eb"
            title="Instant Reply"
            subtitle="Send the first message automatically when a new lead arrives."
            info="The very first response a lead gets, written by AI from your Business Info, FAQ, Pricing, and AI Playbook. Industry studies show the first vendor to reply wins more than half of jobs — Instant Reply makes you that vendor."
            enabled={instantReplyOn}
            onToggle={setInstantReplyOn}
            bizLabel="Only send during business hours"
            bizChecked={opts.instantReplyDuringBusinessHours}
            onBizToggle={v => setOpts(o => ({ ...o, instantReplyDuringBusinessHours: v }))}
          >
            {/* Message generation expandable — AI vs Custom template */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '13px 0 0' }}>
              <button
                type="button"
                onClick={() => setRespAdvOpen(o => !o)}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%',
                  background: 'transparent', border: 0, cursor: 'pointer',
                  fontFamily: 'inherit', textAlign: 'left', padding: 0,
                }}
              >
                {respAdvOpen
                  ? <ChevronDown size={15} style={{ color: 'var(--lb-ink-5)', marginTop: 2, flexShrink: 0 }} />
                  : <ChevronRight size={15} style={{ color: 'var(--lb-ink-5)', marginTop: 2, flexShrink: 0 }} />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>
                    Message generation
                  </span>
                  <span style={{ display: 'block', fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>
                    How messages are composed.
                  </span>
                </span>
                <ModePill useAi={replyUseAi} />
              </button>
              {respAdvOpen && (
                <div style={{ marginTop: 13, paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 13 }}>
                  <RadioButton
                    selected={replyUseAi}
                    onClick={() => setReplyUseAi(true)}
                    title="AI-generated"
                    body="AI writes each message from your Business Info, FAQ, Pricing and AI Playbook."
                  />
                  <RadioButton
                    selected={!replyUseAi}
                    onClick={() => setReplyUseAi(false)}
                    title="Custom template"
                    body="Use your own pre-written messages instead of AI."
                  />
                </div>
              )}
            </div>
          </FirstReplyCard>

          <FirstReplyCard
            icon={MessageCircle}
            iconBg="#d1fae5"
            iconColor="#059669"
            title="Instant Text"
            subtitle="Automatically text the lead when a new lead arrives."
            info="Sends a text message to the lead's phone number the moment they come in. Use this for SMS-first conversations or to capture a phone-callable thread early."
            enabled={instantTextOn}
            onToggle={setInstantTextOn}
            bizLabel="Only send during business hours"
            bizChecked={opts.firstMsgDuringBusinessHours}
            onBizToggle={v => setOpts(o => ({ ...o, firstMsgDuringBusinessHours: v }))}
            bizNoBorder
          />

          <FirstReplyCard
            icon={Phone}
            iconBg="#e0e7ff"
            iconColor="#6366f1"
            title="Instant Call"
            subtitle="Call your team and connect to the lead right away."
            info="Dials your team's number and bridges them to the lead's phone for a live call. Best for high-intent leads where a voice conversation closes faster than chat. Requires the lead's phone number."
            enabled={instantCallOn}
            onToggle={setInstantCallOn}
            bizLabel="Only call during business hours"
            bizChecked={opts.callDuringBusinessHours}
            onBizToggle={v => setOpts(o => ({ ...o, callDuringBusinessHours: v }))}
            bizNoBorder
          />
        </div>
      </div>

      {/* ─── Follow-ups & AI section ────────────────────────────────
          Per the FinalDesign "Wizard Automation (standalone)"
          canonical the wizard groups its second batch of cards under
          a "Follow-ups & AI" header at 16/800 — no subtitle. */}
      <div>
        <div style={{ margin: '22px 0 12px' }}>
          <h2 className="lb-wiz-section-h2" style={{
            margin: 0, fontSize: 16, fontWeight: 800,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>
            Follow-ups &amp; AI
          </h2>
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
            {/* Timing — informational only per canonical. The actual
                "Only send/call during business hours" toggles moved
                into the Instant Reply / Text / Call cards above. */}
            <InfoCard
              icon={Clock}
              iconBg="#dbeafe"
              iconColor="#2563eb"
              title="Timing"
              subtitle={`Business hours: ${businessHoursLabel} · Overnight: ${quietHoursLabel}`}
            />

            <FollowupCard
              icon={RotateCcw}
              iconBg="#ccfbf1"
              iconColor="#0d9488"
              title="Resume follow-ups after a conversation"
              subtitle="When a customer replies and then goes silent again, start a new follow-up sequence."
              info="Once a lead has replied at least once, follow-ups stop. If they then go quiet again, we wait the configured delay and restart the sequence so they don't drift away unattended."
              enabled={opts.fuReEnrollOnSilence}
              onToggle={v => setOpts(o => ({ ...o, fuReEnrollOnSilence: v }))}
              pickerLabel="Send after"
              pickerValue={opts.fuReEnrollDelay}
              pickerOptions={RESUME_DELAY_OPTIONS}
              onPickerChange={v => setOpts(o => ({ ...o, fuReEnrollDelay: v }))}
            />

            <FollowupCard
              icon={MessageSquare}
              iconBg="#ede9fe"
              iconColor="#7c3aed"
              title="Check in after customer deferral"
              subtitle={"When customer says \"I'll get back to you\", schedule one nudge later. Cancels if they reply first."}
              info={'AI detects soft brush-offs ("let me think", "I\'ll get back to you", "checking with my partner") and schedules a single polite nudge after the configured delay. If they reply first, the nudge is canceled automatically.'}
              enabled={opts.aiDeferralCheckIn}
              onToggle={v => setOpts(o => ({ ...o, aiDeferralCheckIn: v }))}
              pickerLabel="Send check-in after"
              pickerValue={opts.aiDeferralDelay}
              pickerOptions={DEFERRAL_DELAY_OPTIONS}
              onPickerChange={v => setOpts(o => ({ ...o, aiDeferralDelay: v }))}
            />

            <FollowupCard
              icon={PhoneCall}
              iconBg="#ffedd5"
              iconColor="#ea580c"
              title="Re-engage after customer hired competitor"
              subtitle="When customer says they hired someone else, send one polite check-in later."
              info="When AI detects the lead picked another vendor, follow-ups stop immediately — but we wait the configured period and send one final friendly check-in. Catches the cases where the other vendor underdelivers and the lead is open to a do-over."
              enabled={opts.aiHiredCompetitorReengage}
              onToggle={v => setOpts(o => ({ ...o, aiHiredCompetitorReengage: v }))}
              pickerLabel="Send re-engage after"
              pickerValue={opts.aiHiredCompetitorDelay}
              pickerOptions={HIRED_DELAY_OPTIONS}
              onPickerChange={v => setOpts(o => ({ ...o, aiHiredCompetitorDelay: v }))}
            />

            {/* Conversation Goal — outer card with header + 5-strategy
                responsive grid + inline expand panel below selected. */}
            <ConversationGoalCard
              value={opts.conversationGoal}
              onChange={v => setOpts(o => ({ ...o, conversationGoal: v }))}
              priceMode={priceMode}
              onPriceModeChange={setPriceMode}
              qualifyFields={qualifyFields}
              onToggleQualifyField={(f) => setQualifyFields(prev => {
                const next = new Set(prev);
                if (next.has(f)) next.delete(f); else next.add(f);
                return next;
              })}
              customQualifyFields={customQualifyFields}
              onAddCustomQualifyField={(label) => setCustomQualifyFields(prev => (
                prev.some(f => f.label.toLowerCase() === label.toLowerCase())
                  ? prev
                  : [...prev, { label, checked: true }]
              ))}
              onToggleCustomQualifyField={(label) => setCustomQualifyFields(prev =>
                prev.map(f => f.label === label ? { ...f, checked: !f.checked } : f)
              )}
              onRemoveCustomQualifyField={(label) => setCustomQualifyFields(prev =>
                prev.filter(f => f.label !== label)
              )}
              bookingWindows={bookingWindows}
              onToggleBookingSlot={(day, slot) => setBookingWindows(prev => ({
                ...prev,
                [day]: { ...prev[day], [slot]: !prev[day][slot] },
              }))}
              onDeepLink={() => navigate('/automation/conversation')}
            />

            {/* AI Response Mode — single checkbox per canonical.
                Checked → 'assist' (only outside business hours).
                Unchecked → 'autopilot' (always). 'suggest' mode is
                still editable on Settings → Automation. */}
            <AiResponseModeCard
              respHoursOnly={opts.aiResponseMode === 'assist'}
              onChange={hoursOnly =>
                setOpts(o => ({ ...o, aiResponseMode: hoursOnly ? 'assist' : 'autopilot' }))
              }
            />

            {/* Subtle gray note below AI Response Mode — explains how
                business hours interact with the checkbox above. */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '12px 14px',
              background: '#f8fafc',
              border: '1px solid var(--lb-line-soft)',
              borderRadius: 10,
              fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.45,
            }}>
              <Clock size={15} style={{ flexShrink: 0 }} />
              <div>Business hours are used when AI Response Mode is set to <em>Assist when unavailable</em>.</div>
            </div>
          </div>
        )}
      </div>

      {/* Simpler tip box per the FinalDesign canonical — single line
          pointing at the full Automation pages. Replaces the prior
          FooterBanner which carried a longer "Looking for more?"
          breakdown that the canonical compressed into one sentence. */}
      <div style={{
        marginTop: 28,
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        background: 'var(--lb-accent-tint)',
        border: '1px solid var(--lb-accent-line)',
        borderRadius: 10,
        fontSize: 12.5, color: 'var(--lb-ink-3)', lineHeight: 1.45,
      }}>
        <Info size={15} style={{ color: 'var(--lb-accent)', flexShrink: 0 }} />
        <div>
          Every control here is also on the{' '}
          <button
            type="button"
            onClick={() => navigate('/automation/respond')}
            style={{
              background: 'transparent', border: 0, padding: 0,
              fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 700,
              color: 'var(--lb-ink-1)', cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Automation
          </button>
          {' '}pages — adjust now or anytime later.
        </div>
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
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

// FirstReplyCard, Toggle, and Checkbox moved 2026-06-23 to
// components/automation/wizard-cards.tsx so the production Automation
// pages (Respond / Followups / Conversation) can render the same
// chrome instead of the legacy SettingCard variants.

/**
 * Informational card — small 36×36 tile + title + subtitle, no controls.
 * Used for the Timing card which now just displays the active business
 * hours window (the actual gates moved into First reply cards).
 */
function InfoCard({
  icon: Icon, iconBg, iconColor, title, subtitle,
}: {
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  iconBg: string; iconColor: string;
  title: string; subtitle: string;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 13,
      padding: '15px 16px',
      background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 12,
    }}>
      <span style={{
        width: 36, height: 36, borderRadius: 10,
        background: iconBg, color: iconColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon size={17} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>{subtitle}</div>
      </div>
    </div>
  );
}

/**
 * Follow-up card chrome — canonical small card (36×36 tile, 14px title,
 * 1px border, 12 radius, no shadow). Header carries master toggle; when
 * on, an inline "<label>  <value> ▾" row appears beneath a hairline.
 * Picker is a styled native <select> so mobile gets the OS picker.
 */
function FollowupCard({
  icon: Icon, iconBg, iconColor, title, subtitle, info,
  enabled, onToggle, pickerLabel, pickerValue, pickerOptions, onPickerChange,
}: {
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  iconBg: string; iconColor: string;
  title: string; subtitle: string; info: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  pickerLabel: string;
  pickerValue: string;
  pickerOptions: string[];
  onPickerChange: (v: string) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const options = pickerOptions.includes(pickerValue) ? pickerOptions : [pickerValue, ...pickerOptions];
  return (
    <div style={{
      padding: '15px 16px',
      background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
        <span style={{
          width: 36, height: 36, borderRadius: 10,
          background: iconBg, color: iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={17} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.45,
          }}>
            <span style={{
              flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {subtitle}
            </span>
            <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
          </div>
          {infoOpen && <InfoTip>{info}</InfoTip>}
        </div>
        <Toggle on={enabled} onChange={onToggle} />
      </div>
      {enabled && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 12, marginTop: 12, paddingTop: 12,
          borderTop: '1px solid var(--lb-line-soft)',
        }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-3)' }}>
            {pickerLabel}
          </span>
          <DropdownSelect
            value={pickerValue}
            options={options}
            onChange={onPickerChange}
          />
        </div>
      )}
    </div>
  );
}

// Custom delay parsing — keeps the same shape (e.g. "5 days") the
// backend parseDelay() understands so wizard-saved customs round-trip.
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

/**
 * Dropdown picker for follow-up delays. Renders a native <select> with
 * preset options + a trailing "Custom…" sentinel. Picking Custom (or
 * arriving with an off-preset value) reveals an inline number + unit
 * editor that serializes back to `"<val> <unit>"`.
 */
function DropdownSelect({
  value, options, onChange,
}: { value: string; options: string[]; onChange: (v: string) => void }) {
  const isCustom = !options.includes(value);
  const custom = parseCustomDelay(isCustom ? value : '1 day');
  return (
    <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
        <select
          value={isCustom ? '__custom__' : value}
          onChange={e => {
            if (e.target.value === '__custom__') {
              // Seed with current custom value (or "1 day" if first time)
              onChange(`${custom.val} ${custom.unit}`);
            } else {
              onChange(e.target.value);
            }
          }}
          style={{
            appearance: 'none',
            padding: '7px 30px 7px 12px',
            border: '1px solid var(--lb-line)',
            borderRadius: 8,
            fontSize: 12.5, fontWeight: 600,
            color: 'var(--lb-ink-2)',
            background: '#fff',
            fontFamily: 'inherit',
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
          <option value="__custom__">{isCustom ? `Custom: ${custom.val} ${PILL_CUSTOM_UNITS.find(u => u.value === custom.unit)?.label}` : 'Custom…'}</option>
        </select>
        <ChevronDown size={13} style={{
          position: 'absolute', right: 10, color: 'var(--lb-ink-5)',
          pointerEvents: 'none',
        }} />
      </span>
      {isCustom && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
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
              width: 56, padding: '6px 8px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
              background: '#fff', color: 'var(--lb-ink-1)',
              outline: 'none',
            }}
          />
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
            <select
              value={custom.unit}
              onChange={e => onChange(`${custom.val} ${e.target.value as CustomUnit}`)}
              style={{
                appearance: 'none',
                padding: '6px 26px 6px 10px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                fontSize: 12.5, fontWeight: 600, fontFamily: 'inherit',
                background: '#fff', color: 'var(--lb-ink-2)',
                cursor: 'pointer', outline: 'none',
              }}
            >
              {PILL_CUSTOM_UNITS.map(u => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
            <ChevronDown size={11} style={{
              position: 'absolute', right: 8, color: 'var(--lb-ink-5)',
              pointerEvents: 'none',
            }} />
          </span>
        </span>
      )}
    </div>
  );
}

/**
 * Conversation Goal card — header + responsive 5-strategy grid + inline
 * expand panel below the selected strategy. Matches canonical exactly:
 * 5-column on desktop, single-column on mobile (.lb-strat-grid media
 * query). Each panel deep-links to /automation/conversation for the
 * detailed settings (qualification fields, booking windows, etc.).
 */
const STRATEGY_DEFS: Array<{
  value: ConversationGoal;
  title: string;
  body: string;
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  iconBg: string;
  iconColor: string;
  panelTitle: string;
  panelBody: string;
  panelExtra?: 'pricing' | 'qualify' | 'booking';
}> = [
  {
    value: 'auto', icon: Sparkles, iconBg: '#ede9fe', iconColor: '#7c3aed',
    title: 'Auto',
    body: 'AI automatically chooses the best approach based on the conversation.',
    panelTitle: 'Auto goal setup',
    panelBody: 'Nothing to configure. AI reads each conversation and automatically switches between pricing, qualifying, booking and call handoff to move the lead forward.',
  },
  {
    value: 'price', icon: CircleDollarSign, iconBg: '#d1fae5', iconColor: '#059669',
    title: 'Price',
    body: 'Provide pricing information as quickly and accurately as possible.',
    panelTitle: 'Price goal setup',
    panelBody: 'AI quotes from your service Pricing Guidance and answers price questions as fast as possible. Booking-critical Qualify fields are still collected first.',
    panelExtra: 'pricing',
  },
  {
    value: 'qualify', icon: UserCheck, iconBg: '#ffedd5', iconColor: '#ea580c',
    title: 'Qualify',
    body: 'Collect the required information before quoting or booking.',
    panelTitle: 'Required information',
    panelBody: 'AI collects key details before quoting or booking. Configure which fields are required on Settings → Automation.',
    panelExtra: 'qualify',
  },
  {
    value: 'booking', icon: CalendarCheck, iconBg: '#dbeafe', iconColor: '#2563eb',
    title: 'Booking',
    body: 'Move the customer toward scheduling the job.',
    panelTitle: 'Available booking windows',
    panelBody: 'Pick the day/time windows the team can take bookings. Configure on Settings → Automation.',
    panelExtra: 'booking',
  },
  {
    value: 'phone', icon: Phone, iconBg: '#ffe4e6', iconColor: '#e11d48',
    title: 'Call Handoff',
    body: "Get the customer's number so your team can call.",
    panelTitle: 'Call Handoff goal setup',
    panelBody: "AI works to collect the customer's phone number, then hands off so your team can call. It still answers a quick price question if asked first.",
  },
];

function ConversationGoalCard({
  value, onChange, priceMode, onPriceModeChange,
  qualifyFields, onToggleQualifyField,
  customQualifyFields, onAddCustomQualifyField, onToggleCustomQualifyField, onRemoveCustomQualifyField,
  bookingWindows, onToggleBookingSlot,
  onDeepLink,
}: {
  value: ConversationGoal;
  onChange: (v: ConversationGoal) => void;
  priceMode: PriceMode;
  onPriceModeChange: (v: PriceMode) => void;
  qualifyFields: Set<QualifyField>;
  onToggleQualifyField: (f: QualifyField) => void;
  customQualifyFields: Array<{ label: string; checked: boolean }>;
  onAddCustomQualifyField: (label: string) => void;
  onToggleCustomQualifyField: (label: string) => void;
  onRemoveCustomQualifyField: (label: string) => void;
  bookingWindows: BookingWindows;
  onToggleBookingSlot: (day: BookingDay, slot: 'morning' | 'afternoon') => void;
  onDeepLink: () => void;
}) {
  const [headerInfoOpen, setHeaderInfoOpen] = useState(false);
  return (
    <div style={{
      background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      padding: 16,
    }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <span style={{
          width: 40, height: 40, borderRadius: 11,
          background: '#e0e7ff', color: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Sparkles size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Conversation Goal
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5, marginTop: 3 }}>
            What AI is trying to achieve with each reply. Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation.
          </div>
          {headerInfoOpen && (
            <InfoTip>
              Each goal changes how AI replies, what it tries to find out, and when it hands off to your team. Pick the one that matches your business — or leave on Auto and AI switches strategies based on what each lead asks.
            </InfoTip>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <InfoDot open={headerInfoOpen} onClick={() => setHeaderInfoOpen(o => !o)} />
        </div>
      </div>

      {/* Strategy grid — responsive 5-col → 1-col on mobile */}
      <div className="lb-strat-grid" style={{ display: 'grid', gap: 10, marginTop: 16 }}>
        {STRATEGY_DEFS.map(def => {
          const selected = value === def.value;
          return (
            <div key={def.value} style={{ display: 'contents' }}>
              <button
                type="button"
                onClick={() => onChange(def.value)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: '#fff',
                  border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
                  borderRadius: 12,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  textAlign: 'left',
                  transition: 'border-color 120ms',
                }}
              >
                <span style={{
                  width: 34, height: 34, borderRadius: 10,
                  background: def.iconBg, color: def.iconColor,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                }}>
                  <def.icon size={17} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{
                    display: 'block',
                    fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)',
                  }}>
                    {def.title}
                  </span>
                  <span style={{
                    display: '-webkit-box',
                    fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.4,
                    marginTop: 2,
                    overflow: 'hidden',
                    WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  } as CSSProperties}>
                    {def.body}
                  </span>
                </span>
                <Info size={13} style={{ color: 'var(--lb-accent)', flexShrink: 0 }} />
              </button>
              {selected && (
                <div className="lb-strat-panel" style={{
                  background: '#fff',
                  border: '1px solid var(--lb-line)',
                  borderRadius: 12,
                  padding: 16,
                }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 4 }}>
                    {def.panelTitle}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5 }}>
                    {def.panelBody}
                  </div>

                  {/* Price strategy — Pricing source link + Range/Exact picker */}
                  {def.value === 'price' && (
                    <>
                      <PricingSourceCard def={def} onEdit={onDeepLink} />
                      <PriceModeChooser value={priceMode} onChange={onPriceModeChange} />
                    </>
                  )}

                  {/* Qualify strategy — 6 required-field checkboxes + user-added customs */}
                  {def.value === 'qualify' && (
                    <QualifyFieldsPanel
                      qualifyFields={qualifyFields}
                      onToggleQualifyField={onToggleQualifyField}
                      customQualifyFields={customQualifyFields}
                      onAddCustomQualifyField={onAddCustomQualifyField}
                      onToggleCustomQualifyField={onToggleCustomQualifyField}
                      onRemoveCustomQualifyField={onRemoveCustomQualifyField}
                    />
                  )}

                  {/* Booking strategy — 7-day × Morning/Afternoon grid */}
                  {def.value === 'booking' && (
                    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {BOOKING_DAYS.map(d => (
                        <div key={d.key} style={{
                          display: 'grid', gridTemplateColumns: '48px 1fr 1fr',
                          gap: 8, alignItems: 'center',
                        }}>
                          <span style={{
                            fontSize: 11, fontWeight: 700,
                            fontFamily: 'var(--lb-font-mono)',
                            color: 'var(--lb-ink-5)',
                            textTransform: 'uppercase', letterSpacing: '0.06em',
                          }}>
                            {d.label}
                          </span>
                          <SlotButton
                            label="Morning"
                            active={bookingWindows[d.key].morning}
                            onClick={() => onToggleBookingSlot(d.key, 'morning')}
                          />
                          <SlotButton
                            label="Afternoon"
                            active={bookingWindows[d.key].afternoon}
                            onClick={() => onToggleBookingSlot(d.key, 'afternoon')}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * "Pricing source" sub-card inside the Price strategy panel — deep-links
 * to the Pricing tables in the AI Playbook (where range/exact +
 * per-service pricing actually live).
 */
function PricingSourceCard({
  def, onEdit,
}: {
  def: { icon: ComponentType<{ size?: number; style?: CSSProperties }>; iconBg: string; iconColor: string };
  onEdit: () => void;
}) {
  return (
    <div style={{
      marginTop: 14,
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 13px',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
    }}>
      <span style={{
        width: 32, height: 32, borderRadius: 9,
        background: def.iconBg, color: def.iconColor,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <def.icon size={16} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          Pricing source
        </div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>
          Per-service price tables in the AI Playbook.
        </div>
      </div>
      <button
        type="button"
        onClick={onEdit}
        style={{
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', fontSize: 12, fontWeight: 600,
          color: 'var(--lb-accent)',
          flexShrink: 0,
        }}
      >
        Edit →
      </button>
    </div>
  );
}

/**
 * Range / Exact quote-style picker for the Price strategy. Range gives
 * "$200–$300" style answers (good for variable-scope jobs); Exact gives
 * single-number quotes (only safe when you have a fixed-price table).
 */
function PriceModeChooser({
  value, onChange,
}: { value: PriceMode; onChange: (v: PriceMode) => void }) {
  return (
    <div style={{
      marginTop: 12,
      padding: '12px 13px',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
    }}>
      <div style={{
        fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)', marginBottom: 8,
      }}>
        Quote style
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        {(['range', 'exact'] as const).map(opt => {
          const active = value === opt;
          return (
            <button
              key={opt}
              type="button"
              onClick={() => onChange(opt)}
              style={{
                flex: 1,
                padding: '9px 12px',
                background: active ? 'var(--lb-accent-tint)' : '#fff',
                border: '1.5px solid ' + (active ? 'var(--lb-accent)' : 'var(--lb-line)'),
                borderRadius: 9,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'background 120ms, border-color 120ms',
              }}
            >
              <div style={{
                fontSize: 13, fontWeight: 700,
                color: active ? 'var(--lb-accent)' : 'var(--lb-ink-1)',
              }}>
                {opt === 'range' ? 'Range' : 'Exact'}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.4 }}>
                {opt === 'range' ? 'AI quotes "$200–$300"' : 'AI quotes "$250"'}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Qualify required-information panel — built-in 6 fields + user-added
 * customs + an inline "Add field" affordance. Each row carries a
 * checkbox (toggle whether the field is required) and a small × on
 * custom rows to delete them entirely. Duplicate-by-label is rejected
 * silently in the add handler.
 */
function QualifyFieldsPanel({
  qualifyFields, onToggleQualifyField,
  customQualifyFields, onAddCustomQualifyField, onToggleCustomQualifyField, onRemoveCustomQualifyField,
}: {
  qualifyFields: Set<QualifyField>;
  onToggleQualifyField: (f: QualifyField) => void;
  customQualifyFields: Array<{ label: string; checked: boolean }>;
  onAddCustomQualifyField: (label: string) => void;
  onToggleCustomQualifyField: (label: string) => void;
  onRemoveCustomQualifyField: (label: string) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    onAddCustomQualifyField(trimmed);
    setDraft('');
    setAddOpen(false);
  };

  return (
    <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 9 }}>
      {QUALIFY_FIELD_DEFS.map(f => (
        <button
          key={f.key}
          type="button"
          onClick={() => onToggleQualifyField(f.key)}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '11px 12px',
            border: '1px solid var(--lb-line)',
            borderRadius: 10,
            background: '#fff',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'left',
          }}
        >
          <Checkbox checked={qualifyFields.has(f.key)} />
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
            {f.label}
          </span>
        </button>
      ))}

      {customQualifyFields.map(f => (
        <div
          key={f.label}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '11px 12px',
            border: '1px solid var(--lb-line)',
            borderRadius: 10,
            background: '#fff',
          }}
        >
          <button
            type="button"
            onClick={() => onToggleCustomQualifyField(f.label)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
              fontFamily: 'inherit', textAlign: 'left',
              flex: 1, minWidth: 0,
            }}
          >
            <Checkbox checked={f.checked} />
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
              {f.label}
            </span>
          </button>
          <button
            type="button"
            onClick={() => onRemoveCustomQualifyField(f.label)}
            aria-label={`Remove ${f.label}`}
            style={{
              background: 'transparent', border: 0, padding: 4, cursor: 'pointer',
              color: 'var(--lb-ink-5)', lineHeight: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
      ))}

      {addOpen ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 10px 9px 12px',
          border: '1.5px solid var(--lb-accent)',
          borderRadius: 10,
          background: '#fff',
        }}>
          <input
            autoFocus
            type="text"
            placeholder="e.g. Pet name, Move-in date…"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit(); }
              if (e.key === 'Escape') { setDraft(''); setAddOpen(false); }
            }}
            style={{
              flex: 1, minWidth: 0,
              border: 0, padding: '4px 0',
              fontSize: 13, fontFamily: 'inherit',
              color: 'var(--lb-ink-1)', background: 'transparent',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={commit}
            disabled={!draft.trim()}
            style={{
              padding: '6px 12px',
              background: draft.trim() ? 'var(--lb-accent)' : 'var(--lb-ink-8)',
              color: '#fff',
              border: 0, borderRadius: 8,
              fontSize: 12.5, fontWeight: 700, fontFamily: 'inherit',
              cursor: draft.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Add
          </button>
          <button
            type="button"
            onClick={() => { setDraft(''); setAddOpen(false); }}
            aria-label="Cancel"
            style={{
              background: 'transparent', border: 0, padding: 4, cursor: 'pointer',
              color: 'var(--lb-ink-5)', lineHeight: 0,
            }}
          >
            <X size={14} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setAddOpen(true)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '11px 12px',
            border: '1px dashed var(--lb-line)',
            borderRadius: 10,
            background: 'transparent',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 13, fontWeight: 600,
            color: 'var(--lb-accent)',
            transition: 'background 120ms, border-color 120ms',
          }}
        >
          <Plus size={14} />
          Add custom field
        </button>
      )}
    </div>
  );
}

/**
 * Morning / Afternoon slot button for the Booking strategy 7-day grid.
 * Active = blue tint + accent border + filled dot. Inactive = neutral
 * gray with hollow dot.
 */
function SlotButton({
  label, active, onClick,
}: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7,
        padding: '8px 10px',
        background: active ? 'var(--lb-accent-tint)' : '#fff',
        border: '1.5px solid ' + (active ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 12.5, fontWeight: 600,
        color: active ? 'var(--lb-accent)' : 'var(--lb-ink-5)',
        transition: 'background 120ms, border-color 120ms, color 120ms',
      }}
    >
      <span style={{
        width: 6, height: 6, borderRadius: 99,
        background: active ? 'var(--lb-accent)' : 'var(--lb-ink-7)',
        flexShrink: 0,
      }} />
      {label}
    </button>
  );
}

/**
 * AI Response Mode card — single checkbox per canonical. Replaces the
 * 3-radio RadioCardSection. Checkbox checked = 'assist' (only outside
 * business hours); unchecked = 'autopilot' (always). The 'suggest'
 * (review-only) mode still exists in the backend but is not surfaced
 * in the wizard — Settings → Automation → Conversation has it.
 */
function AiResponseModeCard({
  respHoursOnly, onChange,
}: {
  respHoursOnly: boolean;
  onChange: (v: boolean) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div style={{
      background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      padding: 16,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{
          width: 40, height: 40, borderRadius: 11,
          background: '#e0e7ff', color: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Clock size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            AI Response Mode
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5, marginTop: 3 }}>
            When AI is allowed to respond automatically to customer messages.
          </div>
          {infoOpen && (
            <InfoTip>
              When the checkbox is on, AI only replies after your business hours close — during the day, your team handles conversations live. When off, AI replies any time of day. Either way, AI follow-ups and detection still run on their own schedule.
            </InfoTip>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
        </div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!respHoursOnly)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left',
          padding: '8px 0 2px', width: '100%',
        }}
      >
        <Checkbox checked={respHoursOnly} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          Only assist outside of business hours
        </span>
      </button>
    </div>
  );
}

function RadioButton({
  selected, onClick, title, body,
}: { selected: boolean; onClick: () => void; title: string; body: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: 'transparent', border: 0, cursor: 'pointer',
        fontFamily: 'inherit', textAlign: 'left', padding: 0,
      }}
    >
      <span style={{
        width: 18, height: 18, borderRadius: 99,
        border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        background: selected ? 'var(--lb-accent)' : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, marginTop: 1,
        transition: 'background 120ms, border-color 120ms',
      }}>
        {selected && <span style={{ width: 6, height: 6, borderRadius: 99, background: '#fff' }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          {title}
        </span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.5, marginTop: 3 }}>
          {body}
        </span>
      </span>
    </button>
  );
}

// ─── AI Conversation: radio-card option lists ───────────────────────────
//
// Mirrors the option set in Settings → Automation → Conversation. The
// internal keys (auto/price/qualify/booking/phone) and labels stay in
// sync with STRATEGIES there so a wizard-saved value renders correctly
// on the full settings page next visit.

// Derive the wizard's Conversation Goal radio value from the backend's
// followUpStrategy. Legacy 'hybrid' and 'convert' values are remapped
// for display the same way Settings → Conversation does.
function deriveConversationGoal(saved: any): ConversationGoal {
  if (saved === 'hybrid') return 'auto';
  if (saved === 'convert') return 'qualify';
  if (saved === 'auto' || saved === 'price' || saved === 'qualify' || saved === 'booking' || saved === 'phone') {
    return saved;
  }
  return 'auto';
}

// Derive the wizard's AI Response Mode radio value from the two
// backend fields. Same mapping the full Conversation page uses.
function deriveAiResponseMode(
  deliveryMode: any,
  availability: any,
): AiResponseMode {
  if (deliveryMode === 'suggest') return 'suggest';
  if (availability === 'active_hours') return 'assist';
  return 'autopilot';
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
