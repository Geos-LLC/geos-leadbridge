import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Sparkles, CircleDollarSign, UserCheck, Phone,
  Clock, Hand, UserX, CalendarCheck, HeartHandshake, CheckSquare,
  PhoneCall, Smartphone, Ruler, BadgeCheck, Info, Bell, ArrowRight,
  MessageSquareText, AlertTriangle, Power,
  ChevronDown, ChevronUp, Shield, Settings2, Target,
  Plus, Trash2,
  type LucideIcon,
} from 'lucide-react';
import {
  SectionCard, ToggleRow,
  Radio, IconTile, ActionLink, AutoBadge, StatusPill,
  PlanOffEmptyState,
  type IconTone,
} from '../../components/automation/ui';
import { InfoDot, InfoTip } from '../../components/InfoPopover';
import { followUpApi, serviceProfilesApi, usersApi, type ServiceProfile } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { UpgradeOverlay } from '../../components/UpgradeOverlay';
import { formatBusinessHoursSummary, type BusinessHoursSchedule } from '../../lib/businessHours';
import { deriveRecommendedFields } from '../../lib/qualificationRecommend';

// Module-level cache that survives mount/unmount AND tab switches, so toggling
// account tabs feels instant and so the mixed-state detection has data to read
// without waiting for the network.
/**
 * Custom required field for the Qualify goal. User-defined alongside the
 * built-in catalog (bedrooms, bathrooms, etc.) — examples include Pets,
 * Gate code, Move-in date. Stored at
 * followUpSettingsJson.qualificationV2.customFields.
 *
 * `question` is optional — when empty the AI generates a natural question
 * from the label at runtime (e.g. label "Pets" → AI asks "Do you have any
 * pets in the home?"). `required` decides whether qualification completion
 * waits for this field; unchecked = AI may ask but doesn't gate on it.
 */
export type QualificationCustomField = {
  id: string;
  label: string;
  question: string;
  required: boolean;
};

/**
 * Generate a stable client-side id for a new custom field row. Prefers
 * crypto.randomUUID where available; falls back to a time + random suffix
 * for older browsers / weird embeds. The id is opaque to the backend —
 * it's only used by React for stable list keys + save-time diffing.
 */
