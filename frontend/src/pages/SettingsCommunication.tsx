import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell, Phone, PhoneCall, MessageSquare, Zap, ArrowLeft, Loader2, AlertCircle,
  AlertTriangle, CheckCircle, X, Send, ChevronDown, Pencil, Check,
} from 'lucide-react';
import {
  notificationsApi, templatesApi, followUpApi, callConnectApi, thumbtackApi, authApi,
} from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type { NotificationRule, MessageTemplate, CallConnectSettings } from '../types';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { TierBadge, LockedFeatureOverlay } from '../components/TierBadges';
import { LeadBridgeNumberManager } from '../components/LeadBridgeNumberManager';
import { notify } from '../store/notificationStore';

// Unified default body for "New Lead Alerts" — applied to every account
// regardless of platform. Backend seeds this as the "Lead Alert - SMS"
// MessageTemplate; this copy is the fallback when the rule is created
// before getTemplates has run.
const LEAD_ALERT_SMS_TEMPLATE =
  'New lead for {account.name}\n' +
  '{lead.name}\n' +
  'Service: {lead.service}\n' +
  'Location: {lead.location}, {lead.zip}\n' +
  'Message: {lead.message}\n' +
  'Phone: {lead.phone}';

const LEAD_ALERT_TEMPLATE_NAME = 'Lead Alert - SMS';

function isValidPhoneE164(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
}

function formatPhoneE164(raw: string): string {
  let cleaned = raw.replace(/[^\d+]/g, '');
  if (!cleaned) return '';
  if (/^\d/.test(cleaned)) cleaned = '+1' + cleaned.replace(/^\+?1?/, '');
  return cleaned;
}

type TestStatus = 'idle' | 'sending' | 'delivered' | 'failed';

// Sentinel value for the "All accounts" picker option. When this is the
// selected value, the New Lead Alerts toggle and template body cascade to
// every saved account in parallel; per-account-only sections (Phone Setup,
// Phone Numbers, Call Connect, Reply Alerts, AI Takeover) are hidden.
const ALL_ACCOUNTS = '__ALL__';

