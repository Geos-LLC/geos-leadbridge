import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Sparkles, Scale, CircleDollarSign, UserCheck, Calendar, Phone,
  Clock, Hand, UserX, CalendarCheck, HeartHandshake, CheckSquare,
  PhoneCall, Smartphone, Ruler, BadgeCheck, Info, Bell, ArrowRight,
  MessageSquareText, AlertTriangle, Power,
  ChevronDown, ChevronUp, Shield, Settings2, Target,
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
  qualificationRequiredFields: string[];
};
const convCache = new Map<string, CachedConvSettings>();

type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';

// Qualification required-fields catalog. The 3 cleaning defaults are
// pre-checked when an account has no saved qualificationV2.requiredFields;
// the user can flip any of the 10 on/off. Snake_case keys match the
// backend prompt-injection format. Order here = display order in the UI.
const QUALIFICATION_FIELDS = [
  { key: 'square_footage', label: 'Square Footage', defaultChecked: true },
  { key: 'service_date',   label: 'Service Date',   defaultChecked: true },
  { key: 'phone_number',   label: 'Phone Number',   defaultChecked: true },
  { key: 'bedrooms',       label: 'Bedrooms',       defaultChecked: false },
  { key: 'bathrooms',      label: 'Bathrooms',      defaultChecked: false },
  { key: 'zip_code',       label: 'Zip Code',       defaultChecked: false },
  { key: 'address',        label: 'Address',        defaultChecked: false },
  { key: 'frequency',      label: 'Frequency',      defaultChecked: false },
  { key: 'condition',      label: 'Condition',      defaultChecked: false },
  { key: 'scope_extras',   label: 'Scope Extras',   defaultChecked: false },
] as const;
const QUALIFICATION_DEFAULT_FIELDS = QUALIFICATION_FIELDS
  .filter(f => f.defaultChecked)
  .map(f => f.key) as string[];
const QUALIFICATION_VALID_KEYS: Set<string> = new Set(QUALIFICATION_FIELDS.map(f => f.key));

