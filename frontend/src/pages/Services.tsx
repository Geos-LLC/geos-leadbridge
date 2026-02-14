import { useState, useEffect } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, CheckCircle, X, Clock,
  Plus, Bot, Pencil, Phone, Send,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, usersApi,
} from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
} from '../types';
import { TemplateEditorModal, AUTO_REPLY_VARIABLES, SMS_VARIABLES } from '../components/TemplateEditorModal';

// Combined variables — same set for all card types (matches Templates page)
const ALL_VARIABLES = [...AUTO_REPLY_VARIABLES, ...SMS_VARIABLES.filter(
  v => !AUTO_REPLY_VARIABLES.some(a => a.desc === v.desc)
)];

// Delay presets for follow-up messages
const DELAY_PRESETS = [
  { label: '5 min', minutes: 5 },
  { label: '15 min', minutes: 15 },
  { label: '30 min', minutes: 30 },
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '6 hours', minutes: 360 },
  { label: '24 hours', minutes: 1440 },
];

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
  children?: React.ReactNode;
  saving?: boolean;
}

function ServiceCard({ icon, title, description, enabled, onToggle, comingSoon, expanded, onExpand, statusText, children, saving }: ServiceCardProps) {
  return (
    <div className={`service-card ${enabled ? 'enabled' : 'disabled'} ${comingSoon ? 'coming-soon' : ''}`}>
      <div className="service-card-header">
        <div className="service-card-icon">{icon}</div>
        <div className="service-card-info">
          <h3>
            {title}
            {comingSoon && <span className="coming-soon-badge">Coming Soon</span>}
          </h3>
          <p>{description}</p>
          {statusText && <span className="service-status-text">{statusText}</span>}
        </div>
        <div className="service-card-toggle">
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              disabled={comingSoon || saving}
            />
            <span className="toggle-slider"></span>
          </label>
        </div>
      </div>
      {expanded && children && (
        <div className="service-card-settings">
          {children}
        </div>
      )}
      {onExpand && !comingSoon && (
        <button className="service-card-expand" onClick={onExpand}>
          {expanded ? 'Hide Settings' : 'Settings'}
          <ChevronDown size={14} className={expanded ? 'rotated' : ''} />
        </button>
      )}
    </div>
  );
}

