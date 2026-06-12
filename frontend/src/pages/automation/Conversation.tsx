import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Sparkles, CircleDollarSign, UserCheck, Phone,
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
  // V2 per-goal completion stops (2026-06-12). Each Conversation Goal
  // owns its own "Stop AI + Notify Team" choice. Price reuses the
  // existing `aiStopOnPriceAgreed` field (stopRules.price_agreed here).
  // Qualify + Phone get their own new JSON keys
  // (`goalQualifyStopOnComplete` / `goalPhoneStopOnComplete`) — both
  // default false so existing tenants behave identically.
  qualifyStopOnComplete: boolean;
  phoneStopOnComplete: boolean;
};
const convCache = new Map<string, CachedConvSettings>();

type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';

// Qualification required-fields catalog (6 fields). Zip code + Phone number
// are platform-driven defaults (TT usually has zip, Yelp usually needs both).
// The other 4 (bedrooms, bathrooms, square footage, frequency) are unchecked
// by default — users opt in per business. Snake_case keys match the backend
// prompt-injection format. Catalog order = display order in the UI.
//
// Future fields (not in UI yet, captured here for context): move_in_out,
// pets, deep_cleaning, extras. They map onto existing legacy backend keys
// (condition / scope_extras) which the prompt builder still understands —
// so a saved value of `condition` or `scope_extras` on an account that
// pre-dates this catalog narrowing stays in `qualificationRequiredFields`
// and continues to inject into the AI prompt at runtime even though the
// UI no longer renders a checkbox for it. See toggleQualificationField
// for the preserve-unknown-keys logic.
const QUALIFICATION_FIELDS = [
  { key: 'bedrooms',       label: 'Bedrooms',       defaultChecked: false },
  { key: 'bathrooms',      label: 'Bathrooms',      defaultChecked: false },
  { key: 'square_footage', label: 'Square Footage', defaultChecked: false },
  { key: 'frequency',      label: 'Frequency',      defaultChecked: false },
  { key: 'zip_code',       label: 'Zip Code',       defaultChecked: true },
  { key: 'phone_number',   label: 'Phone Number',   defaultChecked: true },
] as const;
const QUALIFICATION_DEFAULT_FIELDS = QUALIFICATION_FIELDS
  .filter(f => f.defaultChecked)
  .map(f => f.key) as string[];
const QUALIFICATION_CATALOG_KEYS: Set<string> = new Set(QUALIFICATION_FIELDS.map(f => f.key));

// 4 goals only — Hybrid and Convert collapsed into Auto and Qualify
// respectively (UI only). Saved backend values 'hybrid' and 'convert' are
// remapped for DISPLAY in parseSettings and the runtime continues to honor
// them via STRATEGY_PROMPTS.hybrid / .convert. No DB writes — legacy values
// stay in followUpSettingsJson until the user explicitly picks a new goal.
const STRATEGIES: { k: StrategyKey; icon: LucideIcon; iconTone: IconTone; title: string; body: string; recommended?: boolean }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',    body: 'AI automatically chooses the best approach based on the conversation.', recommended: true },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',   body: 'Provide pricing information as quickly and accurately as possible.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify', body: 'Collect the information needed before quoting or booking.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Phone',   body: 'Get the customer onto a phone call.' },
];