// Template-backed editor. Owner SMS bodies always come from a named
// MessageTemplate; users can switch the linked template or edit the body.
// Editing the body saves it back to the MessageTemplate (so the same
// template's edits persist) AND fires onSave for the consumer to cascade
// to whichever accounts are in scope (single or all).
function TemplateDropdownEditor({
  label, templates, preferredTemplateName, currentBody, mixed, disabled,
  rows = 9, onSave,
}: {
  label: string;
  templates: MessageTemplate[];
  preferredTemplateName: string;
  currentBody: string;
  mixed: boolean;
  disabled: boolean;
  rows?: number;
  onSave: (body: string) => Promise<void>;
}) {
  const preferred = templates.find(t => t.name === preferredTemplateName);
  const matchByBody = templates.find(t => t.content === currentBody);
  const initialId = matchByBody?.id || preferred?.id || templates[0]?.id || '';
  const [selectedId, setSelectedId] = useState(initialId);
  const [draft, setDraft] = useState(currentBody || preferred?.content || '');
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const lastSavedRef = useRef(currentBody || preferred?.content || '');

  // Resync when the cascade/load supplies new body or template list.
  useEffect(() => {
    const next = currentBody || preferred?.content || '';
    setDraft(next);
    lastSavedRef.current = next;
    const newMatch = templates.find(t => t.content === next);
    if (newMatch) setSelectedId(newMatch.id);
    else if (preferred) setSelectedId(preferred.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBody, templates.length]);

  // commit(body, persistToTemplateId?) — when persistToTemplateId is set,
  // also writes the body back to that MessageTemplate so the saved template
  // matches the cascaded body. We pass an explicit id (instead of reading
  // `selectedId` from state) so picking a new template doesn't write the
  // new template's body back to the OLD selectedId.
  async function commit(body: string, persistToTemplateId?: string) {
    if (saving || disabled) return;
    if (body === lastSavedRef.current) return;
    setSaving(true);
    try {
      await onSave(body);
      lastSavedRef.current = body;
      const tid = persistToTemplateId ?? selectedId;
      if (tid) {
        try { await templatesApi.updateTemplate(tid, { content: body }); } catch { /* non-fatal */ }
      }
      setSavedTick(true);
      setTimeout(() => setSavedTick(false), 1500);
    } finally {
      setSaving(false);
    }
  }

  async function pickTemplate(id: string) {
    setSelectedId(id);
    const tpl = templates.find(t => t.id === id);
    if (!tpl) return;
    setDraft(tpl.content);
    // Cascade the picked template's body to all in-scope accounts. We do
    // NOT write back to the template here — the body already matches the
    // template, so there's nothing to persist.
    if (tpl.content !== lastSavedRef.current) {
      setSaving(true);
      try {
        await onSave(tpl.content);
        lastSavedRef.current = tpl.content;
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1500);
      } finally {
        setSaving(false);
      }
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <label className="text-[11px] font-bold uppercase tracking-widest text-slate-400">{label}</label>
        {mixed && (
          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
            Mixed across accounts
          </span>
        )}
        {saving && <Loader2 className="w-3 h-3 animate-spin text-slate-400" />}
        {savedTick && <CheckCircle className="w-3 h-3 text-emerald-500" />}
      </div>
      <select
        value={selectedId}
        onChange={e => pickTemplate(e.target.value)}
        disabled={disabled}
        className="w-full rounded-xl p-3 text-sm font-medium bg-white border border-slate-200 disabled:opacity-50"
      >
        {!selectedId && <option value="">Pick a template…</option>}
        {templates.map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => commit(draft)}
        disabled={disabled}
        rows={rows}
        className="w-full font-mono px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400 disabled:opacity-50 disabled:bg-slate-50"
      />
      <p className="text-[10px] text-slate-400">
        Edits save back to the picked template and cascade to all in-scope accounts.
        {disabled && ' Enable the toggle above to edit.'}
      </p>
    </div>
  );
}

/**
 * Communication & Alerts UI.
 *
 * Exported two ways:
 *   • SettingsCommunicationSection — the content only. Used as an inline
 *     section inside SettingsPage so Communication & Alerts lives alongside
 *     the rest of the Settings page.
 *   • SettingsCommunication (default) — full-page wrapper with back button.
 *     Kept for back-compat with the /settings/communication route, which now
 *     redirects to /settings#communication-alerts.
 *
 * Backend behavior is unchanged: same setting keys
 * (reEngagementAlertEnabled, reEngagementTemplate, handoffAlertTemplate,
 * leadAlertRule rule shape, agentPhoneOverride, call-connect agentPhoneE164),
 * same APIs.
 */
export function SettingsCommunicationSection() {
  const accounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const authToken = useAuthStore(s => s.token);
  const subscriptionTier = useAuthStore(s => s.user?.subscriptionTier);
  const trialActive = useAuthStore(s => s.user?.trialActive);
  const canUseEngage = trialActive || subscriptionTier === 'PRO' || subscriptionTier === 'ENTERPRISE';
  const canUseConvert = trialActive || subscriptionTier === 'ENTERPRISE';

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);
  // For ALL_ACCOUNTS mode: each account's New-Lead rule (null = not yet
  // created for that account) and each account's follow-up alert settings
  // (Reply Alerts + AI Takeover Alerts live there).
  const [allAccountRules, setAllAccountRules] = useState<Record<string, NotificationRule | null>>({});
  const [allAccountFollowUp, setAllAccountFollowUp] = useState<Record<string, {
    reEngagementAlertEnabled: boolean;
    reEngagementTemplate: string;
    handoffAlertTemplate: string;
  } | null>>({});
  const isAllMode = selectedAccountId === ALL_ACCOUNTS;
  const [ccSettings, setCcSettings] = useState<CallConnectSettings | null>(null);
  const [ctEnabled, setCtEnabled] = useState(false);
  const [ctAutoReplyTemplate, setCtAutoReplyTemplate] = useState('');

  // Business Phone (per-account override; falls back to user.businessPhone).
  const [businessPhoneInput, setBusinessPhoneInput] = useState('');
  const [editingBusinessPhone, setEditingBusinessPhone] = useState(false);
  const savingBusinessPhoneRef = useRef(false);

  // Per-business agent-phone override editing — used by the
  // "Phone Numbers Per Business" table moved out of /settings General tab.
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);

  // Alert templates
  const [reEngagementAlertOn, setReEngagementAlertOn] = useState(true);
  const [reEngagementTemplate, setReEngagementTemplate] = useState(
    'Lead {{lead.name}} replied: "{{message}}"'
  );
  const [handoffAlertTemplate, setHandoffAlertTemplate] = useState(
    'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"'
  );

  // Test phone (used by Test Text + Test Call)
  const [testPhone, setTestPhone] = useState('');

  const [hydrating, setHydrating] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [savingAlertRule, setSavingAlertRule] = useState(false);
  const [creatingAlert, setCreatingAlert] = useState(false);
  const [testAlertStatus, setTestAlertStatus] = useState<TestStatus>('idle');
  const [testTextStatus, setTestTextStatus] = useState<TestStatus>('idle');
  const [callTesting, setCallTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Refresh the cached user so a newly-set businessPhone shows on first paint.
  useEffect(() => {
    if (!authToken) return;
    authApi.getProfile().then((profile: any) => {
      const fresh = profile?.user ?? profile;
      if (fresh?.id) setAuth(fresh, authToken);
    }).catch(() => {});
  }, [authToken, setAuth]);

  // Default the picker. With multiple accounts we land in ALL_ACCOUNTS mode
  // (the common case is cascading the same alert config everywhere); with a
  // single account, pick that one so the per-account UI surfaces.
  useEffect(() => {
    if (selectedAccountId) return;
    if (accounts.length > 1) {
      setSelectedAccountId(ALL_ACCOUNTS);
    } else if (accounts.length === 1) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId) || null;

  // Load all-account state when ALL_ACCOUNTS is picked. Fetches New-Lead
  // rules AND follow-up settings (Reply Alerts + AI Takeover) per account
  // in parallel and caches them keyed by accountId.
  useEffect(() => {
    if (!isAllMode) return;
    let cancelled = false;
    setHydrated(false);
    setHydrating(true);
    setError(null);
    Promise.all([
      Promise.all(accounts.map(a =>
        notificationsApi.getRules(a.id)
          .then(({ rules }) => ({ accountId: a.id, rule: (rules || []).find(r => r.triggerType === 'new_lead') || null }))
          .catch(() => ({ accountId: a.id, rule: null }))
      )),
      Promise.all(accounts.map(a =>
        followUpApi.getSettings(a.id)
          .then((res: any) => {
            const s: any = res?.settings || {};
            return {
              accountId: a.id,
              fu: {
                reEngagementAlertEnabled: !!s.reEngagementAlertEnabled,
                reEngagementTemplate: s.reEngagementTemplate || 'Lead {{lead.name}} replied: "{{message}}"',
                handoffAlertTemplate: s.handoffAlertTemplate || 'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"',
              },
            };
          })
          .catch(() => ({ accountId: a.id, fu: null as any }))
      )),
      templatesApi.getTemplates('message').catch(() => ({ templates: [] as MessageTemplate[] })),
    ]).then(([allRulesArr, allFuArr, tplRes]: any) => {
      if (cancelled) return;
      const ruleMap: Record<string, NotificationRule | null> = {};
      for (const r of allRulesArr) ruleMap[r.accountId] = r.rule;
      const fuMap: Record<string, any> = {};
      for (const f of allFuArr) fuMap[f.accountId] = f.fu;
      setAllAccountRules(ruleMap);
      setAllAccountFollowUp(fuMap);
      setTemplates(tplRes.templates || []);
      setLeadAlertRule(null);
    }).catch((err: any) => {
      if (!cancelled) setError(err?.message || 'Failed to load alerts across accounts');
    }).finally(() => {
      if (cancelled) return;
      setHydrating(false);
      setTimeout(() => { if (!cancelled) setHydrated(true); }, 0);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAllMode, accounts.length]);

  // Load per-account state when account changes.
  useEffect(() => {
    if (!selectedAccountId || isAllMode) return;
    let cancelled = false;
    setHydrated(false);
    setHydrating(true);
    setError(null);
    Promise.all([
      notificationsApi.getRules(selectedAccountId).catch(() => ({ rules: [] as NotificationRule[] })),
      templatesApi.getTemplates('message').catch(() => ({ templates: [] as MessageTemplate[] })),
      notificationsApi.listTenantPhones().catch(() => ({ success: false, data: [] as TenantPhoneNumber[] })),
      followUpApi.getSettings(selectedAccountId).catch(() => ({ success: false, settings: null })),
      callConnectApi.getSettings(selectedAccountId).catch(() => ({ settings: null })),
      notificationsApi.getCustomerTextingSettings(selectedAccountId).catch(() => null),
    ]).then(([rulesRes, tplRes, phonesRes, fuRes, ccRes, ctRes]: any) => {
      if (cancelled) return;
      const newLeadRule = (rulesRes.rules || []).find((r: NotificationRule) => r.triggerType === 'new_lead') || null;
      setLeadAlertRule(newLeadRule);
      setTemplates(tplRes.templates || []);
      setTenantPhones(phonesRes.data || []);
      setCcSettings(ccRes?.settings || null);
      if (ctRes) {
        setCtEnabled(!!ctRes.enabled);
        setCtAutoReplyTemplate(ctRes.autoReplyTemplate || '');
      }
      const s: any = fuRes?.settings;
      if (s) {
        if (s.reEngagementAlertEnabled !== undefined) setReEngagementAlertOn(!!s.reEngagementAlertEnabled);
        if (s.reEngagementTemplate) setReEngagementTemplate(s.reEngagementTemplate);
        if (s.handoffAlertTemplate) setHandoffAlertTemplate(s.handoffAlertTemplate);
      }
      // Seed Business Phone from per-account override (preferred) → user.businessPhone
      const acct = accounts.find(a => a.id === selectedAccountId);
      const seedPhone = (acct as any)?.agentPhoneOverride || user?.businessPhone || '';
      setBusinessPhoneInput(seedPhone);
    }).catch((err: any) => {
      if (!cancelled) setError(err?.message || 'Failed to load communication settings');
    }).finally(() => {
      if (cancelled) return;
      setHydrating(false);
      setTimeout(() => { if (!cancelled) setHydrated(true); }, 0);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId]);

  // Debounced auto-save for the alert templates (existing followUpApi field).
  // Skipped in ALL_ACCOUNTS mode — Reply / Handoff Alerts are per-account
  // and the UI hides them in that mode.
  useEffect(() => {
    if (!selectedAccountId || !hydrated || isAllMode) return;
    const t = setTimeout(() => {
      followUpApi.saveSettings(selectedAccountId, {
        reEngagementAlertEnabled: reEngagementAlertOn,
        reEngagementTemplate,
        handoffAlertTemplate,
      } as any).catch((err: any) => {
        setError(err?.response?.data?.message || err?.message || 'Failed to save alert settings');
      });
    }, 600);
    return () => clearTimeout(t);
  }, [selectedAccountId, hydrated, reEngagementAlertOn, reEngagementTemplate, handoffAlertTemplate, isAllMode]);

  const accountPhone = (() => {
    if (!selectedAccountId) return null;
    return tenantPhones.find(p => p.savedAccountId === selectedAccountId && p.status === 'ACTIVE')
      || tenantPhones.find(p => !p.savedAccountId && p.status === 'ACTIVE')
      || tenantPhones.find(p => p.status === 'ACTIVE')
      || null;
  })();
  const ccBotNumber = accountPhone?.phoneNumber || '';
  const ccSamePhone = !!testPhone.trim() && isValidPhoneE164(testPhone) && (
    ccBotNumber === testPhone.trim() || businessPhoneInput === testPhone.trim()
  );

  function showSuccess(msg: string) {
    setSuccess(msg);
    setTimeout(() => setSuccess(null), 3000);
  }

  // Per-business override save — mirrors the SettingsPage handler but writes
  // the updated account list back to the shared appStore so other pages
  // (Automation, Dashboard) see the change.
  async function handleSaveOverride(accountId: string) {
    const trimmed = overrideValue.trim();
    setSavingOverride(true);
    try {
      const value = (!trimmed || trimmed === (user?.businessPhone || '')) ? null : trimmed;
      await thumbtackApi.updateSavedAccount(accountId, { agentPhoneOverride: value });
      setSavedAccounts(accounts.map(a => a.id === accountId ? { ...a, agentPhoneOverride: value } as any : a));
      notify.success('Updated', value ? 'Custom phone set for this business' : 'Reset to default phone');
      setEditingOverrideId(null);
    } catch (err: any) {
      notify.error('Error', err?.response?.data?.message || 'Failed to update phone');
    } finally {
      setSavingOverride(false);
    }
  }

  async function saveBusinessPhone(rawValue: string) {
    if (!selectedAccountId) return;
    if (savingBusinessPhoneRef.current) return;
    setEditingBusinessPhone(false);
    const formatted = formatPhoneE164(rawValue);
    if (formatted && !isValidPhoneE164(formatted)) {
      setError('Business phone must be E.164 (e.g. +12125550100)');
      return;
    }
    setBusinessPhoneInput(formatted);
    savingBusinessPhoneRef.current = true;
    const promises: Promise<any>[] = [];
    if (leadAlertRule && leadAlertRule.id !== '_pending') {
      promises.push(
        notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { toPhone: formatted })
          .then(({ rule }) => setLeadAlertRule(rule))
          .catch(() => setError('Failed to save business phone to alert rule'))
      );
    }
    promises.push(
      callConnectApi.saveSettings(selectedAccountId, { agentPhoneE164: formatted })
        .then(({ settings }) => setCcSettings(settings))
        .catch(() => setError('Failed to save business phone to call settings'))
    );
    promises.push(
      thumbtackApi.updateSavedAccount(selectedAccountId, { agentPhoneOverride: formatted })
        .catch(() => setError('Failed to save business phone override'))
    );
    await Promise.all(promises);
    savingBusinessPhoneRef.current = false;
    showSuccess('Business phone saved');
  }

  // Find or create the unified "Lead Alert - SMS" MessageTemplate so newly
  // created NotificationRules can be linked to it. Returns null on the
  // P2002 unique-name conflict path; callers fall back to the inline
  // `template` body on the rule itself so the alert still fires.
  async function ensureSharedAlertTemplate(): Promise<string | null> {
    const existing = templates.find(t => t.name === LEAD_ALERT_TEMPLATE_NAME);
    if (existing) return existing.id;
    try {
      const { template } = await templatesApi.createTemplate(LEAD_ALERT_TEMPLATE_NAME, LEAD_ALERT_SMS_TEMPLATE);
      setTemplates(prev => [template, ...prev]);
      return template.id;
    } catch {
      return null;
    }
  }

  function defaultAlertBody(): string {
    return LEAD_ALERT_SMS_TEMPLATE;
  }

  // Lead alert rule seeding — one unified "Lead Alert - SMS" template applies
  // to every account regardless of platform.
  async function createLeadAlertRule(): Promise<void> {
    if (!selectedAccountId || !selectedAccount) return;
    setCreatingAlert(true);
    try {
      const defaultBody = defaultAlertBody();
      const templateId = await ensureSharedAlertTemplate();
      const toPhone = businessPhoneInput || user?.businessPhone || '';
      const { rule } = await notificationsApi.createRule(selectedAccountId, {
        name: LEAD_ALERT_TEMPLATE_NAME,
        triggerType: 'new_lead',
        toPhone,
        sendToCustomer: false,
        // Always include inline body — even if MessageTemplate linking failed,
        // the rule has a working alert body so the notification still fires.
        template: defaultBody,
        templateId,
        enabled: true,
      } as any);
      setLeadAlertRule(rule);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to create alert rule');
    } finally {
      setCreatingAlert(false);
    }
  }

  async function toggleLeadAlert(on: boolean) {
    if (!selectedAccountId) return;
    setSavingAlertRule(true);
    setError(null);
    try {
      if (leadAlertRule && leadAlertRule.id !== '_pending') {
        // If we're turning the rule on AND it has no template assigned,
        // seed the unified default in the same update — both as the inline
        // body (always works) and the linked MessageTemplate (best effort).
        const hasAnyTemplate = !!(leadAlertRule.templateId || leadAlertRule.messageTemplate || leadAlertRule.template);
        const updates: any = { enabled: on };
        if (on && !hasAnyTemplate) {
          updates.template = defaultAlertBody();
          const tid = await ensureSharedAlertTemplate();
          if (tid) updates.templateId = tid;
        }
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, updates);
        setLeadAlertRule(rule);
      } else if (on) {
        await createLeadAlertRule();
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to toggle alert');
    } finally {
      setSavingAlertRule(false);
    }
  }

  // ── ALL_ACCOUNTS cascade ────────────────────────────────────────────────
  // Toggling or editing the inline template in all-mode fans out to every
  // account in parallel. Existing rules are PATCHed, missing rules POSTed.
  async function cascadeToggleAllAccounts(on: boolean) {
    setSavingAlertRule(true);
    setError(null);
    try {
      const defaultBody = defaultAlertBody();
      const results = await Promise.allSettled(accounts.map(async acc => {
        const existing = allAccountRules[acc.id];
        if (existing && existing.id !== '_pending') {
          const hasAnyTemplate = !!(existing.templateId || existing.messageTemplate || existing.template);
          const updates: any = { enabled: on };
          if (on && !hasAnyTemplate) updates.template = defaultBody;
          const { rule } = await notificationsApi.updateRule(acc.id, existing.id, updates);
          return { accountId: acc.id, rule };
        }
        if (on) {
          const toPhone = (acc as any).agentPhoneOverride || user?.businessPhone || '';
          const { rule } = await notificationsApi.createRule(acc.id, {
            name: LEAD_ALERT_TEMPLATE_NAME,
            triggerType: 'new_lead',
            toPhone,
            sendToCustomer: false,
            template: defaultBody,
            enabled: true,
          } as any);
          return { accountId: acc.id, rule };
        }
        return { accountId: acc.id, rule: existing };
      }));
      const nextMap: Record<string, NotificationRule | null> = { ...allAccountRules };
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') nextMap[r.value.accountId] = r.value.rule;
        else failed++;
      }
      setAllAccountRules(nextMap);
      if (failed > 0) setError(`${failed} account(s) failed to update — try again`);
      else showSuccess(on ? `Enabled for ${accounts.length} accounts` : `Disabled for ${accounts.length} accounts`);
    } finally {
      setSavingAlertRule(false);
    }
  }

  // Cascade the inline body for New Lead Alerts to every account. One
  // shared template applies regardless of platform.
  async function cascadeTemplateBodyAllAccounts(body: string) {
    setSavingAlertRule(true);
    setError(null);
    try {
      const results = await Promise.allSettled(accounts.map(async acc => {
        const existing = allAccountRules[acc.id];
        if (!existing || existing.id === '_pending') {
          return { accountId: acc.id, rule: existing };
        }
        // `template` is the source of truth used by the backend when no
        // `templateId` is set; we only update `template` and leave any
        // existing templateId link alone.
        const { rule } = await notificationsApi.updateRule(acc.id, existing.id, { template: body });
        return { accountId: acc.id, rule };
      }));
      const nextMap: Record<string, NotificationRule | null> = { ...allAccountRules };
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') nextMap[r.value.accountId] = r.value.rule;
        else failed++;
      }
      setAllAccountRules(nextMap);
      if (failed > 0) setError(`${failed} account(s) failed to update — try again`);
    } finally {
      setSavingAlertRule(false);
    }
  }

  // Cascade Reply Alerts (followUp.reEngagementAlertEnabled) across all
  // accounts. Saves through followUpApi which is the canonical store for
  // these settings; only `reEngagementAlertEnabled` is touched here so the
  // template body is preserved per-account.
  async function cascadeReEngagementEnabledAllAccounts(on: boolean) {
    setSavingAlertRule(true);
    setError(null);
    try {
      const results = await Promise.allSettled(accounts.map(async acc => {
        const current = allAccountFollowUp[acc.id];
        await followUpApi.saveSettings(acc.id, {
          reEngagementAlertEnabled: on,
          reEngagementTemplate: current?.reEngagementTemplate,
          handoffAlertTemplate: current?.handoffAlertTemplate,
        } as any);
        return { accountId: acc.id, fu: { ...(current || { reEngagementTemplate: '', handoffAlertTemplate: '' }), reEngagementAlertEnabled: on } };
      }));
      const next = { ...allAccountFollowUp };
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.accountId] = r.value.fu as any;
        else failed++;
      }
      setAllAccountFollowUp(next);
      if (failed > 0) setError(`${failed} account(s) failed to update — try again`);
      else showSuccess(on ? `Reply Alerts on for ${accounts.length} accounts` : `Reply Alerts off for ${accounts.length} accounts`);
    } finally {
      setSavingAlertRule(false);
    }
  }

  async function cascadeReEngagementTemplateAllAccounts(body: string) {
    setSavingAlertRule(true);
    setError(null);
    try {
      const results = await Promise.allSettled(accounts.map(async acc => {
        const current = allAccountFollowUp[acc.id];
        await followUpApi.saveSettings(acc.id, {
          reEngagementAlertEnabled: current?.reEngagementAlertEnabled,
          reEngagementTemplate: body,
          handoffAlertTemplate: current?.handoffAlertTemplate,
        } as any);
        return { accountId: acc.id, fu: { ...(current || { reEngagementAlertEnabled: false, handoffAlertTemplate: '' }), reEngagementTemplate: body } };
      }));
      const next = { ...allAccountFollowUp };
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.accountId] = r.value.fu as any;
        else failed++;
      }
      setAllAccountFollowUp(next);
      if (failed > 0) setError(`${failed} account(s) failed to update — try again`);
    } finally {
      setSavingAlertRule(false);
    }
  }

  async function cascadeHandoffTemplateAllAccounts(body: string) {
    setSavingAlertRule(true);
    setError(null);
    try {
      const results = await Promise.allSettled(accounts.map(async acc => {
        const current = allAccountFollowUp[acc.id];
        await followUpApi.saveSettings(acc.id, {
          reEngagementAlertEnabled: current?.reEngagementAlertEnabled,
          reEngagementTemplate: current?.reEngagementTemplate,
          handoffAlertTemplate: body,
        } as any);
        return { accountId: acc.id, fu: { ...(current || { reEngagementAlertEnabled: false, reEngagementTemplate: '' }), handoffAlertTemplate: body } };
      }));
      const next = { ...allAccountFollowUp };
      let failed = 0;
      for (const r of results) {
        if (r.status === 'fulfilled') next[r.value.accountId] = r.value.fu as any;
        else failed++;
      }
      setAllAccountFollowUp(next);
      if (failed > 0) setError(`${failed} account(s) failed to update — try again`);
    } finally {
      setSavingAlertRule(false);
    }
  }

  // Aggregate the New-Lead rule state across all accounts. Used by the UI
  // to render All-On / All-Off / Mixed indicators and the shared editor
  // body in ALL_ACCOUNTS mode. One template applies to every account
  // regardless of platform.
  const aggregate = (() => {
    const ruleEntries = accounts.map(a => allAccountRules[a.id] || null);
    const enabledCount = ruleEntries.filter(r => r?.enabled).length;
    const totalCount = accounts.length;
    const allOn = totalCount > 0 && enabledCount === totalCount;
    const allOff = enabledCount === 0;
    const mixed = !allOn && !allOff;
    const bodies = ruleEntries.filter(r => !!r).map(r => r!.template || '');
    const allSameBody = bodies.length > 0 && bodies.every(b => b === bodies[0]);
    const dominantBody = allSameBody ? bodies[0] : (bodies[0] || '');
    const bodiesMixed = bodies.length > 1 && !allSameBody;
    return { enabledCount, totalCount, allOn, allOff, mixed, dominantBody, bodiesMixed };
  })();

  // Aggregate Reply Alerts (followUp.reEngagementAlertEnabled + template)
  // across all accounts.
  const replyAggregate = (() => {
    const fuEntries = accounts.map(a => allAccountFollowUp[a.id] || null);
    const enabledCount = fuEntries.filter(fu => fu?.reEngagementAlertEnabled).length;
    const totalCount = accounts.length;
    const allOn = totalCount > 0 && enabledCount === totalCount;
    const allOff = enabledCount === 0;
    const mixed = !allOn && !allOff;
    const bodies = fuEntries.filter(fu => !!fu).map(fu => fu!.reEngagementTemplate || '');
    const allSameBody = bodies.length > 0 && bodies.every(b => b === bodies[0]);
    const dominantBody = allSameBody ? bodies[0] : bodies[0] || '';
    const bodiesMixed = bodies.length > 1 && !allSameBody;
    return { enabledCount, totalCount, allOn, allOff, mixed, dominantBody, bodiesMixed };
  })();

  // Aggregate AI Takeover template across all accounts (no separate toggle —
  // it shares the Reply Alerts toggle by design).
  const handoffAggregate = (() => {
    const fuEntries = accounts.map(a => allAccountFollowUp[a.id] || null);
    const bodies = fuEntries.filter(fu => !!fu).map(fu => fu!.handoffAlertTemplate || '');
    const allSameBody = bodies.length > 0 && bodies.every(b => b === bodies[0]);
    const dominantBody = allSameBody ? bodies[0] : bodies[0] || '';
    const bodiesMixed = bodies.length > 1 && !allSameBody;
    return { dominantBody, bodiesMixed };
  })();

  // Self-heal: if a leadAlertRule loads enabled with NO usable template (no
  // linked MessageTemplate AND no inline body), seed the platform default.
  // Writes both an inline `template` body (always works) and a `templateId`
  // (best effort — may be null if the MessageTemplate creation conflicts).
  useEffect(() => {
    if (!selectedAccountId || !leadAlertRule || !leadAlertRule.enabled) return;
    if (leadAlertRule.templateId || leadAlertRule.messageTemplate || leadAlertRule.template) return;
    if (savingAlertRule) return;
    let cancelled = false;
    (async () => {
      try {
        const updates: any = { template: defaultAlertBody() };
        const tid = await ensureSharedAlertTemplate();
        if (cancelled) return;
        if (tid) updates.templateId = tid;
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, updates);
        if (!cancelled) setLeadAlertRule(rule);
      } catch {
        // surfaces in normal save-failure paths; no toast spam here
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAccountId, leadAlertRule?.id, leadAlertRule?.enabled, leadAlertRule?.templateId, leadAlertRule?.messageTemplate, leadAlertRule?.template]);

  async function sendTestAlert() {
    if (!leadAlertRule || !selectedAccountId) return;
    setTestAlertStatus('sending');
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, leadAlertRule.id);
      if (result.success) {
        setTestAlertStatus('delivered');
        setTimeout(() => setTestAlertStatus('idle'), 4000);
      } else {
        setTestAlertStatus('failed');
        setError(result.message || 'Failed to send test');
        setTimeout(() => setTestAlertStatus('idle'), 4000);
      }
    } catch (err: any) {
      setTestAlertStatus('failed');
      setError(err?.response?.data?.message || err?.message || 'Failed to send test SMS');
      setTimeout(() => setTestAlertStatus('idle'), 4000);
    }
  }

  async function sendTestText() {
    if (!selectedAccountId || !testPhone || !isValidPhoneE164(testPhone)) return;
    setTestTextStatus('sending');
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, undefined, testPhone.trim(), ctAutoReplyTemplate || undefined);
      if (result.success) {
        setTestTextStatus('delivered');
        setTimeout(() => setTestTextStatus('idle'), 4000);
      } else {
        setTestTextStatus('failed');
        setError(result.message || 'Failed to send test');
        setTimeout(() => setTestTextStatus('idle'), 4000);
      }
    } catch (err: any) {
      setTestTextStatus('failed');
      setError(err?.response?.data?.message || err?.message || 'Failed to send test SMS');
      setTimeout(() => setTestTextStatus('idle'), 4000);
    }
  }

  async function sendTestCall() {
    if (!selectedAccountId || !testPhone || !isValidPhoneE164(testPhone)) return;
    setCallTesting(true);
    setError(null);
    try {
      await callConnectApi.testCall(selectedAccountId, testPhone.trim());
      showSuccess('Test call triggered — your business phone should ring shortly');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Test call failed');
    } finally {
      setCallTesting(false);
    }
  }

  const ccEnabled = !!ccSettings?.enabled;
  const testPhoneValid = !!testPhone.trim() && isValidPhoneE164(testPhone);

  if (accounts.length === 0) {
    return (
      <div id="communication-alerts" className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
        <p className="text-amber-800">Connect a saved account first to configure alerts.</p>
      </div>
    );
  }

  return (
    <div id="communication-alerts" className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-amber-50 text-amber-600 flex items-center justify-center">
            <Bell className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Communication & Alerts</h1>
            <p className="text-sm text-slate-500">Manage phone numbers and team notifications.</p>
          </div>
        </div>
      </div>

      {accounts.length > 1 && (
        <div>
          <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Saved Account</label>
          <div className="relative">
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
              className="w-full appearance-none rounded-xl px-3 py-2.5 pr-9 text-sm border border-slate-200 bg-white focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
            >
              <option value={ALL_ACCOUNTS}>⭐ All accounts (cascade alerts)</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.platform === 'yelp' ? '🔴 ' : '🔵 '}{acc.businessName}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>
          {isAllMode && (
            <p className="text-[11px] text-slate-400 mt-1.5">
              Toggle and template changes below cascade to all {accounts.length} accounts in parallel. Per-account Phone Setup is hidden — pick a single account to edit phone numbers.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-400 hover:text-red-600"><X className="w-4 h-4" /></button>
        </div>
      )}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-700 flex items-center gap-2">
          <CheckCircle className="w-4 h-4 shrink-0" /> {success}
        </div>
      )}

      {hydrating && (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      )}

      {!hydrating && (
        <>
          {/* Phone Setup — per-account; hidden in All Accounts mode. */}
          {!isAllMode && (
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
              <Phone className="w-5 h-5 text-blue-600" />
              <div className="flex-1">
                <h2 className="text-sm font-bold text-slate-800">Phone Setup</h2>
                <p className="text-xs text-slate-400">Set up the numbers used for alerts, messaging, and calls.</p>
              </div>
            </div>
            <div className="px-5 py-4 space-y-4">
              {/* Row 1: Business Phone (Respond) — editable. */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">📱 Business Phone</span>
                    <TierBadge tier="respond" />
                  </div>
                  <p className="text-[11px] text-slate-400 mb-2">Used for alerts only. Lead notifications are sent here.</p>
                  {editingBusinessPhone ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="tel"
                        value={businessPhoneInput}
                        onChange={e => setBusinessPhoneInput(e.target.value.replace(/[^\d+\s\-()]/g, ''))}
                        onBlur={() => saveBusinessPhone(businessPhoneInput)}
                        onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') saveBusinessPhone(businessPhoneInput); }}
                        autoFocus
                        placeholder="+15551234567"
                        className="flex-1 rounded-xl px-3 py-2.5 text-sm border border-slate-200 focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                      />
                      <button onClick={() => saveBusinessPhone(businessPhoneInput)} className="px-3 py-2 text-xs font-semibold text-white bg-blue-600 rounded-lg hover:bg-blue-700">Done</button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-xl px-3 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 text-slate-800">
                        {businessPhoneInput || <span className="text-slate-400">Not set</span>}
                      </div>
                      <button onClick={() => setEditingBusinessPhone(true)} className="px-3 py-2 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 shrink-0">
                        Change
                      </button>
                    </div>
                  )}
                  {ccBotNumber && businessPhoneInput && ccBotNumber === businessPhoneInput && (
                    <p className="mt-1.5 text-xs text-red-600 font-medium flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" />
                      This is your LeadBridge Number — use a different business phone.
                    </p>
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">🧪 Test Alert</span>
                    <TierBadge tier="respond" />
                  </div>
                  <p className="text-[11px] text-slate-400 mb-2">Send a test SMS to your Business Phone.</p>
                  <button
                    onClick={sendTestAlert}
                    disabled={testAlertStatus !== 'idle' || !(leadAlertRule?.enabled) || !businessPhoneInput || !isValidPhoneE164(businessPhoneInput)}
                    title={!(leadAlertRule?.enabled) ? 'Enable New Lead Alerts below first' : !businessPhoneInput ? 'Set Business Phone above' : ''}
                    className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                      testAlertStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                      testAlertStatus === 'failed' ? 'bg-red-100 text-red-700' :
                      testAlertStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                      'bg-amber-100 text-amber-700 hover:bg-amber-200 disabled:opacity-50'
                    }`}
                  >
                    {testAlertStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                     testAlertStatus === 'delivered' ? <CheckCircle size={14} /> :
                     testAlertStatus === 'failed' ? <X size={14} /> :
                     <Send size={14} />}
                    {testAlertStatus === 'sending' ? 'Sending…' : testAlertStatus === 'delivered' ? 'Sent!' : testAlertStatus === 'failed' ? 'Failed' : 'Test Alert'}
                  </button>
                </div>
              </div>

              {/* Row 2: Test Number with Test Text / Test Call (Engage). The
                  read-only LeadBridge Number column was folded into the
                  LeadBridge Numbers manager below — one canonical surface for
                  the per-account number. */}
              <div className="relative">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={!canUseEngage ? 'opacity-60 pointer-events-none' : ''}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">🧪 Test Number</span>
                    <TierBadge tier="engage" />
                  </div>
                  <p className="text-[11px] text-slate-400 mb-2">Used to test SMS and calls from your LeadBridge Number.</p>
                  <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_auto] gap-2 items-start">
                    <input
                      type="tel"
                      value={testPhone}
                      onChange={e => setTestPhone(e.target.value.replace(/[^\d+\s\-()]/g, ''))}
                      onBlur={e => { const f = formatPhoneE164(e.target.value); if (f !== e.target.value) setTestPhone(f); }}
                      placeholder="+15559876543"
                      className={`w-full rounded-xl px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:border-transparent transition-colors ${
                        ccSamePhone ? 'border-2 border-amber-400 bg-amber-50/30 focus:ring-amber-200'
                          : testPhone && !isValidPhoneE164(testPhone) ? 'border-2 border-red-300 bg-red-50/30 focus:ring-red-200'
                          : testPhoneValid ? 'border-2 border-emerald-300 bg-emerald-50/20 focus:ring-emerald-200'
                          : 'bg-slate-50 border border-slate-200 focus:ring-blue-500'
                      }`}
                    />
                    <button
                      onClick={sendTestText}
                      disabled={testTextStatus === 'sending' || !ctEnabled || !testPhoneValid || tenantPhones.length === 0 || ccSamePhone}
                      title={!ctEnabled ? 'Enable Instant Text on the Automation page first' : !testPhoneValid ? 'Enter a valid test phone' : ''}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                        testTextStatus === 'delivered' ? 'bg-emerald-100 text-emerald-700' :
                        testTextStatus === 'failed' ? 'bg-red-100 text-red-700' :
                        testTextStatus === 'sending' ? 'bg-slate-100 text-slate-500' :
                        'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                      }`}
                    >
                      {testTextStatus === 'sending' ? <Loader2 size={14} className="animate-spin" /> :
                       testTextStatus === 'delivered' ? <CheckCircle size={14} /> :
                       testTextStatus === 'failed' ? <X size={14} /> :
                       <Send size={14} />}
                      {testTextStatus === 'sending' ? 'Sending…' : testTextStatus === 'delivered' ? 'Sent' : testTextStatus === 'failed' ? 'Failed' : 'Test Text'}
                    </button>
                    <button
                      onClick={sendTestCall}
                      disabled={callTesting || !ccEnabled || ccSamePhone || !testPhoneValid}
                      title={!ccEnabled ? 'Enable Instant Call on the Automation page first' : !testPhoneValid ? 'Enter a valid test phone' : ''}
                      className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all whitespace-nowrap disabled:cursor-not-allowed ${
                        callTesting ? 'bg-slate-100 text-slate-500' : 'bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50'
                      }`}
                    >
                      {callTesting ? <Loader2 size={14} className="animate-spin" /> : <PhoneCall size={14} />}
                      {callTesting ? 'Calling…' : 'Test Call'}
                    </button>
                  </div>
                  {testPhone && !isValidPhoneE164(testPhone) && (
                    <p className="text-xs text-red-500 mt-1.5 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 shrink-0" /> Must be E.164 format, e.g. +12125550100
                    </p>
                  )}
                  {ccSamePhone && (
                    <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                      <AlertTriangle size={12} /> Test phone cannot be the same as the bot number or business phone.
                    </p>
                  )}
                </div>
              </div>

              {/* LeadBridge Numbers — dedicated phone numbers manager.
                  Folded into Phone Setup so users have one place for every
                  phone-related setting. Replaces the previous read-only
                  LeadBridge Number display + the standalone Section 3.5
                  block that used to live further down the Settings page. */}
              <div className="relative pt-2 border-t border-slate-100">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={!canUseEngage ? 'opacity-60 pointer-events-none' : ''}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">🤖 LeadBridge Numbers</span>
                    <TierBadge tier="engage" />
                  </div>
                  <p className="text-[11px] text-slate-400 mb-3">
                    Dedicated phone numbers used for texting and calling leads. First number is included with Engage and Convert plans; additional numbers are billed as add-ons.
                  </p>
                  <LeadBridgeNumberManager
                    accounts={accounts as any}
                    canPurchase={canUseEngage}
                    onSuccess={msg => notify.success('Success', msg)}
                    onError={msg => notify.error('Error', msg)}
                  />
                </div>
              </div>
            </div>
          </div>
          )}

          {/* Phone Numbers Per Business — moved from /settings General tab.
              Same per-account override edit flow; saves write back to the
              shared appStore so other pages see the change. Stays visible in
              All Accounts mode since the table already shows every account. */}
          {accounts.length > 0 && (
            <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
              <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
                <Phone className="w-5 h-5 text-blue-600" />
                <div className="flex-1">
                  <h2 className="text-sm font-bold text-slate-800">Phone Numbers Per Business</h2>
                  <p className="text-xs text-slate-400">Per-business agent phone override and the assigned LeadBridge bot number for each saved account.</p>
                </div>
              </div>
              <div className="px-5 py-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-slate-400 uppercase tracking-wider">
                      <th className="pb-2 pr-4 font-semibold">Business Name</th>
                      <th className="pb-2 pr-4 font-semibold">Agent Phone</th>
                      <th className="pb-2 font-semibold">Bot Number</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {accounts.map(acct => {
                      const botPhone = tenantPhones.find(p => p.savedAccountId === acct.id)
                        || tenantPhones.find(p => !p.savedAccountId)
                        || tenantPhones[0];
                      const agentOverride = (acct as any).agentPhoneOverride as string | null | undefined;
                      const agentPhone = agentOverride || user?.businessPhone || null;
                      return (
                        <tr key={acct.id}>
                          <td className="py-2 pr-4 font-semibold text-slate-900">{acct.businessName}</td>
                          <td className="py-2 pr-4">
                            {editingOverrideId === acct.id ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="tel"
                                  value={overrideValue}
                                  onChange={e => setOverrideValue(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') handleSaveOverride(acct.id);
                                    if (e.key === 'Escape') setEditingOverrideId(null);
                                  }}
                                  autoFocus
                                  placeholder={user?.businessPhone || '(555) 123-4567'}
                                  className="w-40 px-2 py-1 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
                                />
                                <button className="p-1 text-emerald-600 hover:bg-emerald-50 rounded-lg" onClick={() => handleSaveOverride(acct.id)} disabled={savingOverride} title="Save">
                                  {savingOverride ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check size={14} />}
                                </button>
                                <button className="p-1 text-slate-400 hover:bg-slate-50 rounded-lg" onClick={() => setEditingOverrideId(null)} title="Cancel">
                                  <X size={14} />
                                </button>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 cursor-pointer group" onClick={() => { setOverrideValue(agentOverride || ''); setEditingOverrideId(acct.id); }}>
                                <span className={`font-mono ${agentOverride ? 'text-slate-900 font-semibold' : 'text-slate-400'}`}>
                                  {agentPhone || 'Not set'}
                                </span>
                                {!agentOverride && agentPhone && <span className="text-[10px] text-slate-300">(default)</span>}
                                <Pencil size={12} className="text-slate-300 group-hover:text-slate-500 transition-colors" />
                              </div>
                            )}
                          </td>
                          <td className="py-2">
                            {botPhone ? (
                              <span className="font-mono text-slate-900 font-semibold">
                                {botPhone.phoneNumber}
                                {botPhone.savedAccountId && botPhone.savedAccountId !== acct.id && <span className="text-[10px] text-slate-400 font-normal ml-1">(shared)</span>}
                              </span>
                            ) : (
                              <span className="text-slate-400 text-xs">No bot number</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Alerts & Notifications */}
          <div className="bg-white rounded-2xl border border-amber-100 overflow-hidden">
            <div className="px-5 py-4 border-b border-amber-100 bg-gradient-to-r from-amber-50/60 to-white flex items-center gap-3">
              <Bell className="w-5 h-5 text-amber-600" />
              <div>
                <h2 className="text-sm font-bold text-slate-800">Alerts & Notifications</h2>
                <p className="text-xs text-slate-500">Choose which events should notify your team.</p>
              </div>
            </div>
            <div className="px-5 py-5 space-y-4">

              {/* New Lead Alerts (Respond) */}
              <div className="border border-slate-100 rounded-2xl overflow-hidden">
                <div className="flex items-center justify-between px-5 py-4 bg-slate-50/50">
                  <div className="flex items-center gap-3">
                    <MessageSquare className="w-5 h-5 text-amber-600" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">New Lead Alerts</h4>
                        <TierBadge tier="respond" />
                        {isAllMode && (
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                            aggregate.allOn ? 'bg-emerald-50 text-emerald-700' :
                            aggregate.allOff ? 'bg-slate-100 text-slate-500' :
                            'bg-amber-50 text-amber-700'
                          }`}>
                            {aggregate.allOn ? `All On (${aggregate.totalCount})` :
                             aggregate.allOff ? 'All Off' :
                             `Mixed · ${aggregate.enabledCount}/${aggregate.totalCount} on`}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400">
                        SMS sent to business owner when a new lead arrives.
                        {isAllMode ? ` Cascades to all ${aggregate.totalCount} accounts in parallel.` : ''}
                      </p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={isAllMode ? aggregate.allOn : (leadAlertRule?.enabled ?? false)}
                      onChange={e => isAllMode ? cascadeToggleAllAccounts(e.target.checked) : toggleLeadAlert(e.target.checked)}
                      disabled={savingAlertRule || creatingAlert}
                      className="sr-only peer"
                    />
                    <div className={`relative w-11 h-6 ${isAllMode && aggregate.mixed ? 'bg-amber-300' : 'bg-slate-200'} peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600`} />
                  </label>
                </div>
                <div className="px-5 py-4 space-y-4">
                  {/* ALL_ACCOUNTS mode — single shared editor (one template
                      applies to every account regardless of platform). */}
                  {isAllMode && (
                    <TemplateDropdownEditor
                      key={`new-lead-all-${aggregate.totalCount}-${aggregate.enabledCount}`}
                      label="SMS body sent to business owner"
                      templates={templates}
                      preferredTemplateName={LEAD_ALERT_TEMPLATE_NAME}
                      currentBody={aggregate.dominantBody || defaultAlertBody()}
                      mixed={aggregate.bodiesMixed}
                      disabled={savingAlertRule || aggregate.enabledCount === 0}
                      onSave={(body) => cascadeTemplateBodyAllAccounts(body)}
                    />
                  )}
                  {/* Per-account mode: template dropdown + editable body.
                      Pre-creation (no rule yet), preview the default; after
                      toggle-on, the editor wires into the live rule. */}
                  {!isAllMode && !leadAlertRule && (
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-widest mb-2 block text-slate-400">
                        Default Template
                      </label>
                      <div className="bg-white p-4 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed whitespace-pre-wrap font-mono">
                        {defaultAlertBody()}
                      </div>
                      <p className="text-[10px] text-slate-400 mt-2">
                        Toggle on above to create this alert rule. You can pick a different template and edit the body after it's created.
                      </p>
                    </div>
                  )}
                  {!isAllMode && leadAlertRule && (
                    <div className={!(leadAlertRule.enabled) ? ' opacity-40 pointer-events-none select-none' : ''}>
                      <TemplateDropdownEditor
                        key={`new-lead-${selectedAccountId}-${leadAlertRule.id}`}
                        label="SMS body sent to business owner"
                        templates={templates}
                        preferredTemplateName={LEAD_ALERT_TEMPLATE_NAME}
                        currentBody={leadAlertRule.template || leadAlertRule.messageTemplate?.content || ''}
                        mixed={false}
                        disabled={savingAlertRule}
                        onSave={async (body) => {
                          const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { template: body });
                          setLeadAlertRule(rule);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Reply Alerts (Engage) — per-account in single mode, cascades in All Accounts mode. */}
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={`flex items-center justify-between px-5 py-4 bg-slate-50/50${!canUseEngage ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Bell className="w-5 h-5 text-amber-500" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">Reply Alerts</h4>
                        <TierBadge tier="engage" />
                        {isAllMode && (
                          <span className={`text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full ${
                            replyAggregate.allOn ? 'bg-emerald-50 text-emerald-700' :
                            replyAggregate.allOff ? 'bg-slate-100 text-slate-500' :
                            'bg-amber-50 text-amber-700'
                          }`}>
                            {replyAggregate.allOn ? `All On (${replyAggregate.totalCount})` :
                             replyAggregate.allOff ? 'All Off' :
                             `Mixed · ${replyAggregate.enabledCount}/${replyAggregate.totalCount} on`}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400">
                        {isAllMode
                          ? `Toggling cascades to all ${replyAggregate.totalCount} accounts in parallel.`
                          : 'Get notified when a quiet lead replies.'}
                      </p>
                    </div>
                  </div>
                  <label className={`inline-flex items-center ${canUseEngage ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    <input
                      type="checkbox"
                      checked={isAllMode ? replyAggregate.allOn : reEngagementAlertOn}
                      disabled={!canUseEngage || savingAlertRule}
                      onChange={e => isAllMode ? cascadeReEngagementEnabledAllAccounts(e.target.checked) : setReEngagementAlertOn(e.target.checked)}
                      className="sr-only peer"
                    />
                    <div className={`relative w-11 h-6 ${isAllMode && replyAggregate.mixed ? 'bg-amber-300' : 'bg-slate-200'} peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600`} />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-3${(!isAllMode && (!reEngagementAlertOn || !canUseEngage)) || (isAllMode && !canUseEngage) ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  <p className="text-[11px] text-slate-500">Fires when a customer replies after follow-ups were sent.</p>
                  <p className="text-[10px] text-slate-400">Use {'{{lead.name}}'} for the lead's name and {'{{message}}'} for their reply text.</p>
                  <TemplateDropdownEditor
                    key={`reply-${isAllMode ? `cascade-${replyAggregate.enabledCount}` : selectedAccountId}`}
                    label="SMS body sent to business owner"
                    templates={templates}
                    preferredTemplateName="Reply Alert"
                    currentBody={isAllMode ? replyAggregate.dominantBody : reEngagementTemplate}
                    mixed={isAllMode && replyAggregate.bodiesMixed}
                    disabled={savingAlertRule || !canUseEngage}
                    rows={3}
                    onSave={isAllMode ? cascadeReEngagementTemplateAllAccounts : (async (body) => { setReEngagementTemplate(body); })}
                  />
                </div>
              </div>

              {/* AI Human Takeover Alerts (Convert) — per-account in single mode, cascades in All Accounts mode. */}
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseConvert && <LockedFeatureOverlay ctaLabel="Upgrade to Convert · $139/mo" />}
                <div className={`px-5 py-4 bg-slate-50/50${!canUseConvert ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Zap className="w-5 h-5 text-violet-600" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">AI Human Takeover Alerts</h4>
                        <TierBadge tier="convert" />
                        {isAllMode && handoffAggregate.bodiesMixed && (
                          <span className="text-[10px] font-bold uppercase tracking-widest text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">
                            Mixed across accounts
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400">
                        {isAllMode
                          ? `Template body cascades to all ${accounts.length} accounts. Uses the Reply Alerts toggle above.`
                          : 'Get notified when AI detects a manager should take over.'}
                      </p>
                    </div>
                  </div>
                </div>
                <div className={`px-5 py-4 space-y-3${!canUseConvert ? ' opacity-60 pointer-events-none' : ''}`}>
                  <p className="text-[11px] text-slate-500">Fires during AI Conversation when the customer is ready to book, wants a call, or needs a human.</p>
                  <p className="text-[10px] text-slate-400">
                    Use {'{{lead.name}}'}, {'{{message}}'}, and {'{{intent}}'} ("ready to book" or "wants live call").
                  </p>
                  <TemplateDropdownEditor
                    key={`handoff-${isAllMode ? `cascade-${accounts.length}` : selectedAccountId}`}
                    label="SMS body sent to business owner"
                    templates={templates}
                    preferredTemplateName="Handoff Alert"
                    currentBody={isAllMode ? handoffAggregate.dominantBody : handoffAlertTemplate}
                    mixed={isAllMode && handoffAggregate.bodiesMixed}
                    disabled={savingAlertRule || !canUseConvert}
                    rows={3}
                    onSave={isAllMode ? cascadeHandoffTemplateAllAccounts : (async (body) => { setHandoffAlertTemplate(body); })}
                  />
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Auto-fires while AI Conversation is on (configured on the <Link to="/automation" className="text-blue-600 hover:underline">Automation page</Link>). Also requires <span className="font-semibold text-slate-600">Reply Alerts</span> above to be enabled — the same backend toggle gates both paths.
                  </p>
                </div>
              </div>

            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Page wrapper for the legacy /settings/communication route. Keeps the
 * Section visible with a back button. New surface for Communication & Alerts
 * is /settings (the section is mounted inline under Business profile).
 */
export function SettingsCommunication() {
  const navigate = useNavigate();
  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-4">
      <button onClick={() => navigate('/automation')} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
        <ArrowLeft className="w-4 h-4" /> Back to Automation
      </button>
      <SettingsCommunicationSection />
    </div>
  );
}

export default SettingsCommunication;
