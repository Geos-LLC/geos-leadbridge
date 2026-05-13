import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell, Phone, MessageSquare, Zap, ArrowLeft, Loader2, AlertCircle, ChevronDown,
} from 'lucide-react';
import { notificationsApi, templatesApi, followUpApi } from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type { NotificationRule, MessageTemplate } from '../types';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { TierBadge, LockedFeatureOverlay } from '../components/TierBadges';

/**
 * Communication & Alerts settings page.
 *
 * Hosts the alert template editors and a phone-numbers summary that used to
 * live inline on the Automation (Services) page. The Automation page now
 * shows compact summary cards that link here.
 *
 * Backend behavior unchanged — this page reuses the existing notificationsApi
 * + followUpApi endpoints. Setting keys (`reEngagementAlertEnabled`,
 * `reEngagementTemplate`, `handoffAlertTemplate`, the lead-alert rule shape)
 * are unchanged.
 *
 * Phone editing (Business Phone, LeadBridge Number assignment) stays on
 * /settings; this page renders a read-only summary with edit links.
 */
export function SettingsCommunication() {
  const navigate = useNavigate();
  const accounts = useAppStore(s => s.savedAccounts);
  const user = useAuthStore(s => s.user);
  const subscriptionTier = useAuthStore(s => s.user?.subscriptionTier);
  const trialActive = useAuthStore(s => s.user?.trialActive);
  const canUseEngage = trialActive || subscriptionTier === 'PRO' || subscriptionTier === 'ENTERPRISE';
  const canUseConvert = trialActive || subscriptionTier === 'ENTERPRISE';

  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);

  // Per-account follow-up settings (re-engagement + handoff templates)
  const [reEngagementAlertOn, setReEngagementAlertOn] = useState(true);
  const [reEngagementTemplate, setReEngagementTemplate] = useState(
    'Lead {{lead.name}} replied: "{{message}}"'
  );
  const [handoffAlertTemplate, setHandoffAlertTemplate] = useState(
    'Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"'
  );

  const [hydrating, setHydrating] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [savingAlert, setSavingAlert] = useState(false);
  const [creatingAlert, setCreatingAlert] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick the first account by default
  useEffect(() => {
    if (!selectedAccountId && accounts.length > 0) {
      setSelectedAccountId(accounts[0].id);
    }
  }, [accounts, selectedAccountId]);

  // Load per-account state when account changes
  useEffect(() => {
    if (!selectedAccountId) return;
    let cancelled = false;
    setHydrated(false);
    setHydrating(true);
    Promise.all([
      notificationsApi.getRules(selectedAccountId).catch(() => ({ rules: [] as NotificationRule[] })),
      templatesApi.getTemplates('message').catch(() => ({ templates: [] as MessageTemplate[] })),
      notificationsApi.listTenantPhones().catch(() => ({ success: false, data: [] as TenantPhoneNumber[] })),
      followUpApi.getSettings(selectedAccountId).catch(() => ({ success: false, settings: null })),
    ]).then(([rulesRes, tplRes, phonesRes, fuRes]: any) => {
      if (cancelled) return;
      const newLeadRule = (rulesRes.rules || []).find((r: NotificationRule) => r.triggerType === 'new_lead') || null;
      setLeadAlertRule(newLeadRule);
      setTemplates(tplRes.templates || []);
      setTenantPhones(phonesRes.data || []);
      const s: any = fuRes?.settings;
      if (s) {
        if (s.reEngagementAlertEnabled !== undefined) setReEngagementAlertOn(!!s.reEngagementAlertEnabled);
        if (s.reEngagementTemplate) setReEngagementTemplate(s.reEngagementTemplate);
        if (s.handoffAlertTemplate) setHandoffAlertTemplate(s.handoffAlertTemplate);
      }
    }).catch((err: any) => {
      if (!cancelled) setError(err.message || 'Failed to load communication settings');
    }).finally(() => {
      if (cancelled) return;
      setHydrating(false);
      // Defer hydrated flag by a tick so the auto-save effect doesn't fire
      // on the values we just set from the server.
      setTimeout(() => { if (!cancelled) setHydrated(true); }, 0);
    });
    return () => { cancelled = true; };
  }, [selectedAccountId]);

  // Debounced auto-save for the two alert templates. Mirrors the Services
  // page pattern — same backend field names, same followUpApi.saveSettings.
  useEffect(() => {
    if (!selectedAccountId || !hydrated) return;
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
  }, [selectedAccountId, hydrated, reEngagementAlertOn, reEngagementTemplate, handoffAlertTemplate]);

  const selectedAccount = accounts.find(a => a.id === selectedAccountId) || null;
  const accountPhone = (() => {
    if (!selectedAccountId) return null;
    return tenantPhones.find(p => p.savedAccountId === selectedAccountId && p.status === 'ACTIVE')
      || tenantPhones.find(p => !p.savedAccountId && p.status === 'ACTIVE')
      || tenantPhones.find(p => p.status === 'ACTIVE')
      || null;
  })();
  const businessPhone = selectedAccount?.agentPhoneOverride || user?.businessPhone || null;
  const templateMissing = !!leadAlertRule && !leadAlertRule.templateId && !leadAlertRule.messageTemplate;

  async function toggleLeadAlert(on: boolean) {
    if (!selectedAccountId) return;
    setSavingAlert(true);
    setError(null);
    try {
      if (leadAlertRule && leadAlertRule.id !== '_pending') {
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { enabled: on });
        setLeadAlertRule(rule);
      } else if (on) {
        await createDefaultLeadAlertRule();
      }
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to toggle alert');
    } finally {
      setSavingAlert(false);
    }
  }

  // Minimal creation path: uses a generic default template. The Automation
  // page has a richer platform-specific seeding flow; here we keep it
  // bare-minimum so the toggle works in the rare case the user lands here
  // before ever enabling alerts elsewhere.
  async function createDefaultLeadAlertRule() {
    if (!selectedAccountId) return;
    setCreatingAlert(true);
    try {
      const accPlatform = selectedAccount?.platform || 'thumbtack';
      const tplName = accPlatform === 'yelp' ? 'Lead Alert - Yelp' : 'Lead Alert - Thumbtack';
      const tplBody = accPlatform === 'yelp'
        ? 'New Yelp lead for {account.name}\n{lead.name}\nService: {lead.service}\nMessage: {lead.message}\nPhone: {lead.phone}'
        : 'New lead for {account.name}\n{lead.name}, Price {lead.price}\nService: {lead.service}\nMessage: {lead.message}\nPhone: {lead.phone}';
      let templateId = templates.find(t => t.name === tplName)?.id;
      if (!templateId) {
        const { template } = await templatesApi.createTemplate(tplName, tplBody);
        templateId = template.id;
        setTemplates(prev => [template, ...prev]);
      }
      const toPhone = businessPhone || '';
      const { rule } = await notificationsApi.createRule(selectedAccountId, {
        name: tplName,
        triggerType: 'new_lead',
        toPhone,
        sendToCustomer: false,
        template: tplBody,
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

  const changeAlertTemplate = useCallback(async (templateId: string) => {
    if (!selectedAccountId || !leadAlertRule) return;
    setSavingAlert(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { templateId });
      setLeadAlertRule(rule);
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.message || 'Failed to change template');
    } finally {
      setSavingAlert(false);
    }
  }, [selectedAccountId, leadAlertRule]);

  if (accounts.length === 0) {
    return (
      <div className="max-w-4xl mx-auto p-6">
        <button onClick={() => navigate('/services')} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-4">
          <ArrowLeft className="w-4 h-4" /> Back to Automation
        </button>
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-center">
          <p className="text-amber-800">Connect a saved account first to configure alerts.</p>
          <Link to="/settings" className="inline-block mt-3 px-4 py-2 bg-amber-600 text-white text-sm font-semibold rounded-lg hover:bg-amber-700">
            Go to Settings →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-6">
      {/* Header */}
      <div>
        <button onClick={() => navigate('/services')} className="flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700 mb-3">
          <ArrowLeft className="w-4 h-4" /> Back to Automation
        </button>
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

      {/* Account selector (alerts are per-account) */}
      {accounts.length > 1 && (
        <div>
          <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Saved Account</label>
          <div className="relative">
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
              className="w-full appearance-none rounded-xl px-3 py-2.5 pr-9 text-sm border border-slate-200 bg-white focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
            >
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.platform === 'yelp' ? '🔴 ' : '🔵 '}{acc.businessName}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none" />
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700 flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {hydrating && (
        <div className="flex justify-center py-8">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      )}

      {!hydrating && (
        <>
          {/* Phone numbers summary (read-only — full editing lives in /settings) */}
          <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
              <Phone className="w-5 h-5 text-blue-600" />
              <div className="flex-1">
                <h2 className="text-sm font-bold text-slate-800">Phone Numbers</h2>
                <p className="text-xs text-slate-400">Set up the numbers used for alerts, messaging, and calls.</p>
              </div>
              <Link to="/settings" className="text-xs font-semibold text-blue-600 hover:underline shrink-0">
                Manage in Settings →
              </Link>
            </div>
            <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">📱 Business Phone</span>
                  <TierBadge tier="respond" />
                </div>
                <p className="text-[11px] text-slate-400 mb-2">Where lead notifications are sent.</p>
                <div className="rounded-xl px-3 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 text-slate-800">
                  {businessPhone || <span className="text-slate-400">Not set</span>}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[11px] font-bold text-slate-400 uppercase tracking-widest">🤖 LeadBridge Number</span>
                  <TierBadge tier="engage" />
                </div>
                <p className="text-[11px] text-slate-400 mb-2">Used for texting and calling leads.</p>
                <div className="rounded-xl px-3 py-2.5 text-sm font-mono bg-slate-50 border border-slate-200 text-slate-800">
                  {accountPhone?.phoneNumber || <span className="text-slate-400">Not assigned</span>}
                </div>
              </div>
            </div>
          </div>

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
                      </div>
                      <p className="text-xs text-slate-400">Get notified when a new lead arrives.</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={leadAlertRule?.enabled ?? false}
                      onChange={e => toggleLeadAlert(e.target.checked)}
                      disabled={savingAlert || creatingAlert}
                      className="sr-only peer"
                    />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-3${!(leadAlertRule?.enabled) ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  {!leadAlertRule && (
                    <p className="text-xs text-slate-500">Toggle on to create a default alert rule for this account.</p>
                  )}
                  {leadAlertRule && (
                    <div>
                      <label className={`text-[11px] font-bold uppercase tracking-widest mb-2 block ${templateMissing ? 'text-orange-500' : 'text-slate-400'}`}>
                        Template{templateMissing && <span className="ml-1">*</span>}
                      </label>
                      <select
                        value={leadAlertRule.templateId || leadAlertRule.messageTemplate?.id || ''}
                        onChange={e => changeAlertTemplate(e.target.value)}
                        disabled={savingAlert}
                        className={`w-full rounded-xl p-3 text-sm font-medium disabled:opacity-50 transition-colors ${
                          templateMissing ? 'border-2 border-orange-300 bg-orange-50/40' : 'bg-white border border-slate-200'
                        }`}
                      >
                        <option value="">Select template</option>
                        {templates.map(t => (
                          <option key={t.id} value={t.id}>{t.name}</option>
                        ))}
                      </select>
                      {leadAlertRule.messageTemplate && (
                        <div className="mt-3 bg-white p-4 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed whitespace-pre-wrap">
                          {leadAlertRule.messageTemplate.content}
                        </div>
                      )}
                      <p className="mt-2 text-[10px] text-slate-400">
                        Manage templates and content on the <Link to="/services" className="text-blue-600 hover:underline">Automation page</Link> or via the Templates section.
                      </p>
                    </div>
                  )}
                </div>
              </div>

              {/* Reply Alerts (Engage) */}
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseEngage && <LockedFeatureOverlay ctaLabel="Upgrade to Engage · $89/mo" />}
                <div className={`flex items-center justify-between px-5 py-4 bg-slate-50/50${!canUseEngage ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Bell className="w-5 h-5 text-amber-500" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">Reply Alerts</h4>
                        <TierBadge tier="engage" />
                      </div>
                      <p className="text-xs text-slate-400">Get notified when a quiet lead replies.</p>
                    </div>
                  </div>
                  <label className={`inline-flex items-center ${canUseEngage ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    <input type="checkbox" checked={reEngagementAlertOn} disabled={!canUseEngage} onChange={e => setReEngagementAlertOn(e.target.checked)} className="sr-only peer" />
                    <div className="relative w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-blue-100 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600" />
                  </label>
                </div>
                <div className={`px-5 py-4 space-y-3${!reEngagementAlertOn || !canUseEngage ? ' opacity-40 pointer-events-none select-none' : ''}`}>
                  <p className="text-[11px] text-slate-500">Fires when a customer replies after follow-ups were sent.</p>
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Reply Alert Template</label>
                    <p className="text-[10px] text-slate-400 mb-2">Use {'{{lead.name}}'} for lead name and {'{{message}}'} for their reply text.</p>
                    <textarea
                      value={reEngagementTemplate}
                      onChange={e => setReEngagementTemplate(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 resize-none focus:outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-400"
                      placeholder='Lead {{lead.name}} replied: "{{message}}"'
                    />
                  </div>
                </div>
              </div>

              {/* AI Human Takeover Alerts (Convert) */}
              <div className="relative border border-slate-100 rounded-2xl overflow-hidden">
                {!canUseConvert && <LockedFeatureOverlay ctaLabel="Upgrade to Convert · $139/mo" />}
                <div className={`px-5 py-4 bg-slate-50/50${!canUseConvert ? ' opacity-60' : ''}`}>
                  <div className="flex items-center gap-3">
                    <Zap className="w-5 h-5 text-violet-600" />
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-slate-800">AI Human Takeover Alerts</h4>
                        <TierBadge tier="convert" />
                      </div>
                      <p className="text-xs text-slate-400">Get notified when AI detects a manager should take over.</p>
                    </div>
                  </div>
                </div>
                <div className={`px-5 py-4 space-y-3${!canUseConvert ? ' opacity-60 pointer-events-none' : ''}`}>
                  <p className="text-[11px] text-slate-500">Fires during AI Conversation when the customer is ready to book, wants a call, or needs a human.</p>
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-1 block">Handoff Alert Template</label>
                    <p className="text-[10px] text-slate-400 mb-2">
                      Use {'{{lead.name}}'}, {'{{message}}'}, and {'{{intent}}'} ("ready to book" or "wants live call").
                    </p>
                    <textarea
                      value={handoffAlertTemplate}
                      onChange={e => setHandoffAlertTemplate(e.target.value)}
                      rows={2}
                      className="w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-sm text-slate-700 resize-none focus:outline-none focus:ring-2 focus:ring-violet-200 focus:border-violet-400"
                      placeholder='Lead {{lead.name}} ready for handoff ({{intent}}): "{{message}}"'
                    />
                  </div>
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    Auto-fires while AI Conversation is on (configured on the <Link to="/services" className="text-blue-600 hover:underline">Automation page</Link>). Also requires <span className="font-semibold text-slate-600">Reply Alerts</span> above to be enabled — the same backend toggle gates both paths.
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

export default SettingsCommunication;