const STRATEGIES: { k: StrategyKey; icon: LucideIcon; iconTone: IconTone; title: string; body: string }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',    body: 'AI chooses the best goal based on the customer conversation.' },
  { k: 'hybrid',  icon: Scale,            iconTone: 'gray',   title: 'Hybrid',  body: 'Balanced approach: acknowledge the customer, qualify, and move toward booking.' },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',   body: 'Focus on providing pricing information.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify', body: 'Focus on collecting required information.' },
  { k: 'convert', icon: Calendar,         iconTone: 'blue',   title: 'Convert', body: 'Focus on moving the customer toward booking.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Phone',   body: 'Focus on getting the customer onto a call.' },
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
  // Qualification required fields — stored as a flat array of snake_case
  // keys at `followUpSettingsJson.qualificationV2.requiredFields`. Used by
  // Price + Qualify goals; ignored otherwise. When an account has nothing
  // saved (existing tenants), the runtime falls back to the historical
  // hardcoded behavior and the UI pre-checks the 3 cleaning defaults.
  const [qualificationRequiredFields, setQualificationRequiredFields] =
    useState<string[]>(QUALIFICATION_DEFAULT_FIELDS);

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
    | 'takeover.ready' | 'takeover.live' | 'takeover.phone' | 'takeover.sqft' | 'takeover.qualified'
    | 'qualificationRequiredFields';
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
  const parseSettings = (s: any): CachedConvSettings => {
    // qualificationV2.requiredFields — array of snake_case field keys.
    // Sanitize: filter to known keys (forward-compatible with new fields
    // by ignoring unknown ones). When the key is missing entirely, fall
    // back to the 3 cleaning defaults so the UI matches the "pre-checked"
    // state — but the runtime still treats "no saved value" as legacy
    // behavior (no qualificationBlock injected). The runtime cares about
    // the persisted DB value; the UI default is just an affordance.
    const savedFields: unknown = s?.qualificationV2?.requiredFields;
    const requiredFields = Array.isArray(savedFields)
      ? (savedFields as unknown[])
          .filter(k => typeof k === 'string' && QUALIFICATION_VALID_KEYS.has(k as string))
          .map(k => k as string)
      : QUALIFICATION_DEFAULT_FIELDS;
    return {
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
      qualificationRequiredFields: requiredFields,
    };
  };

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
        setQualificationRequiredFields(first.qualificationRequiredFields);
      }
    } else {
      const cached = convCache.get(accountId);
      if (cached && !dirtyRef.current) {
        setStrategy(cached.strategy);
        setPriceMode(cached.priceMode);
        setAvailability(cached.availability);
        setStopRules(cached.stopRules);
        setTakeover(cached.takeover);
        setQualificationRequiredFields(cached.qualificationRequiredFields);
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
            setQualificationRequiredFields(parsed.qualificationRequiredFields);
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
              setQualificationRequiredFields(parsed.qualificationRequiredFields);
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
    // qualificationV2 is a nested JSON object. The backend save handler
    // writes `extendedSettings.qualificationV2 = body.qualificationV2`,
    // which preserves any future sibling keys (e.g. completionAction)
    // alongside requiredFields without a payload-shape change.
    if (fields.has('qualificationRequiredFields')) {
      payload.qualificationV2 = { requiredFields: qualificationRequiredFields };
    }

    // Optimistic cache update — merge ONLY the changed fields onto each
    // account's existing cached values. Don't replace the whole object, or
    // mixed-state badges would think untouched fields changed too.
    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    targets.forEach(id => {
      const prev = convCache.get(id);
      if (!prev) {
        convCache.set(id, { strategy, priceMode, availability, stopRules, takeover, qualificationRequiredFields });
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
      if (fields.has('qualificationRequiredFields')) {
        next.qualificationRequiredFields = qualificationRequiredFields;
      }
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
  }, [strategy, priceMode, availability, stopRules, takeover, qualificationRequiredFields]);

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

  // Toggle a single qualification field on/off. The full array of selected
  // keys is what gets persisted at `qualificationV2.requiredFields`; we
  // recompute it from the local state each time so the payload is always
  // canonical (sorted by the catalog's display order).
  const toggleQualificationField = (key: string) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualificationRequiredFields');
    const has = qualificationRequiredFields.includes(key);
    const next = has
      ? qualificationRequiredFields.filter(k => k !== key)
      : [...qualificationRequiredFields, key];
    // Re-sort by catalog order for canonical storage.
    const ordered = QUALIFICATION_FIELDS.map(f => f.key).filter(k => next.includes(k));
    setQualificationRequiredFields(ordered);
  };

  // Batch setters — used by the simplified "When goal is reached" radio so
  // one click can flip multiple underlying toggles in a single auto-save.
  // The radio mode preserves: not_contacted (opt-out compliance, ALWAYS on),
  // done (terminal-status stop, ALWAYS on), and all 5 takeover triggers
  // (always notify). It only differs aiStopOnBooked + aiStopOnPriceAgreed.
  const setStopBatch = (next: Partial<typeof stopRules>) => {
    dirtyRef.current = true;
    (Object.keys(next) as (keyof typeof stopRules)[]).forEach(k => {
      if (next[k] !== stopRules[k]) dirtyFieldsRef.current.add(`stopRules.${k}` as DirtyField);
    });
    setStopRules({ ...stopRules, ...next });
  };
  const setTakeoverBatch = (next: Partial<typeof takeover>) => {
    dirtyRef.current = true;
    (Object.keys(next) as (keyof typeof takeover)[]).forEach(k => {
      if (next[k] !== takeover[k]) dirtyFieldsRef.current.add(`takeover.${k}` as DirtyField);
    });
    setTakeover({ ...takeover, ...next });
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

      {/* ───── 1. Conversation Goal ───────────────────────────────────────── */}
      <SectionCard padding="22px 24px 24px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <IconTile icon={Target} tone="violet" size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>Conversation Goal</div>
              <AutoBadge tone="green">Applies everywhere</AutoBadge>
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              What AI is trying to achieve with each reply.<br />
              Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation.<br /><br />
              How AI <em>speaks</em> while pursuing the goal is controlled in <a href="/settings?tab=ai-playbook" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Settings → AI Playbook</a>.
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
      </SectionCard>

      {/* ───── 2. Goal-specific setup (includes per-goal When-Reached radio) ── */}
      <GoalSetupCard
        strategy={strategy}
        priceMode={priceMode}
        onPriceMode={onPriceMode}
        mixedPriceMode={mixedPriceMode}
        stopRules={stopRules}
        takeover={takeover}
        setStopBatch={setStopBatch}
        setTakeoverBatch={setTakeoverBatch}
        qualificationRequiredFields={qualificationRequiredFields}
        toggleQualificationField={toggleQualificationField}
      />

      {/* ───── 3. Advanced Rules (the 9 original toggles + Custom banner) ─── */}
      <AdvancedRulesCard
        stopRules={stopRules}
        takeover={takeover}
        toggleStop={toggleStop}
        toggleTakeover={toggleTakeover}
        mxStopNotContacted={mxStopNotContacted}
        mxStopBooked={mxStopBooked}
        mxStopPriceAgreed={mxStopPriceAgreed}
        mxStopDone={mxStopDone}
        mxTakeReady={mxTakeReady}
        mxTakeLive={mxTakeLive}
        mxTakePhone={mxTakePhone}
        mxTakeSqft={mxTakeSqft}
        mxTakeQualified={mxTakeQualified}
        goAlerts={goAlerts}
        goFollowups={goFollowups}
      />

      {/* ───── 4. Auto Reply Availability ─────────────────────────────────── */}
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

      {/* ───── 5. How it works ────────────────────────────────────────────── */}
      <SectionCard padding="20px 24px">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
          How it works
        </div>
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginBottom: 18 }}>
          AI pursues the Conversation Goal until the goal is reached. Then it either keeps replying (Continue) or stops (Stop) — and your team is notified either way.
        </div>

        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 12,
          background: '#f8fafc', border: '1px solid var(--lb-line-soft)',
          borderRadius: 12, padding: '14px 16px',
        }}>
          <FlowStep icon={MessageSquareText} iconTone="blue"   title="AI is chatting"          subtitle="pursuing the goal" />
          <FlowArrow />
          <FlowStep icon={Target}             iconTone="violet" title="Goal reached"            subtitle="(or protected event fired)" />
          <FlowArrow />
          <FlowStep icon={Bell}               iconTone="green"  title="Team is notified"        subtitle="dispatcher SMS fires" />
          <FlowArrow />
          <FlowStep icon={Hand}               iconTone="rose"   title="Continue or stop"        subtitle="per your setting" />
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

