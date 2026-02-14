import { useState, useEffect } from 'react';
import {
  Loader2, ChevronDown, MessageSquare, Bell, PhoneCall,
  Zap, Briefcase, AlertCircle, CheckCircle, X, Clock,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import {
  automationApi, notificationsApi, thumbtackApi, templatesApi, usersApi,
} from '../services/api';
import type {
  AutomationRule, NotificationRule, SavedAccount, MessageTemplate,
} from '../types';

// Platform template variables (for auto-reply)
const PLATFORM_VARIABLES = [
  { name: '{customerName}', desc: 'Full customer name' },
  { name: '{firstName}', desc: 'First name only' },
  { name: '{category}', desc: 'Service category' },
  { name: '{city}', desc: 'Customer city' },
  { name: '{state}', desc: 'Customer state' },
];

// SMS template variables (for lead alerts + customer texting)
const SMS_VARIABLES = [
  { name: '{{lead.name}}', desc: 'Customer name' },
  { name: '{{lead.phone}}', desc: 'Customer phone' },
  { name: '{{lead.service}}', desc: 'Service category' },
  { name: '{{lead.location}}', desc: 'City, State' },
  { name: '{{lead.zip}}', desc: 'ZIP code' },
  { name: '{{lead.message}}', desc: 'Lead message' },
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

  // Service rules (derived from backend)
  const [autoReplyRule, setAutoReplyRule] = useState<AutomationRule | null>(null);
  const [autoReplyFollowUp, setAutoReplyFollowUp] = useState<AutomationRule | null>(null);
  const [leadAlertRule, setLeadAlertRule] = useState<NotificationRule | null>(null);
  const [customerTextingRule, setCustomerTextingRule] = useState<NotificationRule | null>(null);

  // Supporting data
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [poolPhones, setPoolPhones] = useState<{ id: string; phoneNumber: string; provider: string; friendlyName: string | null; assigned: boolean }[]>([]);

  // UI state
  const [expandedCard, setExpandedCard] = useState<string | null>(null);

  // Lead Alerts form state (needed for first-time creation)
  const [alertToPhone, setAlertToPhone] = useState('');
  const [alertFromPhone, setAlertFromPhone] = useState('');
  const [alertTemplate, setAlertTemplate] = useState('New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}');

  // Customer Texting form state
  const [textingFromPhone, setTextingFromPhone] = useState('');
  const [textingTemplate, setTextingTemplate] = useState('Hi {{lead.name}}, thanks for your interest in {{lead.service}}! We received your request and will reach out shortly.');

  // Auto Reply template editing
  const [autoReplyTemplateContent, setAutoReplyTemplateContent] = useState('');
  const [editingAutoReplyTemplate, setEditingAutoReplyTemplate] = useState(false);

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

      // Find Auto Reply rules
      const autoReply = automationRes.rules.find(
        (r: AutomationRule) => r.triggerType === 'new_lead' && (r.delayMinutes === 0 || !r.delayMinutes)
      ) || null;
      const followUp = automationRes.rules.find(
        (r: AutomationRule) => r.triggerType === 'new_lead' && r.delayMinutes && r.delayMinutes > 0 && r.id !== autoReply?.id
      ) || null;

      // Find notification rules by sendToCustomer flag
      const leadAlert = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && !r.sendToCustomer
      ) || null;
      const customerTexting = notifRes.rules.find(
        (r: NotificationRule) => r.triggerType === 'new_lead' && r.sendToCustomer === true
      ) || null;

      setAutoReplyRule(autoReply);
      setAutoReplyFollowUp(followUp);
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
      if (autoReply?.template) {
        const tpl = templatesRes.templates.find((t: MessageTemplate) => t.id === autoReply.templateId);
        if (tpl) setAutoReplyTemplateContent(tpl.content);
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
      if (autoReplyRule) {
        // Toggle existing rules
        const { rule } = await automationApi.updateRule(autoReplyRule.id, { enabled });
        setAutoReplyRule(rule);
        if (autoReplyFollowUp) {
          const { rule: fu } = await automationApi.updateRule(autoReplyFollowUp.id, { enabled });
          setAutoReplyFollowUp(fu);
        }
        showSuccess(enabled ? 'Auto Reply enabled' : 'Auto Reply disabled');
      } else if (enabled) {
        // Create default template + rules
        let templateId = templates.find(t => t.name.includes('Auto Reply'))?.id;
        if (!templateId) {
          const { template } = await templatesApi.createTemplate(
            'Auto Reply - Welcome',
            'Hi {firstName}, thanks for reaching out about {category}! I\'d love to help. Let me review your request and get back to you shortly.',
          );
          templateId = template.id;
          setTemplates(prev => [template, ...prev]);
          setAutoReplyTemplateContent(template.content);
        }

        const { rule } = await automationApi.createRule({
          savedAccountId: selectedAccountId,
          name: 'Auto Reply - Immediate',
          triggerType: 'new_lead',
          templateId,
          delayMinutes: 0,
          enabled: true,
        });
        setAutoReplyRule(rule);

        // Create follow-up at 2 hours
        let followUpTemplateId = templates.find(t => t.name.includes('Follow Up'))?.id;
        if (!followUpTemplateId) {
          const { template } = await templatesApi.createTemplate(
            'Auto Reply - Follow Up',
            'Hi {firstName}, just checking in on your {category} request. I\'m available whenever works for you!',
          );
          followUpTemplateId = template.id;
          setTemplates(prev => [template, ...prev]);
        }

        const { rule: fuRule } = await automationApi.createRule({
          savedAccountId: selectedAccountId,
          name: 'Auto Reply - 2hr Follow Up',
          triggerType: 'new_lead',
          templateId: followUpTemplateId,
          delayMinutes: 120,
          enabled: true,
        });
        setAutoReplyFollowUp(fuRule);
        showSuccess('Auto Reply enabled with immediate reply + 2hr follow-up');
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

  // --- Save Settings Handlers ---

  async function saveAutoReplyTemplate() {
    if (!autoReplyRule?.templateId || !autoReplyTemplateContent.trim()) return;
    setSaving(true);
    try {
      await templatesApi.updateTemplate(autoReplyRule.templateId, { content: autoReplyTemplateContent });
      setEditingAutoReplyTemplate(false);
      showSuccess('Template saved');
    } catch (err: any) {
      setError(err.message || 'Failed to save template');
    } finally {
      setSaving(false);
    }
  }

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

            {/* 1. Auto Reply */}
            <ServiceCard
              icon={<Zap size={22} />}
              title="Auto Reply"
              description="Automatically respond to new leads on Thumbtack instantly."
              enabled={autoReplyRule?.enabled ?? false}
              onToggle={toggleAutoReply}
              saving={saving}
              expanded={expandedCard === 'auto-reply'}
              onExpand={() => toggleExpand('auto-reply')}
              statusText={autoReplyRule?.enabled ? `Immediate reply${autoReplyFollowUp?.enabled ? ' + 2hr follow-up' : ''}` : undefined}
            >
              <div className="service-settings-inner">
                <p className="form-hint">
                  Sends first reply immediately. Follow-up sent after 2 hours if no response.
                </p>

                {autoReplyRule && (
                  <div className="form-group">
                    <label>Message Template</label>
                    {editingAutoReplyTemplate ? (
                      <>
                        <textarea
                          rows={4}
                          value={autoReplyTemplateContent}
                          onChange={e => setAutoReplyTemplateContent(e.target.value)}
                          placeholder="Enter your auto-reply message..."
                        />
                        <div className="variable-buttons">
                          {PLATFORM_VARIABLES.map(v => (
                            <button
                              key={v.name}
                              className="variable-btn"
                              onClick={() => insertVariable(v.name, setAutoReplyTemplateContent)}
                              title={v.desc}
                            >
                              {v.name}
                            </button>
                          ))}
                        </div>
                        <div className="form-actions">
                          <button className="btn btn-secondary btn-sm" onClick={() => setEditingAutoReplyTemplate(false)}>
                            Cancel
                          </button>
                          <button className="btn btn-primary btn-sm" onClick={saveAutoReplyTemplate} disabled={saving}>
                            {saving ? <Loader2 size={14} className="spinner" /> : null}
                            Save Template
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="template-preview">
                          {autoReplyTemplateContent || 'No template set'}
                        </div>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingAutoReplyTemplate(true)}>
                          Edit Message Template
                        </button>
                      </>
                    )}
                  </div>
                )}
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
