/**
 * AI Playbook — Phase 2 (UI refactor only)
 *
 * Business-language presentation of the existing AI Conversation settings.
 * Every read and write goes through the Playbook adapter, which maps to the
 * same followUpSettingsJson keys + aiConversationMode column that
 * Conversation.tsx already uses. No backend changes. No new keys. No new
 * defaults. No behavior changes.
 *
 * The legacy Conversation.tsx page (mounted at /automation/convert) is the
 * "Advanced" surface; a footer link routes there.
 *
 * Phase 4+ adds the Price Objections card (hidden in Phase 2).
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Brain, Sparkles, Scale, CircleDollarSign, UserCheck, Calendar, Phone,
  Clock, CalendarCheck, Users, PhoneCall, Smartphone, Ruler, BadgeCheck,
  CircleSlash, Hourglass, HeartHandshake, MessageCircleQuestion,
  Info, ArrowRight,
  type LucideIcon,
} from 'lucide-react';
import {
  SectionCard, SettingCard, FieldRow, OptionCard, ToggleRow,
  Radio, IconTile, StatusPill,
  type IconTone,
} from '../../components/automation/ui';
import { followUpApi, usersApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import {
  buildPlaybookView,
  savePlaybookView,
  type WritingStyle,
  type WhenAiReplies,
  type PriceQuoteMode,
} from '../../lib/playbook-adapter';

// Match the strategy picker visuals used on Conversation.tsx so the look
// stays consistent with Respond / Follow-ups.
const STRATEGIES: { k: WritingStyle; icon: LucideIcon; iconTone: IconTone; title: string; body: string }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',    body: 'AI picks the best strategy based on conversation context.' },
  { k: 'hybrid',  icon: Scale,            iconTone: 'gray',   title: 'Hybrid',  body: 'Balance between qualifying, converting, and pricing.' },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',   body: 'Prioritize giving price ranges proactively.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify', body: 'Ask the right questions to qualify the lead.' },
  { k: 'convert', icon: Calendar,         iconTone: 'blue',   title: 'Convert', body: 'Focus on booking and moving the lead to action.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Phone',   body: 'Encourage a phone call with your team.' },
];

// Delay presets reused on the defer / hired cards. These match the values
// the existing Services.tsx + Followups.tsx pages already write so no
// migration is needed.
const DELAY_OPTIONS = ['1h', '4h', '12h', '1d', '3d', '1w', '2w', '21d', '30d'];

const PLAYBOOK_DIRTY_FIELDS = [
  'global.whenAiReplies', 'global.writingStyle', 'global.priceQuoteMode',
  'bookingRequests.notifyTeam', 'bookingRequests.pauseAi', 'bookingRequests.stopOnBooked',
  'humanContact.notifyTeam', 'humanContact.pauseAi',
  'customerDefers.enabled', 'customerDefers.delay', 'customerDefers.message',
  'hiredAnother.enabled', 'hiredAnother.delay', 'hiredAnother.message',
  'optOut.stopAi',
  'keyDetails.notifyOnPhone', 'keyDetails.notifyOnSqft', 'keyDetails.notifyOnQualified',
] as const;
type DirtyField = typeof PLAYBOOK_DIRTY_FIELDS[number];

export function AutomationPlaybook({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const accounts = useAppStore(s => s.savedAccounts);
  const isAll = accountId === 'all';

  // Mirror Conversation.tsx state, but in Playbook shape. Defaults match
  // buildPlaybookView on an empty SavedAccount so first-paint state is
  // identical to what the adapter would produce.
  const [whenAiReplies,  setWhenAiReplies]  = useState<WhenAiReplies>('hours');
  const [writingStyle,   setWritingStyle]   = useState<WritingStyle>('auto');
  const [priceQuoteMode, setPriceQuoteMode] = useState<PriceQuoteMode>('range');
  const [booking, setBooking] = useState({ notifyTeam: true, pauseAi: true, stopOnBooked: true });
  const [humanContact, setHumanContact] = useState({ notifyTeam: true /* pauseAi mirrored from booking */ });
  const [defers, setDefers] = useState({ enabled: true, delay: '3d', message: '' });
  const [hired,  setHired]  = useState({ enabled: true, delay: '21d', message: '' });
  const [optOutStopAi, setOptOutStopAi] = useState(true);
  const [keyDetails, setKeyDetails] = useState({ notifyOnPhone: true, notifyOnSqft: true, notifyOnQualified: true });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Dirty-field tracking — same pattern as Conversation.tsx so users on
  // 'all' don't get untouched fields overwritten across every account.
  const dirtyRef = useRef(false);
  const dirtyFieldsRef = useRef<Set<DirtyField>>(new Set());

  // Reset dirty on scope change so the next user action starts fresh.
  useEffect(() => {
    dirtyRef.current = false;
    dirtyFieldsRef.current = new Set();
  }, [accountId, isAll]);

  // Auto-clear "Saved" pill.
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Pull settings from the same endpoint Conversation.tsx uses. We turn the
  // raw payload into a PlaybookView via the adapter so reads use the locked
  // mapping rules (Decision #1 Option B, mirrored pauseAi, etc.).
  useEffect(() => {
    let alive = true;
    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    if (targets.length === 0) return;
    setLoading(true);
    setError(null);

    // For 'all' mode we display the first account's values — matches the
    // basic semantics of Conversation.tsx without the mixed-state
    // visualization (deferred to a future PR).
    const firstId = targets[0];

    followUpApi.getSettings(firstId).then(async (res: { settings?: Record<string, unknown> | null }) => {
      if (!alive) return;
      const settings = res?.settings ?? null;
      const followUpSettingsJson = settings ? JSON.stringify(settings) : null;
      const aiConversationMode = typeof (settings as Record<string, unknown> | null)?.aiConversationMode === 'string'
        ? ((settings as Record<string, unknown>).aiConversationMode as string)
        : null;
      const followUpMode = typeof (settings as Record<string, unknown> | null)?.followUpMode === 'string'
        ? ((settings as Record<string, unknown>).followUpMode as string)
        : null;
      const view = buildPlaybookView({
        savedAccount: { id: firstId, followUpMode, aiConversationMode, followUpSettingsJson },
        // user.aiConversationEnabled isn't surfaced in this page in Phase 2
        // — we pass `true` because the adapter only uses it for the read-only
        // global.aiEnabled field, which Phase 2 does not render.
        user: { aiConversationEnabled: true },
      });
      if (!dirtyRef.current) {
        setWhenAiReplies(view.global.whenAiReplies);
        setWritingStyle(view.global.writingStyle);
        setPriceQuoteMode(view.global.priceQuoteMode);
        setBooking({
          notifyTeam:   view.cards.bookingRequests.notifyTeam,
          pauseAi:      view.cards.bookingRequests.pauseAi,
          stopOnBooked: view.cards.bookingRequests.stopOnBooked,
        });
        setHumanContact({ notifyTeam: view.cards.humanContact.notifyTeam });
        setDefers({
          enabled: view.cards.customerDefers.enabled,
          delay:   view.cards.customerDefers.delay,
          message: view.cards.customerDefers.message,
        });
        setHired({
          enabled: view.cards.hiredAnother.enabled,
          delay:   view.cards.hiredAnother.delay,
          message: view.cards.hiredAnother.message,
        });
        setOptOutStopAi(view.cards.optOut.stopAi);
        setKeyDetails({
          notifyOnPhone:     view.cards.keyDetails.notifyOnPhone,
          notifyOnSqft:      view.cards.keyDetails.notifyOnSqft,
          notifyOnQualified: view.cards.keyDetails.notifyOnQualified,
        });
      }
    }).catch(() => {
      // Non-fatal — first paint stays on defaults.
    }).finally(() => {
      if (alive) setLoading(false);
    });

    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll, accounts]);

  // Save fan-out — turns dirty fields into a partial PlaybookView, then
  // adapter splits into (settingsPatch, columnPatch) and sends to the same
  // endpoints Conversation.tsx + Services.tsx already use.
  const flushSave = async (fields: Set<DirtyField>) => {
    if (fields.size === 0) return;
    const partial: Parameters<typeof savePlaybookView>[0] = {};
    const ensureGlobal = () => (partial.global ??= {});
    const ensureCards  = () => (partial.cards  ??= {});
    if (fields.has('global.whenAiReplies'))  ensureGlobal().whenAiReplies  = whenAiReplies;
    if (fields.has('global.writingStyle'))   ensureGlobal().writingStyle   = writingStyle;
    if (fields.has('global.priceQuoteMode')) ensureGlobal().priceQuoteMode = priceQuoteMode;
    if (fields.has('bookingRequests.notifyTeam') || fields.has('bookingRequests.pauseAi') || fields.has('bookingRequests.stopOnBooked')) {
      const b: NonNullable<NonNullable<typeof partial.cards>['bookingRequests']> = {};
      if (fields.has('bookingRequests.notifyTeam'))   b.notifyTeam   = booking.notifyTeam;
      if (fields.has('bookingRequests.pauseAi'))      b.pauseAi      = booking.pauseAi;
      if (fields.has('bookingRequests.stopOnBooked')) b.stopOnBooked = booking.stopOnBooked;
      ensureCards().bookingRequests = b;
    }
    if (fields.has('humanContact.notifyTeam') || fields.has('humanContact.pauseAi')) {
      const h: NonNullable<NonNullable<typeof partial.cards>['humanContact']> = {};
      if (fields.has('humanContact.notifyTeam')) h.notifyTeam = humanContact.notifyTeam;
      // pauseAi is mirrored from booking.pauseAi — only one card should
      // ever set it in a single save, but if both did, the booking value
      // wins (assigned first in the patch above).
      if (fields.has('humanContact.pauseAi'))    h.pauseAi    = booking.pauseAi;
      ensureCards().humanContact = h;
    }
    if (fields.has('customerDefers.enabled') || fields.has('customerDefers.delay') || fields.has('customerDefers.message')) {
      const d: NonNullable<NonNullable<typeof partial.cards>['customerDefers']> = {};
      if (fields.has('customerDefers.enabled')) d.enabled = defers.enabled;
      if (fields.has('customerDefers.delay'))   d.delay   = defers.delay;
      if (fields.has('customerDefers.message')) d.message = defers.message;
      ensureCards().customerDefers = d;
    }
    if (fields.has('hiredAnother.enabled') || fields.has('hiredAnother.delay') || fields.has('hiredAnother.message')) {
      const ha: NonNullable<NonNullable<typeof partial.cards>['hiredAnother']> = {};
      if (fields.has('hiredAnother.enabled')) ha.enabled = hired.enabled;
      if (fields.has('hiredAnother.delay'))   ha.delay   = hired.delay;
      if (fields.has('hiredAnother.message')) ha.message = hired.message;
      ensureCards().hiredAnother = ha;
    }
    if (fields.has('optOut.stopAi')) {
      ensureCards().optOut = { stopAi: optOutStopAi };
    }
    if (fields.has('keyDetails.notifyOnPhone') || fields.has('keyDetails.notifyOnSqft') || fields.has('keyDetails.notifyOnQualified')) {
      const k: NonNullable<NonNullable<typeof partial.cards>['keyDetails']> = {};
      if (fields.has('keyDetails.notifyOnPhone'))     k.notifyOnPhone     = keyDetails.notifyOnPhone;
      if (fields.has('keyDetails.notifyOnSqft'))      k.notifyOnSqft      = keyDetails.notifyOnSqft;
      if (fields.has('keyDetails.notifyOnQualified')) k.notifyOnQualified = keyDetails.notifyOnQualified;
      ensureCards().keyDetails = k;
    }

    const { settingsPatch, columnPatch } = savePlaybookView(partial);
    const settingsKeys = Object.keys(settingsPatch);
    const columnKeys   = Object.keys(columnPatch);
    if (settingsKeys.length === 0 && columnKeys.length === 0) return;

    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    setSaving(true);
    setError(null);
    try {
      await Promise.all(targets.flatMap(id => [
        settingsKeys.length ? followUpApi.saveWizardSettings(id, settingsPatch).catch(() => undefined) : Promise.resolve(undefined),
        columnKeys.length   ? usersApi.updateAccountHours(id, columnPatch).catch(() => undefined)       : Promise.resolve(undefined),
      ]));
      setSavedAt(Date.now());
    } catch (e) {
      const msg = (e as { message?: string })?.message;
      setError(msg ?? 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Auto-save effect — fires whenever a tracked field changes. Snapshots and
  // clears the dirty set so concurrent edits queue safely.
  useEffect(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const fields = new Set(dirtyFieldsRef.current);
    dirtyFieldsRef.current = new Set();
    void flushSave(fields);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whenAiReplies, writingStyle, priceQuoteMode, booking, humanContact, defers, hired, optOutStopAi, keyDetails]);

  // markDirty wrappers for every user-facing setter.
  const markDirty = (f: DirtyField) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add(f);
  };
  const onWhenAi      = (v: WhenAiReplies)  => { markDirty('global.whenAiReplies');  setWhenAiReplies(v); };
  const onWriting     = (v: WritingStyle)   => { markDirty('global.writingStyle');   setWritingStyle(v); };
  const onPriceMode   = (v: PriceQuoteMode) => { markDirty('global.priceQuoteMode'); setPriceQuoteMode(v); };
  const onBookingFlag = (k: keyof typeof booking) => () => {
    markDirty(`bookingRequests.${k}` as DirtyField);
    setBooking(prev => ({ ...prev, [k]: !prev[k] }));
    // The pause toggle is mirrored on Human Contact — re-render of that card
    // reads from booking.pauseAi directly so no extra state mutation is
    // needed.
  };
  const onHumanFlag   = (k: 'notifyTeam') => () => {
    markDirty(`humanContact.${k}` as DirtyField);
    setHumanContact(prev => ({ ...prev, [k]: !prev[k] }));
  };
  const onHumanPauseMirror = () => {
    // Toggling the mirrored pause from Card 2 writes to the same key, so we
    // flip booking.pauseAi (the source of truth in local state) AND mark the
    // booking dirty field so flushSave picks it up.
    markDirty('bookingRequests.pauseAi');
    setBooking(prev => ({ ...prev, pauseAi: !prev.pauseAi }));
  };
  const onDeferFlag   = (k: keyof typeof defers) => (v: typeof defers[typeof k]) => {
    markDirty(`customerDefers.${k}` as DirtyField);
    setDefers(prev => ({ ...prev, [k]: v }));
  };
  const onHiredFlag   = (k: keyof typeof hired) => (v: typeof hired[typeof k]) => {
    markDirty(`hiredAnother.${k}` as DirtyField);
    setHired(prev => ({ ...prev, [k]: v }));
  };
  const onOptOut = () => {
    markDirty('optOut.stopAi');
    setOptOutStopAi(v => !v);
  };
  const onKeyDetail = (k: keyof typeof keyDetails) => () => {
    markDirty(`keyDetails.${k}` as DirtyField);
    setKeyDetails(prev => ({ ...prev, [k]: !prev[k] }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      {/* ─── AI Settings (global controls, top of page) ─── */}
      <SectionCard padding="22px 24px 24px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
          <IconTile icon={Brain} tone="violet" size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              AI Settings
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Global controls — when AI replies, how AI writes, and how AI quotes price.
              These apply across the entire Playbook below.
            </div>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
            flex: '0 0 720px',
          }}>
            {STRATEGIES.map(s => (
              <StrategyCard
                key={s.k}
                selected={writingStyle === s.k}
                onClick={() => onWriting(s.k)}
                icon={s.icon}
                iconTone={s.iconTone}
                title={s.title}
                body={s.body}
              />
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--lb-line-soft)', paddingTop: 16, marginTop: 4 }}>
          <FieldRow
            icon={Clock}
            iconTone="violet"
            label="When AI replies"
            sublabel="Choose when AI can auto-reply to customer messages."
            align="top"
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <OptionCard
                compact
                selected={whenAiReplies === 'always'}
                onClick={() => onWhenAi('always')}
                title="Always (24/7)"
                body="AI replies to leads at any time, day or night."
              />
              <OptionCard
                compact
                selected={whenAiReplies === 'hours'}
                onClick={() => onWhenAi('hours')}
                title="Outside of business hours"
                body="AI replies only outside your team's business-hours window — humans handle inquiries during the day."
              />
            </div>
          </FieldRow>

          <FieldRow
            icon={CircleDollarSign}
            iconTone="green"
            label="How AI quotes price"
            sublabel="Pick the format AI uses when it volunteers a price."
            align="top"
            noBorder
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <OptionCard
                compact
                selected={priceQuoteMode === 'range'}
                onClick={() => onPriceMode('range')}
                title="Range"
                body="AI gives a price range and notes the dispatcher will confirm the exact number."
              />
              <OptionCard
                compact
                selected={priceQuoteMode === 'exact'}
                onClick={() => onPriceMode('exact')}
                title="Exact"
                body="AI gives an exact price when it has enough information."
              />
            </div>
          </FieldRow>
        </div>
      </SectionCard>

      {/* ─── Playbook cards ─── */}

      {/* Card 1 — Booking requests */}
      <SettingCard
        icon={CalendarCheck}
        iconTone="green"
        title="When customer wants to book"
        subtitle="Booking signal — customer says they're ready to schedule."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ToggleRow
            icon={Users}
            iconTone="orange"
            label="Notify your team"
            on={booking.notifyTeam}
            onChange={onBookingFlag('notifyTeam')}
          />
          <ToggleRow
            icon={HeartHandshake}
            iconTone="purple"
            label="Pause AI for booking or human request"
            on={booking.pauseAi}
            onChange={onBookingFlag('pauseAi')}
          />
          <ToggleRow
            icon={CalendarCheck}
            iconTone="green"
            label="Stop AI when the job is booked"
            on={booking.stopOnBooked}
            onChange={onBookingFlag('stopOnBooked')}
          />
        </div>
      </SettingCard>

      {/* Card 2 — Human contact requests */}
      <SettingCard
        icon={PhoneCall}
        iconTone="purple"
        title="When customer asks for a person"
        subtitle="Live contact signal — customer wants to talk to a human."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ToggleRow
            icon={Users}
            iconTone="orange"
            label="Notify your team"
            on={humanContact.notifyTeam}
            onChange={onHumanFlag('notifyTeam')}
          />
          <ToggleRow
            icon={HeartHandshake}
            iconTone="purple"
            label="Pause AI for booking or human request"
            on={booking.pauseAi}
            onChange={onHumanPauseMirror}
          />
        </div>
        <div style={{
          marginTop: 10,
          padding: '8px 12px',
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 8,
          fontSize: 12, color: 'var(--lb-ink-5)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Info size={13} />
          The pause toggle is shared with <strong>Booking requests</strong>. Changing it here changes it there.
        </div>
      </SettingCard>

      {/* Card 4 — Customer defers (Card 3 / Price Objections is hidden in Phase 2) */}
      <SettingCard
        icon={Hourglass}
        iconTone="blue"
        title="When customer asks to be contacted later"
        subtitle="Deferral signal — customer wants to revisit in days or weeks."
        enabled={defers.enabled}
        onToggle={onDeferFlag('enabled')}
      >
        <FieldRow
          icon={Clock}
          iconTone="violet"
          label="Wait"
          sublabel="How long to wait before checking in."
          align="center"
        >
          <DelayPicker value={defers.delay} onChange={onDeferFlag('delay')} />
        </FieldRow>
        <FieldRow
          icon={MessageCircleQuestion}
          iconTone="blue"
          label="Check-in message"
          sublabel="Template used when AI re-engages."
          align="top"
          noBorder
        >
          <MessageEditor value={defers.message} onChange={onDeferFlag('message')} />
        </FieldRow>
      </SettingCard>

      {/* Card 5 — Hired another company */}
      <SettingCard
        icon={CircleSlash}
        iconTone="rose"
        title="When customer says they hired another company"
        subtitle="Lost-to-competitor signal — recoverable later if the job goes sideways."
        enabled={hired.enabled}
        onToggle={onHiredFlag('enabled')}
      >
        <FieldRow
          icon={Clock}
          iconTone="violet"
          label="Wait"
          sublabel="How long to wait before reaching back out."
          align="center"
        >
          <DelayPicker value={hired.delay} onChange={onHiredFlag('delay')} />
        </FieldRow>
        <FieldRow
          icon={MessageCircleQuestion}
          iconTone="blue"
          label="Re-engage message"
          sublabel="Template used when AI follows up."
          align="top"
          noBorder
        >
          <MessageEditor value={hired.message} onChange={onHiredFlag('message')} />
        </FieldRow>
      </SettingCard>

      {/* Card 6 — Opt-out */}
      <SettingCard
        icon={CircleSlash}
        iconTone="gray"
        title="When customer asks not to be contacted"
        subtitle="Opt-out signal — AI must stop reaching out immediately."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ToggleRow
            icon={CircleSlash}
            iconTone="gray"
            label="Stop AI when customer opts out"
            on={optOutStopAi}
            onChange={onOptOut}
          />
        </div>
      </SettingCard>

      {/* Card 7 — Key details collected */}
      <SettingCard
        icon={BadgeCheck}
        iconTone="cyan"
        title="When key details are collected"
        subtitle="Notify the team when the customer shares useful information AI alone can't act on."
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <ToggleRow
            icon={Smartphone}
            iconTone="blue"
            label="Phone number provided"
            on={keyDetails.notifyOnPhone}
            onChange={onKeyDetail('notifyOnPhone')}
          />
          <ToggleRow
            icon={Ruler}
            iconTone="orange"
            label="Square footage provided"
            on={keyDetails.notifyOnSqft}
            onChange={onKeyDetail('notifyOnSqft')}
          />
          <ToggleRow
            icon={BadgeCheck}
            iconTone="cyan"
            label="Qualification complete"
            on={keyDetails.notifyOnQualified}
            onChange={onKeyDetail('notifyOnQualified')}
          />
        </div>
      </SettingCard>

      {/* Advanced link footer */}
      <SectionCard padding="18px 24px">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>Looking for the technical settings?</div>
            <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
              The original AI Conversation settings page is still available as Advanced. Same data, same behavior — different grouping.
            </div>
          </div>
          <button
            type="button"
            onClick={() => navigate('/automation/convert')}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'transparent', border: '1px solid var(--lb-line)', borderRadius: 8,
              padding: '8px 14px', cursor: 'pointer', fontFamily: 'inherit',
              fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)',
            }}
          >
            Open Advanced
            <ArrowRight size={14} />
          </button>
        </div>
      </SectionCard>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Small subcomponents
// ───────────────────────────────────────────────────────────────────────────

function StrategyCard({
  selected, onClick, icon, iconTone, title, body,
}: {
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        textAlign: 'left', padding: '14px 12px 14px',
        background: selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 8 }}>
        <Radio selected={selected} />
      </div>
      <div style={{ height: 6 }} />
      <IconTile icon={icon} tone={iconTone} size="md" />
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', textAlign: 'center', lineHeight: 1.4 }}>{body}</div>
    </button>
  );
}

function DelayPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      {DELAY_OPTIONS.map(opt => {
        const selected = value === opt;
        return (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            style={{
              padding: '6px 12px', borderRadius: 999,
              background: selected ? 'var(--lb-accent)' : 'white',
              color: selected ? 'white' : 'var(--lb-ink-2)',
              border: '1px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}

function MessageEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      rows={3}
      style={{
        width: '100%', boxSizing: 'border-box',
        padding: '10px 12px',
        border: '1px solid var(--lb-line)', borderRadius: 8,
        fontFamily: 'inherit', fontSize: 13, lineHeight: 1.5,
        color: 'var(--lb-ink-1)', background: 'white',
        resize: 'vertical',
      }}
    />
  );
}
