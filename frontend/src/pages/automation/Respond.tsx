import { useEffect, useRef, useState } from 'react';
import {
  MessageSquareText, MessageCircle, Phone, Clock,
  FileText, ArrowRightLeft, Volume2, Mic, Info,
  Clipboard, Sparkles, Brain, User, ArrowRight, PhoneCall,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  SettingCard, FieldRow, OptionCard, InfoTile, Checkbox, ActionLink, FooterBanner, MixedBadge, StatusPill,
} from '../../components/automation/ui';
import { automationApi, callConnectApi, notificationsApi, templatesApi } from '../../services/api';
import type { AutomationRule, CallConnectMode, CallConnectSettings, MessageTemplate, NotificationRule, SavedAccount } from '../../types';
import { useAppStore } from '../../store/appStore';

// Module-level cache: persists across mounts and tab switches so flipping
// between account tabs feels instant (the new tab's last-known values render
// immediately while a background refresh fires in parallel).
type CachedAccount = {
  instantReplyOn: boolean;
  instantTextOn: boolean;
  instantCallOn: boolean;
  replyType: 'ai' | 'template';
  connMode: 'agent-first' | 'parallel';
  newLeadRuleId: string | null;
  customerTextRuleId: string | null;
  hasCallSettings: boolean;
};
const accountCache = new Map<string, CachedAccount>();

