import { useState, useEffect } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, CheckCircle, X, Clock,
  Plus, Trash2, Bot,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, usersApi,
} from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
} from '../types';

// Delay presets for follow-up messages
const DELAY_PRESETS = [
  { label: '1 hour', minutes: 60 },
  { label: '2 hours', minutes: 120 },
  { label: '6 hours', minutes: 360 },
  { label: '24 hours', minutes: 1440 },
];

// SMS template variables (for lead alerts + customer texting)
const SMS_VARIABLES = [
  { name: '{{lead.name}}', desc: 'Customer name' },
  { name: '{{lead.phone}}', desc: 'Customer phone' },
  { name: '{{lead.service}}', desc: 'Service category' },
  { name: '{{lead.location}}', desc: 'City, State' },
  { name: '{{lead.zip}}', desc: 'ZIP code' },
  { name: '{{lead.message}}', desc: 'Customer request message' },
  { name: '{{lead.serviceDescription}}', desc: 'Detailed service description' },
  { name: '{{lead.addons}}', desc: 'Service add-ons' },
  { name: '{{lead.frequency}}', desc: 'Service frequency' },
  { name: '{{lead.bedrooms}}', desc: 'Number of bedrooms' },
  { name: '{{lead.bathrooms}}', desc: 'Number of bathrooms' },
  { name: '{{lead.price}}', desc: 'Lead price/cost' },
  { name: '{{lead.pets}}', desc: 'Pet information' },
  { name: '{{lead.estimate}}', desc: 'Estimated cost/quote' },
  { name: '{{lead.dates}}', desc: 'Requested date/schedule' },
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

  // Auto Reply rules (dynamic array of all new_lead automation rules)
  const [autoReplyRules, setAutoReplyRules] = useState<AutomationRule[]>([]);
  const autoReplyEnabled = autoReplyRules.some(r => r.enabled);
  const firstReplyRule = autoReplyRules.find(r => r.delayMinutes === 0 || !r.delayMinutes) || null;
  const followUpRules = autoReplyRules
    .filter(r => r.delayMinutes > 0)
    .sort((a, b) => a.delayMinutes - b.delayMinutes);

  // Other service rules
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);
  const [customerTextingRule, setCustomerTextingRule] = useState<NotificationRule | null>(null);

  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [poolPhones, setPoolPhones] = useState<{ id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[]>([]);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);
  const [aiMode, setAiMode] = useState(false);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState('');
  const [alertFromPhone, setAlertFromPhone] = useState('');
  const [alertTemplate, setAlertTemplate] = useState('New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}');

  // Customer Texting form state
  const [textingFromPhone, setTextingFromPhone] = useState('');
  const [textingTemplate, setTextingTemplate] = useState('Hi {{lead.name}}, thanks for your interest in {{lead.service}}! We received your request and will reach out shortly.');

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

      // Find notification rules by sendToCustomer flag
      const leadAlert = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && !r.sendToCustomer
      ) || null;
      const customerTexting = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && r.sendToCustomer === true
      ) || null;

      setLeadAlertRule(leadAlert);
      setCustomerTextingRule(customerTexting);
      setTemplates(templatesRes.templates);
      setPoolPhones(poolRes.phoneNumbers);

      // Pre-fill form states from existing rules
      if (leadAlert) {
        setAlertToPhone(leadAlert.toPhone || '');
        setAlertFromPhone(leadAlert.fromPhone || '');
        setAlertTemplate(leadAlert.template || alertTemplate);
      }
      if (customerTexting) {
        setTextingFromPhone(customerTexting.fromPhone || '');
        setTextingTemplate(customerTexting.template || textingTemplate);
      }

      // Default from phone to first pool phone
      const defaultFrom = poolRes.phoneNumbers[0]?.phoneNumber || '';
      if (!leadAlert) setAlertFromPhone(defaultFrom);
      if (!customerTexting) setTextingFromPhone(defaultFrom);

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
        if (!alertToPhone) {
          setExpandedCard('lead-alerts');
          setError('Please enter a destination phone number first');
          setSaving(false);
          return;
        }
        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Lead Alert - SMS',
          triggerType: 'new_lead',
          fromPhone: alertFromPhone,
          toPhone: alertToPhone,
          sendToCustomer: false,
          template: alertTemplate,
          enabled: true,
        });
        setLeadAlertRule(rule);
        showSuccess('Lead Alerts enabled');
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
      if (customerTextingRule) {
        const { rule } = await notificationsApi.updateRule(selectedAccountId, customerTextingRule.id, { enabled });
        setCustomerTextingRule(rule);
        showSuccess(enabled ? 'Customer Texting enabled' : 'Customer Texting disabled');
      } else if (enabled) {
        if (!textingFromPhone) {
          setExpandedCard('customer-texting');
          setError('No phone numbers available. Please configure phone settings first.');
          setSaving(false);
          return;
        }
        const { rule } = await notificationsApi.createRule(selectedAccountId, {
          name: 'Customer SMS Follow-Up',
          triggerType: 'new_lead',
          fromPhone: textingFromPhone,
          toPhone: '',
          sendToCustomer: true,
          template: textingTemplate,
          enabled: true,
        });
        setCustomerTextingRule(rule);
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

  async function changeFollowUpDelay(ruleId: string, delayMinutes: number) {
    setSaving(true);
    try {
      const { rule } = await automationApi.updateRule(ruleId, { delayMinutes });
      setAutoReplyRules(prev => prev.map(r => r.id === ruleId ? rule : r));
    } catch (err: any) {
      setError(err.message || 'Failed to update delay');
    } finally {
      setSaving(false);
    }
  }

  async function addFollowUp() {
    setSaving(true);
    try {
      // Find or create a default follow-up template
      let templateId = templates.find(t => t.name.includes('Follow Up'))?.id;
      if (!templateId) {
        const { template } = await templatesApi.createTemplate(
          'Auto Reply - Follow Up',
          'Hi {firstName}, just checking in on your {category} request. I\'m available whenever works for you!',
        );
        templateId = template.id;
        setTemplates(prev => [template, ...prev]);
      }

      const followUpNum = followUpRules.length + 1;
      const { rule } = await automationApi.createRule({
        savedAccountId: selectedAccountId,
        name: `Follow-Up ${followUpNum}`,
        triggerType: 'new_lead',
        templateId,
        delayMinutes: 120,
        enabled: true,
      });
      setAutoReplyRules(prev => [...prev, rule]);
      showSuccess('Follow-up added');
    } catch (err: any) {
      setError(err.message || 'Failed to add follow-up');
    } finally {
      setSaving(false);
    }
  }

  async function deleteFollowUp(ruleId: string) {
    setSaving(true);
    try {
      await automationApi.deleteRule(ruleId);
      setAutoReplyRules(prev => prev.filter(r => r.id !== ruleId));
      showSuccess('Follow-up removed');
    } catch (err: any) {
      setError(err.message || 'Failed to delete follow-up');
    } finally {
      setSaving(false);
    }
  }

  // --- Save Settings Handlers ---

  async function saveLeadAlertSettings() {
    if (!leadAlertRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, leadAlertRule.id, {
        fromPhone: alertFromPhone,
        toPhone: alertToPhone,
        template: alertTemplate,
      });
      setLeadAlertRule(rule);
      showSuccess('Lead Alert settings saved');
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function saveCustomerTextingSettings() {
    if (!customerTextingRule) return;
    setSaving(true);
    try {
      const { rule } = await notificationsApi.updateRule(selectedAccountId, customerTextingRule.id, {
        fromPhone: textingFromPhone,
        template: textingTemplate,
      });
      setCustomerTextingRule(rule);
      showSuccess('Customer Texting settings saved');
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  function insertVariable(variable: string, setter: React.Dispatch<React.SetStateAction<string>>) {
    setter(prev => prev + variable);
  }

  function toggleExpand(card: string) {
    setExpandedCard(expandedCard === card ? null : card);
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
              <div className={`service-settings-inner ${aiMode ? 'ai-disabled' : ''}`}>
                {/* AI Optimization Banner */}
                <div className={`ai-optimization-banner ${aiMode ? 'active' : ''}`}>
                  <div className="ai-banner-info">
                    <Bot size={18} />
                    <div>
                      <strong>AI Optimization</strong>
                      <span className="pro-badge">Pro</span>
                      <p className="form-hint">AI decides timing, follow-ups, and message variations to maximize response.</p>
                    </div>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={aiMode}
                      onChange={e => setAiMode(e.target.checked)}
                    />
                    <span className="toggle-slider"></span>
                  </label>
                </div>

                {aiMode && (
                  <div className="ai-overlay-note">
                    AI is controlling this sequence.
                  </div>
                )}

                {/* First Message Section */}
                <div className="auto-reply-section first-message-section">
                  <h4><Zap size={14} /> First Message</h4>
                  <p className="form-hint">Sent immediately when a new lead arrives.</p>

                  {firstReplyRule && (
                    <div className="form-group">
                      <label>Template</label>
                      <div className="select-wrapper">
                        <select
                          value={firstReplyRule.templateId || ''}
                          onChange={e => changeRuleTemplate(firstReplyRule.id, e.target.value)}
                          disabled={aiMode || saving}
                        >
                          <option value="">Select template...</option>
                          {templates.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                        <ChevronDown size={16} />
                      </div>
                      {firstReplyRule.template?.content && (
                        <div className="template-preview">
                          {firstReplyRule.template.content}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Follow-Up Messages Section */}
                <div className="auto-reply-section followup-section">
                  <h4><Clock size={14} /> Follow-Up Messages</h4>

                  {followUpRules.length === 0 && (
                    <p className="form-hint" style={{ fontStyle: 'italic' }}>
                      No follow-ups yet. Add one below.
                    </p>
                  )}

                  {followUpRules.map((rule, idx) => (
                    <div key={rule.id} className="followup-item">
                      <div className="followup-item-header">
                        <span className="followup-label">Message {idx + 2}</span>
                        <button
                          className="btn-icon btn-delete-followup"
                          onClick={() => deleteFollowUp(rule.id)}
                          disabled={aiMode || saving}
                          title="Delete follow-up"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>

                      <div className="form-group">
                        <label>Send after</label>
                        <div className="delay-presets">
                          {DELAY_PRESETS.map(preset => (
                            <button
                              key={preset.minutes}
                              className={`delay-preset ${rule.delayMinutes === preset.minutes ? 'selected' : ''}`}
                              onClick={() => changeFollowUpDelay(rule.id, preset.minutes)}
                              disabled={aiMode || saving}
                            >
                              {preset.label}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="form-group">
                        <label>Template</label>
                        <div className="select-wrapper">
                          <select
                            value={rule.templateId || ''}
                            onChange={e => changeRuleTemplate(rule.id, e.target.value)}
                            disabled={aiMode || saving}
                          >
                            <option value="">Select template...</option>
                            {templates.map(t => (
                              <option key={t.id} value={t.id}>{t.name}</option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        {rule.template?.content && (
                          <div className="template-preview">
                            {rule.template.content}
                          </div>
                        )}
                      </div>
                    </div>
                  ))}

                  <button
                    className="add-followup-btn"
                    onClick={addFollowUp}
                    disabled={aiMode || saving}
                  >
                    <Plus size={16} />
                    Add Follow-Up
                  </button>
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
                <div className="alert-options">
                  <div className="alert-option">
                    <CheckCircle size={16} className="status-icon success" />
                    <span>SMS Alert</span>
                    <span className="badge-success" style={{ marginLeft: 'auto', padding: '2px 8px', borderRadius: '10px', fontSize: '11px' }}>Active</span>
                  </div>
                  <div className="alert-option disabled-option">
                    <Clock size={16} />
                    <span>Call Alert</span>
                    <span className="coming-soon-badge" style={{ marginLeft: 'auto' }}>Coming Soon</span>
                  </div>
                </div>

                <div className="form-group">
                  <label>Send alerts to (your phone)</label>
                  <input
                    type="tel"
                    value={alertToPhone}
                    onChange={e => setAlertToPhone(e.target.value)}
                    placeholder="+1234567890"
                  />
                </div>

                <div className="form-group">
                  <label>Send from</label>
                  <div className="select-wrapper">
                    <select value={alertFromPhone} onChange={e => setAlertFromPhone(e.target.value)}>
                      <option value="">Select phone number</option>
                      {poolPhones.map(p => (
                        <option key={p.id} value={p.phoneNumber}>
                          {p.phoneNumber} ({p.provider}){p.assigned ? ' - assigned' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </div>
                </div>

                <div className="form-group">
                  <label>SMS Template</label>
                  <textarea
                    rows={3}
                    value={alertTemplate}
                    onChange={e => setAlertTemplate(e.target.value)}
                    placeholder="Enter alert message..."
                  />
                  <div className="variable-buttons">
                    {SMS_VARIABLES.map(v => (
                      <button
                        key={v.name}
                        className="variable-btn"
                        onClick={() => insertVariable(v.name, setAlertTemplate)}
                        title={v.desc}
                      >
                        {v.name}
                      </button>
                    ))}
                  </div>
                </div>

                {leadAlertRule && (
                  <div className="form-actions">
                    <button className="btn btn-primary btn-sm" onClick={saveLeadAlertSettings} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : null}
                      Save Settings
                    </button>
                  </div>
                )}
              </div>
            </ServiceCard>

            {/* 3. Customer Texting */}
            <ServiceCard
              icon={<MessageSquare size={22} />}
              title="Customer Texting"
              description="Send a direct text to customers to increase response rate."
              enabled={customerTextingRule?.enabled ?? false}
              onToggle={toggleCustomerTexting}
              saving={saving}
              expanded={expandedCard === 'customer-texting'}
              onExpand={() => toggleExpand('customer-texting')}
              statusText={customerTextingRule?.enabled ? 'SMS sent to customer on new lead' : undefined}
            >
              <div className="service-settings-inner">
                <p className="form-hint">
                  When a new lead arrives, an SMS is sent directly to the customer's phone number from the lead.
                </p>

                <div className="form-group">
                  <label>Send from</label>
                  <div className="select-wrapper">
                    <select value={textingFromPhone} onChange={e => setTextingFromPhone(e.target.value)}>
                      <option value="">Select phone number</option>
                      {poolPhones.map(p => (
                        <option key={p.id} value={p.phoneNumber}>
                          {p.phoneNumber} ({p.provider}){p.assigned ? ' - assigned' : ''}
                        </option>
                      ))}
                    </select>
                    <ChevronDown size={16} />
                  </div>
                </div>

                <div className="form-group">
                  <label>SMS Template</label>
                  <textarea
                    rows={3}
                    value={textingTemplate}
                    onChange={e => setTextingTemplate(e.target.value)}
                    placeholder="Enter message to customer..."
                  />
                  <div className="variable-buttons">
                    {SMS_VARIABLES.map(v => (
                      <button
                        key={v.name}
                        className="variable-btn"
                        onClick={() => insertVariable(v.name, setTextingTemplate)}
                        title={v.desc}
                      >
                        {v.name}
                      </button>
                    ))}
                  </div>
                </div>

                {customerTextingRule && (
                  <div className="form-actions">
                    <button className="btn btn-primary btn-sm" onClick={saveCustomerTextingSettings} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : null}
                      Save Settings
                    </button>
                  </div>
                )}
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
    </div>
  );
}