// ─── Goal-specific setup card ──────────────────────────────────────────────
// Renders the per-goal configuration: Required Information (Price/Qualify,
// UI-only checkboxes), Goal Completion description (Convert/Phone), the
// price-quote-mode picker (Price), AND the per-goal "When Goal Is Reached"
// radio (Price/Qualify/Convert/Phone). Auto and Hybrid have no extras.
//
// Backend fields are UNCHANGED. The When-Goal-Is-Reached radio writes to
// the SAME global fields (aiStopOnBooked, aiStopOnPriceAgreed, all 5
// handoffTrigger*) — it's presented inside the goal panel for clarity
// since only the active goal can reach its completion criterion at a time.

function GoalSetupCard({
  strategy, priceMode, onPriceMode, mixedPriceMode,
  stopRules, takeover, setStopBatch, setTakeoverBatch,
  qualificationRequiredFields, toggleQualificationField,
}: {
  strategy: StrategyKey;
  priceMode: 'range' | 'exact';
  onPriceMode: (v: 'range' | 'exact') => void;
  mixedPriceMode: { mixed: boolean; tooltip?: string };
  stopRules: StopRulesState;
  takeover: TakeoverState;
  setStopBatch: (next: Partial<StopRulesState>) => void;
  setTakeoverBatch: (next: Partial<TakeoverState>) => void;
  /** Sanitized list of selected snake_case field keys, in catalog order. */
  qualificationRequiredFields: string[];
  /** Single-field toggle. Owns dirty-tracking + canonical sort. */
  toggleQualificationField: (key: string) => void;
}) {

  const titleByStrategy: Record<StrategyKey, string> = {
    auto:    'Auto',
    hybrid:  'Hybrid',
    price:   'Price Goal Setup',
    qualify: 'Qualify Goal Setup',
    convert: 'Convert Goal Setup',
    phone:   'Phone Goal Setup',
  };
  const iconByStrategy: Record<StrategyKey, LucideIcon> = {
    auto: Sparkles, hybrid: Scale, price: CircleDollarSign, qualify: UserCheck, convert: Calendar, phone: Phone,
  };
  const toneByStrategy: Record<StrategyKey, IconTone> = {
    auto: 'violet', hybrid: 'gray', price: 'green', qualify: 'orange', convert: 'blue', phone: 'rose',
  };
  const Icon = iconByStrategy[strategy];

  // Required Information is QUALIFY-only. Price uses the Pricing Table +
  // Pricing Guidance (Playbook) — its qualification logic is "ask only what's
  // needed to quote accurately," not a configurable required-fields list.
  // Backend gate in qualification-context.ts mirrors this: only qualify
  // strategy injects the QUALIFICATION REQUIRED FIELDS reference block.
  const showRequiredInfo = strategy === 'qualify';
  const showWhenReached = strategy === 'price' || strategy === 'qualify' || strategy === 'convert' || strategy === 'phone';

  return (
    <SectionCard padding="22px 24px 24px">
      {/* Goal header + description */}
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
        <IconTile icon={Icon} tone={toneByStrategy[strategy]} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
            {titleByStrategy[strategy]}
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.6 }}>
            {strategy === 'auto' && (
              <>
                AI chooses the most appropriate goal based on the conversation.
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--lb-ink-3)' }}>
                  Examples:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                    <li>Customer asks for pricing → <strong>Price</strong></li>
                    <li>Customer wants a call → <strong>Phone</strong></li>
                    <li>Customer is ready to schedule → <strong>Convert</strong></li>
                    <li>Customer is exploring options → <strong>Qualify</strong></li>
                  </ul>
                </div>
              </>
            )}
            {strategy === 'hybrid' && (
              <>Balanced approach. AI acknowledges the customer, gathers information if needed, and moves toward booking.</>
            )}
            {strategy === 'price' && (
              <>AI volunteers a price from the Pricing Table when the customer's message is about pricing. Choose how AI presents the number below.</>
            )}
            {strategy === 'qualify' && (
              <>AI collects required information before quoting or booking. Pick the fields AI must gather below.</>
            )}
            {strategy === 'convert' && (
              <>
                <strong>Goal completion:</strong> Customer indicates intent to book or schedule service.
              </>
            )}
            {strategy === 'phone' && (
              <>
                <strong>Goal completion:</strong> Customer provides a phone number or requests a call.
              </>
            )}
          </div>
        </div>
      </div>

      {/* Required Information — Price + Qualify only. Wired to
          followUpSettingsJson.qualificationV2.requiredFields. Selected
          keys are injected into the AI prompt for Price and Qualify
          goals; existing tenants without saved values fall through to
          legacy hardcoded priorities. */}
      {showRequiredInfo && (
        <div style={{
          marginBottom: 16,
          padding: '14px 16px',
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 10,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
            letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 10,
            fontFamily: 'var(--lb-font-mono)',
          }}>
            Required Information
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 10 }}>
            {QUALIFICATION_FIELDS.map(field => {
              const checked = qualificationRequiredFields.includes(field.key);
              return (
                <label key={field.key} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 13.5, color: 'var(--lb-ink-2)', cursor: 'pointer',
                }}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleQualificationField(field.key)}
                    style={{ accentColor: 'var(--lb-accent)' }}
                  />
                  {field.label}
                </label>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.5 }}>
            These fields determine when qualification is considered complete. AI will prioritize collecting them before transitioning to other goals.
          </div>
        </div>
      )}

      {/* Price-specific: Pricing Table + Pricing Guidance note +
          priceQuoteMode (Range / Exact). The Price goal has no Required
          Information list — pricing behavior is driven by the Pricing Table
          (in AI Playbook → Pricing Guidance) plus the Range/Exact mode below.
          See backlog note in the commit history for the planned Advanced
          Pricing Rules section (sqft calc, recurring discount, minimum,
          trainee tier, dispatcher-confirm rules). */}
      {strategy === 'price' && (
        <>
          <div style={{
            marginBottom: 16,
            padding: '12px 14px',
            background: '#ecfdf5',
            border: '1px solid #a7f3d0',
            borderRadius: 10,
            fontSize: 12.5, color: '#065f46',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            lineHeight: 1.55,
          }}>
            <Info size={14} style={{ color: '#059669', flexShrink: 0, marginTop: 2 }} />
            <div>
              <strong>AI uses your <a href="/settings?tab=ai-playbook" style={{ color: '#047857', fontWeight: 600 }}>Pricing Table and Pricing Guidance from AI Playbook</a>.</strong> If details are missing, AI asks only what is needed to quote accurately.
            </div>
          </div>

          <div style={{ marginBottom: 16 }}>
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
        </>
      )}

      {/* Per-goal "When Goal Is Reached" radio. Writes the same global
          stop/handoff fields under the hood; fine-grained tuning lives in
          Advanced Rules below. */}
      {showWhenReached && (
        <PerGoalWhenReachedRadio
          stopRules={stopRules}
          takeover={takeover}
          setStopBatch={setStopBatch}
          setTakeoverBatch={setTakeoverBatch}
        />
      )}
    </SectionCard>
  );
}