// -- Main Services Page --
export function Services() {
  const navigate = useNavigate();

  // Account state
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>([]);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;
  const followUpRules = autoReplyRules
    .filter(r => r.delayMinutes > 0)
    .sort((a, b) => a.delayMinutes - b.delayMinutes);

  // Other service rules
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);

  // Customer Texting rules (dynamic array — same pattern as Auto Reply)
  const [customerTextingRules, setCustomerTextingRules] = useState<NotificationRule[]>([]);
  const customerTextingEnabled = customerTextingRules.some(r => r.enabled);
  const firstTextingRule = customerTextingRules.find(r => !r.delayMinutes || r.delayMinutes === 0) || null;
  const textingFollowUpRules = customerTextingRules
    .filter(r => r.delayMinutes && r.delayMinutes > 0)
    .sort((a, b) => (a.delayMinutes || 0) - (b.delayMinutes || 0));

  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [poolPhones, setPoolPhones] = useState<{ id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[]>([]);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [expandedSubCards, setExpandedSubCards] = useState<Set<string>>(new Set(['auto-reply-first', 'texting-first', 'alerts-sms']));
  // Template editor modal state
  const [templateEditor, setTemplateEditor] = useState<{
    mode: 'create' | 'service-edit';
    ruleId: string;
    templateId?: string;
    templateName?: string;
    content: string;
    type: 'autoReply' | 'texting' | 'alert';
  } | null>(null);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState('');
  const [alertFromPhone, setAlertFromPhone] = useState('');

  // Customer Texting form state
  const [textingFromPhone, setTextingFromPhone] = useState('');

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
      if (accs.length > 0) {
        setSelectedAccountId(accs[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
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

      // Collect ALL customer texting rules (sendToCustomer: true)
      const customerTextingAll = notifRes.rules.filter(
        (r: NotificationRule) => r.triggerType === 'new_lead' && r.sendToCustomer === true
      );

      setLeadAlertRule(leadAlert);
      setCustomerTextingRules(customerTextingAll);
      setTemplates(templatesRes.templates);
      setPoolPhones(poolRes.phoneNumbers);

      // Pre-fill form states from existing rules
      if (leadAlert) {
        setAlertToPhone(leadAlert.toPhone || '');
        setAlertFromPhone(leadAlert.fromPhone || '');
      }
      const firstTexting = customerTextingAll.find(r => !r.delayMinutes || r.delayMinutes === 0);
      if (firstTexting) {
        setTextingFromPhone(firstTexting.fromPhone || '');
      }

      // Default from phone to first pool phone
      const defaultFrom = poolRes.phoneNumbers[0]?.phoneNumber || '';
      if (!leadAlert) setAlertFromPhone(defaultFrom);
      if (!firstTexting) setTextingFromPhone(defaultFrom);

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
    setSaving(true);
    setError(null);
    try {
      if (autoReplyRules.length > 0) {
        // Toggle all existing rules
        const updated = await Promise.all(
          autoReplyRules.map(r => automationApi.updateRule(r.id, { enabled }))
        );
        setAutoReplyRules(updated.map(u => u.rule));
        showSuccess(enabled ? 'Auto Reply enabled' : 'Auto Reply disabled');
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
      setError(err.response?.data?.message || err.message || 'Failed to toggle Auto Reply');
    } finally {
      setSaving(false);
    }
  }

  async function toggleLeadAlerts(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (leadAlertRule) {
        const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, { enabled });
        setLeadAlertRule(rule);
        showSuccess(enabled ? 'Lead Alerts enabled' : 'Lead Alerts disabled');
      } else if (enabled) {
        // Find or create a default Lead Alert template
        let templateId = templates.find(t => t.name.includes('Lead Alert'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Lead Alert - SMS',
            'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
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
          template: 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
          templateId,
          enabled: true,
        });
        setLeadAlertRule(rule);
        if (!alertFromPhone && defaultFrom) setAlertFromPhone(defaultFrom);
        setExpandedCard('lead-alerts');
        showSuccess('Lead Alerts enabled — configure your alert phone number');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to toggle Lead Alerts');
    } finally {
      setSaving(false);
    }
  }

  async function toggleCustomerTexting(enabled: boolean) {
    setSaving(true);
    setError(null);
    try {
      if (customerTextingRules.length > 0) {
        // Toggle all existing rules
        const updated = await Promise.all(
          customerTextingRules.map(r => notificationsApi.updateRule(selectedAccountId, r.id, { enabled }))
        );
        setCustomerTextingRules(updated.map(u => u.rule));
        showSuccess(enabled ? 'Customer Texting enabled' : 'Customer Texting disabled');
      } else if (enabled) {
        if (!textingFromPhone) {
          setExpandedCard('customer-texting');
          setError('No phone numbers available. Please configure phone settings first.');
          setSaving(false);
          return;
        }
        // Find or create a default customer texting template
        let templateId = templates.find(t => t.name.includes('Customer SMS'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Customer SMS - Welcome',
            'Hi {{lead.name}}, thanks for your interest in {{lead.service}}! We received your request and will reach out shortly.',
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Customer SMS - Immediate',
          triggerType: 'new_lead',
          fromPhone: textingFromPhone,
          toPhone: '',
          sendToCustomer: true,
          template: 'Hi {{lead.name}}, thanks for your interest in {{lead.service}}! We received your request and will reach out shortly.',
          templateId,
          delayMinutes: 0,
          enabled: true,
        });
        setCustomerTextingRules([rule]);
        showSuccess('Customer Texting enabled');
      }
    } catch (err: any) {
      setError(err.response?.data?.message || err.message || 'Failed to toggle Customer Texting');
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

  // --- Customer Texting Handlers ---

  async function changeTextingRuleTemplate(ruleId: string, templateId: string) {
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, ruleId, { templateId });
      setCustomerTextingRules(prev => prev.map(r => r.id === ruleId ? rule : r));
      showSuccess('Template updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update template');
    } finally {
      setSaving(false);
    }
  }

  // changeTextingFollowUpDelay, addTextingFollowUp, deleteTextingFollowUp, updateStopCondition removed — follow-ups are Coming Soon

  async function saveTextingFromPhone(fromPhone: string) {
    setTextingFromPhone(fromPhone);
    if (customerTextingRules.length === 0) return;
    setSaving(true);
    try {
      const updated = await Promise.all(
        customerTextingRules.map(r => notificationsApi.updateRule(selectedAccountId, r.id, { fromPhone }))
      );
      setCustomerTextingRules(updated.map(u => u.rule));
      showSuccess('Send from number updated');
    } catch (err: any) {
      setError(err.message || 'Failed to update from phone');
    } finally {
      setSaving(false);
    }
  }

  function isCustomDelay(minutes: number) {
    return !DELAY_PRESETS.some(p => p.minutes === minutes);
  }

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
      } else {
        await changeTextingRuleTemplate(templateEditor.ruleId, template.id);
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
      setCustomerTextingRules(prev => prev.map(r =>
        r.id === ruleId && r.messageTemplate?.id === templateId
          ? { ...r, messageTemplate: { ...r.messageTemplate!, content: template.content } }
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
      } else {
        await changeTextingRuleTemplate(templateEditor.ruleId, template.id);
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

  function toggleSubCard(subCardId: string) {
    setExpandedSubCards(prev => {
      const next = new Set(prev);
      if (next.has(subCardId)) next.delete(subCardId);
      else next.add(subCardId);
      return next;
    });
  }

  // --- Render ---

  if (loading && accounts.length === 0) {
    return (
      <div className="services-page">
        <div className="settings-header">
          <h1><Briefcase size={24} /> Automation</h1>
        </div>
        <div className="loading-container">
          <Loader2 size={32} className="spinner" />
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="services-page">
        <div className="settings-header">
          <h1><Briefcase size={24} /> Automation</h1>
        </div>
        <div className="empty-state">
          <p>You need to connect an account first.</p>
          <button className="btn btn-primary" onClick={() => navigate('/dashboard')}>
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="services-page">
      <div className="settings-header">
        <h1><Briefcase size={24} /> Automation</h1>
      </div>

      {error && (
        <div className="error-message">
          <AlertCircle size={16} />
          {error}
          <button className="btn-icon" onClick={() => setError(null)}><X size={16} /></button>
        </div>
      )}

      {successMessage && (
        <div className="success-message">
          <CheckCircle size={16} />
          {successMessage}
        </div>
      )}

      <div className="settings-content">
        {/* Account Selector */}
        <div className="account-selector">
          <label>Account:</label>
          <div className="select-wrapper">
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
            >
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>{acc.businessName}</option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
        </div>

        {loading ? (
          <div className="loading-container">
            <Loader2 size={24} className="spinner" />
          </div>
        ) : (
          <div className="services-grid">

            {/* 1. Auto Reply & Follow-Ups */}
            <ServiceCard
              icon={<Zap size={22} />}
              title="Auto Reply & Follow-Ups"
              description="Automatically respond and follow up with new leads."
              enabled={autoReplyEnabled}
              onToggle={toggleAutoReply}
              saving={saving}
              expanded={expandedCard === 'auto-reply'}
              onExpand={() => toggleExpand('auto-reply')}
              statusText={autoReplyEnabled ? `${1 + followUpRules.length} message${followUpRules.length > 0 ? 's' : ''} in sequence` : undefined}
            >
              <div className="service-settings-inner">
                {/* AI Optimization Banner — Coming Soon */}
                <div className="ai-optimization-banner coming-soon-banner">
                  <div className="ai-banner-info">
                    <Bot size={18} />
                    <div>
                      <strong>AI Optimization</strong>
                      <span className="coming-soon-badge" style={{ marginLeft: 6 }}>Coming Soon</span>
                      <p className="form-hint">AI decides timing, follow-ups, and message variations to maximize response.</p>
                    </div>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={false}
                      disabled
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {/* First Message — Expandable Sub-Card */}
                <div className="sub-card">
                  <div className="sub-card-header" onClick={() => toggleSubCard('auto-reply-first')}>
                    <div className="sub-card-title">
                      <Zap size={14} />
                      <span>First Message</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('auto-reply-first') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('auto-reply-first') && (
                    <div className="sub-card-body">
                      <p className="form-hint">Sent immediately when a new lead arrives.</p>
                      {firstReplyRule && (
                        <div className="form-group">
                          <label>Template</label>
                          <div className="select-wrapper">
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
                            >
                              <option value="">Select template...</option>
                              {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                              <option value="__create_new__">+ Create New Template</option>
                            </select>
                            <ChevronDown size={16} />
                          </div>
                          {firstReplyRule.template?.content && (
                            <div className="template-preview-container">
                              <div className="template-preview">
                                {firstReplyRule.template.content}
                              </div>
                              <button
                                className="template-edit-btn"
                                onClick={() => setTemplateEditor({
                                  mode: 'service-edit',
                                  ruleId: firstReplyRule.id,
                                  templateId: firstReplyRule.template!.id,
                                  templateName: templates.find(t => t.id === firstReplyRule.templateId)?.name || 'template',
                                  content: firstReplyRule.template!.content,
                                  type: 'autoReply',
                                })}
                              >
                                <Pencil size={12} /> Edit
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Follow-Up Messages — Expandable Sub-Card (Coming Soon) */}
                <div className="sub-card sub-card-coming-soon">
                  <div className="sub-card-header" onClick={() => toggleSubCard('auto-reply-followups')}>
                    <div className="sub-card-title">
                      <Clock size={14} />
                      <span>Follow-Up Messages</span>
                      <span className="coming-soon-badge">Coming Soon</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('auto-reply-followups') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('auto-reply-followups') && (
                    <div className="sub-card-body sub-card-disabled">
                      <p className="form-hint">Automated follow-up messages sent after a delay. Configure timing and templates for each message in the sequence.</p>

                      {followUpRules.length === 0 && (
                        <div className="followup-item" style={{ opacity: 0.5 }}>
                          <div className="followup-item-header">
                            <span className="followup-label">Message 2</span>
                          </div>
                          <div className="form-group">
                            <label>Send after</label>
                            <div className="delay-presets">
                              <button className="delay-preset selected" disabled>2 hours</button>
                            </div>
                          </div>
                          <div className="form-group">
                            <label>Template</label>
                            <div className="select-wrapper">
                              <select disabled><option>Select template...</option></select>
                              <ChevronDown size={16} />
                            </div>
                          </div>
                        </div>
                      )}

                      {followUpRules.map((rule, idx) => (
                        <div key={rule.id} className="followup-item">
                          <div className="followup-item-header">
                            <span className="followup-label">Message {idx + 2}</span>
                          </div>
                          <div className="form-group">
                            <label>Send after</label>
                            <div className="delay-presets">
                              {DELAY_PRESETS.map(preset => (
                                <button
                                  key={preset.minutes}
                                  className={`delay-preset ${rule.delayMinutes === preset.minutes ? 'selected' : ''}`}
                                  disabled
                                >
                                  {preset.label}
                                </button>
                              ))}
                              {isCustomDelay(rule.delayMinutes) && (
                                <button className="delay-preset selected" disabled>{rule.delayMinutes} min</button>
                              )}
                            </div>
                          </div>
                          <div className="form-group">
                            <label>Template</label>
                            <div className="select-wrapper">
                              <select value={rule.templateId || ''} disabled>
                                <option value="">Select template...</option>
                                {templates.map(t => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                              <ChevronDown size={16} />
                            </div>
                            {rule.template?.content && (
                              <div className="template-preview">{rule.template.content}</div>
                            )}
                          </div>
                        </div>
                      ))}

                      <button className="add-followup-btn" disabled>
                        <Plus size={16} />
                        Add Follow-Up
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </ServiceCard>

            {/* 2. Lead Alerts */}
            <ServiceCard
              icon={<Bell size={22} />}
              title="Lead Alerts"
              description="Get notified immediately via SMS when a new lead arrives."
              enabled={leadAlertRule?.enabled ?? false}
              onToggle={toggleLeadAlerts}
              saving={saving}
              expanded={expandedCard === 'lead-alerts'}
              onExpand={() => toggleExpand('lead-alerts')}
              statusText={leadAlertRule?.enabled ? `SMS to ${leadAlertRule.toPhone || 'not set'}` : undefined}
            >
              <div className="service-settings-inner">

                {/* SMS Alert — Expandable Sub-Card */}
                <div className="sub-card">
                  <div className="sub-card-header" onClick={() => toggleSubCard('alerts-sms')}>
                    <div className="sub-card-title">
                      <Bell size={14} />
                      <span>SMS Alert</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('alerts-sms') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('alerts-sms') && (
                    <div className="sub-card-body">
                      <p className="form-hint"><Clock size={12} /> Sends immediately when a new lead arrives</p>

                      <div className="form-group">
                        <label>Send to (your phone)</label>
                        <input
                          type="tel"
                          value={alertToPhone}
                          onChange={e => setAlertToPhone(e.target.value)}
                          onBlur={() => { if (leadAlertRule && alertToPhone !== leadAlertRule.toPhone) saveAlertToPhone(alertToPhone); }}
                          placeholder="+1234567890"
                        />
                      </div>

                      <div className="form-group">
                        <label>Send from</label>
                        <div className="select-wrapper">
                          <select value={alertFromPhone} onChange={e => saveAlertFromPhone(e.target.value)} disabled={saving}>
                            <option value="">Select phone number</option>
                            {poolPhones.map(p => (
                              <option key={p.id} value={p.phoneNumber}>
                                {p.phoneNumber} (Pool Default)
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        <button className="get-own-number-btn" disabled>
                          <Phone size={14} />
                          Get your own number
                          <span className="coming-soon-badge">Coming Soon</span>
                        </button>
                      </div>

                      {leadAlertRule && (
                        <div className="form-group">
                          <label>Template</label>
                          <div className="select-wrapper">
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
                            >
                              <option value="">Select template</option>
                              {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                              <option value="__create_new__">+ Create New Template</option>
                            </select>
                            <ChevronDown size={16} />
                          </div>
                          {leadAlertRule.messageTemplate && (
                            <div className="template-preview-container">
                              <div className="template-preview">
                                {leadAlertRule.messageTemplate.content}
                              </div>
                              <button
                                className="template-edit-btn"
                                onClick={() => setTemplateEditor({
                                  mode: 'service-edit',
                                  ruleId: leadAlertRule.id,
                                  templateId: leadAlertRule.messageTemplate!.id,
                                  templateName: templates.find(t => t.id === (leadAlertRule.templateId || leadAlertRule.messageTemplate?.id))?.name || 'template',
                                  content: leadAlertRule.messageTemplate!.content,
                                  type: 'alert',
                                })}
                              >
                                <Pencil size={12} /> Edit
                              </button>
                            </div>
                          )}
                        </div>
                      )}

                      {/* Send Test + Trigger Stats */}
                      {leadAlertRule && (
                        <div className="alert-test-section">
                          <button
                            className="btn btn-sm btn-secondary"
                            onClick={sendTestAlert}
                            disabled={testing || saving || !leadAlertRule.toPhone || !alertFromPhone}
                            title={!leadAlertRule.toPhone ? 'Set a destination phone first' : !alertFromPhone ? 'Set a send-from phone first' : 'Send a test SMS'}
                          >
                            {testing ? <Loader2 size={14} className="spinner" /> : <Send size={14} />}
                            Send Test SMS
                          </button>
                          {leadAlertRule.triggerCount > 0 && (
                            <span className="trigger-stats">
                              Triggered {leadAlertRule.triggerCount} time{leadAlertRule.triggerCount !== 1 ? 's' : ''}
                              {leadAlertRule.lastTriggeredAt && (
                                <> — last {new Date(leadAlertRule.lastTriggeredAt).toLocaleDateString()}</>
                              )}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Call Alert — Expandable Sub-Card (Coming Soon) */}
                <div className="sub-card sub-card-coming-soon">
                  <div className="sub-card-header" onClick={() => toggleSubCard('alerts-call')}>
                    <div className="sub-card-title">
                      <PhoneCall size={14} />
                      <span>Call Alert</span>
                      <span className="coming-soon-badge">Coming Soon</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('alerts-call') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('alerts-call') && (
                    <div className="sub-card-body sub-card-disabled">
                      <p className="form-hint">Get a phone call when a new lead arrives. We'll connect you directly to the customer.</p>

                      <div className="form-group">
                        <label>Call to (your phone)</label>
                        <input type="tel" value="" placeholder="+1234567890" disabled />
                      </div>

                      <div className="form-group">
                        <label>Call from</label>
                        <div className="select-wrapper">
                          <select disabled>
                            <option>Select phone number</option>
                            {poolPhones.map(p => (
                              <option key={p.id} value={p.phoneNumber}>
                                {p.phoneNumber} (LeadBridge)
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>
                    </div>
                  )}
                </div>

              </div>
            </ServiceCard>

            {/* 3. Customer Texting */}
            <ServiceCard
              icon={<MessageSquare size={22} />}
              title="Customer Texting"
              description="Send a direct text to customers to increase response rate."
              enabled={customerTextingEnabled}
              onToggle={toggleCustomerTexting}
              saving={saving}
              expanded={expandedCard === 'customer-texting'}
              onExpand={() => toggleExpand('customer-texting')}
              statusText={customerTextingEnabled ? `${customerTextingRules.length} message${customerTextingRules.length !== 1 ? 's' : ''} in sequence` : undefined}
            >
              <div className="service-settings-inner">

                {/* First SMS — Expandable Sub-Card */}
                <div className="sub-card">
                  <div className="sub-card-header" onClick={() => toggleSubCard('texting-first')}>
                    <div className="sub-card-title">
                      <MessageSquare size={14} />
                      <span>First SMS</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('texting-first') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('texting-first') && (
                    <div className="sub-card-body">
                      <p className="form-hint"><Clock size={12} /> Sent immediately when lead arrives</p>
                      <div className="form-group">
                        <label>Send from</label>
                        <div className="select-wrapper">
                          <select value={textingFromPhone} onChange={e => saveTextingFromPhone(e.target.value)} disabled={saving}>
                            <option value="">Select phone number</option>
                            {poolPhones.map(p => (
                              <option key={p.id} value={p.phoneNumber}>
                                {p.phoneNumber} (Pool Default)
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        <button className="get-own-number-btn" disabled>
                          <Phone size={14} />
                          Get your own number
                          <span className="coming-soon-badge">Coming Soon</span>
                        </button>
                      </div>
                      {firstTextingRule && (
                        <div className="form-group">
                          <label>Template</label>
                          <div className="select-wrapper">
                            <select
                              value={firstTextingRule.templateId || firstTextingRule.messageTemplate?.id || ''}
                              onChange={e => {
                                if (e.target.value === '__create_new__') {
                                  setTemplateEditor({ mode: 'create', ruleId: firstTextingRule.id, content: '', type: 'texting' });
                                } else {
                                  changeTextingRuleTemplate(firstTextingRule.id, e.target.value);
                                }
                              }}
                              disabled={saving}
                            >
                              <option value="">Select template</option>
                              {templates.map(t => (
                                <option key={t.id} value={t.id}>{t.name}</option>
                              ))}
                              <option value="__create_new__">+ Create New Template</option>
                            </select>
                            <ChevronDown size={16} />
                          </div>
                          {firstTextingRule.messageTemplate && (
                            <div className="template-preview-container">
                              <div className="template-preview">
                                {firstTextingRule.messageTemplate.content}
                              </div>
                              <button
                                className="template-edit-btn"
                                onClick={() => setTemplateEditor({
                                  mode: 'service-edit',
                                  ruleId: firstTextingRule.id,
                                  templateId: firstTextingRule.messageTemplate!.id,
                                  templateName: templates.find(t => t.id === (firstTextingRule.templateId || firstTextingRule.messageTemplate?.id))?.name || 'template',
                                  content: firstTextingRule.messageTemplate!.content,
                                  type: 'texting',
                                })}
                              >
                                <Pencil size={12} /> Edit
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Follow-Up SMS — Expandable Sub-Card (Coming Soon) */}
                <div className="sub-card sub-card-coming-soon">
                  <div className="sub-card-header" onClick={() => toggleSubCard('texting-followups')}>
                    <div className="sub-card-title">
                      <Clock size={14} />
                      <span>Follow-Up SMS</span>
                      <span className="coming-soon-badge">Coming Soon</span>
                    </div>
                    <ChevronDown size={14} className={expandedSubCards.has('texting-followups') ? 'rotated' : ''} />
                  </div>
                  {expandedSubCards.has('texting-followups') && (
                    <div className="sub-card-body sub-card-disabled">
                      <p className="form-hint">Automated follow-up SMS sent after a delay. Configure timing and templates for each follow-up.</p>

                      <div className="form-group">
                        <label>Send from</label>
                        <div className="select-wrapper">
                          <select value={textingFromPhone} disabled>
                            <option value="">Select phone number</option>
                            {poolPhones.map(p => (
                              <option key={p.id} value={p.phoneNumber}>
                                {p.phoneNumber} (Pool Default)
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        <button className="get-own-number-btn" disabled>
                          <Phone size={14} />
                          Get your own number
                          <span className="coming-soon-badge">Coming Soon</span>
                        </button>
                      </div>

                      {textingFollowUpRules.length === 0 && (
                        <div className="followup-item" style={{ opacity: 0.5 }}>
                          <div className="followup-item-header">
                            <span className="followup-label">Message 2</span>
                          </div>
                          <div className="form-group">
                            <label>Send after</label>
                            <div className="delay-presets">
                              <button className="delay-preset selected" disabled>2 hours</button>
                            </div>
                          </div>
                          <div className="form-group">
                            <label>Template</label>
                            <div className="select-wrapper">
                              <select disabled><option>Select template...</option></select>
                              <ChevronDown size={16} />
                            </div>
                          </div>
                        </div>
                      )}

                      {textingFollowUpRules.map((rule, idx) => (
                        <div key={rule.id} className="followup-item">
                          <div className="followup-item-header">
                            <span className="followup-label">Message {idx + 2}</span>
                          </div>
                          <div className="form-group">
                            <label>Send after</label>
                            <div className="delay-presets">
                              {DELAY_PRESETS.map(preset => (
                                <button
                                  key={preset.minutes}
                                  className={`delay-preset ${(rule.delayMinutes || 120) === preset.minutes ? 'selected' : ''}`}
                                  disabled
                                >
                                  {preset.label}
                                </button>
                              ))}
                              {isCustomDelay(rule.delayMinutes || 120) && (
                                <button className="delay-preset selected" disabled>{rule.delayMinutes} min</button>
                              )}
                            </div>
                          </div>
                          <div className="form-group">
                            <label>Template</label>
                            <div className="select-wrapper">
                              <select value={rule.templateId || rule.messageTemplate?.id || ''} disabled>
                                <option value="">Select template...</option>
                                {templates.map(t => (
                                  <option key={t.id} value={t.id}>{t.name}</option>
                                ))}
                              </select>
                              <ChevronDown size={16} />
                            </div>
                            {rule.messageTemplate && (
                              <div className="template-preview">{rule.messageTemplate.content}</div>
                            )}
                          </div>
                        </div>
                      ))}

                      <button className="add-followup-btn" disabled>
                        <Plus size={16} /> Add Follow-Up
                      </button>

                      {/* Stop Conditions (visible but disabled) */}
                      <div className="stop-conditions">
                        <h4>Stop Conditions</h4>
                        <label className="stop-condition-item">
                          <input type="checkbox" checked={true} disabled />
                          Stop follow-ups if customer replies
                        </label>
                        <label className="stop-condition-item">
                          <input type="checkbox" checked={true} disabled />
                          Stop if lead marked Closed/Won/Lost
                        </label>
                        <label className="stop-condition-item">
                          <input type="checkbox" checked={true} disabled />
                          Stop if customer opts out (STOP)
                        </label>
                      </div>
                    </div>
                  )}
                </div>

              </div>
            </ServiceCard>

            {/* 4. Instant Call Connect */}
            <ServiceCard
              icon={<PhoneCall size={22} />}
              title="Instant Call Connect"
              description="When a new lead arrives, we call you and connect you to the customer instantly."
              enabled={false}
              onToggle={() => {}}
              comingSoon={true}
            />

          </div>
        )}
      </div>

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
