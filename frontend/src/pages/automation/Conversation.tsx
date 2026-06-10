import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Brain, Sparkles, Scale, CircleDollarSign, UserCheck, Calendar, Phone,
  Clock, Hand, UserX, CalendarCheck, HeartHandshake, CheckSquare,
  Users, PhoneCall, Smartphone, Ruler, BadgeCheck, Info, Bell, ArrowRight,
  MessageSquareText, AlertTriangle, Power,
  type LucideIcon,
} from 'lucide-react';
import {
  SectionCard, SettingCard, FieldRow, OptionCard, ToggleRow,
  Radio, IconTile, ActionLink, AutoBadge, StatusPill,
  type IconTone,
} from '../../components/automation/ui';
import { followUpApi, usersApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { UpgradeOverlay } from '../../components/UpgradeOverlay';
import { formatBusinessHoursSummary, type BusinessHoursSchedule } from '../../lib/businessHours';

// Module-level cache that survives mount/unmount AND tab switches, so toggling
// account tabs feels instant and so the mixed-state detection has data to read
// without waiting for the network.
type CachedConvSettings = {
  strategy: 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';
  priceMode: 'range' | 'exact';
  availability: 'always' | 'hours';
  stopRules: { not_contacted: boolean; booked: boolean; price_agreed: boolean; done: boolean };
  takeover: { ready: boolean; live: boolean; phone: boolean; sqft: boolean; qualified: boolean };
};
const convCache = new Map<string, CachedConvSettings>();

type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';

const STRATEGIES: { k: StrategyKey; icon: LucideIcon; iconTone: IconTone; title: string; body: string }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',    body: 'AI picks the best strategy based on conversation context.' },
  { k: 'hybrid',  icon: Scale,            iconTone: 'gray',   title: 'Hybrid',  body: 'Balance between qualifying, converting, and pricing.' },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',   body: 'Prioritize giving price ranges proactively.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify', body: 'Ask the right questions to qualify the lead.' },
  { k: 'convert', icon: Calendar,         iconTone: 'blue',   title: 'Convert', body: 'Focus on booking and moving the lead to action.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Phone',   body: 'Encourage a phone call with your team.' },
];

