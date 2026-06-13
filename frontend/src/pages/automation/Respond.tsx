import { useEffect, useRef, useState } from 'react';
import {
  MessageSquareText, MessageCircle, Phone, Clock,
  ArrowRightLeft, Volume2, Mic, Info,
  User, ArrowRight, PhoneCall,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  SettingCard, FieldRow, OptionCard, InfoTile, FooterBanner, MixedBadge, StatusPill,
  MessageGenerationRow, TimingRow,
} from '../../components/automation/ui';
// MixedBadge is still used inline next to the Timing labels for the
// per-account business-hours checkboxes (no dedicated mixed prop on Checkbox).
import { automationApi, callConnectApi, followUpApi, notificationsApi, templatesApi, usersApi } from '../../services/api';
import type { AutomationRule, CallConnectMode, CallConnectSettings, MessageTemplate, NotificationRule, SavedAccount } from '../../types';
import { LeadBridgeNumberLock } from '../../components/LeadBridgeNumberLock';
import { useAppStore } from '../../store/appStore';

// Strategy meta — mirrors the picker on AutomationConversation. Used to
// render the "AI Strategy" tile below with the actual saved strategy for the
// account instead of a hardcoded "Auto" label. Keep these keys/labels in
// sync with [Conversation.tsx](Conversation.tsx).
// Strategy key (followUpStrategy in JSON) is preserved on save but no
// longer shown in this page's UI per the Automation Simplification:
// AI-first surfaces (Respond + Followups) don't expose Goal selection.
// Goals live only on AI Conversation.
type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';
// Accept legacy 'hybrid' and 'convert' as valid saved values for
// back-compat. Runtime continues to honour them via STRATEGY_PROMPTS.
const isStrategyKey = (v: unknown): v is StrategyKey =>
  v === 'auto' || v === 'hybrid' || v === 'price' || v === 'qualify' || v === 'convert' || v === 'phone';

// Module-level cache: persists across mounts and tab switches so flipping
// between account tabs feels instant (the new tab's last-known values render
// immediately while a background refresh fires in parallel).
type CachedAccount = {
  instantReplyOn: boolean;
  instantTextOn: boolean;
  instantCallOn: boolean;
  replyType: 'ai' | 'template';
  /**
   * Instant Text generation mode (V2 — 2026-06-12). Lives in
   * followUpSettingsJson.instantTextMode. AI = AI-generated SMS via the
   * notifications.service Instant Text AI path; template = the saved
   * NotificationRule.template. Missing key → treated as 'template' on
   * the backend (existing-tenant back-compat); the UI surfaces the saved
   * value or 'ai' as the visual default for fresh tenants.
   */
  instantTextMode: 'ai' | 'template';
  connMode: 'agent-first' | 'parallel';
  textBizHours: boolean;
  callBizHours: boolean;
  // Actual `followUpStrategy` from the account's followUpSettingsJson. Drives
  // the AI Strategy tile under Instant Reply; the tile used to be hardcoded
  // to "Auto" regardless of what the account had saved.
  followUpStrategy: StrategyKey;
  newLeadRuleId: string | null;
  customerTextRuleId: string | null;
  hasCallSettings: boolean;
};
const accountCache = new Map<string, CachedAccount>();

