import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Sparkles, History,
  RefreshCw, Clock, UserX, Info, Power,
  Plus, Trash2, X, RotateCcw,
} from 'lucide-react';
import {
  SectionCard,
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
type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone' | 'booking';
// Accept legacy 'hybrid' and 'convert' as valid saved values for back-compat.
// 'booking' (2026-06-16) is the new user-selectable scheduling goal; 'phone'
// is the Call Handoff goal (key kept for back-compat with the old label).
// The backend runtime honours all of these via STRATEGY_PROMPTS — no DB
// write happens from this page (Followups preserves prev.followUpStrategy
// on save).
const isStrategyKey = (v: unknown): v is StrategyKey =>
  v === 'auto' || v === 'hybrid' || v === 'price' || v === 'qualify' || v === 'convert' || v === 'phone' || v === 'booking';

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
  // Suggest delivery mode hidden by default. Opt-in toggle lives on
  // Settings → AI Playbook → Delivery mode (advanced). Card still
  // renders inline when saved value IS suggest so off-switch is
  // reachable here too.
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
      // 2026-06-18: flipped default to 'active'. Only explicit 'suggest'
      // shows as suggest; everything else (auto_send, undefined, missing,
      // legacy unset) renders as active. New users default to Active
      // delivery; existing tenants on explicit suggest are preserved.
      deliveryMode: s?.followUpMode === 'suggest' ? 'suggest' : 'active',
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
  const onMessageMode   = (v: 'template' | 'ai')    => { dirtyRef.current = true; dirtyFieldsRef.current.add('messageMode');   setMessageMode(v); };
  const onQuietOn       = (v: boolean)              => { dirtyRef.current = true; dirtyFieldsRef.current.add('quietOn');       setQuietOn(v); };
  const onResumeDelay   = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('resumeDelay');   setResumeDelay(v); };
  const onDeferralDelay = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('deferralDelay'); setDeferralDelay(v); };
  const onHiredDelay    = (v: string)               => { dirtyRef.current = true; dirtyFieldsRef.current.add('hiredDelay');    setHiredDelay(v); };
  // Single plan setter used by the cadence-edit modal. Replaces the whole
  // array because the modal commits a working draft on Save. Per-step
  // diffing isn't needed since the wizard payload serializes the entire
  // plan to `steps` anyway.
  const onPlan          = (next: PlanStepData[])    => { dirtyRef.current = true; dirtyFieldsRef.current.add('plan');         setPlan(next); };
  // scopeKey kept as void-reference to satisfy noUnusedLocals on the alias.
  void scopeKey;

  const [planModalOpen, setPlanModalOpen] = useState(false);

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

      {/* Follow-up plan — derives nodes from the live `plan` state so
          edits made in the cadence modal reflect immediately. The card
          itself stays presentational; per-step editing happens in
          FollowUpPlanEditModal launched from the "Edit cadence" button. */}
      <FollowUpPlanCard plan={plan} onEdit={() => setPlanModalOpen(true)} />

      <FollowUpPlanEditModal
        open={planModalOpen}
        plan={plan}
        onClose={() => setPlanModalOpen(false)}
        onSave={next => { onPlan(next); setPlanModalOpen(false); }}
        onResetDefault={() => onPlan(DEFAULT_FOLLOWUP_PLAN)}
      />

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
          allowCustom
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
          allowCustom
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
          allowCustom
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

// ─── Follow-up plan card ──────────────────────────────────────────────
//
// Visualizes the live `plan` state as a stepper. When the plan has more
// than six steps the visualization collapses to the first five plus the
// final step with a dashed connector marking the gap (matches the
// original illustrative shape). The "Edit cadence" button opens the
// per-step editor modal so users can adjust each delay.

type PlanNodeStyle = 'solid-accent' | 'outline-accent' | 'outline-gray' | 'outline-dashed';

interface PlanNode {
  n: number;
  time: string;
  style: PlanNodeStyle;
}

