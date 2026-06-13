import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  PhoneOff, Sparkles,
  RefreshCw, Clock, UserX, Info, Power,
} from 'lucide-react';
import {
  SettingCard, SectionCard, FieldRow, OptionCard,
  Dropdown, ActionLink, IconTile, FooterBanner, StatusPill, MixedBadge,
  type IconTone,
} from '../../components/automation/ui';
import type { LucideIcon } from 'lucide-react';
import { followUpApi, usersApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { formatQuietHoursSummary } from '../../lib/businessHours';

// Strategy meta — mirrors the picker on AutomationConversation. Used to
// Strategy key (followUpStrategy in JSON) is preserved on save but no longer
// shown in this page's UI per the Automation Simplification: AI-first
// surfaces (Respond + Followups) don't expose Goal selection — Goals live
// only on AI Conversation. The type stays for the save-merge logic that
// reads/writes followUpStrategy from cachedAccount.
type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';
// Accept legacy 'hybrid' and 'convert' as valid saved values for back-compat.
// The backend runtime continues to honour them via STRATEGY_PROMPTS — no DB
// write happens from this page (Followups preserves prev.followUpStrategy
// on save).
const isStrategyKey = (v: unknown): v is StrategyKey =>
  v === 'auto' || v === 'hybrid' || v === 'price' || v === 'qualify' || v === 'convert' || v === 'phone';

// Module-level cache for instant tab switching + delay-free mixed detection.
type CachedFollowups = {
  // Master ON/OFF — derived from followUpMode. Off when followUpMode is
  // null or the literal 'off'. ON snaps to auto_send (+ AI if plan allows).
  followUpsOn: boolean;
  quietOn: boolean;
  deliveryMode: 'suggest' | 'active';
  messageMode: 'template' | 'ai';
  activeHoursStart: string;
  activeHoursEnd: string;
  timezone: string;
  resumeDelay: string;
  deferralDelay: string;
  hiredDelay: string;
  // Read-only on this page (edited in AutomationConversation). Cached so
  // the AI Strategy tile under Follow-up mode reflects the saved value.
  followUpStrategy: StrategyKey;
};
const followupsCache = new Map<string, CachedFollowups>();

export function AutomationFollowups({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'Follow-ups' };
  const accounts = useAppStore(s => s.savedAccounts);
  const isAll = accountId === 'all';

  // AI follow-ups are available on every plan as of the AI-First
  // Simplification (June 2026). Paywalls remain on AI Conversation
  // (per-goal control on /automation/convert) and other advanced features,
  // but the AI message-mode itself is free so users can experience AI
  // before paying for it. canUseAi is kept as `true` here so the existing
  // call sites keep working without further wiring; the useAuthStore
  // import remains because other future logic may still need it.
  const user = useAuthStore(s => s.user);
  void user; // satisfy unused-locals lint while preserving the import
  const canUseAi = true;

  // Master ON/OFF — single source of truth for follow-ups being active.
  // DB column followUpMode has three states: 'off' | 'suggest' | 'auto_send'.
  // The new UI collapses 'suggest' + 'auto_send' under ON and adds an
  // explicit OFF state so users can disable follow-ups entirely without
  // visiting the legacy Services page.
  const [followUpsOn, setFollowUpsOn] = useState(false);
  // 'suggest' UI mode → API 'suggest'; 'active' UI mode → API 'auto_send'.
  const [quietOn, setQuietOn] = useState(true);
  const [deliveryMode, setDeliveryMode] = useState<'suggest' | 'active'>('active');
  const [messageMode, setMessageMode] = useState<'template' | 'ai'>('ai');
  const [activeHoursStart, setActiveHoursStart] = useState('09:00');
  const [activeHoursEnd, setActiveHoursEnd] = useState('18:00');
  const [timezone, setTimezone] = useState('America/New_York');
  const [_platform, setPlatform] = useState<string | undefined>(undefined);
  // Three follow-up rule dropdowns persist to followUpSettingsJson via
  // fuReEnrollDelay / aiDeferralDelay / aiHiredCompetitorDelay.
  const [resumeDelay, setResumeDelay] = useState('12 hours');
  const [deferralDelay, setDeferralDelay] = useState('3 days');
  const [hiredDelay, setHiredDelay] = useState('3 weeks');
  // Read-only AI Strategy + Quiet Hours summary. AI Strategy is per-account
  // (lives in followUpSettingsJson.followUpStrategy); Quiet Hours times are
  // user-level (User.quietHours*) and fetched once below.
  const [followUpStrategy, setFollowUpStrategy] = useState<StrategyKey>('auto');
  const [quietSummary, setQuietSummary] = useState<string>('Loading…');
  const [quietTzLabel, setQuietTzLabel] = useState<string>('');

  const [loading, setLoading] = useState(false);
  // Preserved for potential busy-state UI later; underscore-prefixed to silence the unused-locals lint.
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Dirty flag — set ONLY by user-facing setter wrappers (onX below). Load
  // callbacks don't touch this, so the auto-save effect never fires after a
  // tab switch unless the user actually changed something.
  const dirtyRef = useRef(false);
  // Set of FIELD NAMES the user touched since the last save. Without this,
  // flipping one toggle in All-Accounts mode would fan out the entire local
  // state to every account, wiping out their per-account values for any
  // setting the user never touched on this visit.
  type FollowupsField =
    | 'followUpsOn'
    | 'quietOn' | 'deliveryMode' | 'messageMode'
    | 'activeHoursStart' | 'activeHoursEnd' | 'timezone'
    | 'resumeDelay' | 'deferralDelay' | 'hiredDelay';
  const dirtyFieldsRef = useRef<Set<FollowupsField>>(new Set());
  // hydratedForRef removed — replaced with dirtyRef. Kept the scopeKey alias
  // for compatibility with effect deps below.
  const scopeKey = isAll ? '__all__' : accountId;
  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Capture platform when we know the account so saveSettings can fan-out seeding.
  useEffect(() => {
    if (isAll) { setPlatform(undefined); return; }
    const acc = accounts.find(a => a.id === accountId);
    setPlatform(acc?.platform);
  }, [accountId, isAll, accounts]);

  // Reset dirty on scope change so the next user action triggers save fresh.
  useEffect(() => { dirtyRef.current = false; dirtyFieldsRef.current = new Set(); }, [accountId, isAll]);

  const parseSettings = (s: any, accountHoursQuiet?: boolean): CachedFollowups => ({
    // Master toggle is ON whenever followUpMode is a non-off value
    // ('suggest' or 'auto_send'). Null/missing maps to OFF (the default
    // for new accounts and the legacy column's NULL state).
    followUpsOn: s?.followUpMode != null && s?.followUpMode !== 'off',
    quietOn: accountHoursQuiet !== undefined ? accountHoursQuiet : true,
    deliveryMode: s?.followUpMode === 'auto_send' ? 'active' : 'suggest',
    messageMode: s?.followUpReplyType === 'template' ? 'template' : 'ai',
    activeHoursStart: s?.followUpActiveHoursStart || '09:00',
    activeHoursEnd: s?.followUpActiveHoursEnd || '18:00',
    timezone: s?.followUpTimezone || 'America/New_York',
    resumeDelay: s?.fuReEnrollDelay || '12 hours',
    deferralDelay: s?.aiDeferralDelay || '3 days',
    hiredDelay: s?.aiHiredCompetitorDelay || '3 weeks',
    followUpStrategy: isStrategyKey(s?.followUpStrategy) ? s.followUpStrategy : 'auto',
  });

  // User-level quiet hours — independent of selected account. The Quiet
  // hours card under Follow-ups shows the saved start/end/timezone.
  useEffect(() => {
    let alive = true;
    usersApi.getQuietHours()
      .then(qh => {
        if (!alive) return;
        setQuietSummary(formatQuietHoursSummary(qh.start, qh.end, qh.timezone));
        setQuietTzLabel(qh.timezone || '');
      })
      .catch(() => { if (alive) { setQuietSummary('See Settings → Hours'); setQuietTzLabel(''); } });
    return () => { alive = false; };
  }, []);

  // Hydrate displayed values from cache on scope change (instant).
  useEffect(() => {
    if (isAll) {
      const cached = accounts.map(a => followupsCache.get(a.id)).filter(Boolean) as CachedFollowups[];
      if (cached.length > 0 && !dirtyRef.current) {
        const first = cached[0];
        setFollowUpsOn(first.followUpsOn);
        setQuietOn(first.quietOn);
        setDeliveryMode(first.deliveryMode);
        setMessageMode(first.messageMode);
        setActiveHoursStart(first.activeHoursStart);
        setActiveHoursEnd(first.activeHoursEnd);
        setTimezone(first.timezone);
        setResumeDelay(first.resumeDelay);
        setDeferralDelay(first.deferralDelay);
        setHiredDelay(first.hiredDelay);
        setFollowUpStrategy(first.followUpStrategy);
      }
    } else {
      const cached = followupsCache.get(accountId);
      if (cached && !dirtyRef.current) {
        setFollowUpsOn(cached.followUpsOn);
        setQuietOn(cached.quietOn);
        setDeliveryMode(cached.deliveryMode);
        setMessageMode(cached.messageMode);
        setActiveHoursStart(cached.activeHoursStart);
        setActiveHoursEnd(cached.activeHoursEnd);
        setTimezone(cached.timezone);
        setResumeDelay(cached.resumeDelay);
        setDeferralDelay(cached.deferralDelay);
        setHiredDelay(cached.hiredDelay);
        setFollowUpStrategy(cached.followUpStrategy);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll]);

  // Background fetch — fetches both follow-up settings AND account hours
  // (the latter carries the quiet-hours toggle which is stored per-account).
  useEffect(() => {
    let alive = true;
    if (isAll) {
      if (accounts.length === 0) return;
      setLoading(true);
      Promise.all(accounts.map(a => Promise.all([
        followUpApi.getSettings(a.id).catch(() => ({ settings: null })),
        usersApi.getAccountHours(a.id).catch(() => null),
      ]))).then(results => {
        if (!alive) return;
        results.forEach(([res, hours]: any[], i) => {
          const parsed = parseSettings(res?.settings, hours?.followUpsApplyQuietHours);
          followupsCache.set(accounts[i].id, parsed);
        });
        if (!dirtyRef.current && accounts.length > 0) {
          const first = followupsCache.get(accounts[0].id);
          if (first) {
            setFollowUpsOn(first.followUpsOn);
            setQuietOn(first.quietOn);
            setDeliveryMode(first.deliveryMode);
            setMessageMode(first.messageMode);
            setActiveHoursStart(first.activeHoursStart);
            setActiveHoursEnd(first.activeHoursEnd);
            setTimezone(first.timezone);
            setResumeDelay(first.resumeDelay);
            setDeferralDelay(first.deferralDelay);
            setHiredDelay(first.hiredDelay);
            setFollowUpStrategy(first.followUpStrategy);
          }
        }
      }).finally(() => { if (alive) setLoading(false); });
    } else {
      setLoading(true); setError(null);
      Promise.all([
        followUpApi.getSettings(accountId).catch(() => ({ settings: null })),
        usersApi.getAccountHours(accountId).catch(() => null),
      ]).then(([res, hours]: any[]) => {
        if (!alive) return;
        const parsed = parseSettings(res?.settings, hours?.followUpsApplyQuietHours);
        followupsCache.set(accountId, parsed);
        if (!dirtyRef.current) {
          setFollowUpsOn(parsed.followUpsOn);
          setQuietOn(parsed.quietOn);
          setDeliveryMode(parsed.deliveryMode);
          setMessageMode(parsed.messageMode);
          setActiveHoursStart(parsed.activeHoursStart);
          setActiveHoursEnd(parsed.activeHoursEnd);
          setTimezone(parsed.timezone);
          setResumeDelay(parsed.resumeDelay);
          setDeferralDelay(parsed.deferralDelay);
          setHiredDelay(parsed.hiredDelay);
          setFollowUpStrategy(parsed.followUpStrategy);
        }
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll, accounts]);

  // Save ONLY the fields the user touched since the last save. Untouched
  // fields are NOT written, so each account keeps its per-account values
  // for anything the user didn't explicitly change here.
  const handleSave = async (fields: Set<FollowupsField>) => {
    if (fields.size === 0) return;
    // wizard payload — only include keys for fields actually touched.
    const wizardPayload: Record<string, unknown> = {};
    // Master toggle write order matters: when followUpsOn was touched in the
    // SAME save as deliveryMode, the deliveryMode write wins (covers the
    // implicit 'auto_send' snap on a fresh ON). When followUpsOn is the only
    // touched master field, write 'off' or 'auto_send' (+ AI if allowed).
    if (fields.has('followUpsOn')) {
      if (followUpsOn) {
        wizardPayload.mode = 'auto_send';
        if (canUseAi) wizardPayload.replyType = 'ai';
      } else {
        wizardPayload.mode = 'off';
      }
    }
    if (fields.has('deliveryMode'))     wizardPayload.mode      = deliveryMode === 'active' ? 'auto_send' : 'suggest';
    if (fields.has('messageMode'))      wizardPayload.replyType = messageMode;
    if (fields.has('activeHoursStart')) wizardPayload.activeHoursStart = activeHoursStart;
    if (fields.has('activeHoursEnd'))   wizardPayload.activeHoursEnd   = activeHoursEnd;
    if (fields.has('timezone'))         wizardPayload.timezone         = timezone;
    if (fields.has('resumeDelay'))      wizardPayload.fuReEnrollDelay        = resumeDelay;
    if (fields.has('deferralDelay'))    wizardPayload.aiDeferralDelay        = deferralDelay;
    if (fields.has('hiredDelay'))       wizardPayload.aiHiredCompetitorDelay = hiredDelay;
    // 'preset' was always passed before — keep only when deliveryMode is part
    // of this save, since the backend ignores it for unrelated saves anyway.
    if (fields.has('deliveryMode')) wizardPayload.preset = 'smart';

    const hasWizardWork = Object.keys(wizardPayload).length > 0;
    const hasHoursWork  = fields.has('quietOn');

    // Optimistic cache merge — keep prior values for fields the user didn't
    // touch on each account.
    const targets = isAll ? accounts : (accounts.find(a => a.id === accountId) ? [accounts.find(a => a.id === accountId)!] : []);
    targets.forEach(a => {
      const prev = followupsCache.get(a.id);
      if (!prev) {
        followupsCache.set(a.id, {
          followUpsOn, quietOn, deliveryMode, messageMode, activeHoursStart, activeHoursEnd, timezone,
          resumeDelay, deferralDelay, hiredDelay, followUpStrategy,
        });
        return;
      }
      followupsCache.set(a.id, {
        followUpsOn:      fields.has('followUpsOn')      ? followUpsOn      : prev.followUpsOn,
        quietOn:          fields.has('quietOn')          ? quietOn          : prev.quietOn,
        // When the master toggle flips ON in this save, mirror the
        // implicit deliveryMode='active' + (if AI plan) messageMode='ai'
        // into the cache so a follow-up save in the same session knows
        // the new shape without round-tripping the API.
        deliveryMode:
          fields.has('deliveryMode') ? deliveryMode
            : fields.has('followUpsOn') && followUpsOn ? 'active'
              : prev.deliveryMode,
        messageMode:
          fields.has('messageMode') ? messageMode
            : fields.has('followUpsOn') && followUpsOn && canUseAi ? 'ai'
              : prev.messageMode,
        activeHoursStart: fields.has('activeHoursStart') ? activeHoursStart : prev.activeHoursStart,
        activeHoursEnd:   fields.has('activeHoursEnd')   ? activeHoursEnd   : prev.activeHoursEnd,
        timezone:         fields.has('timezone')         ? timezone         : prev.timezone,
        resumeDelay:      fields.has('resumeDelay')      ? resumeDelay      : prev.resumeDelay,
        deferralDelay:    fields.has('deferralDelay')    ? deferralDelay    : prev.deferralDelay,
        hiredDelay:       fields.has('hiredDelay')       ? hiredDelay       : prev.hiredDelay,
        // followUpStrategy is read-only on this page — preserve prev or
        // fall back to the displayed value (loaded from getSettings).
        followUpStrategy: prev.followUpStrategy ?? followUpStrategy,
      });
    });

    setSaving(true); setError(null);
    try {
      const writes: Promise<unknown>[] = [];
      for (const a of targets) {
        if (hasWizardWork) {
          writes.push(followUpApi.saveWizardSettings(a.id, { ...wizardPayload, platform: a.platform }).catch(() => undefined));
        }
        if (hasHoursWork) {
          writes.push(usersApi.updateAccountHours(a.id, { followUpsApplyQuietHours: quietOn }).catch(() => undefined));
        }
      }
      await Promise.all(writes);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Mixed-state detection from cache.
  function getMixedF<K extends keyof CachedFollowups>(
    key: K,
    fmt: (v: CachedFollowups[K]) => string,
  ): { mixed: boolean; tooltip?: string } {
    if (!isAll) return { mixed: false };
    const entries = accounts
      .map(a => ({ account: a, cached: followupsCache.get(a.id) }))
      .filter(x => x.cached !== undefined) as { account: typeof accounts[0]; cached: CachedFollowups }[];
    if (entries.length < 2) return { mixed: false };
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(String(e.cached[key]), (counts.get(String(e.cached[key])) || 0) + 1);
    let majorityKey = String(entries[0].cached[key]);
    let maxCount = 0;
    counts.forEach((c, k) => { if (c > maxCount) { maxCount = c; majorityKey = k; } });
    const majorityEntry = entries.find(e => String(e.cached[key]) === majorityKey)!;
    const deviants = entries.filter(e => String(e.cached[key]) !== majorityKey);
    if (deviants.length === 0) return { mixed: false };
    const tooltip =
      `Most accounts: ${fmt(majorityEntry.cached[key])}\n` +
      `Differs in:\n` +
      deviants.map(d => `  • ${d.account.businessName || d.account.platform}: ${fmt(d.cached[key])}`).join('\n');
    return { mixed: true, tooltip };
  }
  const mixedMaster   = getMixedF('followUpsOn', v => v ? 'On' : 'Off');
  const mixedDelivery = getMixedF('deliveryMode', v => v === 'active' ? 'Active (auto-send)' : 'Suggest');
  const mixedMessage  = getMixedF('messageMode', v => v === 'ai' ? 'AI (auto)' : 'Custom template');
  const mixedQuiet    = getMixedF('quietOn', v => v ? 'On' : 'Off');
  const mixedResume   = getMixedF('resumeDelay', v => String(v));
  const mixedDeferral = getMixedF('deferralDelay', v => String(v));
  const mixedHired    = getMixedF('hiredDelay', v => String(v));

  // Auto-save IMMEDIATELY on every USER change. We snapshot the dirty-fields
  // set, clear it, then pass to handleSave so only those fields are written.
  useEffect(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const fields = new Set(dirtyFieldsRef.current);
    dirtyFieldsRef.current = new Set();
    setSavedAt(Date.now()); // optimistic
    handleSave(fields);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followUpsOn, deliveryMode, messageMode, activeHoursStart, activeHoursEnd, timezone, quietOn, resumeDelay, deferralDelay, hiredDelay]);

  // markDirty-wrapped setters used by JSX. Each setter adds its specific
  // field name so the save only writes the keys the user changed.
  const onFollowUpsOn = (v: boolean) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('followUpsOn');
    // Snap downstream UI fields to the implied state so the cards render
    // consistently the moment the master toggle flips. The save payload
    // mirrors the same snap server-side.
    if (v) {
      setDeliveryMode('active');
      if (canUseAi) setMessageMode('ai');
    }
    setFollowUpsOn(v);
  };
  const onDeliveryMode  = (v: 'suggest' | 'active') => { dirtyRef.current = true; dirtyFieldsRef.current.add('deliveryMode');  setDeliveryMode(v); };
  const onMessageMode   = (v: 'template' | 'ai')    => { dirtyRef.current = true; dirtyFieldsRef.current.add('messageMode');   setMessageMode(v); };
  const onQuietOn       = (v: boolean)              => { dirtyRef.current = true; dirtyFieldsRef.current.add('quietOn');       setQuietOn(v); };
  const onResumeDelay   = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('resumeDelay');   setResumeDelay(v); };
  const onDeferralDelay = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('deferralDelay'); setDeferralDelay(v); };
  const onHiredDelay    = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('hiredDelay');    setHiredDelay(v); };
  // scopeKey kept as void-reference to satisfy noUnusedLocals on the alias.
  void scopeKey;

  // goAiSettings was used by the now-removed Conversation Goal tile. AI
  // Conversation is still reachable via the sidebar; we don't need a
  // per-card link from here anymore.
  const goQuietSettings = () => navigate('/settings?tab=hours', { state: fromState });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      {/* Master Follow-ups toggle — single source of truth for whether
          follow-ups run at all. OFF writes followUpMode='off'; ON snaps to
          'auto_send' (and AI message mode when the plan allows). Other
          cards below are hidden until the master is ON, matching the
          legacy Services page behavior. */}
      <SettingCard
        icon={Power}
        iconTone="violet"
        title="Follow-ups"
        subtitle={followUpsOn
          ? 'Automatically follow up with leads who stop responding.'
          : 'Turn on to start following up with leads who stop responding.'}
        enabled={followUpsOn}
        onToggle={onFollowUpsOn}
        mixed={mixedMaster.mixed}
        mixedTooltip={mixedMaster.tooltip}
      />

      {!followUpsOn ? null : <>

      {/* Quiet hours */}
      <SettingCard
        icon={PhoneOff}
        iconTone="violet"
        title="Quiet hours"
        subtitle="Don't send follow-ups overnight."
        enabled={quietOn}
        onToggle={onQuietOn}
        mixed={mixedQuiet.mixed}
        mixedTooltip={mixedQuiet.tooltip}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, paddingTop: 4,
        }}>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-2)' }}>
              <span style={{ fontWeight: 500 }}>Quiet hours: </span>
              <span style={{ fontWeight: 700 }}>{quietSummary}</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
              {quietTzLabel ? `${quietTzLabel} (daily)` : 'daily'}
            </div>
          </div>
          <ActionLink external onClick={goQuietSettings}>Edit in Settings</ActionLink>
        </div>
      </SettingCard>

      {/* Follow-up mode */}
      <SectionCard padding="20px 24px 8px">
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Follow-up mode
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
            Choose how follow-ups are delivered and composed.
          </div>
        </div>

        <FieldRow label="Delivery mode" sublabel="How follow-ups are sent." align="top">
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={deliveryMode === 'suggest'}
              onClick={() => onDeliveryMode('suggest')}
              title="Suggest"
              body="Draft follow-ups for you to review and approve."
              mixed={mixedDelivery.mixed && deliveryMode === 'suggest'}
              mixedTooltip={mixedDelivery.tooltip}
            />
            <OptionCard
              selected={deliveryMode === 'active'}
              onClick={() => onDeliveryMode('active')}
              title="Active"
              body="Send follow-ups automatically without approval."
              mixed={mixedDelivery.mixed && deliveryMode === 'active'}
              mixedTooltip={mixedDelivery.tooltip}
            />
          </div>
        </FieldRow>

        <FieldRow label="Message generation" sublabel="How follow-up messages are composed." align="top" noBorder>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', gap: 12 }}>
              {/* AI first — AI-first is the product default. */}
              <OptionCard
                selected={messageMode === 'ai'}
                onClick={() => onMessageMode('ai')}
                title="AI"
                body="AI writes each follow-up from the live conversation."
                mixed={mixedMessage.mixed && messageMode === 'ai'}
                mixedTooltip={mixedMessage.tooltip}
              />
              <OptionCard
                selected={messageMode === 'template'}
                onClick={() => onMessageMode('template')}
                title="Custom template"
                body="Use your saved template for all follow-up messages."
                mixed={mixedMessage.mixed && messageMode === 'template'}
                mixedTooltip={mixedMessage.tooltip}
              />
            </div>
            {messageMode === 'ai' && (
              <div style={{
                padding: '12px 14px',
                background: '#f8fafc',
                border: '1px solid var(--lb-line-soft)',
                borderRadius: 10,
                fontSize: 13, color: 'var(--lb-ink-3)',
                lineHeight: 1.55,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 6 }}>AI follow-ups use:</div>
                <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
                  {[
                    'Conversation history',
                    'Business Information',
                    'FAQ',
                    'Pricing Guidance',
                    'AI Playbook',
                  ].map(item => (
                    <li key={item} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ color: 'var(--lb-success)', fontWeight: 700 }}>✓</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {messageMode === 'template' && (
              // Bug fix (2026-06-12): Custom template mode previously showed
              // no path to manage the underlying templates. Linking to the
              // Templates library filtered to auto-reply (the bucket the
              // follow-up step templates land in — see MessageSettings.tsx
              // getTemplateFilter).
              <div style={{
                padding: '12px 14px',
                background: '#f8fafc',
                border: '1px solid var(--lb-line-soft)',
                borderRadius: 10,
                fontSize: 13, color: 'var(--lb-ink-3)',
                lineHeight: 1.55,
              }}>
                <div style={{ fontWeight: 700, color: 'var(--lb-ink-1)', marginBottom: 6 }}>
                  Follow-up templates
                </div>
                <div style={{ marginBottom: 10 }}>
                  Each follow-up step uses a saved template. Manage which templates run for which step in your library.
                </div>
                <Link
                  to="/templates?filter=auto-reply"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    color: 'var(--lb-accent)', fontWeight: 600, textDecoration: 'none',
                  }}
                >
                  Manage templates →
                </Link>
              </div>
            )}
          </div>
        </FieldRow>
      </SectionCard>

      {/* Follow-up plan — read-only summary.
          The grid that used to live here was UI-only (setPlan touched local
          React state but no save effect persisted it), so editing the
          numbers gave users false confidence. The plan itself is driven
          by the backend follow-up engine seed templates; per-step custom
          delays are configurable via API (followUpSettingsJson.customStepDelays
          / customStepEnabled) and exposed elsewhere when needed. */}
      <SectionCard padding="20px 24px 24px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Follow-up plan
          </div>
          <Sparkles size={14} style={{ color: 'var(--lb-accent)' }} />
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
          LeadBridge follows up with unresponsive leads over an 11-step schedule
          spanning up to one year. AI writes each step from the live conversation;
          timing is managed by the system to match standard best practices.
        </div>
      </SectionCard>

      {/* Stacked rule cards */}
      <SectionCard padding="0">
        <RuleCardRow
          icon={RefreshCw}
          iconTone="green"
          title="Resume follow-ups after conversation"
          body="When a customer replies and then goes silent again, start a new follow-up sequence."
          fieldLabel="Wait before resuming"
          fieldValue={resumeDelay}
          onFieldChange={onResumeDelay}
          fieldOptions={['1 hour', '6 hours', '12 hours', '24 hours', '48 hours']}
          tipIcon={Sparkles}
          tip="How long to wait after your last message before starting follow-ups again."
          mixed={mixedResume.mixed}
          mixedTooltip={mixedResume.tooltip}
        />
        <RuleCardRow
          icon={Clock}
          iconTone="orange"
          title="Check in after customer deferral"
          body={"When customer says \"I'll get back to you\" / \"let me think\", silence the AI and schedule one nudge later. Cancels if they reply first."}
          fieldLabel="Send check-in after"
          fieldValue={deferralDelay}
          onFieldChange={onDeferralDelay}
          fieldOptions={['1 day', '2 days', '3 days', '1 week']}
          tipIcon={Sparkles}
          tip="AI generates this check-in from the conversation using your Business Information. Switch to Custom Template above to write a fixed message instead."
          mixed={mixedDeferral.mixed}
          mixedTooltip={mixedDeferral.tooltip}
        />
        <RuleCardRow
          icon={UserX}
          iconTone="rose"
          title="Re-engage after customer hired competitor"
          body="When customer says they hired someone else, send one polite check-in later. Captures the dissatisfied ones."
          fieldLabel="Send re-engage after"
          fieldValue={hiredDelay}
          onFieldChange={onHiredDelay}
          fieldOptions={['1 week', '2 weeks', '3 weeks', '1 month']}
          tipIcon={Sparkles}
          tip="AI generates this re-engage from the conversation using your Business Information. Switch to Custom Template above to write a fixed message instead."
          mixed={mixedHired.mixed}
          mixedTooltip={mixedHired.tooltip}
          noBorder
        />
      </SectionCard>

      <FooterBanner
        icon={Info}
        body={<>Follow-ups respect quiet hours and business hours. You can edit those in <Link to="/settings?tab=hours" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Settings</Link>.</>}
      />

      </>}
    </div>
  );
}