export function AutomationRespond({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'First Reply' };
  const accounts = useAppStore(s => s.savedAccounts);

  // Advanced/legacy mode — same gate used by the Advanced Rules card on
  // AI Conversation. When OFF, the "First Reply Instructions / AI Prompt"
  // editor is replaced with a helper note (because the prompt now flows
  // from Conversation Goal + AI Playbook + Pricing Table + FAQ). When
  // ON via ?advanced=1 or ?debug=1, the editor is restored so support /
  // power users can still tune the per-rule template directly.
  const [searchParams] = useSearchParams();
  const advancedMode =
    searchParams.get('advanced') === '1' ||
    searchParams.get('debug') === '1';

  // Visual + state
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [instantTextOn,  setInstantTextOn]  = useState(true);
  const [instantCallOn,  setInstantCallOn]  = useState(true);
  const [replyType, setReplyType] = useState<'template' | 'ai'>('ai');
  // V2 Instant Text AI default — new tenants land on AI. Existing tenants'
  // value is hydrated from followUpSettingsJson.instantTextMode below.
  const [instantTextMode, setInstantTextMode] = useState<'template' | 'ai'>('ai');
  const [textBizHours, setTextBizHours] = useState(true);
  const [callBizHours, setCallBizHours] = useState(true);
  const [connMode, setConnMode] = useState<'agent-first' | 'parallel'>('agent-first');
  // Read-only here — the actual strategy editor lives in AutomationConversation.
  // We only display it so the tile reflects what AI will actually do when a
  // lead arrives.
  const [followUpStrategy, setFollowUpStrategy] = useState<StrategyKey>('auto');
  // Business hours summary was rendered as a sublabel under each Timing
  // checkbox; spec 2d moves it behind the Edit Hours link so the row stays
  // single-line. State + fetch removed. Schedule is editable in Settings →
  // Hours via the Edit Hours link.

  // Loaded source-of-truth records (only when a specific account is picked)
  const [newLeadRule, setNewLeadRule] = useState<AutomationRule | null>(null);
  const [customerTextRule, setCustomerTextRule] = useState<NotificationRule | null>(null);
  const [callSettings, setCallSettings] = useState<CallConnectSettings | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);

  // Per-account state for All-Accounts mode. When the user is on the
  // "All accounts" tab we fetch every account's settings so we can
  // detect cross-account disagreement on each toggle and visually flag it.
  type PerAccountState = {
    account: SavedAccount;
    instantReplyOn: boolean;
    instantTextOn: boolean;
    instantCallOn: boolean;
    replyType: 'ai' | 'template';
    connMode: 'agent-first' | 'parallel';
  };
  const [perAccount, setPerAccount] = useState<PerAccountState[]>([]);

  const [loading, setLoading] = useState(false);
  // Preserved for potential busy-state UI later; underscore-prefixed to silence the unused-locals lint.
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAll = accountId === 'all';

  // Dirty flag — set to true ONLY when the user explicitly changes a setting
  // through one of the wrapped setters below. Load callbacks DON'T touch this,
  // so the auto-save effect never fires on tab switch or initial load.
  const dirtyRef = useRef(false);
  // Set of FIELD NAMES the user touched since the last save. The save logic
  // only writes the endpoints/fields named here — without this, flipping one
  // toggle in All-Accounts mode would fan out the entire local state to every
  // account, wiping out their per-account values for untouched settings.
  type RespondField =
    | 'instantReplyOn' | 'replyType'
    | 'instantTextOn' | 'instantTextMode'
    | 'instantCallOn' | 'connMode'
    | 'textBizHours' | 'callBizHours';
  const dirtyFieldsRef = useRef<Set<RespondField>>(new Set());
  // Cancel in-flight save when scope changes so a slow save can't overwrite
  // a freshly-loaded account.
  const saveAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2000);
    return () => clearTimeout(t);
  }, [savedAt]);

  // Templates load once for the whole user (independent of selected account).
  useEffect(() => {
    let alive = true;
    templatesApi.getTemplates()
      .then(res => { if (alive) setTemplates(res.templates || []); })
      .catch(() => { /* non-fatal */ });
    return () => { alive = false; };
  }, []);

  // Business hours load once for the whole user. The Instant Text / Instant
  // Hydrate displayed values INSTANTLY from the module-level cache on every
  // scope change. This is what makes tab switching feel smooth: the previous
  // visit's last-known values render immediately without waiting for the API.
  // A background fetch (next effect) refreshes the cache for any drift.
  useEffect(() => {
    dirtyRef.current = false;
    dirtyFieldsRef.current = new Set();
    if (isAll) {
      const cached = accounts.map(a => accountCache.get(a.id)).filter(Boolean) as CachedAccount[];
      if (cached.length > 0) {
        const first = cached[0];
        setInstantReplyOn(first.instantReplyOn);
        setInstantTextOn(first.instantTextOn);
        setInstantCallOn(first.instantCallOn);
        setReplyType(first.replyType);
        setConnMode(first.connMode);
        setTextBizHours(first.textBizHours);
        setCallBizHours(first.callBizHours);
        setFollowUpStrategy(first.followUpStrategy);
      }
    } else {
      const cached = accountCache.get(accountId);
      if (cached) {
        setInstantReplyOn(cached.instantReplyOn);
        setInstantTextOn(cached.instantTextOn);
        setInstantCallOn(cached.instantCallOn);
        setReplyType(cached.replyType);
        setConnMode(cached.connMode);
        setTextBizHours(cached.textBizHours);
        setCallBizHours(cached.callBizHours);
        setFollowUpStrategy(cached.followUpStrategy);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll]);

  // Background fetch: refreshes the cache for the current scope. Doesn't touch
  // dirtyRef — load-time setters don't trigger the auto-save effect.
  useEffect(() => {
    let alive = true;
    if (isAll) {
      if (accounts.length === 0) { setPerAccount([]); return; }
      setLoading(true);
      (async () => {
        try {
          const allRules = await automationApi.getRules().catch(() => ({ rules: [] as AutomationRule[] }));
          const results = await Promise.all(accounts.map(async (a) => {
            const [notifRes, ccRes, hoursRes, fuRes] = await Promise.all([
              notificationsApi.getRules(a.id).catch(() => ({ rules: [] as NotificationRule[] })),
              callConnectApi.getSettings(a.id).catch(() => ({ settings: null as CallConnectSettings | null })),
              usersApi.getAccountHours(a.id).catch(() => null),
              followUpApi.getSettings(a.id).catch(() => ({ success: false, settings: undefined })),
            ]);
            const nl = (allRules.rules || []).find(r => r.savedAccountId === a.id && r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0));
            const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer);
            const rawStrategy = (fuRes?.settings as any)?.followUpStrategy;
            const rawInstantTextMode = (fuRes?.settings as any)?.instantTextMode;
            const cached: CachedAccount = {
              instantReplyOn: !!nl?.enabled,
              instantTextOn: !!ct?.enabled,
              instantCallOn: !!ccRes.settings?.enabled,
              // AI-first default per the Automation Simplification: when no
              // rule exists yet (fresh tenant) or useAi is unset, default to
              // 'ai'. Existing rules with useAi=false explicitly opt out and
              // keep their 'template' choice.
              replyType: (nl?.useAi === false ? 'template' : 'ai') as 'ai' | 'template',
              // Visual default 'ai' for new tenants (no saved value yet).
              // Existing tenants whose seed wrote 'template' or 'ai' get
              // their saved value back here.
              instantTextMode: (rawInstantTextMode === 'template' ? 'template' : 'ai') as 'ai' | 'template',
              connMode: (ccRes.settings?.mode === 'PARALLEL' ? 'parallel' : 'agent-first') as 'agent-first' | 'parallel',
              textBizHours: hoursRes?.firstMsgDuringBusinessHours ?? true,
              callBizHours: hoursRes?.callDuringBusinessHours ?? true,
              followUpStrategy: isStrategyKey(rawStrategy) ? rawStrategy : 'auto',
              newLeadRuleId: nl?.id || null,
              customerTextRuleId: ct?.id || null,
              hasCallSettings: !!ccRes.settings,
            };
            accountCache.set(a.id, cached);
            return { account: a, ...cached };
          }));
          if (!alive) return;
          setPerAccount(results.map(r => ({
            account: r.account,
            instantReplyOn: r.instantReplyOn,
            instantTextOn: r.instantTextOn,
            instantCallOn: r.instantCallOn,
            replyType: r.replyType,
            connMode: r.connMode,
          })));
          // If user hasn't touched anything yet, refresh displayed values from
          // the first account in the freshly-loaded data. Dirty edits stay.
          if (!dirtyRef.current && results.length > 0) {
            const first = results[0];
            setInstantReplyOn(first.instantReplyOn);
            setInstantTextOn(first.instantTextOn);
            setInstantCallOn(first.instantCallOn);
            setReplyType(first.replyType);
            setInstantTextMode(first.instantTextMode);
            setConnMode(first.connMode);
            setTextBizHours(first.textBizHours);
            setCallBizHours(first.callBizHours);
            setFollowUpStrategy(first.followUpStrategy);
          }
          setNewLeadRule(null); setCustomerTextRule(null); setCallSettings(null);
        } finally {
          if (alive) setLoading(false);
        }
      })();
    } else {
      setLoading(true);
      Promise.all([
        automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
        notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
        callConnectApi.getSettings(accountId).catch(() => ({ settings: null as CallConnectSettings | null })),
        usersApi.getAccountHours(accountId).catch(() => null),
        followUpApi.getSettings(accountId).catch(() => ({ success: false, settings: undefined })),
      ]).then(([autoRes, notifRes, ccRes, hoursRes, fuRes]) => {
        if (!alive) return;
        const nl = (autoRes.rules || []).find(r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0)) || null;
        const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer) || null;
        const rawStrategy = (fuRes?.settings as any)?.followUpStrategy;
        const rawInstantTextMode = (fuRes?.settings as any)?.instantTextMode;
        const cached: CachedAccount = {
          instantReplyOn: !!nl?.enabled,
          instantTextOn: !!ct?.enabled,
          instantCallOn: !!ccRes.settings?.enabled,
          replyType: (nl?.useAi ? 'ai' : 'template') as 'ai' | 'template',
          instantTextMode: (rawInstantTextMode === 'template' ? 'template' : 'ai') as 'ai' | 'template',
          connMode: (ccRes.settings?.mode === 'PARALLEL' ? 'parallel' : 'agent-first') as 'agent-first' | 'parallel',
          textBizHours: hoursRes?.firstMsgDuringBusinessHours ?? true,
          callBizHours: hoursRes?.callDuringBusinessHours ?? true,
          followUpStrategy: isStrategyKey(rawStrategy) ? rawStrategy : 'auto',
          newLeadRuleId: nl?.id || null,
          customerTextRuleId: ct?.id || null,
          hasCallSettings: !!ccRes.settings,
        };
        accountCache.set(accountId, cached);
        setNewLeadRule(nl);
        setCustomerTextRule(ct);
        setCallSettings(ccRes.settings);
        // Only push fresh values to display if the user hasn't started editing.
        if (!dirtyRef.current) {
          setInstantReplyOn(cached.instantReplyOn);
          setInstantTextOn(cached.instantTextOn);
          setInstantCallOn(cached.instantCallOn);
          setReplyType(cached.replyType);
          setInstantTextMode(cached.instantTextMode);
          setConnMode(cached.connMode);
          setTextBizHours(cached.textBizHours);
          setCallBizHours(cached.callBizHours);
          setFollowUpStrategy(cached.followUpStrategy);
        }
        setPerAccount([]);
      }).finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll, accounts]);

  // Auto-save IMMEDIATELY on every USER change. We snapshot the dirty fields
  // set, clear it, then pass to handleSave so we only write what the user
  // actually changed.
  useEffect(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    const fields = new Set(dirtyFieldsRef.current);
    dirtyFieldsRef.current = new Set();
    setSavedAt(Date.now()); // optimistic
    handleSave(fields);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instantReplyOn, instantTextOn, instantCallOn, replyType, instantTextMode, connMode, textBizHours, callBizHours]);

  // markDirty-wrapped setters — each one records both the dirty flag AND the
  // specific field name so the save only writes that field's endpoint.
  const onInstantReplyOn = (v: boolean) => { dirtyRef.current = true; dirtyFieldsRef.current.add('instantReplyOn'); setInstantReplyOn(v); };
  const onInstantTextOn  = (v: boolean) => { dirtyRef.current = true; dirtyFieldsRef.current.add('instantTextOn');  setInstantTextOn(v); };
  const onInstantCallOn  = (v: boolean) => { dirtyRef.current = true; dirtyFieldsRef.current.add('instantCallOn');  setInstantCallOn(v); };
  const onReplyType      = (v: 'ai' | 'template')           => { dirtyRef.current = true; dirtyFieldsRef.current.add('replyType');      setReplyType(v); };
  const onInstantTextMode = (v: 'ai' | 'template')          => { dirtyRef.current = true; dirtyFieldsRef.current.add('instantTextMode'); setInstantTextMode(v); };
  const onConnMode       = (v: 'agent-first' | 'parallel')  => { dirtyRef.current = true; dirtyFieldsRef.current.add('connMode');       setConnMode(v); };
  const onTextBizHours   = (v: boolean) => { dirtyRef.current = true; dirtyFieldsRef.current.add('textBizHours');   setTextBizHours(v); };
  const onCallBizHours   = (v: boolean) => { dirtyRef.current = true; dirtyFieldsRef.current.add('callBizHours');   setCallBizHours(v); };

  // Save only the touched fields for one account. Each settings family lives
  // on its own endpoint — we skip the endpoint entirely if no field in that
  // family was touched. For partial endpoints (automation rule, call-connect
  // settings, account-hours), we only include the keys whose fields are dirty
  // so the backend's merge semantics leave other keys alone.
  const saveOneAccount = async (id: string, fields: Set<RespondField>) => {
    // Optimistic cache merge — keep the prior cached values for fields the
    // user didn't touch on THIS account. Without this, we'd clobber per-
    // account values in the cache too and the mixed badges would lie.
    const prev = accountCache.get(id);
    const nextCache: CachedAccount = {
      instantReplyOn: fields.has('instantReplyOn') ? instantReplyOn : (prev?.instantReplyOn ?? instantReplyOn),
      instantTextOn:  fields.has('instantTextOn')  ? instantTextOn  : (prev?.instantTextOn  ?? instantTextOn),
      instantCallOn:  fields.has('instantCallOn')  ? instantCallOn  : (prev?.instantCallOn  ?? instantCallOn),
      replyType:      fields.has('replyType')      ? replyType      : (prev?.replyType      ?? replyType),
      instantTextMode: fields.has('instantTextMode') ? instantTextMode : (prev?.instantTextMode ?? instantTextMode),
      connMode:       fields.has('connMode')       ? connMode       : (prev?.connMode       ?? connMode),
      textBizHours:   fields.has('textBizHours')   ? textBizHours   : (prev?.textBizHours   ?? textBizHours),
      callBizHours:   fields.has('callBizHours')   ? callBizHours   : (prev?.callBizHours   ?? callBizHours),
      // followUpStrategy is read-only on this page — preserve prev or fall
      // back to current displayed value (which itself came from a prior fetch).
      followUpStrategy:   prev?.followUpStrategy   ?? followUpStrategy,
      newLeadRuleId:      prev?.newLeadRuleId      ?? null,
      customerTextRuleId: prev?.customerTextRuleId ?? null,
      hasCallSettings:    prev?.hasCallSettings    ?? true,
    };
    accountCache.set(id, nextCache);

    const ops: Promise<unknown>[] = [];

    // 0. Per-account business-hours gating — only write the keys whose
    //    checkboxes were actually toggled.
    if (fields.has('textBizHours') || fields.has('callBizHours')) {
      const hours: Record<string, boolean> = {};
      if (fields.has('textBizHours')) hours.firstMsgDuringBusinessHours = textBizHours;
      if (fields.has('callBizHours')) hours.callDuringBusinessHours     = callBizHours;
      ops.push(usersApi.updateAccountHours(id, hours).catch(() => undefined));
    }

    // 1. Instant Reply — automation rule (only touch if the toggle or its
    //    reply-type child was changed; otherwise leave the rule alone).
    if (fields.has('instantReplyOn') || fields.has('replyType')) {
      ops.push((async () => {
        const autoRes = await automationApi.getRulesForAccount(id).catch(() => ({ rules: [] as AutomationRule[] }));
        const nl = (autoRes.rules || []).find(r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0));
        const patch: Record<string, unknown> = {};
        if (fields.has('instantReplyOn')) patch.enabled = instantReplyOn;
        if (fields.has('replyType'))      patch.useAi   = replyType === 'ai';
        if (nl) {
          await automationApi.updateRule(nl.id, patch);
        } else {
          // No new-lead rule on this account — seed one with the touched
          // fields plus sensible defaults for anything not touched.
          await automationApi.createRule({
            savedAccountId: id,
            name: 'Instant Reply',
            triggerType: 'new_lead',
            enabled: fields.has('instantReplyOn') ? instantReplyOn : (nextCache.instantReplyOn),
            useAi:   fields.has('replyType')      ? (replyType === 'ai') : (nextCache.replyType === 'ai'),
            delayMinutes: 0,
          }).catch(() => undefined);
        }
      })());
    }

    // 2. Instant Text — notification rule (only if the toggle changed).
    if (fields.has('instantTextOn')) {
      ops.push((async () => {
        const notifRes = await notificationsApi.getRules(id).catch(() => ({ rules: [] as NotificationRule[] }));
        const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer);
        if (ct) await notificationsApi.updateRule(id, ct.id, { enabled: instantTextOn });
      })());
    }

    // 2b. Instant Text AI mode — followUpSettingsJson.instantTextMode.
    // Saved separately from the on/off toggle because the backend stores
    // them on different rows (NotificationRule.enabled vs SavedAccount
    // followUpSettingsJson). Existing tenants without the key get
    // 'template' behavior at runtime; writing 'ai' or 'template' here
    // explicitly opts them into the new generation path.
    if (fields.has('instantTextMode')) {
      ops.push(
        followUpApi.saveWizardSettings(id, { instantTextMode })
          .catch(() => undefined),
      );
    }

    // 3. Instant Call — call-connect settings (only the touched keys).
    if (fields.has('instantCallOn') || fields.has('connMode')) {
      const ccPatch: Record<string, unknown> = {};
      if (fields.has('instantCallOn')) ccPatch.enabled = instantCallOn;
      if (fields.has('connMode'))      ccPatch.mode    = (connMode === 'parallel' ? 'PARALLEL' : 'AGENT_FIRST') as CallConnectMode;
      ops.push(callConnectApi.saveSettings(id, ccPatch).catch(() => undefined));
    }

    await Promise.all(ops);
  };

  const handleSave = async (fields: Set<RespondField>) => {
    if (fields.size === 0) return;
    // Cancel any in-flight save from a prior toggle so the latest values win.
    if (saveAbortRef.current) saveAbortRef.current.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setSaving(true); setError(null);
    try {
      const targets = isAll ? accounts.map(a => a.id) : [accountId];
      await Promise.all(targets.map(id => saveOneAccount(id, fields)));
      if (!controller.signal.aborted) setSavedAt(Date.now());
    } catch (e: any) {
      if (!controller.signal.aborted) setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setSaving(false);
    }
  };

  // Cross-account disagreement detection. Read straight from accountCache so
  // there's NO delay between landing on the All-Accounts tab and seeing the
  // warning — cache is populated by the load effect AND by every save, so
  // the data is always fresh.
  //
  // The comparison is majority-vs-deviants (not first-vs-rest): we find the
  // mode of each setting across accounts, then list ONLY the accounts that
  // deviate from the majority. The displayed All-Accounts value matches the
  // majority too, so the tooltip says "Most accounts: X. Differs in: …".
  const cachedPerAccount = isAll
    ? accounts.map(a => ({ account: a, cached: accountCache.get(a.id) || null }))
    : [];
  const hasEnoughCachedData = cachedPerAccount.filter(x => x.cached).length >= 2;

  function getMixed<K extends keyof CachedAccount>(
    key: K,
    fmt: (v: CachedAccount[K]) => string,
  ): { mixed: boolean; tooltip?: string } {
    if (!isAll || !hasEnoughCachedData) return { mixed: false };
    const entries = cachedPerAccount
      .filter(x => x.cached !== null)
      .map(x => ({ account: x.account, value: x.cached![key] }));
    // Find the mode (majority value).
    const counts = new Map<CachedAccount[K], number>();
    for (const e of entries) counts.set(e.value, (counts.get(e.value) || 0) + 1);
    let majority: CachedAccount[K] = entries[0].value;
    let maxCount = 0;
    counts.forEach((c, v) => { if (c > maxCount) { maxCount = c; majority = v; } });
    const deviants = entries.filter(e => e.value !== majority);
    if (deviants.length === 0) return { mixed: false };
    const tooltip =
      `Most accounts: ${fmt(majority)}\n` +
      `Differs in:\n` +
      deviants.map(d => `  • ${d.account.businessName || d.account.platform}: ${fmt(d.value)}`).join('\n');
    return { mixed: true, tooltip };
  }

  const onOff = (v: any) => (v ? 'On' : 'Off');
  const _instantReply = getMixed('instantReplyOn', onOff);
  const _instantText  = getMixed('instantTextOn', onOff);
  const _instantCall  = getMixed('instantCallOn', onOff);
  const _replyTypeMix = getMixed('replyType', v => v === 'ai' ? 'Let AI write it' : 'Use template');
  const _connModeMix  = getMixed('connMode', v => v === 'parallel' ? 'Parallel' : 'Agent First');
  const _textBizMix   = getMixed('textBizHours', v => v ? 'Only during business hours' : 'Anytime');
  const _callBizMix   = getMixed('callBizHours', v => v ? 'Only during business hours' : 'Anytime');
  // followUpStrategy mixed detection removed with the Conversation Goal
  // tile. Per-account strategy still persists in followUpSettingsJson; it's
  // just no longer surfaced on this AI-first page.
  const mixedTextBizHours = _textBizMix.mixed;
  const mixedCallBizHours = _callBizMix.mixed;
  const tipTextBizHours   = _textBizMix.tooltip;
  const tipCallBizHours   = _callBizMix.tooltip;
  const mixedInstantReply = _instantReply.mixed;
  const mixedInstantText  = _instantText.mixed;
  const mixedInstantCall  = _instantCall.mixed;
  const mixedReplyType    = _replyTypeMix.mixed;
  const mixedConnMode     = _connModeMix.mixed;
  const tipInstantReply = _instantReply.tooltip;
  const tipInstantText  = _instantText.tooltip;
  const tipInstantCall  = _instantCall.tooltip;
  const tipReplyType    = _replyTypeMix.tooltip;
  const tipConnMode     = _connModeMix.tooltip;
  // perAccount state is no longer referenced for mixed detection; satisfy
  // noUnusedLocals on the var until we either rip out the load population
  // step or expose it for a future feature.
  void perAccount;

  // goAiSettings was used by the now-removed Conversation Goal tile. AI
  // Conversation is still reachable via the sidebar.
  const goEditHours = () => navigate('/settings?tab=hours', { state: fromState });
  // Deep-link to Templates with a specific row highlighted + tab preselected.
  // Filter values match TemplateFilter on the Templates page; 'prompts' is
  // the new tab specifically for AI prompts (type='prompt' templates).
  // Accepts any object with at minimum {id} — rule-embedded templates lack
  // the full MessageTemplate shape, so the type field is optional here.
  type TplRef = { id: string; type?: 'message' | 'prompt' | string };
  const goTemplate = (tpl: TplRef | undefined, fallbackFilter?: string) => {
    const params = new URLSearchParams();
    if (tpl) {
      params.set('highlight', tpl.id);
      params.set('filter', tpl.type === 'prompt' ? 'prompts' : (fallbackFilter || 'auto-reply'));
    } else if (fallbackFilter) {
      params.set('filter', fallbackFilter);
    }
    navigate(`/templates${params.toString() ? '?' + params.toString() : ''}`, { state: fromState });
  };

  // Resolve template names for tiles. Per-card lookup order:
  // 1. Linked template on the loaded rule (when a specific account is picked)
  // 2. Exact content match against the user's templates list
  // 3. Canonical template name (matches what TemplateEditorModal seeds)
  // 4. Loose token match (e.g. "first reply" matches "First Reply (v2)")
  const findTplByContent = (content: string | null | undefined): MessageTemplate | undefined =>
    content ? templates.find(t => t.content === content) : undefined;
  const findTplByName = (...names: string[]): MessageTemplate | undefined => {
    for (const n of names) {
      const exact = templates.find(t => t.name === n);
      if (exact) return exact;
    }
    return undefined;
  };
  const findTplLoose = (...tokens: string[]): MessageTemplate | undefined => {
    const lc = tokens.map(t => t.toLowerCase());
    return templates.find(t => {
      const lower = t.name.toLowerCase();
      return lc.every(tok => lower.includes(tok));
    });
  };

  // Instant Reply — message template (used in 'template' reply type).
  // The AI prompt template (firstReplyPromptTpl) used to surface via the
  // legacy ?advanced=1 custom-AI-prompt tile; that tile was removed when
  // the unified Message Generation row landed. Prompts remain editable at
  // /templates?filter=prompts.
  const firstReplyMessageTpl =
    newLeadRule?.template
    || findTplByName('Auto Reply - New Lead', 'Auto Reply', 'First Reply Template');

  // Customer Text — Instant Text card.
  const ctTpl =
    customerTextRule?.messageTemplate
    || findTplByContent(customerTextRule?.template || null)
    || findTplByName('Auto Reply - New Lead', 'CT - Auto Reply')
    || findTplLoose('auto', 'reply');

  // Call Connect — whisper and voicemail.
  const whisperTpl =
    findTplByContent(callSettings?.agentWhisperMessage)
    || findTplByName('CC - Agent Whisper', 'Agent Whisper')
    || findTplLoose('whisper');
  const voicemailTpl =
    findTplByContent(callSettings?.leadVoicemailMessage)
    || findTplByName('CC - Voicemail TTS', 'Voicemail TTS', 'Voicemail')
    || findTplLoose('voicemail');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Floating top-right status indicator — doesn't shift layout. */}
      {error && <StatusPill status="error" message={error} />}
      {!error && saving && <StatusPill status="saving" />}
      {!error && !saving && savedAt && <StatusPill status="saved" />}
      {!error && !savedAt && loading && <StatusPill status="loading" />}

      {/* Instant Reply */}
      <SettingCard
        icon={MessageSquareText}
        iconTone="blue"
        title="Instant Reply"
        subtitle="Send the first message automatically when a new lead arrives."
        enabled={instantReplyOn}
        onToggle={onInstantReplyOn}
        mixed={mixedInstantReply}
        mixedTooltip={tipInstantReply}
        contentPad="8px 24px 24px"
      >
        {/* Unified Message generation block (spec 2e). The bordered Advanced
            disclosure carries the AI vs Custom template choice, bound to
            replyType. Backend wiring unchanged. The legacy ?advanced=1
            custom-AI-prompt tile is no longer surfaced here — reach it
            from /templates?filter=prompts. */}
        <MessageGenerationRow
          useAi={replyType === 'ai'}
          onChangeUseAi={next => onReplyType(next ? 'ai' : 'template')}
          onOpenPlaybook={() => navigate('/settings?tab=ai-playbook', { state: fromState })}
          onOpenTemplates={() => goTemplate(firstReplyMessageTpl, 'auto-reply')}
        />
        {mixedReplyType && (
          <div style={{ fontSize: 11.5, color: '#b45309', fontStyle: 'italic', marginTop: 8 }}>
            {tipReplyType}
          </div>
        )}
      </SettingCard>

      {/* Instant Text */}
      <LeadBridgeNumberLock feature="Instant Text" />
      <SettingCard
        icon={MessageCircle}
        iconTone="green"
        title="Instant Text"
        subtitle="Automatically text the lead when a new lead arrives."
        enabled={instantTextOn}
        onToggle={onInstantTextOn}
        mixed={mixedInstantText}
        mixedTooltip={tipInstantText}
        contentPad="8px 24px 24px"
      >
        {/* Single-line Timing row per spec 2d — checkbox left, Edit Hours
            link with ExternalLink icon right. The schedule string used to
            be a sublabel; it now lives behind the Edit Hours link. */}
        <TimingRow
          icon={Clock}
          checked={textBizHours}
          onChangeChecked={onTextBizHours}
          checkboxLabel="Only send during business hours"
          onEditHours={goEditHours}
          mixedLabelBadge={mixedTextBizHours ? <MixedBadge tooltip={tipTextBizHours} /> : undefined}
        />

        {/* Unified Message generation block (spec 2e), bound to
            instantTextMode. NotificationsService.sendNotificationWithRule
            still reads followUpSettingsJson.instantTextMode — wiring
            unchanged. The legacy fallback-tile under ?advanced=1 is
            reachable from /templates?filter=auto-reply. */}
        <MessageGenerationRow
          useAi={instantTextMode === 'ai'}
          onChangeUseAi={next => onInstantTextMode(next ? 'ai' : 'template')}
          onOpenPlaybook={() => navigate('/settings?tab=ai-playbook', { state: fromState })}
          onOpenTemplates={() => goTemplate(ctTpl, 'auto-reply')}
        />
      </SettingCard>

      {/* Instant Call */}
      <LeadBridgeNumberLock feature="Instant Call" />
      <SettingCard
        icon={Phone}
        iconTone="violet"
        title="Instant Call"
        subtitle="Call your team and connect to the lead right away."
        enabled={instantCallOn}
        onToggle={onInstantCallOn}
        mixed={mixedInstantCall}
        mixedTooltip={tipInstantCall}
        contentPad="8px 24px 24px"
      >
        {/* Single-line Timing row per spec 2d, matching Instant Text. */}
        <TimingRow
          icon={Clock}
          checked={callBizHours}
          onChangeChecked={onCallBizHours}
          checkboxLabel="Only call during business hours"
          onEditHours={goEditHours}
          mixedLabelBadge={mixedCallBizHours ? <MixedBadge tooltip={tipCallBizHours} /> : undefined}
        />

        <FieldRow
          icon={ArrowRightLeft}
          iconTone="gray"
          label="Connection Mode"
          align="top"
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={connMode === 'agent-first'}
              onClick={() => onConnMode('agent-first')}
              title="Agent First"
              body="We call you first, then bridge the lead."
              illustration={<ConnDiagram kind="serial" />}
              mixed={mixedConnMode && connMode === 'agent-first'}
              mixedTooltip={tipConnMode}
            />
            <OptionCard
              selected={connMode === 'parallel'}
              onClick={() => onConnMode('parallel')}
              title="Parallel"
              body="We call you and the lead at the same time."
              illustration={<ConnDiagram kind="parallel" />}
              mixed={mixedConnMode && connMode === 'parallel'}
              mixedTooltip={tipConnMode}
            />
          </div>
        </FieldRow>

        {/* Advanced call messages — Agent Whisper + Voicemail editors hidden
            by default per the Automation Simplification (2026-06-12). The
            default templates work for most teams; power users + support
            reach the editors here. Runtime is unchanged: the saved
            template values are still read from callSettings on every
            call-connect, regardless of whether this section is open. */}
        <AdvancedExpand
          title="Advanced call messages"
          helper="Default call messages work for most teams. Edit only if you need custom wording for the agent whisper or voicemail."
          defaultOpen={advancedMode}
        >
          <FieldRow icon={Volume2} iconTone="violet" label="Agent Whisper Message">
            <InfoTile
              title={whisperTpl?.name || 'CC - Agent Whisper'}
              body={callSettings?.agentWhisperMessage || whisperTpl?.content || 'You have a new lead for {category}. Customer name: {customerName}…'}
              badge={{ label: 'Template', tone: 'violet' }}
              tooltip={callSettings?.agentWhisperMessage || whisperTpl?.content || undefined}
              actionLabel="Edit Template"
              onAction={() => goTemplate(whisperTpl, 'call-connect')}
            />
          </FieldRow>

          <FieldRow icon={Mic} iconTone="violet" label="Voicemail Message" noBorder>
            <InfoTile
              title={voicemailTpl?.name || 'CC - Voicemail TTS'}
              body={callSettings?.leadVoicemailMessage || voicemailTpl?.content || 'Hi {customerName}, this is {accountName}. We tried to reach you…'}
              badge={{ label: 'Template', tone: 'violet' }}
              tooltip={callSettings?.leadVoicemailMessage || voicemailTpl?.content || undefined}
              actionLabel="Edit Template"
              onAction={() => goTemplate(voicemailTpl, 'call-connect')}
            />
          </FieldRow>
        </AdvancedExpand>
      </SettingCard>

      <FooterBanner
        icon={Info}
        body={
          <>
            Templates can be managed in <Link to="/templates" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Templates</Link>.
          </>
        }
      />
    </div>
  );
}

