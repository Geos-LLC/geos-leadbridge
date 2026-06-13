import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Sparkles, History,
  RefreshCw, Clock, UserX, Info, Power,
} from 'lucide-react';
import {
  SectionCard, FieldRow, OptionCard,
  Dropdown, IconTile, FooterBanner, StatusPill, MixedBadge,
  PlanOffEmptyState, TimingRow, MessageGenerationRow,
  type IconTone,
} from '../../components/automation/ui';
import type { LucideIcon } from 'lucide-react';
import { followUpApi, usersApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';

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
type PlanStepData = { val: number; unit: PlanUnit };
type PlanUnit = 'min' | 'hour' | 'day' | 'week' | 'month' | 'year';

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
  plan: PlanStepData[];
  // Read-only on this page (edited in AutomationConversation). Cached so
  // the AI Strategy tile under Follow-up mode reflects the saved value.
  followUpStrategy: StrategyKey;
};
const followupsCache = new Map<string, CachedFollowups>();

// Default 11-step cadence — matches the backend follow-up engine seed
// templates so a fresh account sees the system's standard rhythm.
const DEFAULT_FOLLOWUP_PLAN: PlanStepData[] = [
  { val: 2,  unit: 'min' },
  { val: 10, unit: 'min' },
  { val: 1,  unit: 'hour' },
  { val: 1,  unit: 'day' },
  { val: 3,  unit: 'day' },
  { val: 7,  unit: 'day' },
  { val: 2,  unit: 'week' },
  { val: 1,  unit: 'month' },
  { val: 3,  unit: 'month' },
  { val: 6,  unit: 'month' },
  { val: 1,  unit: 'year' },
];

// Parse the persisted `${val} ${unit}` string back into the editor shape.
// Matches the backend's parseDelay() substring rules — keep in sync if those
// change (src/follow-up-engine/follow-up-scheduler.service.ts).
function parseDelayToStep(delay: string): PlanStepData {
  const d = (delay || '').toLowerCase().trim();
  const val = Math.max(1, Math.round(parseFloat(d) || 1));
  if (d.includes('min')) return { val, unit: 'min' };
  if (d.includes('hour') || d.includes('hr')) return { val, unit: 'hour' };
  if (d.includes('day')) return { val, unit: 'day' };
  if (d.includes('week') || d.includes('wk')) return { val, unit: 'week' };
  if (d.includes('month') || d.includes('mo')) return { val, unit: 'month' };
  if (d.includes('year') || d.includes('yr')) return { val, unit: 'year' };
  return { val: 1, unit: 'day' };
}