export function AutomationConversation({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'AI Conversation' };
  const accounts = useAppStore(s => s.savedAccounts);
  const isAll = accountId === 'all';

  // Advanced/legacy mode — surfaced via ?advanced=1 or ?debug=1 in the URL.
  // Hides the Stop Rules + Human Takeover toggle grid from the normal
  // user UI (it's all driven by the Goal radio + protected events now)
  // but keeps it reachable for support / power users. The backend fields
  // these toggles write to (aiStopOn*, handoffTrigger*) are unchanged and
  // continue to load + save normally — the only thing that changes is
  // whether the toggles are visible.
  const [searchParams] = useSearchParams();
  const advancedMode =
    searchParams.get('advanced') === '1' ||
    searchParams.get('debug') === '1';

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

  // V2 per-goal completion stops. Default false: existing tenants
  // unaffected. Backend gates in automation.service treat undefined as
  // false too (no behavior change for accounts without the key).
  const [qualifyStopOnComplete, setQualifyStopOnComplete] = useState(false);
  const [phoneStopOnComplete, setPhoneStopOnComplete] = useState(false);

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
    | 'qualificationRequiredFields'
    | 'qualifyStopOnComplete' | 'phoneStopOnComplete';
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
    // Accept ANY string key (not just catalog ones) so values saved by an
    // older UI version, or future-field keys, round-trip without loss.
    // The runtime helper (src/ai/qualification-context.ts) does the final
    // filtering — only known keys reach the AI prompt block.
    // When the key is missing entirely, fall back to the new defaults
    // (zip_code + phone_number) so the UI shows a sensible pre-checked
    // state — but the RUNTIME still treats "no saved value" as legacy
    // behavior (no qualificationBlock injected at all).
    const savedFields: unknown = s?.qualificationV2?.requiredFields;
    const requiredFields = Array.isArray(savedFields)
      ? (savedFields as unknown[])
          .filter((k): k is string => typeof k === 'string')
      : QUALIFICATION_DEFAULT_FIELDS;

    // Strategy DISPLAY remap: hide Hybrid + Convert from the picker but
    // remap their saved DB values to a visible card so users see SOMETHING
    // selected. No DB write — the legacy value persists in
    // followUpSettingsJson until the user explicitly picks a new goal.
    // Runtime continues to honor 'hybrid' / 'convert' via STRATEGY_PROMPTS.
    let displayStrategy: StrategyKey = 'auto';
    const saved = typeof s?.followUpStrategy === 'string' ? s.followUpStrategy : null;
    if (saved === 'hybrid') displayStrategy = 'auto';
    else if (saved === 'convert') displayStrategy = 'qualify';
    else if (saved && STRATEGIES.some(x => x.k === saved)) displayStrategy = saved as StrategyKey;

    return {
      strategy: displayStrategy,
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
      // V2 goal completion stops. Missing key → default false. The new
      // backend gates in automation.service.ts check `=== true` strictly,
      // so undefined or false both mean "Continue AI + Notify Team".
      qualifyStopOnComplete: !!s?.goalQualifyStopOnComplete,
      phoneStopOnComplete:   !!s?.goalPhoneStopOnComplete,
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
        setQualifyStopOnComplete(first.qualifyStopOnComplete);
        setPhoneStopOnComplete(first.phoneStopOnComplete);
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
        setQualifyStopOnComplete(cached.qualifyStopOnComplete);
        setPhoneStopOnComplete(cached.phoneStopOnComplete);
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
            setQualifyStopOnComplete(parsed.qualifyStopOnComplete);
            setPhoneStopOnComplete(parsed.phoneStopOnComplete);
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
              setQualifyStopOnComplete(parsed.qualifyStopOnComplete);
              setPhoneStopOnComplete(parsed.phoneStopOnComplete);
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
    // V2 goal completion stops — Qualify + Phone goals each carry their
    // own "Stop AI + Notify Team" choice as a new top-level JSON key.
    // Backend reads these via aiRules.goalQualifyStopOnComplete /
    // .goalPhoneStopOnComplete (see automation.service handleCustomerReply).
    // Price keeps writing aiStopOnPriceAgreed via stopRules.price_agreed.
    if (fields.has('qualifyStopOnComplete')) payload.goalQualifyStopOnComplete = qualifyStopOnComplete;
    if (fields.has('phoneStopOnComplete'))   payload.goalPhoneStopOnComplete   = phoneStopOnComplete;

    // Optimistic cache update — merge ONLY the changed fields onto each
    // account's existing cached values. Don't replace the whole object, or
    // mixed-state badges would think untouched fields changed too.
    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    targets.forEach(id => {
      const prev = convCache.get(id);
      if (!prev) {
        convCache.set(id, {
          strategy, priceMode, availability,
          stopRules, takeover, qualificationRequiredFields,
          qualifyStopOnComplete, phoneStopOnComplete,
        });
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
      if (fields.has('qualifyStopOnComplete')) next.qualifyStopOnComplete = qualifyStopOnComplete;
      if (fields.has('phoneStopOnComplete'))   next.phoneStopOnComplete   = phoneStopOnComplete;
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
  }, [strategy, priceMode, availability, stopRules, takeover, qualificationRequiredFields, qualifyStopOnComplete, phoneStopOnComplete]);

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
  // keys is what gets persisted at `qualificationV2.requiredFields`. Catalog
  // keys are emitted first in canonical display order; any *unknown* keys
  // already in the saved list (e.g. `service_date`, `address`, or future
  // fields from a different UI build) are PRESERVED and appended after the
  // catalog keys. That way round-tripping never loses data — a user editing
  // bedrooms/zip from a fresh build still keeps their pre-existing
  // service_date selection intact.
  const toggleQualificationField = (key: string) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualificationRequiredFields');
    const has = qualificationRequiredFields.includes(key);
    const next = has
      ? qualificationRequiredFields.filter(k => k !== key)
      : [...qualificationRequiredFields, key];
    const catalogPart = QUALIFICATION_FIELDS.map(f => f.key).filter(k => next.includes(k));
    const preservedPart = next.filter(k => !QUALIFICATION_CATALOG_KEYS.has(k));
    setQualificationRequiredFields([...catalogPart, ...preservedPart]);
  };

  // V2 per-goal "Stop AI on completion" setters. Each goal owns ONE field
  // — no global fan-out — so picking Stop on Phone doesn't accidentally
  // flip Price's behavior. Price still wires through stopRules.price_agreed
  // (aiStopOnPriceAgreed) — see GoalSetupCard for the per-goal radio prop.
  const onQualifyStop = (v: boolean) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualifyStopOnComplete');
    setQualifyStopOnComplete(v);
  };
  const onPhoneStop = (v: boolean) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('phoneStopOnComplete');
    setPhoneStopOnComplete(v);
  };
  // Price still flips the existing aiStopOnPriceAgreed via stopRules.
  // Wrapper here so the per-goal radio prop signature stays uniform.
  const onPriceStop = (v: boolean) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('stopRules.price_agreed');
    setStopRules({ ...stopRules, price_agreed: v });
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
          ? 'AI replies to customers automatically based on your Conversation Goal.'
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
            display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10,
            flex: '0 0 560px',
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
                recommended={s.recommended}
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
        qualificationRequiredFields={qualificationRequiredFields}
        toggleQualificationField={toggleQualificationField}
        // V2 per-goal completion stops. Each goal radio writes ONE field
        // (no global fan-out). Auto has no completion radio at all.
        priceStop={stopRules.price_agreed}
        qualifyStop={qualifyStopOnComplete}
        phoneStop={phoneStopOnComplete}
        onPriceStop={onPriceStop}
        onQualifyStop={onQualifyStop}
        onPhoneStop={onPhoneStop}
      />

      {/* ───── 3. Advanced Rules — only when ?advanced=1 or ?debug=1 ────────
            Normal users manage AI behavior via Conversation Goals + the
            per-goal When-Goal-Is-Reached radio above. The 9 legacy
            Stop Rules / Human Takeover toggles still drive the backend
            (aiStopOn* / handoffTrigger* fields) and remain reachable
            for support and power users through the URL param. */}
      {advancedMode && (
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
      )}

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
  selected, onClick, icon, iconTone, title, body, recommended, mixed, mixedTooltip,
}: {
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
  /** Show a small "Recommended" pill above the title. Used on Auto. */
  recommended?: boolean;
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
      {recommended && !mixed && (
        <div style={{
          position: 'absolute', top: 6, right: 6,
          fontSize: 9, fontWeight: 700, letterSpacing: 0.05,
          padding: '2px 6px', borderRadius: 999,
          background: '#ede9fe', color: '#6d28d9',
          textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
        }}>
          Recommended
        </div>
      )}
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
  qualificationRequiredFields, toggleQualificationField,
  priceStop, qualifyStop, phoneStop,
  onPriceStop, onQualifyStop, onPhoneStop,
}: {
  strategy: StrategyKey;
  priceMode: 'range' | 'exact';
  onPriceMode: (v: 'range' | 'exact') => void;
  mixedPriceMode: { mixed: boolean; tooltip?: string };
  /** Sanitized list of selected snake_case field keys, in catalog order. */
  qualificationRequiredFields: string[];
  /** Single-field toggle. Owns dirty-tracking + canonical sort. */
  toggleQualificationField: (key: string) => void;
  /** V2 per-goal Stop-on-completion booleans. true = Stop AI, false = Continue. */
  priceStop: boolean;
  qualifyStop: boolean;
  phoneStop: boolean;
  /** Each setter writes ONLY that goal's underlying field. */
  onPriceStop: (v: boolean) => void;
  onQualifyStop: (v: boolean) => void;
  onPhoneStop: (v: boolean) => void;
}) {

  // Display metadata for the 4 visible goals. Legacy 'hybrid' / 'convert'
  // never reach this card because parseSettings remaps them to 'auto' /
  // 'qualify' for display. The Record entries below cover all 6 keys for
  // type completeness, but only auto/price/qualify/phone are reachable.
  const titleByStrategy: Record<StrategyKey, string> = {
    auto:    'Auto',
    hybrid:  'Auto',           // unreachable — remapped in parseSettings
    price:   'Price Goal Setup',
    qualify: 'Qualify Goal Setup',
    convert: 'Qualify Goal Setup', // unreachable — remapped in parseSettings
    phone:   'Phone Goal Setup',
  };
  const iconByStrategy: Record<StrategyKey, LucideIcon> = {
    auto: Sparkles, hybrid: Sparkles, price: CircleDollarSign, qualify: UserCheck, convert: UserCheck, phone: Phone,
  };
  const toneByStrategy: Record<StrategyKey, IconTone> = {
    auto: 'violet', hybrid: 'violet', price: 'green', qualify: 'orange', convert: 'orange', phone: 'rose',
  };
  const Icon = iconByStrategy[strategy];

  // Required Information is QUALIFY-only. Price uses the Pricing Table +
  // Pricing Guidance (Playbook) — its qualification logic is "ask only what's
  // needed to quote accurately," not a configurable required-fields list.
  // Backend gate in qualification-context.ts mirrors this: only qualify
  // strategy injects the QUALIFICATION REQUIRED FIELDS reference block.
  const showRequiredInfo = strategy === 'qualify';
  // V2: When-Goal-Is-Reached radio appears on the 3 concrete goals only.
  // Auto has NO completion criteria (per spec) — AI inherits whichever
  // sub-goal it picks each turn, so a single Continue/Stop choice
  // wouldn't apply cleanly. Per-goal completion semantics are owned by
  // each goal individually.
  const showWhenReached = strategy === 'price' || strategy === 'qualify' || strategy === 'phone';

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
                AI automatically chooses the best approach based on the conversation.
                <div style={{ marginTop: 8, fontSize: 13, color: 'var(--lb-ink-3)' }}>
                  Examples:
                  <ul style={{ margin: '4px 0 0', paddingLeft: 18, lineHeight: 1.7 }}>
                    <li>Customer asks about price → <strong>Price behavior</strong></li>
                    <li>Customer explores options → <strong>Qualify behavior</strong></li>
                    <li>Customer requests a call → <strong>Phone behavior</strong></li>
                  </ul>
                </div>
              </>
            )}
            {strategy === 'price' && (
              <>Focus on providing pricing information as quickly and accurately as possible.</>
            )}
            {strategy === 'qualify' && (
              <>
                Focus on collecting the information needed before quoting or booking. This goal naturally moves the customer toward booking.
              </>
            )}
            {strategy === 'phone' && (
              <>
                Focus on getting the customer onto a phone call.
                <div style={{ marginTop: 6, fontSize: 13, color: 'var(--lb-ink-3)' }}>
                  <strong>Goal completion:</strong> customer requests a call, or provides a phone number.
                </div>
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

      {/* Per-goal "When Goal Is Reached" radio. V2: each goal owns ONE
          field — no global fan-out. Price → aiStopOnPriceAgreed.
          Qualify → goalQualifyStopOnComplete (new). Phone →
          goalPhoneStopOnComplete (new). Backend gates honor each
          independently; the Notify-Team side is implicit (handoff alert
          fires on classifier signal regardless of this choice). */}
      {showWhenReached && (
        <PerGoalWhenReachedRadio
          goalKey={strategy as 'price' | 'qualify' | 'phone'}
          stopValue={
            strategy === 'price'   ? priceStop :
            strategy === 'qualify' ? qualifyStop :
            phoneStop
          }
          setStopValue={
            strategy === 'price'   ? onPriceStop :
            strategy === 'qualify' ? onQualifyStop :
            onPhoneStop
          }
        />
      )}
    </SectionCard>
  );
}