// ─── Per-goal When-Goal-Is-Reached radio ──────────────────────────────────
// Inline two-option radio embedded inside GoalSetupCard. Mirrors the same
// preset detection used by AdvancedRulesCard so the two surfaces stay in
// agreement (and switching modes from either surface flips the same global
// fields).
function PerGoalWhenReachedRadio({
  stopRules, takeover, setStopBatch, setTakeoverBatch,
}: {
  stopRules: StopRulesState;
  takeover: TakeoverState;
  setStopBatch: (next: Partial<StopRulesState>) => void;
  setTakeoverBatch: (next: Partial<TakeoverState>) => void;
}) {
  const allTakeoverOn = takeover.ready && takeover.live && takeover.phone && takeover.sqft && takeover.qualified;
  const isContinueMode = !stopRules.booked && !stopRules.price_agreed && allTakeoverOn;
  const isStopMode     =  stopRules.booked &&  stopRules.price_agreed && allTakeoverOn;
  const isCustom = !isContinueMode && !isStopMode;

  const applyContinue = () => {
    setStopBatch({ booked: false, price_agreed: false });
    setTakeoverBatch({ ready: true, live: true, phone: true, sqft: true, qualified: true });
  };
  const applyStop = () => {
    setStopBatch({ booked: true, price_agreed: true });
    setTakeoverBatch({ ready: true, live: true, phone: true, sqft: true, qualified: true });
  };

  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
        letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 10,
        fontFamily: 'var(--lb-font-mono)',
      }}>
        When Goal Is Reached
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <OptionCard
          selected={isContinueMode}
          onClick={applyContinue}
          title="Continue AI + Notify Team"
          body="AI keeps replying after the goal is reached. Your team is notified."
        />
        <OptionCard
          selected={isStopMode}
          onClick={applyStop}
          title="Stop AI + Notify Team"
          body="AI stops once the goal is reached. Your team takes over."
        />
      </div>
      {isCustom && (
        <div style={{
          marginTop: 10,
          padding: '8px 12px',
          background: '#fffbeb',
          border: '1px solid #fde68a',
          borderRadius: 8,
          fontSize: 12, color: '#92400e',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={13} />
          <span><strong>Custom Configuration</strong> — your current toggle mix doesn't match either preset. Adjust under Advanced Rules below.</span>
        </div>
      )}
    </div>
  );
}

