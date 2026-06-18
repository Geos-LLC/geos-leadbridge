import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  ArrowRight, ArrowRightLeft, CalendarCheck, CircleDollarSign, Clock, ExternalLink, Info,
  MessageCircle, MessageSquare, MessageSquareText, Moon, Phone, PhoneCall, RotateCcw,
  Sparkles, UserCheck, Workflow, Loader2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import {
  automationApi, callConnectApi, followUpApi, notificationsApi, usersApi,
} from '../../../services/api';
import type { AutomationRule, NotificationRule } from '../../../types';
import { notify } from '../../../store/notificationStore';
import { WizardStepActions } from '../WizardStepActions';
import {
  FieldRow, FooterBanner, MessageGenerationRow, OptionCard, SettingCard, TimingRow, ToggleRow,
} from '../../../components/automation/ui';

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
type GoalCompletionAction = 'continue' | 'stop';
// First-reply controls — mirror Settings → Automation → Respond.
type ReplyMode = 'ai' | 'template';
type ConnMode = 'agent-first' | 'parallel';

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
  // AI Conversation defaults — mirror Settings → Automation → AI
  // Conversation. The wizard exposes a small subset (Goal +
  // Response Mode + Goal Completion); handoff triggers and per-goal
  // qualification fields live on the full page.
  conversationGoal: 'auto' as ConversationGoal,
  aiResponseMode: 'autopilot' as AiResponseMode,
  goalCompletionAction: 'continue' as GoalCompletionAction,
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

  // First-reply state — mirrors Settings → Automation → Respond. The
  // three master toggles, AI/template mode for the message-generation
  // blocks, the per-account business-hours flags, and the connection
  // mode for Instant Call. Hydrated from the primary SavedAccount.
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [replyType, setReplyType] = useState<ReplyMode>('ai');
  const [instantTextOn, setInstantTextOn] = useState(true);
  const [instantTextMode, setInstantTextMode] = useState<ReplyMode>('ai');
  const [textBizHours, setTextBizHours] = useState(false);
  const [instantCallOn, setInstantCallOn] = useState(true);
  const [connMode, setConnMode] = useState<ConnMode>('agent-first');
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

        // First-reply hydration — same shape lookups Respond.tsx uses.
        const newLeadRule = (autoRes.rules || []).find(
          r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0),
        );
        const customerTextRule = (notifRes.rules || []).find(
          r => r.triggerType === 'new_lead' && r.sendToCustomer,
        );
        const callSettings: any = (callRes as any)?.settings ?? null;
        if (newLeadRule) {
          setInstantReplyOn(!!newLeadRule.enabled);
          setReplyType(newLeadRule.useAi ? 'ai' : 'template');
        }
        if (customerTextRule) {
          setInstantTextOn(!!customerTextRule.enabled);
        }
        if (callSettings) {
          setInstantCallOn(callSettings.enabled !== false);
          setConnMode(callSettings.mode === 'PARALLEL' ? 'parallel' : 'agent-first');
        }
        const rawInstantTextMode = (s as any)?.instantTextMode;
        setInstantTextMode(rawInstantTextMode === 'template' ? 'template' : 'ai');
        setTextBizHours((hours as any)?.firstMsgDuringBusinessHours ?? false);
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
          // AI Conversation — derive the three wizard controls from
          // the raw backend fields (followUpStrategy /
          // aiConversationDeliveryMode / followUpAvailability /
          // goal*StopOnComplete). Mirrors the parseSettings logic in
          // Settings → Automation → Conversation.
          conversationGoal: deriveConversationGoal(s.followUpStrategy),
          aiResponseMode: deriveAiResponseMode(
            s.aiConversationDeliveryMode,
            s.followUpAvailability,
          ),
          goalCompletionAction:
            s.goalQualifyStopOnComplete === true || s.goalPhoneStopOnComplete === true
              ? 'stop'
              : 'continue',
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
  //   - goalQualifyStopOnComplete + goalPhoneStopOnComplete (Goal Action)
  // The two per-goal stops are written symmetrically with the single
  // wizard radio — the runtime applies whichever matches the currently
  // active goal. Users can fine-tune per goal in Settings later.
  const wizardPayload = useMemo(() => ({
    ...TRIAL_BUNDLE,
    fuReEnrollOnSilence: opts.fuReEnrollOnSilence,
    fuReEnrollDelay: opts.fuReEnrollDelay,
    aiDeferralCheckIn: opts.aiDeferralCheckIn,
    aiDeferralDelay: opts.aiDeferralDelay,
    aiHiredCompetitorReengage: opts.aiHiredCompetitorReengage,
    aiHiredCompetitorDelay: opts.aiHiredCompetitorDelay,
    // AI Conversation slice.
    followUpStrategy: opts.conversationGoal,
    aiConversationDeliveryMode: responseModeBackend.aiConversationDeliveryMode,
    followUpAvailability: responseModeBackend.followUpAvailability,
    goalQualifyStopOnComplete: opts.goalCompletionAction === 'stop',
    goalPhoneStopOnComplete: opts.goalCompletionAction === 'stop',
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

    // Account-hours fan-out — extend the existing call also writes
    // firstMsgDuringBusinessHours now that the wizard surfaces it.
    ops.push(
      usersApi.updateAccountHours(accountId, {
        callDuringBusinessHours: opts.callDuringBusinessHours,
        followUpsApplyQuietHours: opts.followUpsApplyQuietHours,
        firstMsgDuringBusinessHours: textBizHours,
      }).catch(() => undefined),
    );

    // Instant Reply — automation rule. Look up the new_lead rule;
    // patch or seed.
    ops.push((async () => {
      const r = await automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] }));
      const nl = (r.rules || []).find(
        x => x.triggerType === 'new_lead' && (!x.delayMinutes || x.delayMinutes === 0),
      );
      if (nl) {
        await automationApi.updateRule(nl.id, {
          enabled: instantReplyOn,
          useAi: replyType === 'ai',
        });
      } else {
        await automationApi.createRule({
          savedAccountId: accountId,
          name: 'Instant Reply',
          triggerType: 'new_lead',
          enabled: instantReplyOn,
          useAi: replyType === 'ai',
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

    // Instant Call — call-connect settings.
    ops.push(
      callConnectApi.saveSettings(accountId, {
        enabled: instantCallOn,
        mode: (connMode === 'parallel' ? 'PARALLEL' : 'AGENT_FIRST') as any,
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
      let firstError: any = null;
      for (const acct of savedAccounts) {
        try {
          // Compose the followUp payload with instantTextMode merged in
          // so the AI/template choice for Instant Text persists too.
          await followUpApi.saveWizardSettings(acct.id, {
            ...wizardPayload,
            instantTextMode,
          });
          await saveFirstReplyToAccount(acct.id);
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

      {/* ─── First reply section ──────────────────────────────────── */}
      {/* Mirrors Settings → Automation → Respond. Three master toggles
          for what happens the moment a new lead arrives. Advanced bits
          (Agent Whisper, Voicemail TTS, custom AI prompts) deliberately
          omitted — those live behind the AdvancedExpand on the full
          settings page; the wizard's footer banner points there. */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ marginBottom: 14 }}>
          <h2 style={{
            margin: 0, fontSize: 18, fontWeight: 700,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>
            First reply
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 13.5, color: 'var(--lb-ink-5)' }}>
            What happens automatically when a new lead arrives.
          </p>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <SettingCard
            icon={MessageSquareText}
            iconTone="blue"
            title="Instant Reply"
            subtitle="Send the first message automatically when a new lead arrives."
            enabled={instantReplyOn}
            onToggle={setInstantReplyOn}
            contentPad="8px 24px 16px"
          >
            <MessageGenerationRow
              useAi={replyType === 'ai'}
              onChangeUseAi={next => setReplyType(next ? 'ai' : 'template')}
              onOpenPlaybook={() => navigate('/settings?tab=ai-playbook')}
              onOpenTemplates={() => navigate('/templates?filter=auto-reply')}
            />
          </SettingCard>

          <SettingCard
            icon={MessageCircle}
            iconTone="green"
            title="Instant Text"
            subtitle="Automatically text the lead when a new lead arrives."
            enabled={instantTextOn}
            onToggle={setInstantTextOn}
            contentPad="8px 24px 16px"
          >
            <TimingRow
              icon={Clock}
              checked={textBizHours}
              onChangeChecked={setTextBizHours}
              checkboxLabel="Only send during business hours"
              onEditHours={() => navigate('/settings?tab=hours')}
            />
            <MessageGenerationRow
              useAi={instantTextMode === 'ai'}
              onChangeUseAi={next => setInstantTextMode(next ? 'ai' : 'template')}
              onOpenPlaybook={() => navigate('/settings?tab=ai-playbook')}
              onOpenTemplates={() => navigate('/templates?filter=auto-reply')}
            />
          </SettingCard>

          <SettingCard
            icon={Phone}
            iconTone="purple"
            title="Instant Call"
            subtitle="Call your team and connect to the lead right away."
            enabled={instantCallOn}
            onToggle={setInstantCallOn}
            contentPad="8px 24px 16px"
          >
            <TimingRow
              icon={Clock}
              checked={opts.callDuringBusinessHours}
              onChangeChecked={v => setOpts(o => ({ ...o, callDuringBusinessHours: v }))}
              checkboxLabel="Only call during business hours"
              onEditHours={() => navigate('/settings?tab=hours')}
            />
            <FieldRow
              icon={ArrowRightLeft}
              iconTone="gray"
              label="Connection Mode"
              align="top"
              noBorder
            >
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <OptionCard
                  selected={connMode === 'agent-first'}
                  onClick={() => setConnMode('agent-first')}
                  title="Agent First"
                  body="We call you first, then bridge the lead."
                />
                <OptionCard
                  selected={connMode === 'parallel'}
                  onClick={() => setConnMode('parallel')}
                  title="Parallel"
                  body="We call you and the lead at the same time."
                />
              </div>
            </FieldRow>
          </SettingCard>
        </div>
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

            {/* ── AI Conversation: Conversation Goal ─────────────────
                Mirrors Settings → Automation → Conversation. 5 cards:
                Auto / Price / Qualify / Booking / Call Handoff. Writes
                followUpStrategy. */}
            <RadioCardSection
              icon={Sparkles}
              title="Conversation Goal"
              subtitle="What AI is trying to achieve with each reply. Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation."
              options={CONVERSATION_GOAL_OPTIONS}
              value={opts.conversationGoal}
              onChange={v => setOpts(o => ({ ...o, conversationGoal: v }))}
              columns={2}
            />

            {/* ── AI Response Mode ────────────────────────────────────
                3 cards: Review / Assist when unavailable / Full
                autopilot. Maps to deliveryMode + availability. */}
            <RadioCardSection
              icon={MessageSquare}
              title="AI Response Mode"
              subtitle="When AI is allowed to respond automatically to customer messages."
              options={AI_RESPONSE_MODE_OPTIONS}
              value={opts.aiResponseMode}
              onChange={v => setOpts(o => ({ ...o, aiResponseMode: v }))}
              columns={1}
            />

            {/* ── When the goal is reached ───────────────────────────
                2 cards: Continue AI + notify / Stop AI + notify.
                Writes goalQualify/goalPhoneStopOnComplete. */}
            <RadioCardSection
              icon={Workflow}
              title="When the goal is reached"
              subtitle="What AI does once it achieves the conversation goal."
              options={GOAL_COMPLETION_OPTIONS}
              value={opts.goalCompletionAction}
              onChange={v => setOpts(o => ({ ...o, goalCompletionAction: v }))}
              columns={2}
            />
          </div>
        )}
      </div>

      {/* Advanced-controls banner — points the user at Settings →
          Automation for the bits the wizard intentionally omits (custom
          AI prompts, agent whisper, voicemail TTS, per-goal
          qualification fields, handoff triggers, follow-up plan
          editor). Uses the shared FooterBanner so the visual rhythm
          matches the main Automation pages. */}
      <div style={{ marginTop: 28 }}>
        <FooterBanner
          icon={ExternalLink}
          body={
            <>
              <strong>Looking for more?</strong> Custom AI prompts, agent
              whisper messages, follow-up plan editor, per-goal
              qualification fields, and handoff triggers all live in{' '}
              <button
                type="button"
                onClick={() => navigate('/automation/respond')}
                style={{
                  background: 'transparent', border: 0, padding: 0,
                  fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 600,
                  color: 'var(--lb-accent)', cursor: 'pointer',
                }}
              >
                Settings → Automation
              </button>
              {' '}after onboarding.
            </>
          }
        />
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

// ─── AI Conversation: radio-card option lists ───────────────────────────
//
// Mirrors the option set in Settings → Automation → Conversation. The
// internal keys (auto/price/qualify/booking/phone) and labels stay in
// sync with STRATEGIES there so a wizard-saved value renders correctly
// on the full settings page next visit.

const CONVERSATION_GOAL_OPTIONS: Array<{
  value: ConversationGoal;
  title: string;
  body: string;
  icon: typeof Sparkles;
  recommended?: boolean;
}> = [
  { value: 'auto',    icon: Sparkles,         title: 'Auto',         body: 'AI automatically chooses the best approach based on the conversation.', recommended: true },
  { value: 'price',   icon: CircleDollarSign, title: 'Price',        body: 'Provide pricing information as quickly and accurately as possible.' },
  { value: 'qualify', icon: UserCheck,        title: 'Qualify',      body: 'Collect the required information before quoting or booking.' },
  { value: 'booking', icon: CalendarCheck,    title: 'Booking',      body: 'Move the customer toward scheduling the job.' },
  { value: 'phone',   icon: Phone,            title: 'Call Handoff', body: "Get the customer's number so your team can call." },
];

const AI_RESPONSE_MODE_OPTIONS: Array<{
  value: AiResponseMode;
  title: string;
  body: string;
  icon: typeof Sparkles;
}> = [
  { value: 'suggest',   icon: MessageSquare, title: 'Review before sending',  body: 'AI drafts replies and parks them for your approval. Nothing sends until you tap Send.' },
  { value: 'assist',    icon: Moon,          title: 'Assist when unavailable', body: 'AI responds automatically outside your business hours.' },
  { value: 'autopilot', icon: Sparkles,      title: 'Full autopilot',         body: 'AI responds automatically at any time.' },
];

const GOAL_COMPLETION_OPTIONS: Array<{
  value: GoalCompletionAction;
  title: string;
  body: string;
  icon: typeof Sparkles;
}> = [
  { value: 'continue', icon: Workflow, title: 'Continue AI + notify team', body: 'AI keeps replying after the goal is reached; your team is notified.' },
  { value: 'stop',     icon: PhoneCall, title: 'Stop AI + notify team',     body: 'AI pauses once the goal is reached and hands off to your team.' },
];

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

// Lightweight radio-card section. Title + subtitle header on top, grid
// of selectable cards below. Used for the three AI Conversation
// sub-controls. Mirrors the OptionCard / SectionCard visual rhythm of
// Settings → Automation → Conversation without dragging in the whole
// SectionCard primitive (which has mixed-state badges, save indicators,
// and other concerns the wizard doesn't need).
function RadioCardSection<T extends string>({
  icon: Icon, title, subtitle, options, value, onChange, columns,
}: {
  icon: typeof Sparkles;
  title: string;
  subtitle: string;
  options: Array<{ value: T; title: string; body: string; icon: typeof Sparkles; recommended?: boolean }>;
  value: T;
  onChange: (v: T) => void;
  columns: 1 | 2;
}) {
  const gridStyle: CSSProperties = columns === 1
    ? { display: 'grid', gridTemplateColumns: '1fr', gap: 10 }
    : { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 };
  return (
    <div style={{
      padding: '18px 20px',
      background: 'white',
      border: '1px solid var(--lb-line, #e2e8f0)',
      borderRadius: 14,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 14 }}>
        <div style={{
          width: 32, height: 32, borderRadius: 8,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(124,58,237,0.08)', color: '#7c3aed',
          flexShrink: 0,
        }}>
          <Icon size={16} />
        </div>
        <div>
          <div style={{
            fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)',
            letterSpacing: '-0.01em', lineHeight: 1.2,
          }}>{title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 3, lineHeight: 1.45 }}>
            {subtitle}
          </div>
        </div>
      </div>
      <div style={gridStyle}>
        {options.map(opt => {
          const selected = opt.value === value;
          const Icon2 = opt.icon;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              style={{
                position: 'relative',
                textAlign: 'left',
                padding: '12px 14px',
                background: selected ? 'rgba(37,99,235,0.06)' : 'white',
                border: '1px solid ' + (selected ? 'var(--lb-accent, #2563eb)' : 'var(--lb-line, #e2e8f0)'),
                borderRadius: 10,
                cursor: 'pointer',
                transition: 'background 120ms, border-color 120ms',
                fontFamily: 'inherit',
                color: 'inherit',
              }}
            >
              {opt.recommended && (
                <span style={{
                  position: 'absolute', top: 8, right: 8,
                  fontSize: 9.5, fontWeight: 800,
                  padding: '2px 6px', borderRadius: 4,
                  background: '#dcfce7', color: '#15803d',
                  letterSpacing: 0.06, textTransform: 'uppercase',
                  fontFamily: 'var(--lb-font-mono)',
                }}>
                  Rec
                </span>
              )}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <Icon2 size={16} style={{ color: selected ? 'var(--lb-accent, #2563eb)' : 'var(--lb-ink-5, #64748b)', flexShrink: 0, marginTop: 1 }} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--lb-ink-1)' }}>
                    {opt.title}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 3, lineHeight: 1.45 }}>
                    {opt.body}
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
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