// Serialize an editor step back to the canonical `${val} ${unit}` form
// the backend's parseDelay() understands.
function stepToDelayString(step: PlanStepData): string {
  return `${step.val} ${step.unit}`;
}

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
  // 11-step plan — editable. Persisted to followUpSettingsJson.followUpSteps
  // as [{ delay: '2 min', message: null }, ...]. Backend parseDelay()
  // converts each delay string into minutes for scheduling.
  const [plan, setPlan] = useState<PlanStepData[]>(DEFAULT_FOLLOWUP_PLAN);
  // Read-only AI Strategy. Per-account, lives in followUpSettingsJson.
  // Quiet hours summary used to render in its own card; per spec 2g it's
  // now folded into the Timing row inside Follow-up mode (the schedule
  // lives behind the Edit Hours link), so the standalone summary state
  // is gone.
  const [followUpStrategy, setFollowUpStrategy] = useState<StrategyKey>('auto');

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
    | 'resumeDelay' | 'deferralDelay' | 'hiredDelay'
    | 'plan';
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

  const parseSettings = (s: any, accountHoursQuiet?: boolean): CachedFollowups => {
    // Follow-up plan — hydrate from any of the three legacy key names the
    // backend accepts (followUpSteps is the canonical one).
    const rawSteps = s?.followUpSteps || s?.followUpSmartSteps || s?.followUpCustomSteps;
    const hydratedPlan: PlanStepData[] = Array.isArray(rawSteps) && rawSteps.length > 0
      ? rawSteps.map((st: any) => parseDelayToStep(st?.delay ?? ''))
      : DEFAULT_FOLLOWUP_PLAN;
    return {
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
      plan: hydratedPlan,
      followUpStrategy: isStrategyKey(s?.followUpStrategy) ? s.followUpStrategy : 'auto',
    };
  };

  // User-level quiet hours — independent of selected account. The Quiet
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
        setPlan(first.plan);
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
        setPlan(cached.plan);
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
            setPlan(first.plan);
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
          setPlan(parsed.plan);
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
    if (fields.has('plan')) {
      // Persisted as the canonical `steps` array. Backend writes it to
      // followUpSettingsJson.followUpSteps; the scheduler prefers these
      // user-configured delays over the seed template's defaults
      // (see follow-up-scheduler.service.ts getUserConfiguredSteps).
      wizardPayload.steps = plan.map(s => ({ delay: stepToDelayString(s), message: null }));
    }
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
          resumeDelay, deferralDelay, hiredDelay, plan, followUpStrategy,
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
        plan:             fields.has('plan')             ? plan             : prev.plan,
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
  // mixedMaster previously fed the in-page master SettingCard which moved
  // to the shell PlanSwitcher in the 2026-06-13 design refresh. Kept the
  // helper call shape inline-deleted; the mixed-state badge for the master
  // toggle now belongs on the shell (Phase 4 follow-up).
  const mixedDelivery = getMixedF('deliveryMode', v => v === 'active' ? 'Active (auto-send)' : 'Suggest');
  const mixedMessage  = getMixedF('messageMode', v => v === 'ai' ? 'AI (auto)' : 'Custom template');
  const mixedQuiet    = getMixedF('quietOn', v => v ? 'On' : 'Off');
  const mixedResume   = getMixedF('resumeDelay', v => String(v));
  const mixedDeferral = getMixedF('deferralDelay', v => String(v));
  const mixedHired    = getMixedF('hiredDelay', v => String(v));

  // Plan needs a deep-equality compare — getMixedF stringifies via String()
  // which collapses arrays of objects to the same value. Bypass with a
  // JSON-serialized key so distinct plans show up as deviants.
  function getMixedPlan(): { mixed: boolean; tooltip?: string } {
    if (!isAll) return { mixed: false };
    const entries = accounts
      .map(a => ({ account: a, cached: followupsCache.get(a.id) }))
      .filter(x => x.cached !== undefined) as { account: typeof accounts[0]; cached: CachedFollowups }[];
    if (entries.length < 2) return { mixed: false };
    const keyOf = (p: PlanStepData[]) => JSON.stringify(p);
    const fmt = (p: PlanStepData[]) => p.map(s => `${s.val}${s.unit[0]}`).join(' → ');
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(keyOf(e.cached.plan), (counts.get(keyOf(e.cached.plan)) || 0) + 1);
    let majorityKey = keyOf(entries[0].cached.plan);
    let maxCount = 0;
    counts.forEach((c, k) => { if (c > maxCount) { maxCount = c; majorityKey = k; } });
    const majorityEntry = entries.find(e => keyOf(e.cached.plan) === majorityKey)!;
    const deviants = entries.filter(e => keyOf(e.cached.plan) !== majorityKey);
    if (deviants.length === 0) return { mixed: false };
    const tooltip =
      `Most accounts: ${fmt(majorityEntry.cached.plan)}\n` +
      `Differs in:\n` +
      deviants.map(d => `  • ${d.account.businessName || d.account.platform}: ${fmt(d.cached.plan)}`).join('\n');
    return { mixed: true, tooltip };
  }
  // mixedPlan was used by the editable cadence card before spec 2h made it
  // presentational; getMixedPlan is preserved upstream in case the editable
  // plan ever returns.
  void getMixedPlan;

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
  }, [followUpsOn, deliveryMode, messageMode, activeHoursStart, activeHoursEnd, timezone, quietOn, resumeDelay, deferralDelay, hiredDelay, plan]);

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
  // Plan editor handlers (onPlanStepChange / onPlanAddStep / onPlanRemoveStep
  // / onPlanReset) were removed when the Follow-up plan card became
  // presentational per spec 2h. The plan state + save plumbing is preserved
  // upstream so saved cadences keep loading; only the editing UI is gone.
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

      {/* Master Follow-ups toggle moved to the page-shell PlanSwitcher
          (Phase 3 design refresh). When OFF, show the centered empty
          state instead of the controls. Writing OFF still goes through
          followUpMode='off' via the legacy onFollowUpsOn handler. */}
      {!followUpsOn ? (
        <PlanOffEmptyState
          planLabel="Follow-ups"
          icon={Power}
          onTurnOn={() => onFollowUpsOn(true)}
          description="Turn on to start following up with leads who stop responding."
        />
      ) : null}

      {!followUpsOn ? null : <>

      {/* Follow-up mode — spec 2g. Quiet hours is folded into the first
          row of this card as a Timing checkbox; the separate Quiet hours
          card is gone. */}
      <SectionCard padding="20px 24px 8px">
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Follow-up mode
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
            Choose how follow-ups are delivered and composed.
          </div>
        </div>

        <TimingRow
          icon={Clock}
          sublabel="When follow-ups can send."
          checked={quietOn}
          onChangeChecked={onQuietOn}
          checkboxLabel="Don't send follow-ups overnight"
          onEditHours={goQuietSettings}
          mixedLabelBadge={mixedQuiet.mixed ? <MixedBadge tooltip={mixedQuiet.tooltip} /> : undefined}
        />

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

        {/* Unified Message generation row (spec 2e) bound to messageMode.
            Backend wiring unchanged — saveWizardSettings still reads
            replyType from messageMode. */}
        <MessageGenerationRow
          useAi={messageMode === 'ai'}
          onChangeUseAi={next => onMessageMode(next ? 'ai' : 'template')}
          onOpenPlaybook={() => navigate('/settings?tab=ai-playbook', { state: fromState })}
          onOpenTemplates={() => navigate('/templates?filter=auto-reply', { state: fromState })}
        />
        {mixedMessage.mixed && (
          <div style={{ fontSize: 11.5, color: '#b45309', fontStyle: 'italic', marginTop: 6 }}>
            {mixedMessage.tooltip}
          </div>
        )}
      </SectionCard>

      {/* Follow-up plan — spec 2h. Presentational card describing the
          managed 11-step schedule. The real cadence is backend-driven,
          so this card holds no editable state. The accent-tinted node 1
          and outline-only nodes 2-5 + dashed node 11 illustrate the shape
          of the schedule without exposing each step. */}
      <FollowUpPlanCard />

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

// ─── Follow-up plan presentational card (spec 2h) ─────────────────────
//
// Illustrates the managed 11-step schedule with five labelled nodes
// (1·"1 hour"·First, 2·"4 hours"·Same day, 3·"1 day"·Next day, 4·"3
// days"·This week, 5·"1 week"·Week out), a dashed connector to node 11
// ("1 year"·Final), and a 3-cell stat strip below. No editable state —
// the real cadence is backend-managed; users adjust pacing in
// follow-up engine config, not here.

type PlanNodeStyle = 'solid-accent' | 'outline-accent' | 'outline-gray' | 'outline-dashed';

interface PlanNode {
  n: number;
  time: string;
  sub: string;
  style: PlanNodeStyle;
}

const PLAN_NODES: PlanNode[] = [
  { n: 1,  time: '1 hour',  sub: 'First',     style: 'solid-accent' },
  { n: 2,  time: '4 hours', sub: 'Same day',  style: 'outline-accent' },
  { n: 3,  time: '1 day',   sub: 'Next day',  style: 'outline-gray' },
  { n: 4,  time: '3 days',  sub: 'This week', style: 'outline-gray' },
  { n: 5,  time: '1 week',  sub: 'Week out',  style: 'outline-gray' },
  { n: 11, time: '1 year',  sub: 'Final',     style: 'outline-dashed' },
];

function PlanCircle({ n, style }: { n: number; style: PlanNodeStyle }) {
  const base = {
    width: 26,
    height: 26,
    borderRadius: 999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 11.5,
    fontWeight: 700,
    fontFamily: 'var(--lb-font-mono)',
    flexShrink: 0,
  } as const;
  if (style === 'solid-accent') {
    return <div style={{ ...base, background: 'var(--lb-accent)', color: '#fff' }}>{n}</div>;
  }
  if (style === 'outline-accent') {
    return <div style={{ ...base, background: '#fff', color: 'var(--lb-accent)', border: '2px solid var(--lb-accent)' }}>{n}</div>;
  }
  if (style === 'outline-dashed') {
    return <div style={{ ...base, background: '#fff', color: 'var(--lb-ink-5)', border: '2px dashed var(--lb-ink-7)' }}>{n}</div>;
  }
  // outline-gray
  return <div style={{ ...base, background: '#fff', color: 'var(--lb-ink-3)', border: '2px solid var(--lb-ink-8)' }}>{n}</div>;
}

function FollowUpPlanCard() {
  return (
    <SectionCard padding="20px 24px 22px">
      {/* Header — violet History tile + title + "Managed" mono pill + description */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16 }}>
        <IconTile icon={History} tone="purple" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Follow-up plan
            </div>
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 9px', borderRadius: 999,
                background: '#ede9fe', color: '#6d28d9',
                fontSize: 10, fontWeight: 700,
                letterSpacing: 0.06, textTransform: 'uppercase',
                fontFamily: 'var(--lb-font-mono)',
              }}
            >
              <Sparkles size={10} /> Managed
            </span>
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
            LeadBridge nudges unresponsive leads on an 11-step schedule
            spanning up to a year — AI writes every step from the live
            conversation.
          </div>
        </div>
      </div>

      {/* Cadence stepper */}
      <div
        style={{
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 12,
          padding: '20px 18px',
          overflowX: 'auto',
          marginBottom: 14,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, minWidth: 'fit-content' }}>
          {PLAN_NODES.map((node, i) => {
            const isLast = i === PLAN_NODES.length - 1;
            const next = PLAN_NODES[i + 1];
            // Dashed connector when the gap to the next node skips intermediate
            // steps (5 -> 11), per spec.
            const dashedConnector = next && (next.n - node.n) > 1;
            return (
              <div key={node.n} style={{ display: 'flex', alignItems: 'flex-start', flexShrink: 0 }}>
                {/* Node + labels */}
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, minWidth: 90 }}>
                  <PlanCircle n={node.n} style={node.style} />
                  <div style={{
                    fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)',
                    fontFamily: 'var(--lb-font-mono)',
                    letterSpacing: '-0.01em',
                  }}>
                    {node.time}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)' }}>{node.sub}</div>
                </div>
                {/* Connector line */}
                {!isLast && (
                  <div
                    style={{
                      flex: '0 0 auto',
                      width: 80,
                      marginTop: 12,
                      borderTop: dashedConnector
                        ? '2px dashed var(--lb-ink-7)'
                        : '2px solid var(--lb-ink-8)',
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Stat strip — 3 cells, bordered + divided */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          border: '1px solid var(--lb-line)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--lb-surface)',
        }}
      >
        <StatCell value="11" label="steps total" />
        <StatCell value="1 yr" label="max duration" divided />
        <StatCell
          value={
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              AI <Sparkles size={14} style={{ color: 'var(--lb-accent)' }} />
            </span>
          }
          label="writes each step"
          divided
        />
      </div>
    </SectionCard>
  );
}

function StatCell({ value, label, divided }: { value: ReactNode; label: string; divided?: boolean }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderLeft: divided ? '1px solid var(--lb-line)' : undefined,
      }}
    >
      <div style={{
        fontSize: 20, fontWeight: 700, color: 'var(--lb-ink-1)',
        letterSpacing: '-0.02em', fontFamily: 'var(--lb-font-mono)',
      }}>
        {value}
      </div>
      <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>
        {label}
      </div>
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