function ConnDiagram({ kind }: { kind: 'serial' | 'parallel' }) {
  if (kind === 'serial') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-4)' }}>
        <User size={14} />
        <ArrowRight size={12} style={{ color: 'var(--lb-ink-6)' }} />
        <PhoneCall size={14} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-4)' }}>
      <User size={14} />
      <ArrowRight size={12} style={{ color: 'var(--lb-ink-6)' }} />
      <User size={14} />
    </div>
  );
}

/**
 * Collapsible "Advanced" section for Instant Text + Instant Call.
 *
 * The Automation Simplification (2026-06-12) hides the SMS template tile
 * and the Agent Whisper + Voicemail editors from the normal First Reply
 * page. Power users + support reach them via this expand. Auto-opens when
 * ?advanced=1 or ?debug=1 is in the URL (driven by the parent `defaultOpen`).
 *
 * Local React state controls open/close so a user who manually expanded
 * the section in a normal session keeps it open while they edit, without
 * needing the URL param.
 */
function AdvancedExpand({
  title, helper, defaultOpen, children,
}: {
  title: string;
  helper: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(!!defaultOpen);
  return (
    <div style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%',
          padding: '12px 0',
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>{title}</div>
          {helper && (
            <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.5 }}>
              {helper}
            </div>
          )}
        </div>
        <div style={{ display: 'inline-flex', color: 'var(--lb-ink-5)', flexShrink: 0, marginLeft: 12 }}>
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>
      {open && <div style={{ paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}
