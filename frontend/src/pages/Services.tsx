import { useState, useEffect } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, CheckCircle, X, Clock,
  Bot, Pencil, Phone, Send, ChevronUp, Trash2,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, usersApi,
} from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
} from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';
import { useAppStore } from '../store/appStore';

// Combined variables — same set for all card types (matches Templates page)
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

// -- ServiceCard sub-component --
interface ServiceCardProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  comingSoon?: boolean;
  expanded?: boolean;
  onExpand?: () => void;
  statusText?: string;
  warningText?: string;
  setupRequired?: boolean;
  children?: React.ReactNode;
  iconBgColor?: string;
  iconTextColor?: string;
}

function ServiceCard({ icon, title, description, enabled, onToggle, comingSoon, expanded, onExpand, statusText, warningText, setupRequired, children, iconBgColor = 'bg-blue-50', iconTextColor = 'text-blue-600' }: ServiceCardProps) {
  return (
    <div className={`bg-white rounded-3xl border shadow-sm overflow-hidden transition-all ${comingSoon ? 'opacity-75 bg-slate-50/50 border-slate-100' : setupRequired ? 'border-orange-200 hover:border-orange-300' : 'border-slate-100 hover:border-blue-200'}`}>
      <div className="p-6 md:p-8">
        <div className="flex flex-col md:flex-row md:items-start justify-between gap-6">
          <div className="flex gap-5">
            <div className={`w-14 h-14 ${comingSoon ? 'bg-white text-slate-400 border border-slate-100' : `${iconBgColor} ${iconTextColor}`} rounded-2xl flex items-center justify-center shrink-0`}>
              {icon}
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className={`text-xl font-bold ${comingSoon ? 'text-slate-400' : 'text-slate-900'}`}>{title}</h3>
                {comingSoon && (
                  <span className="px-2 py-0.5 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase">Coming Soon</span>
                )}
                {!comingSoon && (
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full border uppercase tracking-wider ${
                    enabled
                      ? 'bg-emerald-50 text-emerald-600 border-emerald-200'
                      : 'bg-slate-100 text-slate-400 border-slate-200'
                  }`}>
                    {enabled ? 'Active' : 'Disabled'}
                  </span>
                )}
                {setupRequired && !comingSoon && (
                  <span className="px-2 py-0.5 bg-orange-100 text-orange-600 text-[10px] font-bold rounded-full border border-orange-200 uppercase tracking-wider">Setup Required</span>
                )}
              </div>
              <p className={`mt-1 ${comingSoon ? 'text-slate-400' : 'text-slate-500'}`}>{description}</p>
              {warningText && !comingSoon && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="w-2 h-2 rounded-full bg-orange-400"></span>
                  <span className="text-xs font-bold text-orange-600 uppercase tracking-tight">{warningText}</span>
                </div>
              )}
              {statusText && !warningText && !comingSoon && (
                <div className="flex items-center gap-2 mt-3">
                  <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                  <span className="text-xs font-bold text-slate-600 uppercase tracking-tight">{statusText}</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            {!comingSoon && onExpand && (
              <button
                onClick={onExpand}
                className="p-2 text-slate-400 hover:text-slate-600 transition-colors"
              >
                {expanded ? <ChevronUp className="w-6 h-6" /> : <ChevronDown className="w-6 h-6" />}
              </button>
            )}
            <label className="inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onToggle(e.target.checked)}
                disabled={comingSoon}
                className="sr-only peer"
              />
              <div className={`relative w-14 h-7 ${comingSoon ? 'bg-slate-100 cursor-not-allowed' : 'bg-slate-200'} peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-0.5 after:start-[4px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-6 after:w-6 after:transition-all peer-checked:bg-blue-600`}></div>
            </label>
          </div>
        </div>

        {expanded && children && (
          <div className="mt-10 pt-8 border-t border-slate-50 space-y-6">
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

// -- Main Services Page --
export function Services() {
  const navigate = useNavigate();
  const storedAccounts = useAppStore(state => state.savedAccounts);
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);

  // Account state — seed from Zustand store so there's no loading flash
  const [accounts, setAccounts] = useState<SavedAccount[]>(storedAccounts);
  const [selectedAccountId, setSelectedAccountId] = useState(storedAccounts[0]?.id || '');
  const [loading, setLoading] = useState(storedAccounts.length === 0);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deletingAlert, setDeletingAlert] = useState(false);
  const [confirmDeleteAlert, setConfirmDeleteAlert] = useState(false);

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>([]);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;
  const followUpRules = autoReplyRules
    .filter(r => r.delayMinutes > 0)
    .sort((a, b) => a.delayMinutes - b.delayMinutes);

  // Other service rules
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);


  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [poolPhones, setPoolPhones] = useState<{ id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[]>([]);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  // Template editor modal state
  const [templateEditor, setTemplateEditor] = useState<{
    mode: 'create' | 'service-edit';
    ruleId: string;
    templateId?: string;
    templateName?: string;
    content: string;
    type: 'autoReply' | 'alert';
  } | null>(null);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState('');
  const [alertFromPhone, setAlertFromPhone] = useState('');


  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadServiceData(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadAccounts() {
    try {
      const { accounts: accs } = await thumbtackApi.getSavedAccounts();
      setAccounts(accs);
      setSavedAccounts(accs); // Update global app store
      // Only set selectedAccount from fetch if nothing was pre-selected from store
      if (!selectedAccountId && accs.length > 0) {
        setSelectedAccountId(accs[0].id);
      }
    } catch (err: any) {
      // If we have store data, silent fail; only show error if accounts list is empty
      if (accounts.length === 0) {
        setError(err.message || 'Failed to load accounts');
      }
    } finally {
      setLoading(false);
    }
  }

  async function loadServiceData(accountId: string) {
    try {
      setLoading(true);
      setError(null);

      const [automationRes, notifRes, templatesRes, poolRes] = await Promise.all([
        automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
        notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
        templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[] })),
        usersApi.getPoolPhonesForSms().catch(() => ({ phoneNumbers: [] })),
      ]);

      // Collect ALL new_lead automation rules
      const allAutoReplies = automationRes.rules.filter(
        (r: AutomationRule) => r.triggerType === 'new_lead'
      );
      setAutoReplyRules(allAutoReplies);

      // Find lead alert rules (non-customer-facing)
      const leadAlert = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && !r.sendToCustomer
      ) || null;

      setLeadAlertRule(leadAlert);
      setTemplates(templatesRes.templates);
      setPoolPhones(poolRes.phoneNumbers);

      // Pre-fill form states from existing rules
      if (leadAlert) {
        setAlertToPhone(leadAlert.toPhone || '');
        setAlertFromPhone(leadAlert.fromPhone || '');
      }
      // Default from phone to first pool phone
      const defaultFrom = poolRes.phoneNumbers[0]?.phoneNumber || '';
      if (!leadAlert) setAlertFromPhone(defaultFrom);

      // Auto-expand Lead Alerts card if setup is incomplete
      const toPhoneMissing = leadAlert && !leadAlert.toPhone;
      const templateMissing = leadAlert && !leadAlert.templateId && !leadAlert.messageTemplate;
      if (toPhoneMissing || templateMissing) {
        setExpandedCard('lead-alerts');
      }

    } catch (err: any) {
      setError(err.message || 'Failed to load services data');
    } finally {
      setLoading(false);
    }
  }

  function showSuccess(msg: string) {
    setSuccessMessage(msg);
    setTimeout(() => setSuccessMessage(null), 3000);
  }

  // --- Toggle Handlers ---

  async function toggleAutoReply(enabled: boolean) {
    setError(null);
    // Optimistic: update UI immediately
    const prevRules = [...autoReplyRules];
    if (autoReplyRules.length > 0) {
      setAutoReplyRules(prev => prev.map(r => ({ ...r, enabled })));
    }
    setSaving(true);
    try {
      if (autoReplyRules.length > 0) {
        // Toggle all existing rules
        const updated = await Promise.all(
          autoReplyRules.map(r => automationApi.updateRule(r.id, { enabled }))
        );
        setAutoReplyRules(updated.map(u => u.rule));
      } else if (enabled) {
        // First time: create default template + first message rule only
        let templateId = templates.find(t => t.name.includes('Auto Reply'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Auto Reply - Welcome',
            'Hi {firstName}, thanks for reaching out about {category}! I\'d love to help. Let me review your request and get back to you shortly.',
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const { rule } = await automationApi.createRule({
          savedAccountId: selectedAccountId,
          name: 'Auto Reply - Immediate',
          triggerType: 'new_lead',
          templateId,
          delayMinutes: 0,
          enabled: true,
        });
        setAutoReplyRules([rule]);
        showSuccess('Auto Reply enabled');
      }
    } catch (err: any) {
      // Rollback on error
      setAutoReplyRules(prevRules);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Auto Reply');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLeadAlerts(enabled: boolean) {
    setError(null);
    // Optimistic: update UI immediately
    const prevAlertRule = leadAlertRule ? { ...leadAlertRule } : null;
    if (leadAlertRule) {
      setLeadAlertRule({ ...leadAlertRule, enabled });
    }
    setSaving(true);
    try {
      if (leadAlertRule) {
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { enabled });
        setLeadAlertRule(rule);
      } else if (enabled) {
        // Find or create a default Lead Alert template
        const DEFAULT_ALERT_TEMPLATE =
          'New lead: {{lead.name}}, Price {{lead.price}}\n' +
          'Location: {{lead.location}}, {{lead.zip}}\n' +
          'Service: {{lead.service}} {{lead.bedrooms}} bed /{{lead.bathrooms}} bath\n' +
          'Frequency: {{lead.frequency}}\n' +
          'Description: {{lead.serviceDescription}}\n' +
          'Add-ons: {{lead.addons}}\n' +
          'Pets: {{lead.pets}}\n' +
          'Message: {{lead.message}}\n' +
          'Phone: {{lead.phone}}';

        let templateId = templates.find(t => t.name.includes('Lead Alert'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Lead Alert - SMS',
            DEFAULT_ALERT_TEMPLATE,
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const defaultFrom = poolPhones[0]?.phoneNumber || '';
        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Lead Alert - SMS',
          triggerType: 'new_lead',
          fromPhone: alertFromPhone || defaultFrom,
          toPhone: alertToPhone,
          sendToCustomer: false,
          template: DEFAULT_ALERT_TEMPLATE,
          templateId,
          enabled: true,
        });
        setLeadAlertRule(rule);
        if (!alertFromPhone && defaultFrom) setAlertFromPhone(defaultFrom);
        setExpandedCard('lead-alerts');
        showSuccess('Lead Alerts enabled — configure your alert phone number');
      }
    } catch (err: any) {
      // Rollback on error
      setLeadAlertRule(prevAlertRule);
      setError(err.response?.data?.message || err.message || 'Failed to toggle Lead Alerts');
    } finally {
      setSaving(false);
    }
  }


  // --- Auto Reply Handlers ---

  async function changeRuleTemplate(ruleId: string, templateId: string) {
    setSaving(true);
    try {
      const { rule } = await automationApi.updateRule(ruleId, { templateId });
      setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? rule : r));
      showSuccess('Template updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update template');
    } finally {
      setSaving(false);
    }
  }

  // changeFollowUpDelay, addFollowUp, deleteFollowUp removed — follow-ups are Coming Soon

  // --- Lead Alert Handlers ---

  async function changeAlertRuleTemplate(ruleId: string, templateId: string) {
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, ruleId, { templateId });
      setLeadAlertRule(rule);
      showSuccess('Template updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update template');
    } finally {
      setSaving(false);
    }
  }

  async function saveAlertToPhone(toPhone: string) {
    setAlertToPhone(toPhone);
    if (!leadAlertRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { toPhone });
      setLeadAlertRule(rule);
      showSuccess('Alert destination updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update alert destination');
    } finally {
      setSaving(false);
    }
  }

  async function saveAlertFromPhone(fromPhone: string) {
    setAlertFromPhone(fromPhone);
    if (!leadAlertRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { fromPhone });
      setLeadAlertRule(rule);
      showSuccess('Send from number updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update from phone');
    } finally {
      setSaving(false);
    }
  }

  async function sendTestAlert() {
    if (!leadAlertRule || !selectedAccountId) return;
    setTesting(true);
    setError(null);
    try {
      const result = await notificationsApi.sendTest(selectedAccountId, leadAlertRule.id);
      if (result.success) {
        showSuccess('Test SMS sent!');
      } else {
        setError(result.message || 'Failed to send test');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to send test SMS');
    } finally {
      setTesting(false);
    }
  }

  async function deleteLeadAlertRule() {
    if (!leadAlertRule || !selectedAccountId) return;
    setDeletingAlert(true);
    setError(null);
    try {
      await notificationsApi.deleteRule(selectedAccountId, leadAlertRule.id);
      setLeadAlertRule(null);
      setAlertToPhone('');
      setConfirmDeleteAlert(false);
      setExpandedCard(null);
      showSuccess('Lead Alerts rule removed — toggle it on to set up fresh');
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to delete rule');
    } finally {
      setDeletingAlert(false);
    }
  }

  // --- Customer Texting Handlers ---


  // changeTextingFollowUpDelay, addTextingFollowUp, deleteTextingFollowUp, updateStopCondition removed — follow-ups are Coming Soon

  // --- Template Editor Modal Handlers ---

  async function handleEditorCreate({ name, content }: { name: string; content: string }) {
    if (!templateEditor) return;
    setSaving(true);
    try {
      const { template } = await templatesApi.createTemplate(name, content || 'Hi {{lead.name}}, ');
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReply') {
        await changeRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'alert') {
        await changeAlertRuleTemplate(templateEditor.ruleId, template.id);
      }
      setTemplateEditor(null);
      showSuccess('Template created');
    } catch (err: any) {
      setError(err.message || 'Failed to create template');
    } finally {
      setSaving(false);
    }
  }

  async function handleEditorUpdate({ content }: { name: string; content: string }) {
    if (!templateEditor || !templateEditor.templateId) return;
    const { ruleId, templateId } = templateEditor;
    setSaving(true);
    try {
      const { template } = await templatesApi.updateTemplate(templateId, { content });
      setTemplates(prev => prev.map(t => t.id === templateId ? { ...t, content: template.content } : t));
      setAutoReplyRules(prev => prev.map(r =>
        r.id === ruleId && r.template?.id === templateId
          ? { ...r, template: { ...r.template!, content: template.content } }
          : r
      ));
      if (leadAlertRule?.id === ruleId && leadAlertRule?.messageTemplate?.id === templateId) {
        setLeadAlertRule({ ...leadAlertRule, messageTemplate: { ...leadAlertRule.messageTemplate!, content: template.content } });
      }
      setTemplateEditor(null);
      showSuccess('Template saved');
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

  async function handleEditorSaveAsNew({ name, content }: { name: string; content: string }) {
    if (!templateEditor) return;
    setSaving(true);
    try {
      const { template } = await templatesApi.createTemplate(name, content);
      setTemplates(prev => [template, ...prev]);
      if (templateEditor.type === 'autoReply') {
        await changeRuleTemplate(templateEditor.ruleId, template.id);
      } else if (templateEditor.type === 'alert') {
        await changeAlertRuleTemplate(templateEditor.ruleId, template.id);
      }
      setTemplateEditor(null);
      showSuccess('Saved as new template');
    } catch (err: any) {
      setError(err.message || 'Failed to save as new template');
    } finally {
      setSaving(false);
    }
  }

  function toggleExpand(card: string) {
    setExpandedCard(expandedCard === card ? null : card);
  }

  // --- Render ---

  if (loading && accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Briefcase className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Automation</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Briefcase className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Automation</h1>
        </div>
        <div className="max-w-md mx-auto bg-white rounded-3xl border border-slate-100 shadow-sm p-10 text-center mt-10">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-900 mb-2">No Accounts Connected</h3>
          <p className="text-slate-500 mb-6">You need to connect an account first.</p>
          <button
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
            onClick={() => navigate('/dashboard')}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-8">
      {/* Floating Notifications */}
      {error && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium shadow-lg animate-in slide-in-from-top-2">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 max-w-md w-full mx-4 bg-emerald-50 border border-emerald-100 rounded-2xl p-4 flex items-center gap-3 text-emerald-600 text-sm font-medium shadow-lg animate-in slide-in-from-top-2">
          <CheckCircle size={16} className="shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Account Selector */}
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Select Account</h2>
          <p className="text-slate-600 text-sm">Configure automation rules for your business profile.</p>
        </div>
        <div className="relative min-w-[240px]">
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-3 appearance-none font-semibold"
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>{acc.businessName}</option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Loader2 size={24} className="animate-spin text-blue-600" />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-6">

          {/* 1. Auto Reply & Follow-Ups */}
          <ServiceCard
            icon={<Zap className="w-7 h-7" />}
            title="Auto Reply & Follow-Ups"
            description="Automatically respond to new leads as they arrive."
            enabled={autoReplyEnabled}
            onToggle={toggleAutoReply}
            expanded={expandedCard === 'auto-reply'}
            onExpand={() => toggleExpand('auto-reply')}
            statusText={autoReplyEnabled ? `Active: ${1 + followUpRules.length} message${followUpRules.length > 0 ? 's' : ''} in sequence` : undefined}
          >
            {/* AI Optimization Banner — Coming Soon */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-800 rounded-2xl p-6 text-white flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden">
              <div className="flex items-center gap-4 relative z-10">
                <div className="w-12 h-12 bg-white/10 rounded-xl flex items-center justify-center">
                  <Bot className="w-6 h-6 text-blue-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="font-bold">AI Optimization</h4>
                    <span className="px-2 py-0.5 bg-blue-500 text-[10px] font-bold rounded uppercase tracking-wider">Coming Soon</span>
                  </div>
                  <p className="text-slate-400 text-sm mt-1">AI decides timing and message variations to maximize response.</p>
                </div>
              </div>
              <div className="opacity-50 cursor-not-allowed grayscale">
                <div className="w-12 h-6 bg-white/20 rounded-full"></div>
              </div>
            </div>

            {/* First Message */}
            {firstReplyRule && (
              <div className="bg-slate-50 rounded-2xl p-6 border border-slate-100">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2 text-blue-600 font-bold">
                    <Zap className="w-4 h-4" />
                    <span>First Message</span>
                  </div>
                  <span className="text-xs font-semibold text-slate-400 italic">Sent Immediately</span>
                </div>

                <div className="space-y-4">
                  <div className="relative">
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Template Selection</label>
                    <select
                      value={firstReplyRule.templateId || ''}
                      onChange={e => {
                        if (e.target.value === '__create_new__') {
                          setTemplateEditor({ mode: 'create', ruleId: firstReplyRule.id, content: '', type: 'autoReply' });
                        } else {
                          changeRuleTemplate(firstReplyRule.id, e.target.value);
                        }
                      }}
                      disabled={saving}
                      className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium disabled:opacity-50"
                    >
                      <option value="">Select template...</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                      <option value="__create_new__">+ Create New Template</option>
                    </select>
                  </div>
                  {firstReplyRule.template?.content && (
                    <div className="bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                      {firstReplyRule.template.content}
                      <button
                        onClick={() => setTemplateEditor({
                          mode: 'service-edit',
                          ruleId: firstReplyRule.id,
                          templateId: firstReplyRule.template!.id,
                          templateName: templates.find(t => t.id === firstReplyRule.templateId)?.name || 'template',
                          content: firstReplyRule.template!.content,
                          type: 'autoReply',
                        })}
                        className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-blue-600"
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Follow-Up Messages - Coming Soon */}
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-slate-400">
                <Clock className="w-4 h-4" />
                <span className="font-bold">Follow-Up Messages</span>
                <span className="px-2 py-0.5 bg-slate-200 text-[10px] font-bold rounded uppercase">Coming Soon</span>
              </div>
              {followUpRules.length > 0 ? (
                followUpRules.map((rule, idx) => (
                  <div key={rule.id} className="bg-slate-50/50 rounded-2xl p-6 border border-slate-100 opacity-50">
                    <div className="text-sm font-bold text-slate-600 mb-3">Message {idx + 2}</div>
                    <div className="text-xs text-slate-500">Delay: {rule.delayMinutes} minutes</div>
                  </div>
                ))
              ) : (
                <div className="bg-slate-50/50 rounded-2xl p-6 border border-slate-100 border-dashed opacity-50 text-center">
                  <p className="text-sm text-slate-400">Scheduled follow-up messages will appear here</p>
                </div>
              )}
            </div>
          </ServiceCard>

          {/* 2. Lead Alerts */}
          {(() => {
            const toPhoneMissing = !!leadAlertRule && !alertToPhone;
            const templateMissing = !!leadAlertRule && !leadAlertRule.templateId && !leadAlertRule.messageTemplate;
            const leadAlertsIncomplete = toPhoneMissing || templateMissing;
            return (
          <ServiceCard
            icon={<Bell className="w-7 h-7" />}
            title="Lead Alerts"
            description="Get SMS notifications for every new inquiry."
            enabled={leadAlertRule?.enabled ?? false}
            onToggle={toggleLeadAlerts}
            expanded={expandedCard === 'lead-alerts'}
            onExpand={() => toggleExpand('lead-alerts')}
            setupRequired={leadAlertsIncomplete}
            warningText={leadAlertsIncomplete ? (toPhoneMissing ? 'Phone number required' : 'Template required') : undefined}
            statusText={!leadAlertsIncomplete && leadAlertRule?.enabled ? `Destination: ${leadAlertRule.toPhone}` : undefined}
            iconBgColor="bg-amber-50"
            iconTextColor="text-amber-600"
          >
            {/* SMS Alert Configuration */}
            <div className="space-y-6">
              <div>
                <label className={`text-[11px] font-bold uppercase tracking-widest mb-2 block ${toPhoneMissing ? 'text-orange-500' : 'text-slate-400'}`}>
                  Send to (your phone){toPhoneMissing && <span className="ml-1 text-orange-500">*</span>}
                </label>
                <input
                  type="tel"
                  value={alertToPhone}
                  onChange={e => setAlertToPhone(e.target.value)}
                  placeholder="+1234567890"
                  className={`w-full rounded-xl p-3 text-sm focus:ring-2 focus:outline-none transition-colors ${
                    toPhoneMissing
                      ? 'border-2 border-orange-300 bg-orange-50/40 focus:ring-orange-200 focus:border-orange-400 placeholder:text-orange-300'
                      : 'bg-white border border-slate-200 focus:ring-blue-500 focus:border-blue-500'
                  }`}
                />
                {toPhoneMissing && (
                  <p className="mt-1.5 text-xs text-orange-600 font-medium flex items-center gap-1">
                    <AlertCircle className="w-3 h-3 shrink-0" />
                    Enter your phone number to receive lead alert SMS messages
                  </p>
                )}
              </div>

              <div>
                <label className="text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2 block">Send from</label>
                <div className="relative">
                  <select
                    value={alertFromPhone}
                    onChange={e => saveAlertFromPhone(e.target.value)}
                    disabled={saving}
                    className="w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium disabled:opacity-50 appearance-none"
                  >
                    <option value="">Select phone number</option>
                    {/* Show current fromPhone even if not in pool list */}
                    {alertFromPhone && !poolPhones.some(p => p.phoneNumber === alertFromPhone) && (
                      <option value={alertFromPhone}>{alertFromPhone} (configured)</option>
                    )}
                    {poolPhones.map(p => (
                      <option key={p.id} value={p.phoneNumber}>
                        {p.phoneNumber} (LeadBridge)
                      </option>
                    ))}
                  </select>
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
                    <ChevronDown className="w-4 h-4" />
                  </div>
                </div>
                <button className="mt-2 px-4 py-2 bg-slate-100 text-slate-400 rounded-xl text-xs font-bold flex items-center gap-2 cursor-not-allowed">
                  <Phone className="w-3 h-3" />
                  Get your own number
                  <span className="px-1.5 py-0.5 bg-slate-200 text-[9px] rounded uppercase">Coming Soon</span>
                </button>
              </div>

              {leadAlertRule && (
                <>
                  <div>
                    <label className={`text-[11px] font-bold uppercase tracking-widest mb-2 block ${templateMissing ? 'text-orange-500' : 'text-slate-400'}`}>
                      Template{templateMissing && <span className="ml-1 text-orange-500">*</span>}
                    </label>
                    <select
                      value={leadAlertRule.templateId || leadAlertRule.messageTemplate?.id || ''}
                      onChange={e => {
                        if (e.target.value === '__create_new__') {
                          setTemplateEditor({ mode: 'create', ruleId: leadAlertRule.id, content: '', type: 'alert' });
                        } else {
                          changeAlertRuleTemplate(leadAlertRule.id, e.target.value);
                        }
                      }}
                      disabled={saving}
                      className={`w-full rounded-xl p-3 text-sm font-medium disabled:opacity-50 transition-colors ${
                        templateMissing
                          ? 'border-2 border-orange-300 bg-orange-50/40 focus:ring-orange-200 focus:border-orange-400'
                          : 'bg-white border border-slate-200'
                      }`}
                    >
                      <option value="">Select template</option>
                      {templates.map(t => (
                        <option key={t.id} value={t.id}>{t.name}</option>
                      ))}
                      <option value="__create_new__">+ Create New Template</option>
                    </select>
                    {templateMissing && (
                      <p className="mt-1.5 text-xs text-orange-600 font-medium flex items-center gap-1">
                        <AlertCircle className="w-3 h-3 shrink-0" />
                        Select or create a template to define the SMS message content
                      </p>
                    )}
                    {leadAlertRule.messageTemplate && (
                      <div className="mt-4 bg-white p-5 rounded-xl border border-dashed border-slate-200 text-slate-600 text-sm leading-relaxed relative group">
                        {leadAlertRule.messageTemplate.content}
                        <button
                          onClick={() => setTemplateEditor({
                            mode: 'service-edit',
                            ruleId: leadAlertRule.id,
                            templateId: leadAlertRule.messageTemplate!.id,
                            templateName: templates.find(t => t.id === (leadAlertRule.templateId || leadAlertRule.messageTemplate?.id))?.name || 'template',
                            content: leadAlertRule.messageTemplate!.content,
                            type: 'alert',
                          })}
                          className="absolute top-3 right-3 p-2 bg-slate-50 rounded-lg text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity hover:text-blue-600"
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Send Test + Trigger Stats + Save Button */}
                  <div className="space-y-4 pt-4 border-t border-slate-100">
                    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                      <button
                        onClick={sendTestAlert}
                        disabled={testing || saving || !leadAlertRule.toPhone || !alertFromPhone}
                        className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        title={!leadAlertRule.toPhone ? 'Set a destination phone first' : !alertFromPhone ? 'Set a send-from phone first' : 'Send a test SMS'}
                      >
                        {testing ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                        Send Test SMS
                      </button>
                      {leadAlertRule.triggerCount > 0 && (
                        <span className="text-xs text-slate-500">
                          Triggered {leadAlertRule.triggerCount} time{leadAlertRule.triggerCount !== 1 ? 's' : ''}
                          {leadAlertRule.lastTriggeredAt && (
                            <> — last {new Date(leadAlertRule.lastTriggeredAt).toLocaleDateString()}</>
                          )}
                        </span>
                      )}
                    </div>
                    <div className="flex justify-end">
                      <button
                        onClick={() => { if (leadAlertRule && alertToPhone !== leadAlertRule.toPhone) saveAlertToPhone(alertToPhone); }}
                        disabled={saving || !alertToPhone || alertToPhone === leadAlertRule.toPhone}
                        className="px-6 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                        Save Changes
                      </button>
                    </div>
                  </div>
                </>
              )}

              {/* Delete / Reset rule */}
              {leadAlertRule && (
                <div className="pt-4 border-t border-slate-100">
                  {confirmDeleteAlert ? (
                    <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                      <div className="flex-1">
                        <p className="text-sm font-bold text-red-700">Delete this Lead Alert rule?</p>
                        <p className="text-xs text-red-500 mt-0.5">This removes the rule and phone configuration. Toggle Lead Alerts back on to create a fresh setup with the new default template.</p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          onClick={() => setConfirmDeleteAlert(false)}
                          className="px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-800 transition-colors"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={deleteLeadAlertRule}
                          disabled={deletingAlert}
                          className="px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-all disabled:opacity-50 flex items-center gap-2"
                        >
                          {deletingAlert ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                          Delete Rule
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteAlert(true)}
                      className="text-xs font-semibold text-slate-400 hover:text-red-500 transition-colors flex items-center gap-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      Delete this rule and start over
                    </button>
                  )}
                </div>
              )}
            </div>
          </ServiceCard>
            );
          })()}

          {/* 3. Customer Texting — Coming Soon */}
          <ServiceCard
            icon={<MessageSquare className="w-7 h-7" />}
            title="Customer Texting"
            description="Direct text routing to bypass platform apps."
            enabled={false}
            onToggle={() => {}}
            comingSoon={true}
          />

          {/* 4. Instant Call Connect */}
          <ServiceCard
            icon={<PhoneCall className="w-7 h-7" />}
            title="Instant Call Connect"
            description="Receive a phone call to bridge you instantly to new leads."
            enabled={false}
            onToggle={() => {}}
            comingSoon={true}
          />

        </div>
      )}

      {/* Template Editor Modal */}
      <TemplateEditorModal
        isOpen={!!templateEditor}
        onClose={() => setTemplateEditor(null)}
        mode={templateEditor?.mode === 'create' ? 'create' : 'service-edit'}
        initialName=""
        initialContent={templateEditor?.content || ''}
        templateName={templateEditor?.templateName}
        saving={saving}
        variables={ALL_VARIABLES}
        existingNames={templates.map(t => t.name)}
        onSave={templateEditor?.mode === 'create' ? handleEditorCreate : handleEditorUpdate}
        onSaveAsNew={handleEditorSaveAsNew}
      />
    </div>
  );
}