// ─── Per-goal When-Goal-Is-Reached radio ──────────────────────────────────
// V2: each Conversation Goal owns ONE backend stop flag — no global toggle
// fan-out. Caller picks which goal this radio represents and passes the
// corresponding boolean + setter. Notify-Team is implicit: the handoff
// alert SMS fires on the classifier signal regardless of this choice.
function PerGoalWhenReachedRadio({
  goalKey,
  stopValue,
  setStopValue,
}: {
  goalKey: 'price' | 'qualify' | 'phone';
  /** true = "Stop AI + Notify Team", false = "Continue AI + Notify Team". */
  stopValue: boolean;
  setStopValue: (v: boolean) => void;
}) {
  const completionLabel: Record<'price' | 'qualify' | 'phone', string> = {
    price:   'When the customer agrees with the price',
    qualify: 'When all required fields are collected',
    phone:   'When the customer provides a phone number',
  };

  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--lb-ink-5)',
        letterSpacing: 0.06, textTransform: 'uppercase', marginBottom: 6,
        fontFamily: 'var(--lb-font-mono)',
      }}>
        When Goal Is Reached
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginBottom: 10 }}>
        {completionLabel[goalKey]}:
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <OptionCard
          selected={!stopValue}
          onClick={() => setStopValue(false)}
          title="Continue AI + Notify Team"
          body="AI keeps replying after the goal is reached. Your team is notified."
        />
        <OptionCard
          selected={stopValue}
          onClick={() => setStopValue(true)}
          title="Stop AI + Notify Team"
          body="AI stops once the goal is reached. Your team takes over."
        />
      </div>
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Legacy compatibility settings
            </div>
            <span style={{
              fontSize: 9.5, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
              background: '#fef3c7', color: '#92400e',
              letterSpacing: 0.05, textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
            }}>
              Legacy
            </span>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
            These settings are preserved for compatibility. Most users should configure Conversation Goals above. The raw toggles below back the legacy Stop Rules + Human Takeover behavior and remain reachable for support and power users via <code>?advanced=1</code>.
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