export function AutomationRespond({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'When a Lead Arrives' };
  const accounts = useAppStore(s => s.savedAccounts);

  // Visual + state
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [instantTextOn,  setInstantTextOn]  = useState(true);
  const [instantCallOn,  setInstantCallOn]  = useState(true);
  const [replyType, setReplyType] = useState<'template' | 'ai'>('ai');
  const [textBizHours, setTextBizHours] = useState(true);
  const [callBizHours, setCallBizHours] = useState(true);
  const [connMode, setConnMode] = useState<'agent-first' | 'parallel'>('agent-first');

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

  // Hydrate displayed values INSTANTLY from the module-level cache on every
  // scope change. This is what makes tab switching feel smooth: the previous
  // visit's last-known values render immediately without waiting for the API.
  // A background fetch (next effect) refreshes the cache for any drift.
  useEffect(() => {
    dirtyRef.current = false;
    if (isAll) {
      const cached = accounts.map(a => accountCache.get(a.id)).filter(Boolean) as CachedAccount[];
      if (cached.length > 0) {
        const first = cached[0];
        setInstantReplyOn(first.instantReplyOn);
        setInstantTextOn(first.instantTextOn);
        setInstantCallOn(first.instantCallOn);
        setReplyType(first.replyType);
        setConnMode(first.connMode);
      }
    } else {
      const cached = accountCache.get(accountId);
      if (cached) {
        setInstantReplyOn(cached.instantReplyOn);
        setInstantTextOn(cached.instantTextOn);
        setInstantCallOn(cached.instantCallOn);
        setReplyType(cached.replyType);
        setConnMode(cached.connMode);
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
            const [notifRes, ccRes] = await Promise.all([
              notificationsApi.getRules(a.id).catch(() => ({ rules: [] as NotificationRule[] })),
              callConnectApi.getSettings(a.id).catch(() => ({ settings: null as CallConnectSettings | null })),
            ]);
            const nl = (allRules.rules || []).find(r => r.savedAccountId === a.id && r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0));
            const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer);
            const cached: CachedAccount = {
              instantReplyOn: !!nl?.enabled,
              instantTextOn: !!ct?.enabled,
              instantCallOn: !!ccRes.settings?.enabled,
              replyType: (nl?.useAi ? 'ai' : 'template') as 'ai' | 'template',
              connMode: (ccRes.settings?.mode === 'PARALLEL' ? 'parallel' : 'agent-first') as 'agent-first' | 'parallel',
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
            setConnMode(first.connMode);
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
      ]).then(([autoRes, notifRes, ccRes]) => {
        if (!alive) return;
        const nl = (autoRes.rules || []).find(r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0)) || null;
        const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer) || null;
        const cached: CachedAccount = {
          instantReplyOn: !!nl?.enabled,
          instantTextOn: !!ct?.enabled,
          instantCallOn: !!ccRes.settings?.enabled,
          replyType: (nl?.useAi ? 'ai' : 'template') as 'ai' | 'template',
          connMode: (ccRes.settings?.mode === 'PARALLEL' ? 'parallel' : 'agent-first') as 'agent-first' | 'parallel',
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
          setConnMode(cached.connMode);
        }
        setPerAccount([]);
      }).finally(() => { if (alive) setLoading(false); });
    }
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, isAll, accounts]);

  // Auto-save IMMEDIATELY on every USER change. Gate on dirtyRef so load
  // setters can't trigger this (they don't touch dirtyRef).
  useEffect(() => {
    if (!dirtyRef.current) return;
    dirtyRef.current = false;
    setSavedAt(Date.now()); // optimistic
    handleSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instantReplyOn, instantTextOn, instantCallOn, replyType, connMode]);

  // markDirty-wrapped setters — these are what the JSX uses. The plain setX
  // setters are reserved for load callbacks (which DON'T mark dirty).
  const onInstantReplyOn = (v: boolean) => { dirtyRef.current = true; setInstantReplyOn(v); };
  const onInstantTextOn  = (v: boolean) => { dirtyRef.current = true; setInstantTextOn(v); };
  const onInstantCallOn  = (v: boolean) => { dirtyRef.current = true; setInstantCallOn(v); };
  const onReplyType      = (v: 'ai' | 'template') => { dirtyRef.current = true; setReplyType(v); };
  const onConnMode       = (v: 'agent-first' | 'parallel') => { dirtyRef.current = true; setConnMode(v); };

  // Save the current display state to one or more accounts. For each account
  // we look up the rule fresh (don't trust component state — it can be stale
  // after a tab switch or a load races our user-edit) and create the rule on
  // the fly if the account doesn't have one yet. Cache is updated after each
  // successful write so the next render reads the new values.
  const saveOneAccount = async (id: string) => {
    const ops: Promise<unknown>[] = [];
    // 1. Instant Reply — automation rule (new_lead, delay=0)
    ops.push((async () => {
      const autoRes = await automationApi.getRulesForAccount(id).catch(() => ({ rules: [] as AutomationRule[] }));
      const nl = (autoRes.rules || []).find(r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0));
      if (nl) {
        await automationApi.updateRule(nl.id, {
          enabled: instantReplyOn,
          useAi: replyType === 'ai',
        });
      } else {
        // No new-lead rule on this account — seed one so the toggle actually
        // does something. Without this branch the user's click would be a
        // silent no-op and the setting wouldn't persist.
        await automationApi.createRule({
          savedAccountId: id,
          name: 'Instant Reply',
          triggerType: 'new_lead',
          enabled: instantReplyOn,
          useAi: replyType === 'ai',
          delayMinutes: 0,
        }).catch(() => undefined);
      }
    })());
    // 2. Instant Text — notification rule (customer-texting; new_lead + sendToCustomer)
    ops.push((async () => {
      const notifRes = await notificationsApi.getRules(id).catch(() => ({ rules: [] as NotificationRule[] }));
      const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer);
      if (ct) {
        await notificationsApi.updateRule(id, ct.id, { enabled: instantTextOn });
      }
      // If no customer-texting rule, do nothing — creating one requires extra
      // info (template, fromPhone, etc.) that we don't have in this UI.
    })());
    // 3. Instant Call — call-connect settings (always upsert; the API treats
    //    the endpoint as upsert when settings don't yet exist).
    ops.push(callConnectApi.saveSettings(id, {
      enabled: instantCallOn,
      mode: (connMode === 'parallel' ? 'PARALLEL' : 'AGENT_FIRST') as CallConnectMode,
    }).catch(() => undefined));
    await Promise.all(ops);
    // Mirror the just-saved values back into the cache so a subsequent tab
    // switch shows them without a flash.
    const prev = accountCache.get(id);
    accountCache.set(id, {
      instantReplyOn,
      instantTextOn,
      instantCallOn,
      replyType,
      connMode,
      newLeadRuleId: prev?.newLeadRuleId ?? null,
      customerTextRuleId: prev?.customerTextRuleId ?? null,
      hasCallSettings: true,
    });
  };

  const handleSave = async () => {
    // Cancel any in-flight save from a prior toggle so the latest values win.
    if (saveAbortRef.current) saveAbortRef.current.abort();
    const controller = new AbortController();
    saveAbortRef.current = controller;
    setSaving(true); setError(null);
    try {
      const targets = isAll ? accounts.map(a => a.id) : [accountId];
      await Promise.all(targets.map(saveOneAccount));
      if (!controller.signal.aborted) setSavedAt(Date.now());
    } catch (e: any) {
      if (!controller.signal.aborted) setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      if (saveAbortRef.current === controller) saveAbortRef.current = null;
      setSaving(false);
    }
  };

  // Cross-account disagreement detection for All-Accounts mode. For each
  // tracked setting we both: (1) flag whether accounts disagree, and (2)
  // build a human-readable tooltip listing each account's current value so
  // the user can hover the warning to see exactly what's diverging.
  const isMixedFor = <K extends keyof PerAccountState>(key: K): boolean => {
    if (!isAll || perAccount.length < 2) return false;
    const first = perAccount[0][key];
    return perAccount.some(p => p[key] !== first);
  };
  const tooltipFor = <K extends keyof PerAccountState>(key: K, fmt: (v: PerAccountState[K]) => string): string | undefined => {
    if (!isAll || perAccount.length < 2) return undefined;
    return 'Accounts disagree on this setting:\n'
      + perAccount.map(p => `  • ${p.account.businessName || p.account.platform}: ${fmt(p[key])}`).join('\n');
  };
  const onOff = (v: any) => (v ? 'On' : 'Off');
  const mixedInstantReply = isMixedFor('instantReplyOn');
  const mixedInstantText  = isMixedFor('instantTextOn');
  const mixedInstantCall  = isMixedFor('instantCallOn');
  const mixedReplyType    = isMixedFor('replyType');
  const mixedConnMode     = isMixedFor('connMode');
  const tipInstantReply = tooltipFor('instantReplyOn', onOff);
  const tipInstantText  = tooltipFor('instantTextOn', onOff);
  const tipInstantCall  = tooltipFor('instantCallOn', onOff);
  const tipReplyType    = tooltipFor('replyType', v => v === 'ai' ? 'Let AI write it' : 'Use template');
  const tipConnMode     = tooltipFor('connMode', v => v === 'parallel' ? 'Parallel' : 'Agent First');

  const goAiSettings = () => navigate('/automation/convert', { state: fromState });
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

  // Instant Reply — AI prompt template (used in 'ai' reply type) or message template (used in 'template' reply type).
  const firstReplyPromptTpl =
    newLeadRule?.promptTemplate
    || findTplByName('First Reply', 'AI - First Reply', 'First Reply Instructions')
    || findTplLoose('first', 'reply');
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
        <FieldRow
          label={
            mixedReplyType ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                Reply type <MixedBadge tooltip={tipReplyType} />
              </span>
            ) : 'Reply type'
          }
          align="top"
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={replyType === 'template'}
              onClick={() => onReplyType('template')}
              title="Use template"
              body="Send a pre-written reply."
              icon={Clipboard}
            />
            <OptionCard
              selected={replyType === 'ai'}
              onClick={() => onReplyType('ai')}
              title="Let AI write it"
              body="AI will write a personalized first reply."
              icon={Sparkles}
            />
          </div>
        </FieldRow>

        <FieldRow label="AI Strategy">
          <InfoTile
            icon={Brain}
            iconTone="violet"
            title="Auto"
            body="AI picks the best strategy based on conversation context."
            actionLabel="Edit AI Settings"
            onAction={goAiSettings}
          />
        </FieldRow>

        <FieldRow label="First Reply Instructions" noBorder>
          <InfoTile
            icon={FileText}
            iconTone="violet"
            title={
              replyType === 'ai'
                ? (firstReplyPromptTpl?.name || 'Default first-reply instructions')
                : (firstReplyMessageTpl?.name || 'Default first-reply template')
            }
            body={
              replyType === 'ai'
                ? (firstReplyPromptTpl?.content || newLeadRule?.aiSystemPrompt || 'How AI should write the first reply.')
                : (firstReplyMessageTpl?.content || 'Pre-written reply sent when a new lead arrives.')
            }
            badge={replyType === 'ai' ? { label: 'AI Prompt', tone: 'violet' } : { label: 'Template', tone: 'blue' }}
            tooltip={
              replyType === 'ai'
                ? (firstReplyPromptTpl?.content || newLeadRule?.aiSystemPrompt || undefined)
                : (firstReplyMessageTpl?.content || undefined)
            }
            actionLabel={replyType === 'ai' ? 'Edit Prompt' : 'Edit Template'}
            onAction={() => goTemplate(
              replyType === 'ai' ? firstReplyPromptTpl : firstReplyMessageTpl,
              replyType === 'ai' ? 'prompts' : 'auto-reply',
            )}
          />
        </FieldRow>
      </SettingCard>

      {/* Instant Text */}
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
        <FieldRow icon={Clock} iconTone="gray" label="Timing" align="top">
          <div>
            <Checkbox
              checked={textBizHours}
              onChange={setTextBizHours}
              label="Only send during business hours"
              sublabel="Mon–Fri, 9:00 AM – 6:00 PM (America/New_York)"
            />
            <div style={{ marginTop: 10 }}>
              <ActionLink onClick={goEditHours}>Edit Hours</ActionLink>
            </div>
          </div>
        </FieldRow>

        <FieldRow icon={FileText} iconTone="green" label="SMS Template" noBorder>
          <InfoTile
            title={ctTpl?.name || customerTextRule?.name || 'CT - Auto Reply'}
            body={ctTpl?.content || customerTextRule?.template || 'Hi {{lead.name}}, this is {{account.name}}. We just received your request…'}
            badge={{ label: 'Template', tone: 'green' }}
            tooltip={ctTpl?.content || customerTextRule?.template || undefined}
            actionLabel="Edit Template"
            onAction={() => goTemplate(ctTpl, 'auto-reply')}
          />
        </FieldRow>
      </SettingCard>

      {/* Instant Call */}
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
        <FieldRow icon={Clock} iconTone="gray" label="Timing" align="top">
          <div>
            <Checkbox
              checked={callBizHours}
              onChange={setCallBizHours}
              label="Only call during business hours"
              sublabel="Mon–Fri, 9:00 AM – 6:00 PM (America/New_York)"
            />
            <div style={{ marginTop: 10 }}>
              <ActionLink onClick={goEditHours}>Edit Hours</ActionLink>
            </div>
          </div>
        </FieldRow>

        <FieldRow
          icon={ArrowRightLeft}
          iconTone="gray"
          label={
            mixedConnMode ? (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                Connection Mode <MixedBadge tooltip={tipConnMode} />
              </span>
            ) : 'Connection Mode'
          }
          align="top"
        >
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={connMode === 'agent-first'}
              onClick={() => onConnMode('agent-first')}
              title="Agent First"
              body="We call you first, then bridge the lead."
              illustration={<ConnDiagram kind="serial" />}
            />
            <OptionCard
              selected={connMode === 'parallel'}
              onClick={() => onConnMode('parallel')}
              title="Parallel"
              body="We call you and the lead at the same time."
              illustration={<ConnDiagram kind="parallel" />}
            />
          </div>
        </FieldRow>

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
      </SettingCard>

      <FooterBanner
        icon={Info}
        body={<>Templates can be managed in <Link to="/templates" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Templates</Link>.</>}
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