// Map an editor unit onto the compact label used in the cadence pill
// ("min" / "hr" / "day" / "wk" / "mo" / "yr"). Pluralizes where it reads
// naturally — "2 min" stays singular, "2 days" pluralizes.
function planUnitLabel(val: number, unit: PlanUnit): string {
  const plural = val !== 1;
  switch (unit) {
    case 'min':   return `${val} min`;
    case 'hour':  return `${val} ${plural ? 'hours' : 'hour'}`;
    case 'day':   return `${val} ${plural ? 'days' : 'day'}`;
    case 'week':  return `${val} ${plural ? 'weeks' : 'week'}`;
    case 'month': return `${val} ${plural ? 'months' : 'month'}`;
    case 'year':  return `${val} ${plural ? 'years' : 'year'}`;
  }
}

// Approximate-minute conversions used to sum a plan's total schedule
// length. Months and years use calendar averages (30d, 365d) — the value
// is rendered as an at-a-glance label, not a scheduling primitive.
const STEP_MINUTES: Record<PlanUnit, number> = {
  min: 1,
  hour: 60,
  day: 60 * 24,
  week: 60 * 24 * 7,
  month: 60 * 24 * 30,
  year: 60 * 24 * 365,
};

// Find the longest individual delay in the plan. Replaces the prior
// cumulative-sum label (which rendered "2 yr" for a plan whose biggest
// gap was 1 year — users read it as a doubled value vs. their real
// setting, reported 2026-06-18). The longest-gap reading matches what
// the user sees on the largest circle in the cadence picture, so the
// stat strip and the picture agree.
function longestStepLabel(plan: PlanStepData[]): string {
  if (plan.length === 0) return '—';
  let bestMin = 0;
  let bestVal = plan[0].val;
  let bestUnit: PlanUnit = plan[0].unit;
  for (const s of plan) {
    const m = s.val * STEP_MINUTES[s.unit];
    if (m > bestMin) {
      bestMin = m;
      bestVal = s.val;
      bestUnit = s.unit;
    }
  }
  return planUnitLabel(bestVal, bestUnit);
}

// Render every real step from the live plan. The stepper is the user's
// source of truth for what's configured, so collapsing long plans to
// head-5 + last (which we did before) misrepresented the cadence — users
// saw "1...5, 11" instead of all 11 saved steps. The cadence container
// is horizontally scrollable, so longer plans just extend rightward.
function nodesForPlan(plan: PlanStepData[]): PlanNode[] {
  if (plan.length === 0) return [];
  const styleFor = (idx: number): PlanNodeStyle => {
    if (idx === 0) return 'solid-accent';
    if (idx === 1) return 'outline-accent';
    return 'outline-gray';
  };
  return plan.map((s, i) => ({
    n: i + 1,
    time: planUnitLabel(s.val, s.unit),
    style: styleFor(i),
  }));
}

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

// Match the cadence stepper's container width to its parent. The
// breakpoint at 560px flips from a horizontal flex stepper (connectors
// stretch to fill available width) to a vertical list view tuned for
// mobile — short rows with a connector spine on the left.
function useContainerNarrow(ref: RefObject<HTMLElement | null>, breakpoint = 560) {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        setNarrow(entry.contentRect.width < breakpoint);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, breakpoint]);
  return narrow;
}