function RuleCardRow({
  icon, iconTone, title, body, fieldLabel, fieldValue, onFieldChange, fieldOptions, tipIcon: TipIcon, tip, noBorder,
  mixed, mixedTooltip,
}: {
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
  fieldLabel: string;
  fieldValue: string;
  onFieldChange: (v: string) => void;
  fieldOptions: string[];
  tipIcon: LucideIcon;
  tip: string;
  noBorder?: boolean;
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 24,
      padding: '20px 24px',
      borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
      alignItems: 'flex-start',
      background: mixed ? '#fffbeb' : undefined,
      borderLeft: mixed ? '4px solid #f59e0b' : undefined,
    }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <IconTile icon={icon} tone={iconTone} size="md" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>{title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.5 }}>{body}</div>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {fieldLabel}
          {mixed && <MixedBadge tooltip={mixedTooltip} />}
        </div>
        <Dropdown
          value={fieldValue}
          onChange={onFieldChange}
          options={fieldOptions}
          width="100%"
        />
      </div>
      <div style={{
        display: 'flex', gap: 10,
        padding: '12px 14px',
        background: '#f8fafc',
        border: '1px solid var(--lb-line-soft)',
        borderRadius: 10,
        fontSize: 12.5, color: 'var(--lb-ink-4)',
        lineHeight: 1.5,
      }}>
        <TipIcon size={14} style={{ color: 'var(--lb-accent)', flexShrink: 0, marginTop: 1 }} />
        <div>{tip}</div>
      </div>
    </div>
  );
}