// ─── When-goal-is-reached card ─────────────────────────────────────────────
// Replaces the old Stop Rules + Human Takeover cards with one simplified
// radio (Continue AI + Notify Team / Stop AI + Notify Team) plus an
// "Advanced rules" accordion that exposes every original toggle for users
// whose saved state doesn't match either preset. Backend fields are
// UNCHANGED — the radio just batches the underlying setters.
//
// PROTECTED behavior (never changeable from the simplified radio):
//   - aiStopOnOptOut          ← compliance, must always stop on opt-out
//   - aiStopOnBooked.done      ← terminal status, must always stop
//   - All 5 handoffTrigger*    ← team gets notified regardless of mode
//
// MODE-DIFFERENTIATING fields (the only two that differ Continue vs Stop):
//   - aiStopOnBooked        Continue=false / Stop=true
//   - aiStopOnPriceAgreed   Continue=false / Stop=true
type StopRulesState = { not_contacted: boolean; booked: boolean; price_agreed: boolean; done: boolean };
type TakeoverState  = { ready: boolean; live: boolean; phone: boolean; sqft: boolean; qualified: boolean };

function AdvancedRulesCard({
  stopRules, takeover,
  toggleStop, toggleTakeover,
  mxStopNotContacted, mxStopBooked, mxStopPriceAgreed, mxStopDone,
  mxTakeReady, mxTakeLive, mxTakePhone, mxTakeSqft, mxTakeQualified,
  goAlerts, goFollowups,
}: {
  stopRules: StopRulesState;
  takeover: TakeoverState;
  toggleStop: (k: keyof StopRulesState) => void;
  toggleTakeover: (k: keyof TakeoverState) => void;
  mxStopNotContacted: { mixed: boolean; tooltip?: string };
  mxStopBooked: { mixed: boolean; tooltip?: string };
  mxStopPriceAgreed: { mixed: boolean; tooltip?: string };
  mxStopDone: { mixed: boolean; tooltip?: string };
  mxTakeReady: { mixed: boolean; tooltip?: string };
  mxTakeLive: { mixed: boolean; tooltip?: string };
  mxTakePhone: { mixed: boolean; tooltip?: string };
  mxTakeSqft: { mixed: boolean; tooltip?: string };
  mxTakeQualified: { mixed: boolean; tooltip?: string };
  goAlerts: () => void;
  goFollowups: () => void;
}) {
  // Derive Custom Configuration banner + auto-expand from underlying state.
  // Continue = stopOnBooked=false AND stopOnPriceAgreed=false AND all takeover ON
  // Stop     = stopOnBooked=true  AND stopOnPriceAgreed=true  AND all takeover ON
  // Otherwise = 'custom' (open Advanced automatically).
  const allTakeoverOn = takeover.ready && takeover.live && takeover.phone && takeover.sqft && takeover.qualified;
  const isContinueMode = !stopRules.booked && !stopRules.price_agreed && allTakeoverOn;
  const isStopMode     =  stopRules.booked &&  stopRules.price_agreed && allTakeoverOn;
  const isCustom = !isContinueMode && !isStopMode;
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(isCustom);

  return (
    <SectionCard padding="22px 24px 8px">
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
        <IconTile icon={Settings2} tone="gray" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
            Advanced Rules
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
            Fine-grained control over every Stop Rule and Human Takeover trigger. These toggles back the simplified <em>When Goal Is Reached</em> radio on each Goal — flipping individual rows here is what produces a Custom Configuration.
          </div>
        </div>
      </div>

      {/* Custom-state banner */}
      {isCustom && (
        <div style={{
          marginTop: 14,
          padding: '10px 14px',
          background: '#fffbeb',
          border: '1px solid #fde68a',
          borderRadius: 10,
          fontSize: 12.5, color: '#92400e',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <AlertTriangle size={14} />
          <strong>Custom Configuration</strong>&nbsp;— your saved toggles don't match either standard preset. The full toggle list is expanded below.
        </div>
      )}

      {/* Protected behavior note */}
      <div style={{
        marginTop: 14,
        padding: '10px 14px',
        background: '#f8fafc',
        border: '1px solid var(--lb-line-soft)',
        borderRadius: 10,
        fontSize: 12.5, color: 'var(--lb-ink-3)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <Shield size={14} style={{ color: 'var(--lb-ink-5)' }} />
        <div style={{ flex: 1 }}>
          <strong>Always protected:</strong> opt-out compliance (AI stops), wants-live-contact (team notified), terminal lead status (AI stops). These can't be turned off.
        </div>
      </div>

      {/* Accordion — exposes the original 9 toggles for full control. */}
      <div style={{ marginTop: 14, borderTop: '1px solid var(--lb-line-soft)', paddingTop: 12 }}>
        <button
          type="button"
          onClick={() => setAdvancedOpen(v => !v)}
          style={{
            background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            color: 'var(--lb-accent)',
            display: 'inline-flex', alignItems: 'center', gap: 6,
          }}
        >
          <Settings2 size={13} />
          {advancedOpen ? 'Hide advanced rules' : 'Show advanced rules'}
          {advancedOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>

        {advancedOpen && (
          <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 18 }}>
            {/* Stop Rules subsection */}
            <div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
                letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8,
                fontFamily: 'var(--lb-font-mono)',
              }}>
                Stop Rules — when AI stops replying
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <ToggleRow icon={UserX}         iconTone="gray"   label="Customer asks not to be contacted"             on={stopRules.not_contacted} onChange={() => toggleStop('not_contacted')} mixed={mxStopNotContacted.mixed} mixedTooltip={mxStopNotContacted.tooltip} />
                <ToggleRow icon={CalendarCheck} iconTone="green"  label="Job is booked or confirmed"                    on={stopRules.booked}        onChange={() => toggleStop('booked')}        mixed={mxStopBooked.mixed}       mixedTooltip={mxStopBooked.tooltip} />
                <ToggleRow icon={HeartHandshake}iconTone="purple" label="Customer agrees on price — hand off to manager" on={stopRules.price_agreed} onChange={() => toggleStop('price_agreed')} mixed={mxStopPriceAgreed.mixed} mixedTooltip={mxStopPriceAgreed.tooltip} />
                <ToggleRow icon={CheckSquare}   iconTone="cyan"   label="Lead is done, scheduled, or archived"          on={stopRules.done}          onChange={() => toggleStop('done')}          mixed={mxStopDone.mixed}         mixedTooltip={mxStopDone.tooltip} />
              </div>
              <div style={{
                marginTop: 10,
                padding: '8px 12px',
                background: '#eff6ff',
                border: '1px solid #c3d4ff',
                borderRadius: 8,
                fontSize: 12, color: 'var(--lb-accent)',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Info size={13} />
                Some stop rules also trigger follow-up flows. Manage in
                <a
                  href="/automation/engage"
                  onClick={(e) => { e.preventDefault(); goFollowups(); }}
                  style={{ color: 'var(--lb-accent)', fontWeight: 600 }}
                >Follow-ups settings.</a>
              </div>
            </div>

            {/* Human Takeover subsection */}
            <div>
              <div style={{
                fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
                letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 8,
                fontFamily: 'var(--lb-font-mono)',
              }}>
                Human Takeover — when your team is notified
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <ToggleRow icon={CalendarCheck} iconTone="green"  label="Ready to book"            on={takeover.ready}     onChange={() => toggleTakeover('ready')}     mixed={mxTakeReady.mixed}     mixedTooltip={mxTakeReady.tooltip} />
                <ToggleRow icon={PhoneCall}     iconTone="purple" label="Wants live contact"       on={takeover.live}      onChange={() => toggleTakeover('live')}      mixed={mxTakeLive.mixed}      mixedTooltip={mxTakeLive.tooltip} />
                <ToggleRow icon={Smartphone}    iconTone="blue"   label="Provided phone number"    on={takeover.phone}     onChange={() => toggleTakeover('phone')}     mixed={mxTakePhone.mixed}     mixedTooltip={mxTakePhone.tooltip} />
                <ToggleRow icon={Ruler}         iconTone="orange" label="Provided square footage"  on={takeover.sqft}      onChange={() => toggleTakeover('sqft')}      mixed={mxTakeSqft.mixed}      mixedTooltip={mxTakeSqft.tooltip} />
                <ToggleRow icon={BadgeCheck}    iconTone="cyan"   label="Qualification complete"   on={takeover.qualified} onChange={() => toggleTakeover('qualified')} mixed={mxTakeQualified.mixed} mixedTooltip={mxTakeQualified.tooltip} />
              </div>
              <div style={{
                marginTop: 10,
                padding: '8px 12px',
                background: '#fffbeb',
                border: '1px solid #fde68a',
                borderRadius: 8,
                fontSize: 12, color: '#92400e',
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <Bell size={13} style={{ color: '#d97706' }} />
                <div style={{ flex: 1 }}>
                  Alert templates: <strong>Settings → Communication → AI Human Takeover Alerts</strong>.
                </div>
                <ActionLink external onClick={goAlerts}>Alerts &amp; Notifications</ActionLink>
              </div>
            </div>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