function makeCustomFieldId(): string {
  const c = typeof crypto !== 'undefined' ? crypto : undefined;
  if (c && typeof (c as any).randomUUID === 'function') {
    return (c as any).randomUUID();
  }
  return `cf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type CachedConvSettings = {
  strategy: 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone' | 'booking';
  availability: 'always' | 'hours';
  // V2 Review Mode (2026-06-12). 'suggest' parks AI replies as pending
  // drafts; 'auto_send' dispatches them according to `availability`.
  // Existing tenants whose followUpSettingsJson predates this key default
  // to 'auto_send' so behavior is unchanged on first paint.
  aiConversationDeliveryMode: 'suggest' | 'auto_send';
  stopRules: { not_contacted: boolean; booked: boolean; price_agreed: boolean; done: boolean };
  takeover: { ready: boolean; live: boolean; phone: boolean; sqft: boolean; qualified: boolean };
  qualificationRequiredFields: string[];
  // True when followUpSettingsJson.qualificationV2.requiredFields was a
  // saved array on the wire. False = no save present → hydration should
  // fall back to the recommended-defaults set (which is service-derived
  // when ServiceProfiles are loaded, otherwise just zip + phone).
  qualificationRequiredFieldsWasSaved: boolean;
  qualificationCustomFields: QualificationCustomField[];
  // Per-account booking-availability (Booking goal). 7 weekdays × 2
  // periods (morning / afternoon). Missing in older saves → defaulted
  // to Mon–Fri both on, weekends both off by normalizeBookingAvailability.
  bookingAvailability: BookingAvailability;
};
const convCache = new Map<string, CachedConvSettings>();

type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone' | 'booking';

// Qualification required-fields catalog (7 fields). Zip code + Phone number
// are platform-driven defaults (TT usually has zip, Yelp usually needs both).
// The other 5 (bedrooms, bathrooms, square footage, frequency, desired
// service date) are unchecked by default — users opt in per business.
// Snake_case keys match the backend prompt-injection format. Catalog order
// = display order in the UI.
//
// `service_date` (Desired Service Date, added 2026-06-16) belongs under
// Qualify, not only Booking — multiple tenants want it collected as part
// of the regular qualification flow so the AI can flag scheduling
// concerns before a quote even goes out. The Booking goal's prompt also
// honours it when present in the REQUIRED FIELDS block.
//
// Future fields (not in UI yet, captured here for context): move_in_out,
// pets, deep_cleaning, extras. They map onto existing legacy backend keys
// (condition / scope_extras) which the prompt builder still understands —
// so a saved value of `condition` or `scope_extras` on an account that
// pre-dates this catalog narrowing stays in `qualificationRequiredFields`
// and continues to inject into the AI prompt at runtime even though the
// UI no longer renders a checkbox for it. See toggleQualificationField
// for the preserve-unknown-keys logic.
// Booking-availability shape — mirrors src/ai/booking-availability.ts on
// the backend. The runtime normalizer there is the source of truth; this
// frontend copy is just for editor state. Keep the keys + default in
// sync if either side changes.
type BookingDayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
type BookingDaySettings = { morning: boolean; afternoon: boolean };
type BookingAvailability = Record<BookingDayKey, BookingDaySettings>;
const BOOKING_DAY_LABELS: Record<BookingDayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
const BOOKING_DAY_KEYS: readonly BookingDayKey[] =
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
// Default Mon–Fri morning + afternoon ON, weekends OFF. Matches
// DEFAULT_BOOKING_AVAILABILITY on the backend so accounts that haven't
// saved anything render the same windows the AI is told about.
const DEFAULT_BOOKING_AVAILABILITY: BookingAvailability = {
  mon: { morning: true,  afternoon: true  },
  tue: { morning: true,  afternoon: true  },
  wed: { morning: true,  afternoon: true  },
  thu: { morning: true,  afternoon: true  },
  fri: { morning: true,  afternoon: true  },
  sat: { morning: false, afternoon: false },
  sun: { morning: false, afternoon: false },
};
function normalizeBookingAvailability(raw: unknown): BookingAvailability {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOOKING_AVAILABILITY };
  const obj = raw as Record<string, unknown>;
  const out = {} as BookingAvailability;
  for (const day of BOOKING_DAY_KEYS) {
    const node = obj[day];
    const defaults = DEFAULT_BOOKING_AVAILABILITY[day];
    if (!node || typeof node !== 'object') { out[day] = { ...defaults }; continue; }
    const n = node as Record<string, unknown>;
    out[day] = {
      morning:   typeof n.morning   === 'boolean' ? n.morning   : defaults.morning,
      afternoon: typeof n.afternoon === 'boolean' ? n.afternoon : defaults.afternoon,
    };
  }
  return out;
}

const QUALIFICATION_FIELDS = [
  { key: 'bedrooms',       label: 'Bedrooms',             defaultChecked: false },
  { key: 'bathrooms',      label: 'Bathrooms',            defaultChecked: false },
  { key: 'square_footage', label: 'Square Footage',       defaultChecked: false },
  { key: 'frequency',      label: 'Frequency',            defaultChecked: false },
  { key: 'service_date',   label: 'Desired Service Date', defaultChecked: false },
  { key: 'zip_code',       label: 'Zip Code',             defaultChecked: true },
  { key: 'phone_number',   label: 'Phone Number',         defaultChecked: true },
] as const;
const QUALIFICATION_DEFAULT_FIELDS = QUALIFICATION_FIELDS
  .filter(f => f.defaultChecked)
  .map(f => f.key) as string[];
const QUALIFICATION_CATALOG_KEYS: Set<string> = new Set(QUALIFICATION_FIELDS.map(f => f.key));

// 5 user-selectable goals — Hybrid and Convert collapsed into Auto and
// Qualify respectively (UI only). Saved backend values 'hybrid' and
// 'convert' are remapped for DISPLAY in parseSettings and the runtime
// continues to honor them via STRATEGY_PROMPTS.hybrid / .convert. No DB
// writes — legacy values stay in followUpSettingsJson until the user
// explicitly picks a new goal.
//
// Phone (2026-06-16) is rendered as "Call Handoff" but the internal key
// stays `phone` so existing tenants' saved followUpStrategy='phone'
// values resolve unchanged. Booking is the new "schedule the job" goal.
const STRATEGIES: { k: StrategyKey; icon: LucideIcon; iconTone: IconTone; title: string; body: string; recommended?: boolean }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',         body: 'AI automatically chooses the best approach based on the conversation.', recommended: true },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',        body: 'Provide pricing information as quickly and accurately as possible.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify',      body: 'Collect the required information before quoting or booking.' },
  { k: 'booking', icon: CalendarCheck,    iconTone: 'blue',   title: 'Booking',      body: 'Move the customer toward scheduling the job.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Call Handoff', body: "Get the customer's number so your team can call." },
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
  const [availability, setAvailability] = useState<'always' | 'hours'>('always');
  const [aiConversationDeliveryMode, setAiConversationDeliveryMode] = useState<'suggest' | 'auto_send'>('auto_send');
  const [stopRules, setStopRules] = useState({
    not_contacted: true, booked: true, price_agreed: true, done: true,
  });
  const [takeover, setTakeover] = useState({
    ready: true, live: true, phone: true, sqft: true, qualified: true,
  });
  // Qualification required fields — stored as a flat array of snake_case
  // keys at `followUpSettingsJson.qualificationV2.requiredFields`. Used by
  // Price + Qualify goals; ignored otherwise. When an account has nothing
  // saved (existing tenants), the UI pre-checks the recommended-defaults
  // set: zip + phone (universal) + whatever the configured ServiceProfiles
  // imply (bedrooms/bathrooms/sqft/frequency).
  const [qualificationRequiredFields, setQualificationRequiredFields] =
    useState<string[]>(QUALIFICATION_DEFAULT_FIELDS);

  // ServiceProfile-derived recommendation set. Fetched once on mount, used
  // (a) to badge matching tiles as "Recommended" and (b) as the pre-tick
  // default when an account has no saved qualificationV2.requiredFields.
  // Per-account scope still derives across ALL of the user's active
  // profiles — runtime resolver picks the matching profile by category, so
  // we conservatively recommend the union here rather than gambling on
  // a single profile.
  const [serviceProfiles, setServiceProfiles] = useState<ServiceProfile[]>([]);
  const recommendedKeys = useMemo(
    () => deriveRecommendedFields(serviceProfiles),
    [serviceProfiles],
  );
  // parseSettings is invoked from many useEffect callsites that close over
  // stale `recommendedKeys` values; keep a ref so the most recent set is
  // always reachable from inside the parser.
  const recommendedKeysRef = useRef<Set<string>>(recommendedKeys);
  useEffect(() => { recommendedKeysRef.current = recommendedKeys; }, [recommendedKeys]);
  useEffect(() => {
    let alive = true;
    serviceProfilesApi.list()
      .then(res => { if (alive) setServiceProfiles(res.profiles ?? []); })
      .catch(() => { /* leave recommendedKeys at zip+phone defaults */ });
    return () => { alive = false; };
  }, []);

  // Custom Qualify fields (Pets, Gate code, Move-in date, etc). Tenant-
  // defined alongside the built-in catalog. Stored at
  // followUpSettingsJson.qualificationV2.customFields. Empty by default —
  // existing tenants with no saved customFields render no rows.
  const [qualificationCustomFields, setQualificationCustomFields] =
    useState<QualificationCustomField[]>([]);

  // Booking-goal availability — 7-day × 2-period toggle grid. Stored at
  // followUpSettingsJson.bookingAvailability. Defaults render Mon–Fri
  // morning + afternoon on for fresh accounts (matches DEFAULT on the
  // backend so the AVAILABILITY block injected at runtime stays in
  // sync with what the user sees).
  const [bookingAvailability, setBookingAvailability] =
    useState<BookingAvailability>(() => ({ ...DEFAULT_BOOKING_AVAILABILITY }));

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Click-to-toggle info popovers for the two main section headers
  // (matches the wizard's InfoDot/InfoTip pattern).
  const [goalInfoOpen, setGoalInfoOpen] = useState(false);
  const [modeInfoOpen, setModeInfoOpen] = useState(false);
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
    | 'strategy' | 'availability'
    | 'aiConversationDeliveryMode'
    | 'stopRules.not_contacted' | 'stopRules.booked' | 'stopRules.price_agreed' | 'stopRules.done'
    | 'takeover.ready' | 'takeover.live' | 'takeover.phone' | 'takeover.sqft' | 'takeover.qualified'
    | 'qualificationRequiredFields' | 'qualificationCustomFields'
    | 'bookingAvailability';
  const dirtyFieldsRef = useRef<Set<DirtyField>>(new Set());

  // Whether the currently-loaded scope had a saved qualificationV2.requiredFields
  // value. False = the displayed checkboxes are the recommended-defaults
  // fallback, so a later recommendedKeys arrival should refresh them.
  const currentScopeWasSavedRef = useRef<boolean>(false);

  // When ServiceProfiles arrive AFTER settings have hydrated, refresh the
  // recommended-defaults fallback so the matching boxes pre-tick on the
  // current scope. Guarded against (a) saved values, which always win, and
  // (b) user edits since load — we never overwrite a dirty draft.
  useEffect(() => {
    if (currentScopeWasSavedRef.current) return;
    if (dirtyFieldsRef.current.has('qualificationRequiredFields')) return;
    setQualificationRequiredFields(Array.from(recommendedKeys));
  }, [recommendedKeys]);

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
    const wasSaved = Array.isArray(savedFields);
    const requiredFields = wasSaved
      ? (savedFields as unknown[])
          .filter((k): k is string => typeof k === 'string')
      : Array.from(recommendedKeysRef.current);

    // Custom fields — defensive parsing. Drops malformed rows so a bad
    // save from an older UI version doesn't poison the editor. Each row
    // needs at minimum a non-empty label; missing question defaults to ''
    // (AI auto-generates at runtime). Missing required defaults to true.
    const savedCustom: unknown = s?.qualificationV2?.customFields;
    const customFields: QualificationCustomField[] = Array.isArray(savedCustom)
      ? (savedCustom as unknown[])
          .map((row): QualificationCustomField | null => {
            if (!row || typeof row !== 'object') return null;
            const r = row as Record<string, unknown>;
            const label = typeof r.label === 'string' ? r.label.trim() : '';
            if (!label) return null;
            return {
              id: typeof r.id === 'string' && r.id ? r.id : makeCustomFieldId(),
              label,
              question: typeof r.question === 'string' ? r.question : '',
              required: r.required !== false,
            };
          })
          .filter((x): x is QualificationCustomField => x !== null)
      : [];

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
      availability: s?.followUpAvailability === 'active_hours' ? 'hours' : 'always',
      // Default to 'auto_send' when missing so pre-V2 tenants keep firing
      // AI replies automatically. Only explicit 'suggest' parks them.
      aiConversationDeliveryMode: s?.aiConversationDeliveryMode === 'suggest' ? 'suggest' : 'auto_send',
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
      qualificationRequiredFieldsWasSaved: wasSaved,
      qualificationCustomFields: customFields,
      // Defensive parsing — older saves without this key fall through to
      // the Mon–Fri morning/afternoon default via normalizeBookingAvailability.
      bookingAvailability: normalizeBookingAvailability(s?.bookingAvailability),
    };
  };

  // Hydrate from cache on scope change for instant display.
  useEffect(() => {
    if (isAll) {
      const cached = accounts.map(a => convCache.get(a.id)).filter(Boolean) as CachedConvSettings[];
      if (cached.length > 0 && !dirtyRef.current) {
        const first = cached[0];
        setStrategy(first.strategy);
        setAvailability(first.availability);
        setAiConversationDeliveryMode(first.aiConversationDeliveryMode);
        setStopRules(first.stopRules);
        setTakeover(first.takeover);
        setQualificationRequiredFields(first.qualificationRequiredFields);
        currentScopeWasSavedRef.current = first.qualificationRequiredFieldsWasSaved;
        setQualificationCustomFields(first.qualificationCustomFields);
        setBookingAvailability(first.bookingAvailability);
      }
    } else {
      const cached = convCache.get(accountId);
      if (cached && !dirtyRef.current) {
        setStrategy(cached.strategy);
        setAvailability(cached.availability);
        setAiConversationDeliveryMode(cached.aiConversationDeliveryMode);
        setStopRules(cached.stopRules);
        setTakeover(cached.takeover);
        setQualificationRequiredFields(cached.qualificationRequiredFields);
        currentScopeWasSavedRef.current = cached.qualificationRequiredFieldsWasSaved;
        setQualificationCustomFields(cached.qualificationCustomFields);
        setBookingAvailability(cached.bookingAvailability);
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
            setAvailability(parsed.availability);
            setAiConversationDeliveryMode(parsed.aiConversationDeliveryMode);
            setStopRules(parsed.stopRules);
            setTakeover(parsed.takeover);
            setQualificationRequiredFields(parsed.qualificationRequiredFields);
            currentScopeWasSavedRef.current = parsed.qualificationRequiredFieldsWasSaved;
            setQualificationCustomFields(parsed.qualificationCustomFields);
            setBookingAvailability(parsed.bookingAvailability);
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
              setAvailability(parsed.availability);
              setAiConversationDeliveryMode(parsed.aiConversationDeliveryMode);
              setStopRules(parsed.stopRules);
              setTakeover(parsed.takeover);
              setQualificationRequiredFields(parsed.qualificationRequiredFields);
              currentScopeWasSavedRef.current = parsed.qualificationRequiredFieldsWasSaved;
              setQualificationCustomFields(parsed.qualificationCustomFields);
              setBookingAvailability(parsed.bookingAvailability);
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
    if (fields.has('availability')) payload.followUpAvailability = availability === 'hours' ? 'active_hours' : 'always';
    if (fields.has('aiConversationDeliveryMode')) payload.aiConversationDeliveryMode = aiConversationDeliveryMode;
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
    if (fields.has('qualificationRequiredFields') || fields.has('qualificationCustomFields')) {
      // Save BOTH sub-keys together — backend replaces the whole
      // qualificationV2 object, so omitting either when one is dirty
      // would wipe the other from storage.
      payload.qualificationV2 = {
        requiredFields: qualificationRequiredFields,
        customFields: qualificationCustomFields,
      };
    }
    if (fields.has('bookingAvailability'))   payload.bookingAvailability       = bookingAvailability;

    // Optimistic cache update — merge ONLY the changed fields onto each
    // account's existing cached values. Don't replace the whole object, or
    // mixed-state badges would think untouched fields changed too.
    const targets = isAll ? accounts.map(a => a.id) : [accountId];
    targets.forEach(id => {
      const prev = convCache.get(id);
      if (!prev) {
        convCache.set(id, {
          strategy, availability, aiConversationDeliveryMode,
          stopRules, takeover,
          qualificationRequiredFields,
          qualificationRequiredFieldsWasSaved: true,
          qualificationCustomFields,
          bookingAvailability,
        });
        return;
      }
      const next: CachedConvSettings = { ...prev };
      if (fields.has('strategy'))     next.strategy     = strategy;
      if (fields.has('availability')) next.availability = availability;
      if (fields.has('aiConversationDeliveryMode')) next.aiConversationDeliveryMode = aiConversationDeliveryMode;
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
      if (fields.has('qualificationCustomFields')) {
        next.qualificationCustomFields = qualificationCustomFields;
      }
      if (fields.has('bookingAvailability'))   next.bookingAvailability   = bookingAvailability;
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
  }, [strategy, availability, aiConversationDeliveryMode, stopRules, takeover, qualificationRequiredFields, qualificationCustomFields, bookingAvailability]);

  // markDirty-wrapped setters used by JSX. Each setter records BOTH the
  // dirty flag (gates the save effect) AND the specific field name(s) so we
  // only write what the user actually changed.
  const onStrategy     = (v: StrategyKey)            => { dirtyRef.current = true; dirtyFieldsRef.current.add('strategy');     setStrategy(v); };
  // AI Response Mode picker. Three tiles map to two underlying fields:
  //   Review before sending → deliveryMode='suggest' (availability irrelevant
  //                            in runtime; we leave it untouched so existing
  //                            value survives a future tile flip back).
  //   Assist when unavailable → deliveryMode='auto_send' + availability='hours'
  //   Full autopilot          → deliveryMode='auto_send' + availability='always'
  const onResponseMode = (mode: 'review' | 'assist' | 'autopilot') => {
    dirtyRef.current = true;
    if (mode === 'review') {
      dirtyFieldsRef.current.add('aiConversationDeliveryMode');
      setAiConversationDeliveryMode('suggest');
      return;
    }
    // Both non-review modes are auto-send with different availability windows.
    dirtyFieldsRef.current.add('aiConversationDeliveryMode');
    dirtyFieldsRef.current.add('availability');
    setAiConversationDeliveryMode('auto_send');
    setAvailability(mode === 'assist' ? 'hours' : 'always');
  };

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

  // Custom Qualify fields — add / update / remove. Each mutates the
  // qualificationCustomFields array and marks the same dirty key, so
  // auto-save batches consecutive edits.
  const addCustomField = () => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualificationCustomFields');
    setQualificationCustomFields(prev => [
      ...prev,
      { id: makeCustomFieldId(), label: '', question: '', required: true },
    ]);
  };
  const updateCustomField = (id: string, patch: Partial<Omit<QualificationCustomField, 'id'>>) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualificationCustomFields');
    setQualificationCustomFields(prev =>
      prev.map(f => (f.id === id ? { ...f, ...patch } : f)),
    );
  };
  const removeCustomField = (id: string) => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('qualificationCustomFields');
    setQualificationCustomFields(prev => prev.filter(f => f.id !== id));
  };

  // Booking-availability toggle. Each click flips one (day, period) cell
  // and marks the whole blob dirty — the backend save handler replaces
  // bookingAvailability wholesale, so partial-key writes aren't a thing.
  const toggleBookingDayPeriod = (day: BookingDayKey, period: 'morning' | 'afternoon') => {
    dirtyRef.current = true;
    dirtyFieldsRef.current.add('bookingAvailability');
    setBookingAvailability(prev => ({
      ...prev,
      [day]: { ...prev[day], [period]: !prev[day][period] },
    }));
  };

  const goFollowups = () => navigate('/automation/engage', { state: fromState });
  const goAlerts = () => navigate('/settings?tab=communication', { state: fromState });
  const goEditHours = () => navigate('/settings?tab=hours', { state: fromState });

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

      {/* Master enable moved to the page-shell PlanSwitcher (Phase 3 design
          refresh). When off + the user has the Convert tier, show the
          empty state instead of the controls. Non-Convert users still see
          the controls behind UpgradeOverlay so they know what they'd unlock. */}
      {!aiOn && canUseAi ? (
        <PlanOffEmptyState
          planLabel="AI Conversation"
          icon={Power}
          onTurnOn={() => onAiToggle(true)}
          description="Turn on to let AI handle customer conversations end-to-end. Applies to all connected accounts."
        />
      ) : null}

      {!(aiOn || !canUseAi) ? null : <>

      {/* ───── 1. Conversation Goal — wizard chrome ────────────────────── */}
      <div style={{
        background: '#fff',
        border: '1px solid var(--lb-line)',
        borderRadius: 14,
        boxShadow: 'var(--lb-shadow-sm)',
        padding: 16,
      }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
          <span style={{
            width: 40, height: 40, borderRadius: 11,
            background: '#e0e7ff', color: '#6366f1',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            <Target size={19} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
                Conversation Goal
              </div>
              <AutoBadge tone="green">Applies everywhere</AutoBadge>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 3, lineHeight: 1.5 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                What AI is trying to achieve with each reply. Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation.
                How AI <em>speaks</em> is controlled in <a href="/settings?tab=ai-playbook" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Settings → AI Playbook</a>.
              </span>
              <InfoDot open={goalInfoOpen} onClick={() => setGoalInfoOpen(o => !o)} />
            </div>
            {goalInfoOpen && (
              <InfoTip>
                Each goal changes how AI replies, what it tries to find out, and when it hands off to your team. Pick the one that matches your business — or leave on Auto and AI switches strategies based on what each lead asks.
              </InfoTip>
            )}
          </div>
        </div>
        <div style={{ marginTop: 16 }} />
        {/* Strategy grid — wizard's lb-strat-grid: 5-col on desktop,
            1-col on mobile (see index.css). Replaces the previous
            inline repeat(5,1fr) which had no mobile collapse and
            squeezed titles into a letter-per-line wrap on phones. */}
        <div
          className="lb-strat-grid"
          style={{ display: 'grid', gap: 10 }}
        >
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

      {/* ───── 2. Goal-specific setup ─────────────────────────────────────── */}
      <GoalSetupCard
        strategy={strategy}
        qualificationRequiredFields={qualificationRequiredFields}
        toggleQualificationField={toggleQualificationField}
        recommendedKeys={recommendedKeys}
        qualificationCustomFields={qualificationCustomFields}
        addCustomField={addCustomField}
        updateCustomField={updateCustomField}
        removeCustomField={removeCustomField}
        bookingAvailability={bookingAvailability}
        toggleBookingDayPeriod={toggleBookingDayPeriod}
      />

      {/* ───── 3. Advanced Rules — only when ?advanced=1 or ?debug=1 ────────
            Normal users manage AI behavior via Conversation Goals. The
            legacy Stop Rules / Human Takeover toggles still drive the
            backend (aiStopOn* / handoffTrigger* fields) and remain
            reachable for support and power users through the URL param. */}
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

      {/* ───── 4. AI Response Mode ──────────────────────────────────────────
            Merges the old Delivery Mode + Auto Reply Availability concepts
            into one "when is AI allowed to respond" picker. This is
            AI-Conversation specific — Follow-ups keep their own quiet
            hours + delivery picker because business-initiated re-engagement
            has different customer expectations than mid-conversation reply.
            See spec section 3.

            Internal mapping (V2 Review Mode shipped 2026-06-12):
              "Review before sending" → aiConversationDeliveryMode='suggest'
                AI generates a draft on customer reply but parks it on
                ThreadContext.stateJson.pendingAiSuggestion instead of
                dispatching. Operator approves/discards from Lead Activity.
              "Assist when unavailable" → deliveryMode='auto_send'
                + followUpAvailability='active_hours' (sends only outside
                business hours).
              "Full autopilot"        → deliveryMode='auto_send'
                + followUpAvailability='always' (sends any time). */}
      <SectionCard padding="22px 24px 24px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
          <IconTile icon={Clock} tone="violet" size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              AI Response Mode
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                When AI is allowed to respond automatically to customer messages.
              </span>
              <InfoDot open={modeInfoOpen} onClick={() => setModeInfoOpen(o => !o)} />
            </div>
            {modeInfoOpen && (
              <InfoTip>
                "Assist when unavailable" lets your team handle live conversations during business hours; AI fills in only after-hours. "Full autopilot" runs AI any time. Either way, AI follow-ups and detection still run on their own schedule.
              </InfoTip>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* "Review before sending" hidden by default 2026-06-18. New
              users skip suggest mode entirely — they want AI to start
              replying ASAP, not park drafts for review. The opt-in
              toggle for suggest mode now lives on Settings → AI
              Playbook → Delivery mode (advanced). This card still
              renders here when the tenant's saved value IS suggest so
              they're never locked out of switching off without
              hunting through Playbook. */}
          {aiConversationDeliveryMode === 'suggest' && (
            <ResponseModeOption
              selected={aiConversationDeliveryMode === 'suggest'}
              onClick={() => onResponseMode('review')}
              title="Review before sending"
              body="AI drafts replies and parks them for your approval. Nothing sends until you tap Send."
            />
          )}
          <ResponseModeOption
            selected={aiConversationDeliveryMode === 'auto_send' && availability === 'hours'}
            onClick={() => onResponseMode('assist')}
            title="Assist when unavailable"
            body="AI responds automatically outside your business hours."
            mixed={mixedAvailability.mixed && aiConversationDeliveryMode === 'auto_send' && availability === 'hours'}
            mixedTooltip={mixedAvailability.tooltip}
          />
          <ResponseModeOption
            selected={aiConversationDeliveryMode === 'auto_send' && availability === 'always'}
            onClick={() => onResponseMode('autopilot')}
            title="Full autopilot"
            body="AI responds automatically at any time."
            mixed={mixedAvailability.mixed && aiConversationDeliveryMode === 'auto_send' && availability === 'always'}
            mixedTooltip={mixedAvailability.tooltip}
          />
        </div>

        <div style={{
          marginTop: 16,
          padding: '12px 14px',
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 10,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-2)' }}>
              <strong style={{ color: 'var(--lb-ink-1)' }}>Business Hours:</strong> {bizHoursSummary}
            </div>
            <ActionLink external onClick={goEditHours}>Edit</ActionLink>
          </div>
          <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 6, lineHeight: 1.5 }}>
            Business hours are used when AI Response Mode is set to <em>Assist when unavailable</em>.
          </div>
        </div>
      </SectionCard>

      {/* ───── 5. How it works ────────────────────────────────────────────── */}
      <SectionCard padding="20px 24px">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
          How it works
        </div>
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginBottom: 18 }}>
          AI pursues the Conversation Goal until the goal is reached. Then it stops and hands the lead off — your team is notified.
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
          <FlowStep icon={Hand}               iconTone="rose"   title="AI hands off"            subtitle="team is notified" />
        </div>
      </SectionCard>

      </>}

      </UpgradeOverlay>
    </div>
  );
}

/**
 * Vertical-stack option tile used by the AI Response Mode card. Rendered as
 * a button row with a radio indicator on the left. When `disabled` is true,
 * the tile cannot be clicked and renders muted with the supplied `badge`
 * (used today for the "Coming soon" Review-before-sending mode while
 * backend wiring catches up). When `mixed` is true (All-Accounts cross-
 * account disagreement), the tile draws the same amber border the other
 * mixed-state controls on this page use.
 */
function ResponseModeOption({
  selected, onClick, disabled, title, body, badge, mixed, mixedTooltip,
}: {
  selected: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title: string;
  body: string;
  badge?: string;
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  const interactive = !disabled && !!onClick;
  return (
    <button
      type="button"
      onClick={interactive ? onClick : undefined}
      disabled={disabled}
      title={mixed ? mixedTooltip : undefined}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        width: '100%',
        padding: '12px 14px',
        textAlign: 'left',
        background: disabled ? '#f8fafc' : mixed ? '#fffbeb' : selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (mixed ? '#f59e0b' : selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: interactive ? 'pointer' : 'default',
        fontFamily: 'inherit',
        opacity: disabled ? 0.7 : 1,
        transition: 'border-color 120ms, background 120ms',
        boxShadow: mixed ? '0 0 0 3px rgba(245,158,11,0.14)' : undefined,
      }}
    >
      <div style={{ paddingTop: 2 }}>
        <Radio selected={selected} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</span>
          {badge && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.05,
              padding: '2px 7px', borderRadius: 999,
              background: '#fef3c7', color: '#92400e',
              textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
            }}>
              {badge}
            </span>
          )}
          {mixed && !disabled && (
            <span style={{ display: 'inline-flex', color: '#d97706' }}>
              <AlertTriangle size={12} />
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5 }}>{body}</div>
      </div>
    </button>
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
  /** Show a small "REC" pill next to the title. Used on Auto. */
  recommended?: boolean;
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  // Wizard-mirroring horizontal layout: icon-left, title+body-middle,
  // info-glyph-right. The vertical column layout we used before broke
  // titles letter-by-letter when the parent grid collapsed to narrow
  // columns. Now the title has the full row width available.
  return (
    <button
      type="button"
      onClick={onClick}
      title={mixed ? mixedTooltip : undefined}
      style={{
        textAlign: 'left', padding: 12,
        background: mixed ? '#fffbeb' : selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (mixed ? '#f59e0b' : selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 12,
        cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', alignItems: 'center', gap: 10,
        transition: 'border-color 120ms, background 120ms',
        boxShadow: mixed ? '0 0 0 3px rgba(245,158,11,0.14)' : undefined,
      }}
    >
      <IconTile icon={icon} tone={iconTone} size="md" />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            {title}
          </span>
          {recommended && !mixed && (
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: 0.06,
              padding: '2px 7px', borderRadius: 999,
              background: 'var(--lb-success-tint)', color: 'var(--lb-success)',
              textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)',
              border: '1px solid #a7f3d0',
            }}>
              REC
            </span>
          )}
          {mixed && (
            <span style={{ color: '#d97706', display: 'inline-flex' }}>
              <AlertTriangle size={13} />
            </span>
          )}
        </span>
        <span style={{
          display: '-webkit-box',
          fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.4,
          marginTop: 2,
          overflow: 'hidden',
          WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
        } as CSSProperties}>
          {body}
        </span>
      </span>
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
// Renders the per-goal configuration ONLY: Required Information (Qualify,
// UI-driven checkboxes + custom fields), Goal description blurb, and the
// price-quote-mode picker (Price). Auto + Phone get the goal description
// only (Phone has no extra controls; Auto explains the auto-router).
//
// V2.1 (2026-06-13): the per-goal "When Goal Is Reached" radio that used
// to live here has moved out to the account-level
// <GoalCompletionBehaviorCard>. Completion behavior is one decision per
// account, not per goal — see the new card in the parent JSX.

function GoalSetupCard({
  strategy,
  qualificationRequiredFields, toggleQualificationField,
  recommendedKeys,
  qualificationCustomFields, addCustomField, updateCustomField, removeCustomField,
  bookingAvailability, toggleBookingDayPeriod,
}: {
  strategy: StrategyKey;
  qualificationRequiredFields: string[];
  toggleQualificationField: (key: string) => void;
  recommendedKeys: Set<string>;
  qualificationCustomFields: QualificationCustomField[];
  addCustomField: () => void;
  updateCustomField: (id: string, patch: Partial<Omit<QualificationCustomField, 'id'>>) => void;
  removeCustomField: (id: string) => void;
  bookingAvailability: BookingAvailability;
  toggleBookingDayPeriod: (day: BookingDayKey, period: 'morning' | 'afternoon') => void;
}) {
  // Auto + Call Handoff goals have no per-goal setup card per design —
  // Auto routes to whichever sub-goal applies, Call Handoff behavior is
  // fully driven by the global rules. Booking renders an availability
  // editor (the AI uses the enabled day/period windows when offering two
  // slots to the customer). Only Price and Qualify render dedicated
  // setup cards beyond that.
  if (strategy === 'booking') {
    return (
      <SectionCard padding="22px 24px 22px">
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Booking goal setup
          </div>
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.55 }}>
            AI asks for the customer's preferred service date and pushes
            toward scheduling. It will answer a price question first if
            the customer asks, and hand off to your team if the customer
            asks for a call.
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 8, lineHeight: 1.5 }}>
            Booking-critical Qualify fields (address, zip, desired service
            date) are configured under the <strong>Qualify</strong> goal —
            anything ticked there is also collected before AI tries to
            book.
          </div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Available booking windows
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.5 }}>
            Pick the day/time windows the team can take bookings. AI
            offers two of these when asking the customer for a date.
            Turn a row off to skip that day entirely.
          </div>

          <div style={{ marginTop: 12, display: 'grid', rowGap: 6 }}>
            {BOOKING_DAY_KEYS.map(day => (
              <BookingDayRow
                key={day}
                label={BOOKING_DAY_LABELS[day]}
                morningOn={bookingAvailability[day].morning}
                afternoonOn={bookingAvailability[day].afternoon}
                onMorningToggle={() => toggleBookingDayPeriod(day, 'morning')}
                onAfternoonToggle={() => toggleBookingDayPeriod(day, 'afternoon')}
              />
            ))}
          </div>
        </div>
      </SectionCard>
    );
  }

  // Price goal no longer has a per-goal setup card. The range/exact
  // picker that used to live here moved to AI Playbook → Pricing
  // Guidance → ServicePricingForm on 2026-06-18 so it lives next to
  // the price table the operator is reviewing and applies independent
  // of the Conversation Goal.
  if (strategy !== 'qualify') return null;

  // ─── Qualify goal: Required information ──────────────────────────────
  return (
    <SectionCard padding="22px 24px 22px">
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
          Required information
        </div>
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 4 }}>
          AI collects these before quoting or booking.
        </div>
      </div>

      <div
        className="lb-required-info-grid lb-qual"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 10,
          marginBottom: 12,
        }}
      >
        {QUALIFICATION_FIELDS.map(field => {
          const checked = qualificationRequiredFields.includes(field.key);
          const recommended = recommendedKeys.has(field.key);
          return (
            <RequiredInfoCheckbox
              key={field.key}
              checked={checked}
              label={field.label}
              recommended={recommended}
              onToggle={() => toggleQualificationField(field.key)}
            />
          );
        })}
      </div>

      <button
        type="button"
        onClick={addCustomField}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '8px 14px',
          background: 'var(--lb-surface)', color: 'var(--lb-ink-3)',
          border: '1px dashed var(--lb-line)', borderRadius: 999,
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
        }}
      >
        <Plus size={13} /> Add custom field
      </button>

      {qualificationCustomFields.length > 0 && (
        <div style={{ marginTop: 14, display: 'grid', gap: 8 }}>
          {qualificationCustomFields.map(field => (
            <CustomFieldRow
              key={field.id}
              field={field}
              onLabelChange={v => updateCustomField(field.id, { label: v })}
              onQuestionChange={v => updateCustomField(field.id, { question: v })}
              onRequiredChange={v => updateCustomField(field.id, { required: v })}
              onRemove={() => removeCustomField(field.id)}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Required-info checkbox tile ─────────────────────────────────────────
// Card-style checkbox row per the Qualify-goal screenshot: rounded border,
// blue check icon when on, full-width clickable area.
function RequiredInfoCheckbox({
  checked, label, recommended, onToggle,
}: {
  checked: boolean;
  label: string;
  recommended?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={recommended ? 'Recommended for your configured services' : undefined}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        background: 'var(--lb-surface)',
        border: '1.5px solid ' + (checked ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: 'pointer', fontFamily: 'inherit',
        textAlign: 'left',
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <span
        style={{
          width: 18, height: 18, borderRadius: 5,
          background: checked ? 'var(--lb-accent)' : 'var(--lb-surface)',
          border: '1.5px solid ' + (checked ? 'var(--lb-accent)' : '#cbd5e1'),
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {checked && (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
        )}
      </span>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)', flex: 1 }}>{label}</span>
      {recommended && (
        <span
          style={{
            fontSize: 10.5, fontWeight: 700, letterSpacing: '0.04em',
            color: '#0369a1',
            background: '#e0f2fe',
            border: '1px solid #bae6fd',
            padding: '2px 7px', borderRadius: 999,
            textTransform: 'uppercase',
            whiteSpace: 'nowrap',
          }}
        >
          Recommended
        </span>
      )}
    </button>
  );
}

// ─── Booking-availability day row ─────────────────────────────────────────
// One weekday row with two pill toggles (Morning / Afternoon). Used in
// the Booking goal setup card. Visually mirrors the Required-info
// checkbox tile but with two side-by-side period toggles to the right
// of the day label.
function BookingDayRow({
  label, morningOn, afternoonOn, onMorningToggle, onAfternoonToggle,
}: {
  label: string;
  morningOn: boolean;
  afternoonOn: boolean;
  onMorningToggle: () => void;
  onAfternoonToggle: () => void;
}) {
  return (
    <div className="lb-booking-time-row" style={{
      display: 'grid',
      gridTemplateColumns: '64px 1fr 1fr',
      gap: 10, alignItems: 'center',
      padding: '8px 12px',
      background: 'var(--lb-surface)',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
    }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-2)', letterSpacing: '0.02em', textTransform: 'uppercase', fontFamily: 'var(--lb-font-mono)' }}>
        {label}
      </div>
      <BookingPeriodPill on={morningOn}   label="Morning"   onClick={onMorningToggle}   />
      <BookingPeriodPill on={afternoonOn} label="Afternoon" onClick={onAfternoonToggle} />
    </div>
  );
}

function BookingPeriodPill({
  on, label, onClick,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 12px',
        background: on ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (on ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 999,
        cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 12.5, fontWeight: 600,
        color: on ? 'var(--lb-accent)' : 'var(--lb-ink-4)',
        transition: 'border-color 120ms, background 120ms, color 120ms',
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
      }}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 999,
          background: on ? 'var(--lb-accent)' : '#cbd5e1',
        }}
      />
      {label}
    </button>
  );
}

// GoalCompletionBehaviorCard removed 2026-06-18. AI always stops on
// goal complete; no user choice exposed. See automation.service.ts
// Price/Qualify/Phone gate blocks for the unconditional stop logic.

/**
 * One editable row inside the Custom Required Fields list. Label is
 * required (an empty label is allowed in state but its row carries a
 * warning border until filled). Helper question is optional. Required
 * toggle defaults true — uncheck to mark the field as "ask but don't
 * gate qualification on it."
 */
function CustomFieldRow({
  field, onLabelChange, onQuestionChange, onRequiredChange, onRemove,
}: {
  field: QualificationCustomField;
  onLabelChange: (v: string) => void;
  onQuestionChange: (v: string) => void;
  onRequiredChange: (v: boolean) => void;
  onRemove: () => void;
}) {
  const labelEmpty = field.label.trim().length === 0;
  return (
    <div className="lb-qual-field-row" style={{
      display: 'grid',
      gridTemplateColumns: 'minmax(140px, 1fr) minmax(180px, 2fr) auto auto',
      gap: 8, alignItems: 'center',
      padding: '8px 10px',
      background: 'white',
      border: '1px solid ' + (labelEmpty ? '#fde68a' : 'var(--lb-line-soft)'),
      borderRadius: 8,
    }}>
      <input
        type="text"
        value={field.label}
        onChange={e => onLabelChange(e.target.value)}
        placeholder="Field label (e.g. Pets)"
        style={{
          padding: '6px 8px',
          border: '1px solid var(--lb-line)',
          borderRadius: 6,
          fontSize: 13, fontFamily: 'inherit',
          background: 'white', color: 'var(--lb-ink-1)',
        }}
      />
      <input
        type="text"
        value={field.question}
        onChange={e => onQuestionChange(e.target.value)}
        placeholder="Optional helper question (AI will auto-phrase if empty)"
        style={{
          padding: '6px 8px',
          border: '1px solid var(--lb-line)',
          borderRadius: 6,
          fontSize: 13, fontFamily: 'inherit',
          background: 'white', color: 'var(--lb-ink-1)',
        }}
      />
      <label style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        fontSize: 12, color: 'var(--lb-ink-3)', cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}>
        <input
          type="checkbox"
          checked={field.required}
          onChange={e => onRequiredChange(e.target.checked)}
          style={{ accentColor: 'var(--lb-accent)' }}
        />
        Required
      </label>
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove field"
        title="Remove field"
        style={{
          padding: 6, background: 'transparent', border: 0,
          cursor: 'pointer', color: 'var(--lb-ink-5)',
          display: 'inline-flex', alignItems: 'center',
        }}
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

// ─── Advanced rules card ───────────────────────────────────────────────────
// Legacy compatibility surface for the 9 original Stop Rules / Human
// Takeover toggles. Hidden by default; reachable via ?advanced=1 or
// ?debug=1. Backend fields (aiStopOn* / handoffTrigger*) are still live
// except aiStopOnPriceAgreed, which became inert with the 2026-06-18
// handoff-on-goal simplification but remains here for legacy parity.
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