export function AutomationConversation({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'AI Conversation' };
  const accounts = useAppStore(s => s.savedAccounts);
  const isAll = accountId === 'all';

  // Master AI Conversation toggle — user-scoped per the 2026-05-23 migration
  // (User.aiConversationEnabled is the single source of truth). The legacy
  // per-account write target stays put: saveSettings(accountId, {aiConversationEnabled})
  // is rewritten server-side to update the User row, regardless of which
  // account tab the user is currently on.
  const authUser = useAuthStore(s => s.user);
  const setAuthUser = useAuthStore(s => s.setAuth);
  const authToken = useAuthStore(s => s.token);
  const canUseAi = !!authUser?.trialActive || authUser?.subscriptionTier === 'ENTERPRISE';
  const [aiOn, setAiOn] = useState<boolean>(!!authUser?.aiConversationEnabled);

  const [strategy, setStrategy] = useState<StrategyKey>('auto');
  const [priceMode, setPriceMode] = useState<'range' | 'exact'>('range');
  const [availability, setAvailability] = useState<'always' | 'hours'>('always');
  const [stopRules, setStopRules] = useState({
    not_contacted: true, booked: true, price_agreed: true, done: true,
  });
  const [takeover, setTakeover] = useState({
    ready: true, live: true, phone: true, sqft: true, qualified: true,
  });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // User-level business hours, shown in the "Outside of business hours"
  // option body. Replaces a hardcoded "Mon–Fri, 9:00 AM – 6:00 PM" string.
  const [bizHoursSummary, setBizHoursSummary] = useState<string>('Loading…');
  // Dirty flag set only by user-facing setters below. Load callbacks DON'T
  // touch this, so the auto-save effect never fires on tab switch or load.
  const dirtyRef = useRef(false);
  // Set of dotted field keys the user has touched since the last save. The
  // auto-save effect only writes THESE fields — without this, flipping one
  // toggle in All-Accounts mode would fan out the WHOLE local state to every
  // account, wiping out per-account values the user never touched.
  type DirtyField =
    | 'strategy' | 'priceMode' | 'availability'
    | 'stopRules.not_contacted' | 'stopRules.booked' | 'stopRules.price_agreed' | 'stopRules.done'
    | 'takeover.ready' | 'takeover.live' | 'takeover.phone' | 'takeover.sqft' | 'takeover.qualified';
  const dirtyFieldsRef = useRef<Set<DirtyField>>(new Set());

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Keep the master toggle in sync if the auth user's aiConversationEnabled
  // changes from elsewhere (Services page, Communication page, login).
  useEffect(() => {
    setAiOn(!!authUser?.aiConversationEnabled);
  }, [authUser?.aiConversationEnabled]);

  // Reset dirty on scope change so the next user action starts fresh.
  useEffect(() => { dirtyRef.current = false; dirtyFieldsRef.current = new Set(); }, [accountId, isAll]);

  // One-time fetch of user-level business hours for the option body below.
  useEffect(() => {
    let alive = true;
    usersApi.getBusinessHours()
      .then(bh => {
        if (!alive) return;
        setBizHoursSummary(formatBusinessHoursSummary(bh.schedule as BusinessHoursSchedule, bh.timezone));
      })
      .catch(() => { if (alive) setBizHoursSummary('See Settings → Hours'); });
    return () => { alive = false; };
  }, []);

  // Helper: parse a settings payload into our local shape.
  const parseSettings = (s: any): CachedConvSettings => ({
    strategy: (s?.followUpStrategy && STRATEGIES.some(x => x.k === s.followUpStrategy))
      ? s.followUpStrategy
      : 'auto',
    priceMode: (s?.priceQuoteMode === 'exact' || s?.priceQuoteMode === 'range') ? s.priceQuoteMode : 'range',
    availability: s?.followUpAvailability === 'active_hours' ? 'hours' : 'always',
    stopRules: {
      not_contacted: s?.aiStopOnOptOut !== undefined ? !!s.aiStopOnOptOut : true,
      booked:        s?.aiStopOnBooked !== undefined ? !!s.aiStopOnBooked : true,
      price_agreed:  s?.aiStopOnPriceAgreed !== undefined ? !!s.aiStopOnPriceAgreed : true,
      done:          true,
    },
    takeover: {
      ready:     s?.handoffTriggerAgreed !== undefined ? !!s.handoffTriggerAgreed : true,
      live:      s?.handoffTriggerWantsLiveContact !== undefined ? !!s.handoffTriggerWantsLiveContact : true,
      phone:     s?.handoffTriggerProvidedPhone !== undefined ? !!s.handoffTriggerProvidedPhone : true,
      sqft:      s?.handoffTriggerProvidedSquareFootage !== undefined ? !!s.handoffTriggerProvidedSquareFootage : true,
      qualified: s?.handoffTriggerQualificationComplete !== undefined ? !!s.handoffTriggerQualificationComplete : true,
    },
  });

  // Hydrate from cache on scope change for instant display.
  useEffect(() => {
    if (isAll) {
      const cached = accounts.map(a => convCache.get(a.id)).filter(Boolean) as CachedConvSettings[];
      if (cached.length > 0 && !dirtyRef.current) {
        const first = cached[0];
        setStrategy(first.strategy);
        setPriceMode(first.priceMode);
        setAvailability(first.availability);
        setStopRules(first.stopRules);
        setTakeover(first.takeover);
      }
    } else {
      const cached = convCache.get(accountId);
      if (cached && !dirtyRef.current) {
        setStrategy(cached.strategy);
        setPriceMode(cached.priceMode);
        setAvailability(cached.availability);
        setStopRules(cached.stopRules);
        setTakeover(cached.takeover);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll]);

  // Background fetch — single account or all accounts.
  useEffect(() => {
    let alive = true;
    if (isAll) {
      if (accounts.length === 0) return;
      setLoading(true); setError(null);
      Promise.all(accounts.map(a =>
        followUpApi.getSettings(a.id).catch(() => ({ settings: null })),
      )).then(results => {
        if (!alive) return;
        results.forEach((res: any, i) => {
          if (res?.settings) convCache.set(accounts[i].id, parseSettings(res.settings));
        });
        if (!dirtyRef.current && results.length > 0) {
          const first = results.find((r: any) => r?.settings);
          if (first) {
            const parsed = parseSettings((first as any).settings);
            setStrategy(parsed.strategy);
            setPriceMode(parsed.priceMode);
            setAvailability(parsed.availability);
            setStopRules(parsed.stopRules);
            setTakeover(parsed.takeover);
          }
        }
      }).finally(() => { if (alive) setLoading(false); });
    } else {
      setLoading(true); setError(null);
      followUpApi.getSettings(accountId)
        .then((res: any) => {
          if (!alive) return;
          const s = res?.settings;
          if (s) {
            const parsed = parseSettings(s);
            convCache.set(accountId, parsed);
            if (!dirtyRef.current) {
              setStrategy(parsed.strategy);
              setPriceMode(parsed.priceMode);
              setAvailability(parsed.availability);
              setStopRules(parsed.stopRules);
              setTakeover(parsed.takeover);
            }
          }
        })
        .catch(() => { /* non-fatal */ })
        .finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll, accounts]);

  // Save ONLY the fields the user touched since the last save. Untouched
  // fields are NOT included in the payload, so each account keeps its
  // existing values for anything the user didn't explicitly change. This is
  // critical in All-Accounts mode — without it, flipping one toggle would
  // wipe out per-account values for every other setting.
  const handleSave = async (fields: Set<DirtyField>) => {
    if (fields.size === 0) return;
    const payload: Record<string, unknown> = {};
    if (fields.has('strategy'))     payload.followUpStrategy     = strategy;
    if (fields.has('priceMode'))    payload.priceQuoteMode       = priceMode;
    if (fields.has('availability')) payload.followUpAvailability = availability === 'hours' ? 'active_hours' : 'always';
    if (fields.has('stopRules.not_contacted')) payload.aiStopOnOptOut      = stopRules.not_contacted;
    if (fields.has('stopRules.booked'))        payload.aiStopOnBooked      = stopRules.booked;
    if (fields.has('stopRules.price_agreed'))  payload.aiStopOnPriceAgreed = stopRules.price_agreed;
    // stopRules.done is local-only (no backend column), so we skip writing.
    if (fields.has('takeover.ready'))     payload.handoffTriggerAgreed                = takeover.ready;
    if (fields.has('takeover.live'))      payload.handoffTriggerWantsLiveContact      = takeover.live;
    if (fields.has('takeover.phone'))     payload.handoffTriggerProvidedPhone         = takeover.phone;
    if (fields.has('takeover.sqft'))      payload.handoffTriggerProvidedSquareFootage = takeover.sqft;
    if (fields.has('takeover.qualified')) payload.handoffTriggerQualificationComplete = takeover.qualified;

    // Optimistic cache update — merge ONLY the changed fields onto each
    // account's existing cached values. Don't replace the whole object, or
    // mixed-state badges would think untouched fields changed too.
    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    targets.forEach(id => {
      const prev = convCache.get(id);
      if (!prev) {
        convCache.set(id, { strategy, priceMode, availability, stopRules, takeover });
        return;
      }
      const next: CachedConvSettings = { ...prev };
      if (fields.has('strategy'))     next.strategy     = strategy;
      if (fields.has('priceMode'))    next.priceMode    = priceMode;
      if (fields.has('availability')) next.availability = availability;
      const nextStop = { ...prev.stopRules };
      if (fields.has('stopRules.not_contacted')) nextStop.not_contacted = stopRules.not_contacted;
      if (fields.has('stopRules.booked'))        nextStop.booked        = stopRules.booked;
      if (fields.has('stopRules.price_agreed'))  nextStop.price_agreed  = stopRules.price_agreed;
      if (fields.has('stopRules.done'))          nextStop.done          = stopRules.done;
      next.stopRules = nextStop;
      const nextTake = { ...prev.takeover };
      if (fields.has('takeover.ready'))     nextTake.ready     = takeover.ready;
      if (fields.has('takeover.live'))      nextTake.live      = takeover.live;
      if (fields.has('takeover.phone'))     nextTake.phone     = takeover.phone;
      if (fields.has('takeover.sqft'))      nextTake.sqft      = takeover.sqft;
      if (fields.has('takeover.qualified')) nextTake.qualified = takeover.qualified;
      next.takeover = nextTake;
      convCache.set(id, next);
    });

    setSaving(true); setError(null);
    try {
      await Promise.all(targets.map(id => followUpApi.saveWizardSettings(id, payload).catch(() => undefined)));
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // Mixed-state detection from cache — majority vs deviants, no delay.
  function getMixed<K extends keyof CachedConvSettings>(
    key: K,
    fmt: (v: CachedConvSettings[K]) => string,
  ): { mixed: boolean; tooltip?: string } {
    if (!isAll) return { mixed: false };
    const entries = accounts
      .map(a => ({ account: a, cached: convCache.get(a.id) }))
      .filter(x => x.cached !== undefined) as { account: typeof accounts[0]; cached: CachedConvSettings }[];
    if (entries.length < 2) return { mixed: false };
    // Use JSON.stringify for objects to handle stopRules/takeover deeply.
    const keyValue = (v: CachedConvSettings[K]) =>
      typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(keyValue(e.cached[key]), (counts.get(keyValue(e.cached[key])) || 0) + 1);
    let majorityKey = keyValue(entries[0].cached[key]);
    let maxCount = 0;
    counts.forEach((c, k) => { if (c > maxCount) { maxCount = c; majorityKey = k; } });
    const majorityEntry = entries.find(e => keyValue(e.cached[key]) === majorityKey)!;
    const deviants = entries.filter(e => keyValue(e.cached[key]) !== majorityKey);
    if (deviants.length === 0) return { mixed: false };
    const tooltip =
      `Most accounts: ${fmt(majorityEntry.cached[key])}\n` +
      `Differs in:\n` +
      deviants.map(d => `  • ${d.account.businessName || d.account.platform}: ${fmt(d.cached[key])}`).join('\n');
    return { mixed: true, tooltip };
  }
  const mixedStrategy     = getMixed('strategy', v => String(v).charAt(0).toUpperCase() + String(v).slice(1));
  const mixedPriceMode    = getMixed('priceMode', v => v === 'range' ? 'Range' : 'Exact');
  const mixedAvailability = getMixed('availability', v => v === 'hours' ? 'Outside of business hours' : 'Always (24/7)');

  // Per-sub-key mixed detection for object settings (stopRules, takeover).
  // Each individual toggle gets its own warning, so the user sees exactly
  // which toggle accounts disagree on instead of a blanket section warning.
  function getMixedSubKey<
    K extends 'stopRules' | 'takeover',
    S extends keyof CachedConvSettings[K],
  >(outerKey: K, subKey: S): { mixed: boolean; tooltip?: string } {
    if (!isAll) return { mixed: false };
    const entries = accounts
      .map(a => ({ account: a, cached: convCache.get(a.id) }))
      .filter(x => x.cached !== undefined) as { account: typeof accounts[0]; cached: CachedConvSettings }[];
    if (entries.length < 2) return { mixed: false };
    const counts = new Map<boolean, number>();
    for (const e of entries) {
      const v = (e.cached[outerKey] as any)[subKey] as boolean;
      counts.set(v, (counts.get(v) || 0) + 1);
    }
    let majority: boolean = (entries[0].cached[outerKey] as any)[subKey];
    let maxCount = 0;
    counts.forEach((c, v) => { if (c > maxCount) { maxCount = c; majority = v; } });
    const deviants = entries.filter(e => (e.cached[outerKey] as any)[subKey] !== majority);
    if (deviants.length === 0) return { mixed: false };
    const fmt = (b: boolean) => (b ? 'On' : 'Off');
    const tooltip =
      `Most accounts: ${fmt(majority)}\n` +
      `Differs in:\n` +
      deviants.map(d => `  • ${d.account.businessName || d.account.platform}: ${fmt((d.cached[outerKey] as any)[subKey])}`).join('\n');
    return { mixed: true, tooltip };
  }
  const mxStopNotContacted = getMixedSubKey('stopRules', 'not_contacted');
  const mxStopBooked       = getMixedSubKey('stopRules', 'booked');
  const mxStopPriceAgreed  = getMixedSubKey('stopRules', 'price_agreed');
  const mxStopDone         = getMixedSubKey('stopRules', 'done');
  const mxTakeReady        = getMixedSubKey('takeover', 'ready');
  const mxTakeLive         = getMixedSubKey('takeover', 'live');
  const mxTakePhone        = getMixedSubKey('takeover', 'phone');
  const mxTakeSqft         = getMixedSubKey('takeover', 'sqft');
  const mxTakeQualified    = getMixedSubKey('takeover', 'qualified');

  // Auto-save on every USER change. We snapshot the dirty-fields set, clear
  // it, then pass the snapshot to handleSave so only those fields are written.
  useEffect(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const fields = new Set(dirtyFieldsRef.current);
    dirtyFieldsRef.current = new Set();
    setSavedAt(Date.now());
    handleSave(fields);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategy, priceMode, availability, stopRules, takeover]);

  // markDirty-wrapped setters used by JSX. Each setter records BOTH the
  // dirty flag (gates the save effect) AND the specific field name(s) so we
  // only write what the user actually changed.
  const onStrategy     = (v: StrategyKey)            => { dirtyRef.current = true; dirtyFieldsRef.current.add('strategy');     setStrategy(v); };
  const onPriceMode    = (v: 'range' | 'exact')      => { dirtyRef.current = true; dirtyFieldsRef.current.add('priceMode');    setPriceMode(v); };
  const onAvailability = (v: 'always' | 'hours')     => { dirtyRef.current = true; dirtyFieldsRef.current.add('availability'); setAvailability(v); };

  const toggleStop = (k: keyof typeof stopRules) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add(`stopRules.${k}` as DirtyField);
    setStopRules({ ...stopRules, [k]: !stopRules[k] });
  };
  const toggleTakeover = (k: keyof typeof takeover) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add(`takeover.${k}` as DirtyField);
    setTakeover({ ...takeover, [k]: !takeover[k] });
  };

  const goFollowups = () => navigate('/automation/engage', { state: fromState });
  const goAlerts = () => navigate('/settings?tab=communication', { state: fromState });

  // Master toggle handler — writes to User.aiConversationEnabled via the
  // per-account saveSettings endpoint (server-side it's user-scope). On
  // success the auth store mirrors the new value so other pages (Services,
  // Communication, Layout badges) react without a refresh.
  const onAiToggle = async (on: boolean) => {
    if (on && !canUseAi) return;
    setAiOn(on);
    setSavedAt(Date.now());
    setSaving(true); setError(null);
    try {
      // Pick any account id to satisfy the route param; backend writes the
      // user row regardless. Fall back to first account when viewing 'all'.
      const targetId = !isAll ? accountId : accounts[0]?.id;
      if (targetId) {
        await followUpApi.saveSettings(targetId, { aiConversationEnabled: on } as any);
      }
      if (authUser && authToken) {
        setAuthUser({ ...authUser, aiConversationEnabled: on }, authToken);
      }
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
      setAiOn(!on); // rollback
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      {/* Master AI Conversation toggle + the rest of the page. Wrapped in
          UpgradeOverlay so non-Convert users still see the full UI behind a
          translucent "Upgrade to Convert" overlay — the controls aren't
          interactive, but the user can see what they'd unlock. */}
      <UpgradeOverlay tier="convert">

      <SettingCard
        icon={Power}
        iconTone="violet"
        title="AI Conversation"
        subtitle={aiOn
          ? 'AI replies to customers automatically based on your strategy.'
          : canUseAi
            ? 'Turn on to let AI handle customer conversations end-to-end.'
            : 'Turn on to let AI handle customer conversations end-to-end.'}
        enabled={aiOn}
        onToggle={onAiToggle}
      />

      {!(aiOn || !canUseAi) ? null : <>

      <SectionCard padding="22px 24px 24px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
          <IconTile icon={Brain} tone="violet" size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>AI Strategy</div>
              <AutoBadge tone="green">Applies everywhere</AutoBadge>
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Single source of truth for how AI-generated messages are written.<br />
              Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation.<br /><br />
              Pick the goal for each reply. Only Price volunteers a price proactively — the other strategies stay focused on their own goal and only quote when the customer asks.
            </div>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
            flex: '0 0 720px',
          }}>
            {STRATEGIES.map(s => (
              <StrategyCard
                key={s.k}
                selected={strategy === s.k}
                onClick={() => onStrategy(s.k)}
                icon={s.icon}
                iconTone={s.iconTone}
                title={s.title}
                body={s.body}
                mixed={mixedStrategy.mixed && strategy === s.k}
                mixedTooltip={mixedStrategy.tooltip}
              />
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--lb-line-soft)', paddingTop: 16, marginTop: 4 }}>
          <FieldRow
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                How AI quotes price <Info size={12} style={{ color: 'var(--lb-ink-6)' }} />
              </span>
            }
            sublabel="Choose how AI presents pricing when it volunteers a price."
            align="top"
            noBorder
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <OptionCard
                selected={priceMode === 'range'}
                onClick={() => onPriceMode('range')}
                title="Range"
                body="AI gives a price range and tells the customer the dispatcher will confirm the exact number."
                mixed={mixedPriceMode.mixed && priceMode === 'range'}
                mixedTooltip={mixedPriceMode.tooltip}
              />
              <OptionCard
                selected={priceMode === 'exact'}
                onClick={() => onPriceMode('exact')}
                title="Exact"
                body="AI gives an exact price when it has enough information."
                mixed={mixedPriceMode.mixed && priceMode === 'exact'}
                mixedTooltip={mixedPriceMode.tooltip}
              />
            </div>
          </FieldRow>
        </div>
      </SectionCard>

      <SettingCard
        icon={Clock}
        iconTone="violet"
        title="Auto Reply Availability"
        subtitle="Choose when AI can reply automatically."
        headerRight={
          <div style={{ display: 'flex', gap: 12, flex: 1, marginLeft: 24, marginTop: -4 }}>
            <OptionCard
              compact
              selected={availability === 'always'}
              onClick={() => onAvailability('always')}
              title="Always (24/7)"
              body="AI replies to leads at any time, day or night."
              mixed={mixedAvailability.mixed && availability === 'always'}
              mixedTooltip={mixedAvailability.tooltip}
            />
            <OptionCard
              compact
              selected={availability === 'hours'}
              onClick={() => onAvailability('hours')}
              title="Outside of business hours"
              body={<>AI replies only outside your business hours window.<br /><span style={{ color: 'var(--lb-ink-3)' }}>Business Hours: {bizHoursSummary}</span></>}
              mixed={mixedAvailability.mixed && availability === 'hours'}
              mixedTooltip={mixedAvailability.tooltip}
            />
          </div>
        }
      />

      <SectionCard padding="22px 24px 8px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <IconTile icon={Hand} tone="rose" size="lg" />
          <div style={{ flex: '0 0 280px', minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              AI Conversation Stop Rules
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Rules that tell AI when to stop replying.
              <br /><br />
              When any of these happen, AI stops and the conversation is handed off.
            </div>
            <div style={{ marginTop: 14 }}>
              <ActionLink external onClick={() => window.open('https://help.leadbridge360.com', '_blank')}>Learn more</ActionLink>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <ToggleRow icon={UserX}         iconTone="gray"   label="Customer asks not to be contacted"           on={stopRules.not_contacted} onChange={() => toggleStop('not_contacted')} mixed={mxStopNotContacted.mixed} mixedTooltip={mxStopNotContacted.tooltip} />
            <ToggleRow icon={CalendarCheck} iconTone="green"  label="Job is booked or confirmed"                  on={stopRules.booked}        onChange={() => toggleStop('booked')}        mixed={mxStopBooked.mixed}       mixedTooltip={mxStopBooked.tooltip} />
            <ToggleRow icon={HeartHandshake}iconTone="purple" label="Customer agrees on price — hand off to manager" on={stopRules.price_agreed} onChange={() => toggleStop('price_agreed')} mixed={mxStopPriceAgreed.mixed} mixedTooltip={mxStopPriceAgreed.tooltip} />
            <ToggleRow icon={CheckSquare}   iconTone="cyan"   label="Lead is done, scheduled, or archived"         on={stopRules.done}          onChange={() => toggleStop('done')}          mixed={mxStopDone.mixed}         mixedTooltip={mxStopDone.tooltip} />
          </div>
        </div>

        <div style={{
          marginTop: 14,
          padding: '10px 14px',
          background: '#eff6ff',
          border: '1px solid #c3d4ff',
          borderRadius: 10,
          fontSize: 12.5, color: 'var(--lb-accent)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Info size={14} />
          Some stop rules may also trigger follow-up flows. Manage in
          <a
            href="/automation/engage"
            onClick={(e) => { e.preventDefault(); goFollowups(); }}
            style={{ color: 'var(--lb-accent)', fontWeight: 600 }}
          >Follow-ups settings.</a>
        </div>
      </SectionCard>

      <SectionCard padding="22px 24px 8px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <IconTile icon={Users} tone="orange" size="lg" />
          <div style={{ flex: '0 0 280px', minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              Human Takeover (Notify Your Team)
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Notify your team when AI detects the customer needs a human.
              <br /><br />
              These rules trigger alerts. AI may continue the conversation unless a Stop Rule above is also matched.
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--lb-accent)', fontWeight: 600 }}>
              Manage alert templates in<br />
              Settings → Communication
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <ToggleRow icon={CalendarCheck} iconTone="green"  label="Ready to book"            on={takeover.ready}     onChange={() => toggleTakeover('ready')}     mixed={mxTakeReady.mixed}     mixedTooltip={mxTakeReady.tooltip} />
            <ToggleRow icon={PhoneCall}     iconTone="purple" label="Wants live contact"       on={takeover.live}      onChange={() => toggleTakeover('live')}      mixed={mxTakeLive.mixed}      mixedTooltip={mxTakeLive.tooltip} />
            <ToggleRow icon={Smartphone}    iconTone="blue"   label="Provided phone number"    on={takeover.phone}     onChange={() => toggleTakeover('phone')}     mixed={mxTakePhone.mixed}     mixedTooltip={mxTakePhone.tooltip} />
            <ToggleRow icon={Ruler}         iconTone="orange" label="Provided square footage"  on={takeover.sqft}      onChange={() => toggleTakeover('sqft')}      mixed={mxTakeSqft.mixed}      mixedTooltip={mxTakeSqft.tooltip} />
            <ToggleRow icon={BadgeCheck}    iconTone="cyan"   label="Qualification complete"   on={takeover.qualified} onChange={() => toggleTakeover('qualified')} mixed={mxTakeQualified.mixed} mixedTooltip={mxTakeQualified.tooltip} />
          </div>
        </div>

        <div style={{
          marginTop: 14,
          padding: '12px 14px',
          background: '#fffbeb',
          border: '1px solid #fde68a',
          borderRadius: 10,
          fontSize: 12.5, color: '#92400e',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Bell size={14} style={{ color: '#d97706' }} />
          <div style={{ flex: 1 }}>
            Alerts are sent based on templates in <strong>Settings → Communication → AI Human Takeover Alerts</strong>.
          </div>
          <ActionLink external onClick={goAlerts}>Go to Alerts &amp; Notifications</ActionLink>
        </div>
      </SectionCard>

      <SectionCard padding="20px 24px">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
          How it works
        </div>
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginBottom: 18 }}>
          AI continues the conversation until a Stop Rule is matched. Human Takeover rules send alerts so your team can jump in.
        </div>

        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 12,
          background: '#f8fafc', border: '1px solid var(--lb-line-soft)',
          borderRadius: 12, padding: '14px 16px',
        }}>
          <FlowStep icon={MessageSquareText} iconTone="blue"   title="AI is chatting"          subtitle="with the lead" />
          <FlowArrow />
          <FlowStep icon={Users}              iconTone="orange" title="Takeover rule matched"   subtitle="(alert sent to your team)" />
          <FlowArrow />
          <FlowStep icon={Bell}               iconTone="green"  title="Team is notified and"    subtitle="can take over" />
          <FlowArrow />
          <FlowStep icon={Hand}               iconTone="rose"   title="If a Stop Rule matches," subtitle="AI stops replying" />
        </div>
      </SectionCard>

      </>}

      </UpgradeOverlay>
    </div>
  );
}

function StrategyCard({
  selected, onClick, icon, iconTone, title, body, mixed, mixedTooltip,
}: {
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={mixed ? mixedTooltip : undefined}
      style={{
        position: 'relative',
        textAlign: 'left', padding: '14px 12px 14px',
        background: mixed ? '#fffbeb' : selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (mixed ? '#f59e0b' : selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        transition: 'border-color 120ms, background 120ms',
        boxShadow: mixed ? '0 0 0 3px rgba(245,158,11,0.14)' : undefined,
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 8 }}>
        <Radio selected={selected} />
      </div>
      {mixed && (
        <div style={{ position: 'absolute', top: 6, right: 6, color: '#d97706' }}>
          <AlertTriangle size={12} />
        </div>
      )}
      <div style={{ height: 6 }} />
      <IconTile icon={icon} tone={iconTone} size="md" />
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', textAlign: 'center', lineHeight: 1.4 }}>{body}</div>
    </button>
  );
}

function FlowStep({ icon, iconTone, title, subtitle }: { icon: LucideIcon; iconTone: IconTone; title: string; subtitle: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px' }}>
      <IconTile icon={icon} tone={iconTone} size="md" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-1)', lineHeight: 1.3 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', lineHeight: 1.3 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', color: 'var(--lb-ink-6)' }}>
      <ArrowRight size={16} />
    </div>
  );
}
