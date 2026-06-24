import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  Sparkles, History,
  Clock, Info, Power,
  Plus, Trash2, X, RotateCcw,
  MessageSquare, PhoneCall,
} from 'lucide-react';
import {
  SectionCard,
  IconTile, FooterBanner, StatusPill, MixedBadge,
  PlanOffEmptyState, TimingRow,
} from '../../components/automation/ui';
import { FollowupCard, MessageGenerationExpander } from '../../components/automation/wizard-cards';
import { InfoDot, InfoTip } from '../../components/InfoPopover';
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
  // Per-rule enable flags — wizard surfaces these as a Toggle on each
  // FollowupCard. Default true so existing tenants keep the legacy
  // always-on behaviour.
  resumeOn: boolean;
  deferralOn: boolean;
  hiredOn: boolean;
  // Per-rule message generation mode — defaults to 'ai' so each rule
  // uses its own dedicated AI prompt seed (Resume After Conversation /
  // Customer Deferral / Re-engage). Flipping to 'template' makes the
  // engine fall back to that rule's named MessageTemplate body.
  resumeMessageMode: 'template' | 'ai';
  deferralMessageMode: 'template' | 'ai';
  hiredMessageMode: 'template' | 'ai';
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
  // Per-rule master toggles — match the wizard's three FollowupCard
  // toggles. Default true to preserve legacy always-on behaviour for
  // tenants whose saved JSON doesn't carry these keys yet.
  const [resumeOn, setResumeOn] = useState(true);
  const [deferralOn, setDeferralOn] = useState(true);
  const [hiredOn, setHiredOn] = useState(true);
  // Per-rule message generation mode. Mirrors the global Follow-up mode
  // expander but writes to per-rule fields so each rule can diverge.
  // Default 'ai' matches the seed default for the deferral / hired
  // sequence templates (see follow-up-seed.ts and commits f8a8c91b /
  // b5fd82a4).
  const [resumeMessageMode, setResumeMessageMode] = useState<'template' | 'ai'>('ai');
  const [deferralMessageMode, setDeferralMessageMode] = useState<'template' | 'ai'>('ai');
  const [hiredMessageMode, setHiredMessageMode] = useState<'template' | 'ai'>('ai');
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
  // True once we've populated state from either the cache or a fetch.
  // Gates the master-off empty state so the page doesn't flash
  // "Follow-ups is off" on first mount before settings load. Other
  // Automation pages don't have this race because they don't switch
  // their entire layout based on a single loaded boolean.
  const [hydrated, setHydrated] = useState(false);
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
    | 'resumeOn' | 'deferralOn' | 'hiredOn'
    | 'resumeMessageMode' | 'deferralMessageMode' | 'hiredMessageMode'
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
      resumeOn: s?.fuReEnrollOnSilence ?? true,
      deferralOn: s?.aiDeferralCheckIn ?? true,
      hiredOn: s?.aiHiredCompetitorReengage ?? true,
      // Per-rule mode defaults to 'ai' to match the seed default (see
      // commits f8a8c91b / b5fd82a4). Backend keys mirror the existing
      // global `followUpReplyType` enum.
      resumeMessageMode: s?.fuReEnrollReplyType === 'template' ? 'template' : 'ai',
      deferralMessageMode: s?.aiDeferralReplyType === 'template' ? 'template' : 'ai',
      hiredMessageMode: s?.aiHiredCompetitorReplyType === 'template' ? 'template' : 'ai',
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
        setResumeOn(first.resumeOn);
        setDeferralOn(first.deferralOn);
        setHiredOn(first.hiredOn);
        setResumeMessageMode(first.resumeMessageMode);
        setDeferralMessageMode(first.deferralMessageMode);
        setHiredMessageMode(first.hiredMessageMode);
        setPlan(first.plan);
        setFollowUpStrategy(first.followUpStrategy);
        setHydrated(true);
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
        setResumeOn(cached.resumeOn);
        setDeferralOn(cached.deferralOn);
        setHiredOn(cached.hiredOn);
        setResumeMessageMode(cached.resumeMessageMode);
        setDeferralMessageMode(cached.deferralMessageMode);
        setHiredMessageMode(cached.hiredMessageMode);
        setPlan(cached.plan);
        setFollowUpStrategy(cached.followUpStrategy);
        setHydrated(true);
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
            setResumeOn(first.resumeOn);
            setDeferralOn(first.deferralOn);
            setHiredOn(first.hiredOn);
            setPlan(first.plan);
            setFollowUpStrategy(first.followUpStrategy);
          }
        }
      }).finally(() => { if (alive) { setLoading(false); setHydrated(true); } });
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
          setResumeOn(parsed.resumeOn);
          setDeferralOn(parsed.deferralOn);
          setHiredOn(parsed.hiredOn);
          setResumeMessageMode(parsed.resumeMessageMode);
          setDeferralMessageMode(parsed.deferralMessageMode);
          setHiredMessageMode(parsed.hiredMessageMode);
          setPlan(parsed.plan);
          setFollowUpStrategy(parsed.followUpStrategy);
        }
      })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (alive) { setLoading(false); setHydrated(true); } });
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
    if (fields.has('resumeOn'))         wizardPayload.fuReEnrollOnSilence       = resumeOn;
    if (fields.has('deferralOn'))       wizardPayload.aiDeferralCheckIn         = deferralOn;
    if (fields.has('hiredOn'))          wizardPayload.aiHiredCompetitorReengage = hiredOn;
    if (fields.has('resumeMessageMode'))   wizardPayload.fuReEnrollReplyType         = resumeMessageMode;
    if (fields.has('deferralMessageMode')) wizardPayload.aiDeferralReplyType         = deferralMessageMode;
    if (fields.has('hiredMessageMode'))    wizardPayload.aiHiredCompetitorReplyType  = hiredMessageMode;
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
          resumeDelay, deferralDelay, hiredDelay, resumeOn, deferralOn, hiredOn,
          resumeMessageMode, deferralMessageMode, hiredMessageMode,
          plan, followUpStrategy,
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
        resumeOn:         fields.has('resumeOn')         ? resumeOn         : prev.resumeOn,
        deferralOn:       fields.has('deferralOn')       ? deferralOn       : prev.deferralOn,
        hiredOn:          fields.has('hiredOn')          ? hiredOn          : prev.hiredOn,
        resumeMessageMode:   fields.has('resumeMessageMode')   ? resumeMessageMode   : prev.resumeMessageMode,
        deferralMessageMode: fields.has('deferralMessageMode') ? deferralMessageMode : prev.deferralMessageMode,
        hiredMessageMode:    fields.has('hiredMessageMode')    ? hiredMessageMode    : prev.hiredMessageMode,
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
  }, [followUpsOn, deliveryMode, messageMode, activeHoursStart, activeHoursEnd, timezone, quietOn, resumeDelay, deferralDelay, hiredDelay, resumeMessageMode, deferralMessageMode, hiredMessageMode, plan]);

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
  const onResumeOn      = (v: boolean)              => { dirtyRef.current = true; dirtyFieldsRef.current.add('resumeOn');      setResumeOn(v); };
  const onDeferralOn    = (v: boolean)              => { dirtyRef.current = true; dirtyFieldsRef.current.add('deferralOn');    setDeferralOn(v); };
  const onHiredOn       = (v: boolean)              => { dirtyRef.current = true; dirtyFieldsRef.current.add('hiredOn');       setHiredOn(v); };
  const onResumeMessageMode   = (v: 'template' | 'ai') => { dirtyRef.current = true; dirtyFieldsRef.current.add('resumeMessageMode');   setResumeMessageMode(v); };
  const onDeferralMessageMode = (v: 'template' | 'ai') => { dirtyRef.current = true; dirtyFieldsRef.current.add('deferralMessageMode'); setDeferralMessageMode(v); };
  const onHiredMessageMode    = (v: 'template' | 'ai') => { dirtyRef.current = true; dirtyFieldsRef.current.add('hiredMessageMode');    setHiredMessageMode(v); };
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
          followUpMode='off' via the legacy onFollowUpsOn handler.
          Render priority:
            • !hydrated → show the content optimistically with defaults
              (toggle values overwrite once the fetch resolves). Mirrors
              what Respond/Conversation do so the page chrome appears
              instantly instead of waiting for the API.
            • hydrated && !followUpsOn → swap to the empty state.
            • hydrated && followUpsOn → keep showing the content. */}
      {hydrated && !followUpsOn ? (
        <PlanOffEmptyState
          planLabel="Follow-ups"
          icon={Power}
          onTurnOn={() => onFollowUpsOn(true)}
          description="Turn on to start following up with leads who stop responding."
        />
      ) : <>

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

        {/* Wizard Message generation expander — chevron-toggle header
            that reveals AI-generated / Custom template radios. Same
            chrome the wizard step uses. Backend wiring unchanged —
            saveWizardSettings still reads replyType from messageMode. */}
        <MessageGenerationExpander
          useAi={messageMode === 'ai'}
          onChangeUseAi={next => onMessageMode(next ? 'ai' : 'template')}
          aiBody="AI writes each follow-up from your Business Info, FAQ, Pricing and AI Playbook."
          templateName="Follow Up"
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

      {/* Rule cards — wizard FollowupCard chrome (extracted to
          components/automation/wizard-cards.tsx). Per-rule toggle is
          wired to the same fuReEnrollOnSilence / aiDeferralCheckIn /
          aiHiredCompetitorReengage flags the wizard writes. */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <FollowupCard
          icon={RotateCcw}
          iconBg="#ccfbf1"
          iconColor="#0d9488"
          title="Resume follow-ups after a conversation"
          info="When a customer replies and then goes silent again, start a new follow-up sequence."
          enabled={resumeOn}
          onToggle={onResumeOn}
          pickerLabel="Send after"
          pickerValue={resumeDelay}
          pickerOptions={['1 hour', '6 hours', '12 hours', '24 hours', '48 hours']}
          onPickerChange={onResumeDelay}
          extra={
            <>
              <MessageGenerationExpander
                useAi={resumeMessageMode === 'ai'}
                onChangeUseAi={next => onResumeMessageMode(next ? 'ai' : 'template')}
                aiBody='AI writes the resume nudge using your "Resume After Conversation" prompt.'
                templateBody='Send the saved "Resume After Conversation" template from Templates.'
              />
              {mixedResume.mixed && (
                <div style={{ fontSize: 11.5, color: '#b45309', fontStyle: 'italic', marginTop: 8 }}>
                  {mixedResume.tooltip}
                </div>
              )}
            </>
          }
        />
        <FollowupCard
          icon={MessageSquare}
          iconBg="#ede9fe"
          iconColor="#7c3aed"
          title="Check in after customer deferral"
          info={'When customer says "I\'ll get back to you", schedule one nudge later. Cancels if they reply first.'}
          enabled={deferralOn}
          onToggle={onDeferralOn}
          pickerLabel="Send check-in after"
          pickerValue={deferralDelay}
          pickerOptions={['1 day', '2 days', '3 days', '1 week']}
          onPickerChange={onDeferralDelay}
          extra={
            <>
              <MessageGenerationExpander
                useAi={deferralMessageMode === 'ai'}
                onChangeUseAi={next => onDeferralMessageMode(next ? 'ai' : 'template')}
                aiBody='AI writes the check-in using your "Customer Deferral" prompt.'
                templateBody='Send the saved "Customer Deferral" template from Templates.'
              />
              {mixedDeferral.mixed && (
                <div style={{ fontSize: 11.5, color: '#b45309', fontStyle: 'italic', marginTop: 8 }}>
                  {mixedDeferral.tooltip}
                </div>
              )}
            </>
          }
        />
        <FollowupCard
          icon={PhoneCall}
          iconBg="#ffedd5"
          iconColor="#ea580c"
          title="Re-engage after customer hired competitor"
          info="When customer says they hired someone else, send one polite check-in later."
          enabled={hiredOn}
          onToggle={onHiredOn}
          pickerLabel="Send re-engage after"
          pickerValue={hiredDelay}
          pickerOptions={['1 week', '2 weeks', '3 weeks', '1 month']}
          onPickerChange={onHiredDelay}
          extra={
            <>
              <MessageGenerationExpander
                useAi={hiredMessageMode === 'ai'}
                onChangeUseAi={next => onHiredMessageMode(next ? 'ai' : 'template')}
                aiBody='AI writes the re-engage nudge using your "Re-engage" prompt.'
                templateBody='Send the saved "Re-engage" template from Templates.'
              />
              {mixedHired.mixed && (
                <div style={{ fontSize: 11.5, color: '#b45309', fontStyle: 'italic', marginTop: 8 }}>
                  {mixedHired.tooltip}
                </div>
              )}
            </>
          }
        />
      </div>

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
// useContainerNarrow removed 2026-06-23 — the stepper is now always
// horizontal with overflow-x:auto on narrow viewports, so the vertical
// list branch is gone and the breakpoint flip is no longer needed.

function FollowUpPlanCard({ plan, onEdit }: { plan: PlanStepData[]; onEdit: () => void }) {
  const nodes = nodesForPlan(plan);
  const stepperRef = useRef<HTMLDivElement>(null);
  const [planInfoOpen, setPlanInfoOpen] = useState(false);
  return (
    <SectionCard padding="20px 24px 22px">
      {/* Header — violet History tile + title + (i) info dot + Edit button.
          Description ("LeadBridge nudges unresponsive leads…") collapses
          behind the (i) toggle so the header reads as a single line. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 16, flexWrap: 'wrap' }}>
        <IconTile icon={History} tone="purple" size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Follow-up plan
            </div>
            <InfoDot open={planInfoOpen} onClick={() => setPlanInfoOpen(o => !o)} />
          </div>
          {planInfoOpen && (
            <InfoTip>
              LeadBridge nudges unresponsive leads on this cadence — AI
              writes every step from the live conversation. Edit the timing
              to match how often you want to follow up.
            </InfoTip>
          )}
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
          Edit
        </button>
      </div>

      {/* Cadence stepper — always horizontal; overflows to a swipeable
          scroll row on narrow viewports. Drops the previous vertical-on-
          narrow branch so the layout reads the same on every width. */}
      <div
        ref={stepperRef}
        style={{
          background: '#f8fafc',
          border: '1px solid var(--lb-line-soft)',
          borderRadius: 12,
          padding: '20px 18px',
          marginBottom: 14,
          overflowX: 'auto',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 0,
          // On desktop the row stretches to fill the card. On mobile
          // it uses its natural width and the parent scrolls.
          minWidth: 'min-content',
        }}>
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
                  // node+connector pairs stretch on desktop. flex-shrink
                  // 0 so the row keeps its natural width on mobile.
                  flex: isLast ? '0 0 auto' : '1 0 auto',
                }}
              >
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
                {!isLast && (
                  <div
                    style={{
                      flex: '1 1 auto',
                      minWidth: 32,
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

      {/* Stat strip — 3 cells, bordered + divided. Switched from a fixed
          3-col grid to a horizontally-scrollable flex row so the third
          cell ("AI writes each step") stops getting clipped on phones —
          users now swipe right to see the rest. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          overflowX: 'auto',
          border: '1px solid var(--lb-line)',
          borderRadius: 10,
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