function FollowUpPlanCard({ plan, onEdit }: { plan: PlanStepData[]; onEdit: () => void }) {
  const nodes = nodesForPlan(plan);
  const stepperRef = useRef<HTMLDivElement>(null);
  const narrow = useContainerNarrow(stepperRef);
  return (
    <SectionCard padding="20px 24px 22px">
      {/* Header — violet History tile + title + description + Edit cadence button */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <IconTile icon={History} tone="purple" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
            Follow-up plan
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
            LeadBridge nudges unresponsive leads on this cadence — AI
            writes every step from the live conversation. Edit the timing
            to match how often you want to follow up.
          </div>
        </div>
        <button
          type="button"
          onClick={onEdit}
          style={{
            padding: '8px 14px',
            border: '1px solid var(--lb-line)',
            borderRadius: 8,
            background: 'white',
            color: 'var(--lb-ink-2)',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          Edit cadence
        </button>
      </div>

      {/* Cadence stepper — horizontal on wide containers, vertical list on narrow */}
      <div
        ref={stepperRef}
        style={{
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 12,
          padding: narrow ? '14px 14px 6px' : '20px 18px',
          marginBottom: 14,
        }}
      >
        {narrow ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {nodes.map((node, i) => {
              const isLast = i === nodes.length - 1;
              const next = nodes[i + 1];
              const dashedConnector = next && (next.n - node.n) > 1;
              return (
                <div key={`${node.n}-${i}`} style={{ display: 'flex', alignItems: 'stretch', gap: 12 }}>
                  {/* Spine: circle + vertical connector */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0 }}>
                    <PlanCircle n={node.n} style={node.style} />
                    {!isLast && (
                      <div
                        style={{
                          flex: 1,
                          width: 0,
                          marginTop: 4,
                          marginBottom: 4,
                          borderLeft: dashedConnector
                            ? '2px dashed var(--lb-ink-7)'
                            : '2px solid var(--lb-ink-8)',
                        }}
                      />
                    )}
                  </div>
                  {/* Label */}
                  <div style={{
                    paddingTop: 4,
                    paddingBottom: isLast ? 0 : 14,
                    fontSize: 13.5,
                    fontWeight: 700,
                    color: 'var(--lb-ink-1)',
                    fontFamily: 'var(--lb-font-mono)',
                    letterSpacing: '-0.01em',
                  }}>
                    {node.time}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, width: '100%' }}>
            {nodes.map((node, i) => {
              const isLast = i === nodes.length - 1;
              const next = nodes[i + 1];
              // Dashed connector when the visualized gap skips intermediate
              // steps (head-summary mode shows 1-5 then jumps to the last).
              const dashedConnector = next && (next.n - node.n) > 1;
              return (
                <div
                  key={`${node.n}-${i}`}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    // First/last segment shouldn't grow — only the inner
                    // node+connector pairs stretch so labels stay centered
                    // under their circles. The connector inside stretches.
                    flex: isLast ? '0 0 auto' : '1 1 0',
                    minWidth: 0,
                  }}
                >
                  {/* Node + labels */}
                  <div style={{
                    display: 'flex', flexDirection: 'column', alignItems: 'center',
                    gap: 6, flexShrink: 0, minWidth: 56,
                  }}>
                    <PlanCircle n={node.n} style={node.style} />
                    <div style={{
                      fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)',
                      fontFamily: 'var(--lb-font-mono)',
                      letterSpacing: '-0.01em',
                      whiteSpace: 'nowrap',
                    }}>
                      {node.time}
                    </div>
                  </div>
                  {/* Connector line — flex-1 so the stepper fills the card */}
                  {!isLast && (
                    <div
                      style={{
                        flex: '1 1 auto',
                        minWidth: 16,
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
        )}
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
        <StatCell value={String(plan.length)} label={plan.length === 1 ? 'step total' : 'steps total'} />
        <StatCell value={longestStepLabel(plan)} label="longest gap" divided />
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

const CUSTOM_SENTINEL = '__custom__';

// Unit choices for the custom delay editor. Backend parseDelay() accepts
// any of these via substring matching, so the labels here just need to
// contain the unit keyword.
const CUSTOM_UNIT_OPTIONS: { value: PlanUnit; label: string }[] = [
  { value: 'min',   label: 'minutes' },
  { value: 'hour',  label: 'hours' },
  { value: 'day',   label: 'days' },
  { value: 'week',  label: 'weeks' },
  { value: 'month', label: 'months' },
];

function RuleCardRow({
  icon, iconTone, title, body, fieldLabel, fieldValue, onFieldChange, fieldOptions, tipIcon: TipIcon, tip, noBorder,
  mixed, mixedTooltip, allowCustom,
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
  allowCustom?: boolean;
}) {
  // A value is "custom" when it doesn't match any preset. Note the
  // sentinel is never the saved value — selecting it just switches the
  // row into custom-edit mode (and persists the parsed current step).
  const isCustom = allowCustom && !fieldOptions.includes(fieldValue);
  const dropdownOptions = allowCustom
    ? [...fieldOptions, { value: CUSTOM_SENTINEL, label: 'Custom…' }]
    : fieldOptions;
  const dropdownValue = isCustom ? CUSTOM_SENTINEL : fieldValue;
  const handleDropdownChange = (v: string) => {
    if (v === CUSTOM_SENTINEL) {
      // Seed the custom editor with the parsed current step so users
      // don't lose context — e.g. "12 hours" → step{12, hour} → still
      // "12 hours" (no-op write, but the row flips to custom mode).
      const seed = parseDelayToStep(fieldValue);
      onFieldChange(stepToDelayString(seed));
      return;
    }
    onFieldChange(v);
  };
  const customStep = parseDelayToStep(fieldValue);
  const onCustomVal = (n: number) => {
    const safe = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1));
    onFieldChange(stepToDelayString({ val: safe, unit: customStep.unit }));
  };
  const onCustomUnit = (u: PlanUnit) => {
    onFieldChange(stepToDelayString({ val: customStep.val, unit: u }));
  };
  return (
    <div className="lb-rule" style={{
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
          value={dropdownValue}
          onChange={handleDropdownChange}
          options={dropdownOptions}
          width="100%"
        />
        {isCustom && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
            <input
              type="number"
              min={1}
              value={customStep.val}
              onChange={e => onCustomVal(parseInt(e.target.value, 10))}
              style={{
                width: 72, padding: '9px 10px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                background: 'white', color: 'var(--lb-ink-1)',
                outline: 'none',
              }}
            />
            <select
              value={customStep.unit}
              onChange={e => onCustomUnit(e.target.value as PlanUnit)}
              style={{
                flex: 1, padding: '9px 32px 9px 12px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                background: 'white', color: 'var(--lb-ink-1)',
                appearance: 'none', cursor: 'pointer', outline: 'none',
              }}
            >
              {CUSTOM_UNIT_OPTIONS.map(u => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
          </div>
        )}
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

// ─── Follow-up plan edit modal ────────────────────────────────────────
//
// Lets users edit the per-step delays for the follow-up cadence. Holds a
// working draft so Cancel reliably discards changes; only Save commits
// back via onSave. Cap at 20 steps to keep both the UI and the wizard
// payload sane — the default plan is 11, so this leaves room without
// inviting pathological cadences.

const MAX_PLAN_STEPS = 20;

// Full set of editor units for the plan modal — includes `year` so the
// default plan's "1 year" final step stays representable. The rule-card
// custom delays use a smaller `CUSTOM_UNIT_OPTIONS` set (no `year`,
// since 1-year deferrals don't make sense for those rules).
const PLAN_UNIT_OPTIONS: { value: PlanUnit; label: string }[] = [
  { value: 'min',   label: 'minutes' },
  { value: 'hour',  label: 'hours' },
  { value: 'day',   label: 'days' },
  { value: 'week',  label: 'weeks' },
  { value: 'month', label: 'months' },
  { value: 'year',  label: 'years' },
];

function FollowUpPlanEditModal({
  open, plan, onClose, onSave, onResetDefault,
}: {
  open: boolean;
  plan: PlanStepData[];
  onClose: () => void;
  onSave: (next: PlanStepData[]) => void;
  onResetDefault: () => void;
}) {
  const [draft, setDraft] = useState<PlanStepData[]>(plan);

  // Re-seed the draft whenever the modal re-opens so we don't carry over
  // stale edits from a previous Cancel. Also covers the case where the
  // user switches accounts mid-edit (the parent rehydrates `plan`).
  useEffect(() => {
    if (open) setDraft(plan);
  }, [open, plan]);

  if (!open) return null;

  const updateVal = (i: number, val: number) => {
    const safe = Math.max(1, Math.floor(Number.isFinite(val) ? val : 1));
    setDraft(d => d.map((s, idx) => idx === i ? { ...s, val: safe } : s));
  };
  const updateUnit = (i: number, unit: PlanUnit) => {
    setDraft(d => d.map((s, idx) => idx === i ? { ...s, unit } : s));
  };
  const removeStep = (i: number) => {
    setDraft(d => d.length <= 1 ? d : d.filter((_, idx) => idx !== i));
  };
  const addStep = () => {
    setDraft(d => d.length >= MAX_PLAN_STEPS ? d : [...d, { val: 1, unit: 'day' as PlanUnit }]);
  };
  const resetToDefault = () => {
    setDraft(DEFAULT_FOLLOWUP_PLAN);
    onResetDefault();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Edit follow-up cadence"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white',
          borderRadius: 16,
          width: '100%', maxWidth: 560,
          maxHeight: '90vh',
          display: 'flex', flexDirection: 'column',
          boxShadow: '0 24px 48px rgba(15,23,42,0.18)',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid var(--lb-line-soft)',
          display: 'flex', alignItems: 'flex-start', gap: 12,
        }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Edit follow-up cadence
            </div>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 2 }}>
              Each step waits the chosen delay after the previous one.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              padding: 6, border: 'none', background: 'transparent',
              color: 'var(--lb-ink-5)', cursor: 'pointer', borderRadius: 6,
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable rows */}
        <div style={{ padding: '12px 24px', overflowY: 'auto', flex: 1 }}>
          {draft.map((step, i) => (
            <div
              key={i}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 0',
                borderBottom: i === draft.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
              }}
            >
              <div style={{
                width: 26, height: 26, borderRadius: 999,
                background: i === 0 ? 'var(--lb-accent)' : '#fff',
                color: i === 0 ? '#fff' : 'var(--lb-ink-3)',
                border: i === 0 ? 'none' : '1px solid var(--lb-line)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11.5, fontWeight: 700, fontFamily: 'var(--lb-font-mono)',
                flexShrink: 0,
              }}>
                {i + 1}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', flexShrink: 0 }}>
                {i === 0 ? 'First send after' : 'Then wait'}
              </div>
              <input
                type="number"
                min={1}
                value={step.val}
                onChange={e => updateVal(i, parseInt(e.target.value, 10))}
                style={{
                  width: 72, padding: '8px 10px',
                  border: '1px solid var(--lb-line)', borderRadius: 8,
                  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                  background: 'white', color: 'var(--lb-ink-1)', outline: 'none',
                }}
              />
              <select
                value={step.unit}
                onChange={e => updateUnit(i, e.target.value as PlanUnit)}
                style={{
                  flex: 1, padding: '8px 28px 8px 10px',
                  border: '1px solid var(--lb-line)', borderRadius: 8,
                  fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
                  background: 'white', color: 'var(--lb-ink-1)',
                  appearance: 'none', cursor: 'pointer', outline: 'none',
                }}
              >
                {PLAN_UNIT_OPTIONS.map(u => (
                  <option key={u.value} value={u.value}>{u.label}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => removeStep(i)}
                disabled={draft.length <= 1}
                aria-label="Remove step"
                style={{
                  padding: 8, border: 'none', background: 'transparent',
                  color: draft.length <= 1 ? 'var(--lb-ink-7)' : 'var(--lb-ink-4)',
                  cursor: draft.length <= 1 ? 'not-allowed' : 'pointer',
                  borderRadius: 6, flexShrink: 0,
                }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}

          <button
            type="button"
            onClick={addStep}
            disabled={draft.length >= MAX_PLAN_STEPS}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '10px 12px', marginTop: 12,
              border: '1px dashed var(--lb-line)', borderRadius: 8,
              background: 'transparent',
              color: draft.length >= MAX_PLAN_STEPS ? 'var(--lb-ink-7)' : 'var(--lb-ink-3)',
              fontSize: 13, fontWeight: 600,
              cursor: draft.length >= MAX_PLAN_STEPS ? 'not-allowed' : 'pointer',
              width: '100%',
            }}
          >
            <Plus size={14} /> Add step
          </button>
        </div>

        {/* Footer */}
        <div style={{
          padding: '14px 24px',
          borderTop: '1px solid var(--lb-line-soft)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
        }}>
          <button
            type="button"
            onClick={resetToDefault}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 12px',
              border: 'none', background: 'transparent',
              color: 'var(--lb-ink-4)', fontSize: 13, fontWeight: 600,
              cursor: 'pointer', borderRadius: 6,
            }}
          >
            <RotateCcw size={14} /> Reset to default
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '9px 16px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                background: 'white', color: 'var(--lb-ink-2)',
                fontSize: 13, fontWeight: 600, cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onSave(draft)}
              style={{
                padding: '9px 18px',
                border: 'none', borderRadius: 8,
                background: 'var(--lb-accent)', color: 'white',
                fontSize: 13, fontWeight: 700, cursor: 'pointer',
              }}
            >
              Save changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
