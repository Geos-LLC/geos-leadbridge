import { useState, useEffect, useRef } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2, Loader2, Save, X, Zap, Clock, Play, Pause, ChevronDown, FileText, Phone, Moon, MessageSquare } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { automationApi, thumbtackApi, templatesApi, callConnectApi, notificationsApi } from '../services/api';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import type { AutomationRule, SavedAccount, MessageTemplate, CallConnectMode, AgentStrategy } from '../types';

// Available variables for templates
const TEMPLATE_VARIABLES = [
  { name: '{customerName}', description: 'Full customer name' },
  { name: '{firstName}', description: 'First name only' },
  { name: '{accountName}', description: 'Your business name' },
  { name: '{category}', description: 'Service category or "your project"' },
  { name: '{city}', description: 'Customer city' },
  { name: '{state}', description: 'Customer state' },
];

// Delay options in minutes
const DELAY_OPTIONS = [
  { value: 0, label: 'Immediately' },
  { value: 5, label: '5 minutes' },
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 120, label: '2 hours' },
];

// Module-level cache — survives navigation unmounts
let _autoCache: { rules: AutomationRule[]; accounts: SavedAccount[]; templates: MessageTemplate[] } | null = null;

export function AutomationSettings() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<AutomationRule[]>(_autoCache?.rules ?? []);
  const [accounts, setAccounts] = useState<SavedAccount[]>(_autoCache?.accounts ?? []);
  const [templates, setTemplates] = useState<MessageTemplate[]>(_autoCache?.templates ?? []);
  const [loading, setLoading] = useState(!_autoCache);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Selected account filter
  const [selectedAccountId, setSelectedAccountId] = useState<string | 'all'>('all');

  // Edit/create mode
  const [editingRule, setEditingRule] = useState<AutomationRule | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Form state
  const [formName, setFormName] = useState('');
  const [formAccountId, setFormAccountId] = useState('');
  const [formTriggerType, setFormTriggerType] = useState<'new_lead' | 'customer_reply'>('new_lead');
  const [formReplyMode, setFormReplyMode] = useState<'first_only' | 'every_reply'>('first_only');
  const [formTemplateId, setFormTemplateId] = useState('');
  const [formDelayMinutes, setFormDelayMinutes] = useState(0);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formUseAi, setFormUseAi] = useState(false);
  const [formAiSystemPrompt, setFormAiSystemPrompt] = useState('');
  const [formPromptTemplateId, setFormPromptTemplateId] = useState('');
  const [promptTemplates, setPromptTemplates] = useState<MessageTemplate[]>([]);

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // ── Call Connect settings ──────────────────────────────────────────────────
  const [ccLoading, setCcLoading] = useState(false);
  const [ccSaving, setCcSaving] = useState(false);
  const [ccEnabled, setCcEnabled] = useState(false);
  const [ccExpanded, setCcExpanded] = useState(false);
  const [ccMode, setCcMode] = useState<CallConnectMode>('AGENT_FIRST');
  const [ccAgentStrategy, setCcAgentStrategy] = useState<AgentStrategy>('owner');
  const [ccAgentPhone, setCcAgentPhone] = useState('');
  const [ccMaxAttempts, setCcMaxAttempts] = useState(2);
  const [ccQuietEnabled, setCcQuietEnabled] = useState(false);
  const [ccQuietTimezone, setCcQuietTimezone] = useState('America/New_York');
  const [ccQuietStart, setCcQuietStart] = useState('22:00');
  const [ccQuietEnd, setCcQuietEnd] = useState('08:00');

  // ── Customer Texting settings ─────────────────────────────────────────────
  const [ctLoading, setCtLoading] = useState(false);
  const [ctSaving, setCtSaving] = useState(false);
  const [ctEnabled, setCtEnabled] = useState(false);
  const [ctExpanded, setCtExpanded] = useState(false);
  const [ctAutoReplyTemplate, setCtAutoReplyTemplate] = useState(
    'Hi {{lead.name}}, this is {{account.name}}. We just received your request for {{lead.service}} in {{lead.location}}. When would be a good time to call you?'
  );
  // Quick template creation modal
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);
  const templateContentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    const effectiveAccountId = selectedAccountId !== 'all' ? selectedAccountId : accounts[0]?.id;
    if (effectiveAccountId) {
      loadCcSettings(effectiveAccountId);
      loadCtSettings(effectiveAccountId);
    }
  }, [selectedAccountId, accounts]);

  async function loadData() {
    try {
      if (!_autoCache) setLoading(true);
      setError(null);

      const [rulesRes, accountsRes, templatesRes, promptsRes] = await Promise.all([
        automationApi.getRules(),
        thumbtackApi.getSavedAccounts(),
        templatesApi.getTemplates('message'),
        templatesApi.getTemplates('prompt'),
      ]);

      setRules(rulesRes.rules);
      setAccounts(accountsRes.accounts);
      setTemplates(templatesRes.templates);
      setPromptTemplates(promptsRes.templates);
      _autoCache = { rules: rulesRes.rules, accounts: accountsRes.accounts, templates: templatesRes.templates };

      // Pre-select first account if available
      if (accountsRes.accounts.length > 0 && !formAccountId) {
        setFormAccountId(accountsRes.accounts[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }

  async function loadCcSettings(accountId: string) {
    setCcLoading(true);
    try {
      const res = await callConnectApi.getSettings(accountId);
      if (res.settings) {
        setCcEnabled(res.settings.enabled);
        setCcExpanded(res.settings.enabled);
        setCcMode(res.settings.mode);
        setCcAgentStrategy(res.settings.agentStrategy);
        setCcAgentPhone(res.settings.agentPhoneE164 || '');
        setCcMaxAttempts(res.settings.maxAgentAttempts);
        setCcQuietEnabled(res.settings.quietHoursEnabled);
        setCcQuietTimezone(res.settings.quietHoursTimezone || 'America/New_York');
        setCcQuietStart(res.settings.quietHoursStart || '22:00');
        setCcQuietEnd(res.settings.quietHoursEnd || '08:00');
      } else {
        setCcEnabled(false);
        setCcExpanded(false);
        setCcMode('AGENT_FIRST');
        setCcAgentStrategy('owner');
        setCcAgentPhone('');
        setCcMaxAttempts(2);
        setCcQuietEnabled(false);
        setCcQuietTimezone('America/New_York');
        setCcQuietStart('22:00');
        setCcQuietEnd('08:00');
      }
    } catch {
      // non-fatal
    } finally {
      setCcLoading(false);
    }
  }

  async function saveCcSettings() {
    const effectiveAccountId = selectedAccountId !== 'all' ? selectedAccountId : accounts[0]?.id;
    if (!effectiveAccountId) return;
    setCcSaving(true);
    try {
      await callConnectApi.saveSettings(effectiveAccountId, {
        enabled: ccEnabled,
        mode: ccMode,
        agentStrategy: ccAgentStrategy,
        agentPhoneE164: ccAgentPhone || undefined,
        maxAgentAttempts: ccMaxAttempts,
        quietHoursEnabled: ccQuietEnabled,
        quietHoursTimezone: ccQuietEnabled ? ccQuietTimezone : undefined,
        quietHoursStart: ccQuietEnabled ? ccQuietStart : undefined,
        quietHoursEnd: ccQuietEnabled ? ccQuietEnd : undefined,
      });
      await loadCcSettings(effectiveAccountId);
    } catch {
      setError('Failed to save Instant Call Connect settings');
    } finally {
      setCcSaving(false);
    }
  }


  async function loadCtSettings(accountId: string) {
    setCtLoading(true);
    try {
      const res = await notificationsApi.getCustomerTextingSettings(accountId);
      setCtEnabled(res.enabled);
      setCtExpanded(res.enabled);
      setCtAutoReplyTemplate(res.autoReplyTemplate);
    } catch {
      // non-fatal — keep defaults
    } finally {
      setCtLoading(false);
    }
  }

  async function saveCtSettings() {
    const effectiveAccountId = selectedAccountId !== 'all' ? selectedAccountId : accounts[0]?.id;
    if (!effectiveAccountId) return;
    setCtSaving(true);
    try {
      await notificationsApi.saveCustomerTextingSettings(effectiveAccountId, {
        enabled: ctEnabled,
        autoReplyTemplate: ctAutoReplyTemplate,
      });
    } catch {
      setError('Failed to save Customer Texting settings');
    } finally {
      setCtSaving(false);
    }
  }

  function startCreate() {
    setIsCreating(true);
    setEditingRule(null);
    setFormName('');
    setFormAccountId(accounts[0]?.id || '');
    setFormTriggerType('new_lead');
    setFormReplyMode('first_only');
    setFormTemplateId(templates[0]?.id || '');
    setFormDelayMinutes(0);
    setFormEnabled(true);
    setFormUseAi(false);
    const defaultPrompt = promptTemplates.find(p => p.isDefault) || promptTemplates[0];
    setFormPromptTemplateId(defaultPrompt?.id || '');
    setFormAiSystemPrompt(defaultPrompt?.content || '');
  }

  function startEdit(rule: AutomationRule) {
    setEditingRule(rule);
    setIsCreating(false);
    setFormName(rule.name);
    setFormAccountId(rule.savedAccountId);
    setFormTriggerType(rule.triggerType);
    setFormReplyMode(rule.replyTriggerMode || 'first_only');
    setFormTemplateId(rule.templateId || '');
    setFormDelayMinutes(rule.delayMinutes);
    setFormEnabled(rule.enabled);
    setFormUseAi(rule.useAi ?? false);
    const rulePromptId = rule.promptTemplateId || promptTemplates.find(p => p.isDefault)?.id || '';
    setFormPromptTemplateId(rulePromptId);
    const promptContent = rule.aiSystemPrompt || promptTemplates.find(p => p.id === rulePromptId)?.content || '';
    setFormAiSystemPrompt(promptContent);
  }

  function cancelEdit() {
    setEditingRule(null);
    setIsCreating(false);
  }

  async function handleSave() {
    if (!formName.trim() || !formAccountId) {
      setError('Please fill in all required fields');
      return;
    }
    if (!formUseAi && !formTemplateId) {
      setError('Please select a template or enable AI replies');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (isCreating) {
        const { rule } = await automationApi.createRule({
          savedAccountId: formAccountId,
          name: formName.trim(),
          triggerType: formTriggerType,
          replyTriggerMode: formTriggerType === 'customer_reply' ? formReplyMode : undefined,
          templateId: formUseAi ? undefined : formTemplateId,
          promptTemplateId: formUseAi ? formPromptTemplateId || undefined : undefined,
          delayMinutes: formDelayMinutes,
          enabled: formEnabled,
          useAi: formUseAi,
          aiSystemPrompt: formUseAi ? formAiSystemPrompt : undefined,
        });
        setRules(prev => [rule, ...prev]);
      } else if (editingRule) {
        const { rule } = await automationApi.updateRule(editingRule.id, {
          name: formName.trim(),
          triggerType: formTriggerType,
          replyTriggerMode: formTriggerType === 'customer_reply' ? formReplyMode : undefined,
          templateId: formUseAi ? undefined : formTemplateId,
          promptTemplateId: formUseAi ? formPromptTemplateId || undefined : undefined,
          delayMinutes: formDelayMinutes,
          enabled: formEnabled,
          useAi: formUseAi,
          aiSystemPrompt: formUseAi ? formAiSystemPrompt : undefined,
        });
        setRules(prev => prev.map(r => (r.id === rule.id ? rule : r)));
      }

      cancelEdit();
    } catch (err: any) {
      setError(err.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled(rule: AutomationRule) {
    try {
      const { rule: updatedRule } = await automationApi.updateRule(rule.id, {
        enabled: !rule.enabled,
      });
      setRules(prev => prev.map(r => (r.id === updatedRule.id ? updatedRule : r)));
    } catch (err: any) {
      setError(err.message || 'Failed to toggle rule');
    }
  }

  async function handleDelete(id: string) {
    try {
      setSaving(true);
      await automationApi.deleteRule(id);
      setRules(prev => prev.filter(r => r.id !== id));
      setDeletingId(null);
    } catch (err: any) {
      setError(err.message || 'Failed to delete rule');
    } finally {
      setSaving(false);
    }
  }

  // Filter rules by selected account
  const filteredRules = selectedAccountId === 'all'
    ? rules
    : rules.filter(r => r.savedAccountId === selectedAccountId);

  function getDelayLabel(minutes: number): string {
    const option = DELAY_OPTIONS.find(o => o.value === minutes);
    return option?.label || `${minutes} min`;
  }

  function getTriggerLabel(rule: AutomationRule): string {
    if (rule.triggerType === 'new_lead') {
      return 'New Lead';
    }
    // Note: First customer message is excluded, so "First Reply" means 2nd message
    return rule.replyTriggerMode === 'every_reply' ? 'Every Reply' : 'First Reply';
  }

  function handleTemplateChange(value: string) {
    if (value === '__new__') {
      setShowTemplateModal(true);
    } else {
      setFormTemplateId(value);
    }
  }

  function openTemplateModal() {
    setNewTemplateName('');
    setNewTemplateContent('');
    setShowTemplateModal(true);
  }

  function closeTemplateModal() {
    setShowTemplateModal(false);
    setNewTemplateName('');
    setNewTemplateContent('');
  }

  async function handleCreateTemplate() {
    if (!newTemplateName.trim() || !newTemplateContent.trim()) {
      return;
    }

    try {
      setSavingTemplate(true);
      const { template } = await templatesApi.createTemplate(
        newTemplateName.trim(),
        newTemplateContent.trim(),
      );
      // Add new template to list and select it
      setTemplates(prev => [template, ...prev]);
      setFormTemplateId(template.id);
      closeTemplateModal();
    } catch (err: any) {
      setError(err.message || 'Failed to create template');
    } finally {
      setSavingTemplate(false);
    }
  }

  function insertVariable(variable: string) {
    const textarea = templateContentRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const newContent = newTemplateContent.substring(0, start) + variable + newTemplateContent.substring(end);
      setNewTemplateContent(newContent);
      // Restore focus and set cursor position after the inserted variable
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + variable.length;
      });
    } else {
      // Fallback: append to end if ref not available
      setNewTemplateContent(prev => prev + variable);
    }
  }

  if (loading) {
    return (
      <div className="automation-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Zap size={24} />
            Automations
          </h1>
        </div>
        <div className="loading-container">
          <Loader2 size={32} className="spinner" />
          <p>Loading automations...</p>
        </div>
      </div>
    );
  }

  // Show message if no accounts or templates

  if (templates.length === 0 && !showTemplateModal) {
    return (
      <div className="automation-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Zap size={24} />
            Automations
          </h1>
        </div>
        <div className="empty-state">
          <p>You need to create a message template before setting up automations.</p>
          <button className="btn btn-primary" onClick={openTemplateModal}>
            <Plus size={16} />
            Create Template
          </button>
        </div>

        {/* Quick Template Creation Modal */}
        {showTemplateModal && (
          <div className="modal-overlay" onClick={closeTemplateModal}>
            <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
              <div className="modal-header">
                <h3>
                  <FileText size={20} />
                  Create New Template
                </h3>
                <button className="btn-icon" onClick={closeTemplateModal}>
                  <X size={20} />
                </button>
              </div>

              <div className="modal-body">
                <div className="form-group">
                  <label>Template Name *</label>
                  <input
                    type="text"
                    value={newTemplateName}
                    onChange={e => setNewTemplateName(e.target.value)}
                    placeholder="e.g., Welcome Message"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Message Content *</label>
                  <textarea
                    ref={templateContentRef}
                    value={newTemplateContent}
                    onChange={e => setNewTemplateContent(e.target.value)}
                    placeholder="Hi {firstName}, thanks for reaching out about {category}! I wanted to follow up..."
                    rows={6}
                  />
                  <div className="variable-buttons">
                    {TEMPLATE_VARIABLES.map(v => (
                      <button
                        key={v.name}
                        type="button"
                        className="variable-btn"
                        onClick={() => insertVariable(v.name)}
                        title={v.description}
                      >
                        {v.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="modal-actions">
                <button className="btn btn-secondary" onClick={closeTemplateModal} disabled={savingTemplate}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleCreateTemplate}
                  disabled={savingTemplate || !newTemplateName.trim() || !newTemplateContent.trim()}
                >
                  {savingTemplate ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                  Create Template
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="automation-settings">
      {accounts.length === 0 && <NoAccountsOverlay />}
      <div className="settings-header">
        <button className="btn-icon" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
        </button>
        <h1>
          <Zap size={24} />
          Automations
        </h1>
      </div>

      {error && (
        <div className="error-message">
          <X size={16} />
          {error}
          <button className="btn-icon" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      <div className="settings-content">
        {/* Account Filter - always show */}
        <div className="account-filter">
          <label>Filter by account:</label>
          <div className="select-wrapper">
            <select
              value={selectedAccountId}
              onChange={e => setSelectedAccountId(e.target.value)}
            >
              <option value="all">All Accounts ({accounts.length})</option>
              {accounts.map(acc => (
                <option key={acc.id} value={acc.id}>
                  {acc.businessName}
                </option>
              ))}
            </select>
            <ChevronDown size={16} />
          </div>
          <span className="rules-count">{filteredRules.length} rule{filteredRules.length !== 1 ? 's' : ''}</span>
        </div>

        {/* Rules Section */}
        <div className="rules-section">
          <div className="section-header">
            <h2>Automation Rules</h2>
            {!isCreating && !editingRule && (
              <button className="btn btn-primary" onClick={startCreate}>
                <Plus size={16} />
                Add Rule
              </button>
            )}
          </div>

          {/* Create Form - shown at top only when creating new */}
          {isCreating && (
            <div className="rule-form">
              <div className="form-group">
                <label>Rule Name *</label>
                <input
                  type="text"
                  value={formName}
                  onChange={e => setFormName(e.target.value)}
                  placeholder="e.g., Auto-reply to new leads"
                />
              </div>

              <div className="form-group">
                <label>Account *</label>
                <div className="select-wrapper">
                  <select
                    value={formAccountId}
                    onChange={e => setFormAccountId(e.target.value)}
                  >
                    {accounts.map(acc => (
                      <option key={acc.id} value={acc.id}>
                        {acc.businessName}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
              </div>

              <div className="form-group">
                <label>Trigger *</label>
                <div className="select-wrapper">
                  <select
                    value={formTriggerType}
                    onChange={e => setFormTriggerType(e.target.value as 'new_lead' | 'customer_reply')}
                  >
                    <option value="new_lead">New Lead Received</option>
                    <option value="customer_reply">Customer Replies (excludes first message)</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
              </div>

              {formTriggerType === 'customer_reply' && (
                <div className="form-group">
                  <label>When to trigger</label>
                  <p className="form-hint">The customer's initial message is not counted as a reply.</p>
                  <div className="radio-group">
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="replyMode"
                        checked={formReplyMode === 'first_only'}
                        onChange={() => setFormReplyMode('first_only')}
                      />
                      First reply only
                    </label>
                    <label className="radio-label">
                      <input
                        type="radio"
                        name="replyMode"
                        checked={formReplyMode === 'every_reply'}
                        onChange={() => setFormReplyMode('every_reply')}
                      />
                      Every reply
                    </label>
                  </div>
                </div>
              )}

              {/* AI Toggle */}
              <div className="form-group">
                <label>Reply Type</label>
                <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                  <button
                    type="button"
                    onClick={() => setFormUseAi(false)}
                    style={{
                      flex: 1, padding: '8px', borderRadius: '10px', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                      background: !formUseAi ? '#1d4ed8' : '#f1f5f9',
                      color: !formUseAi ? '#fff' : '#64748b',
                      border: !formUseAi ? '2px solid #1d4ed8' : '2px solid #e2e8f0',
                    }}
                  >
                    📝 Static Template
                  </button>
                  <button
                    type="button"
                    onClick={() => setFormUseAi(true)}
                    style={{
                      flex: 1, padding: '8px', borderRadius: '10px', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                      background: formUseAi ? '#1d4ed8' : '#f1f5f9',
                      color: formUseAi ? '#fff' : '#64748b',
                      border: formUseAi ? '2px solid #1d4ed8' : '2px solid #e2e8f0',
                    }}
                  >
                    ✨ AI Reply
                  </button>
                </div>

                {!formUseAi ? (
                  <>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', display: 'block' }}>Template *</label>
                    <div className="template-select-row">
                      <div className="select-wrapper">
                        <select
                          value={formTemplateId}
                          onChange={e => handleTemplateChange(e.target.value)}
                        >
                          {templates.map(t => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                          <option value="__new__">+ Create New Template</option>
                        </select>
                        <ChevronDown size={16} />
                      </div>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={openTemplateModal}
                        title="Create new template"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                    {formTemplateId && (
                      <div className="template-preview-small">
                        {templates.find(t => t.id === formTemplateId)?.content.substring(0, 100)}...
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px', fontSize: '12px', color: '#1e40af' }}>
                      ✨ AI will read the customer's message and generate a personalized reply using the prompt below.
                    </div>
                    <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', display: 'block' }}>
                      AI Prompt Template
                    </label>
                    <div className="select-wrapper" style={{ marginBottom: '8px' }}>
                      <select
                        value={formPromptTemplateId}
                        onChange={e => {
                          setFormPromptTemplateId(e.target.value);
                          const selected = promptTemplates.find(p => p.id === e.target.value);
                          if (selected) setFormAiSystemPrompt(selected.content);
                        }}
                        style={{ width: '100%', padding: '8px 12px', borderRadius: '10px', border: '1.5px solid #e2e8f0', fontSize: '13px', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#fff' }}
                      >
                        {promptTemplates.map(p => (
                          <option key={p.id} value={p.id}>{p.name}{p.isDefault ? ' (default)' : ''}</option>
                        ))}
                        <option value="">Custom prompt...</option>
                      </select>
                    </div>
                    <textarea
                      rows={4}
                      placeholder="e.g. You are a friendly assistant for a cleaning business..."
                      value={formAiSystemPrompt}
                      onChange={e => { setFormAiSystemPrompt(e.target.value); setFormPromptTemplateId(''); }}
                      style={{ width: '100%', padding: '8px 12px', borderRadius: '10px', border: '1.5px solid #e2e8f0', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                    />
                    <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                      Select a prompt or edit directly. The AI always knows the customer's name, message, service, and location.
                    </p>
                  </>
                )}
              </div>

              <div className="form-group">
                <label>
                  <Clock size={14} />
                  Delay
                </label>
                <div className="select-wrapper">
                  <select
                    value={formDelayMinutes}
                    onChange={e => setFormDelayMinutes(parseInt(e.target.value, 10))}
                  >
                    {DELAY_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <ChevronDown size={16} />
                </div>
              </div>

              <div className="form-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formEnabled}
                    onChange={e => setFormEnabled(e.target.checked)}
                  />
                  Enable this rule
                </label>
              </div>

              <div className="form-actions">
                <button className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleSave}
                  disabled={saving || !formName.trim() || (!formUseAi && !formTemplateId)}
                >
                  {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                  Create Rule
                </button>
              </div>
            </div>
          )}

          {/* Rules List */}
          {filteredRules.length === 0 && !isCreating ? (
            <div className="empty-rules">
              <Zap size={48} className="empty-icon" />
              <p>No automation rules yet.</p>
              <p className="hint">
                Create rules to automatically send messages when new leads arrive or customers reply.
              </p>
            </div>
          ) : (
            <div className="rules-list">
              {filteredRules.map(rule => (
                <div key={rule.id} className="rule-card-wrapper">
                  <div className={`rule-card ${rule.enabled ? 'enabled' : 'disabled'} ${editingRule?.id === rule.id ? 'editing' : ''}`}>
                    <div className="rule-status">
                      <button
                        className={`toggle-btn ${rule.enabled ? 'on' : 'off'}`}
                        onClick={() => toggleEnabled(rule)}
                        title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                      >
                        {rule.enabled ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                    </div>

                    <div className="rule-content">
                      <div className="rule-header">
                        <h3>{rule.name}</h3>
                        <div className="rule-actions">
                          <button
                            className="btn-icon"
                            onClick={() => editingRule?.id === rule.id ? cancelEdit() : startEdit(rule)}
                            title={editingRule?.id === rule.id ? 'Cancel edit' : 'Edit rule'}
                          >
                            {editingRule?.id === rule.id ? <X size={16} /> : <Pencil size={16} />}
                          </button>
                          <button
                            className="btn-icon btn-danger-subtle"
                            onClick={() => setDeletingId(rule.id)}
                            title="Delete rule"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>

                      <div className="rule-details">
                        <span className="rule-account">
                          {rule.savedAccount?.businessName || 'Unknown account'}
                        </span>
                        <span className="rule-trigger">{getTriggerLabel(rule)}</span>
                        <span className="rule-delay">
                          <Clock size={12} />
                          {getDelayLabel(rule.delayMinutes)}
                        </span>
                      </div>

                      <div className="rule-template">
                        {rule.useAi
                          ? <span>✨ <strong>AI Reply</strong> — {rule.promptTemplate?.name || (rule.aiSystemPrompt ? 'Custom prompt' : 'Default prompt')}</span>
                          : <>Template: <strong>{rule.template?.name}</strong></>
                        }
                      </div>

                      {rule.triggerCount > 0 && (
                        <div className="rule-stats">
                          Triggered {rule.triggerCount} time{rule.triggerCount !== 1 ? 's' : ''}
                          {rule.lastTriggeredAt && (
                            <> - Last: {new Date(rule.lastTriggeredAt).toLocaleDateString()}</>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Edit Form - shown beneath the rule being edited */}
                  {editingRule?.id === rule.id && (
                    <div className="rule-form inline-edit">
                      <div className="form-group">
                        <label>Rule Name *</label>
                        <input
                          type="text"
                          value={formName}
                          onChange={e => setFormName(e.target.value)}
                          placeholder="e.g., Auto-reply to new leads"
                        />
                      </div>

                      <div className="form-group">
                        <label>Trigger *</label>
                        <div className="select-wrapper">
                          <select
                            value={formTriggerType}
                            onChange={e => setFormTriggerType(e.target.value as 'new_lead' | 'customer_reply')}
                          >
                            <option value="new_lead">New Lead Received</option>
                            <option value="customer_reply">Customer Replies (excludes first message)</option>
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>

                      {formTriggerType === 'customer_reply' && (
                        <div className="form-group">
                          <label>When to trigger</label>
                          <p className="form-hint">The customer's initial message is not counted as a reply.</p>
                          <div className="radio-group">
                            <label className="radio-label">
                              <input
                                type="radio"
                                name="replyMode"
                                checked={formReplyMode === 'first_only'}
                                onChange={() => setFormReplyMode('first_only')}
                              />
                              First reply only
                            </label>
                            <label className="radio-label">
                              <input
                                type="radio"
                                name="replyMode"
                                checked={formReplyMode === 'every_reply'}
                                onChange={() => setFormReplyMode('every_reply')}
                              />
                              Every reply
                            </label>
                          </div>
                        </div>
                      )}

                      <div className="form-group">
                        <label>Reply Type</label>
                        <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
                          <button
                            type="button"
                            onClick={() => setFormUseAi(false)}
                            style={{
                              flex: 1, padding: '8px', borderRadius: '10px', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                              background: !formUseAi ? '#1d4ed8' : '#f1f5f9',
                              color: !formUseAi ? '#fff' : '#64748b',
                              border: !formUseAi ? '2px solid #1d4ed8' : '2px solid #e2e8f0',
                            }}
                          >
                            📝 Static Template
                          </button>
                          <button
                            type="button"
                            onClick={() => setFormUseAi(true)}
                            style={{
                              flex: 1, padding: '8px', borderRadius: '10px', fontWeight: 600, fontSize: '13px', cursor: 'pointer',
                              background: formUseAi ? '#1d4ed8' : '#f1f5f9',
                              color: formUseAi ? '#fff' : '#64748b',
                              border: formUseAi ? '2px solid #1d4ed8' : '2px solid #e2e8f0',
                            }}
                          >
                            ✨ AI Reply
                          </button>
                        </div>

                        {!formUseAi ? (
                          <>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', display: 'block' }}>Template *</label>
                            <div className="template-select-row">
                              <div className="select-wrapper">
                                <select
                                  value={formTemplateId}
                                  onChange={e => handleTemplateChange(e.target.value)}
                                >
                                  {templates.map(t => (
                                    <option key={t.id} value={t.id}>
                                      {t.name}
                                    </option>
                                  ))}
                                  <option value="__new__">+ Create New Template</option>
                                </select>
                                <ChevronDown size={16} />
                              </div>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={openTemplateModal}
                                title="Create new template"
                              >
                                <Plus size={14} />
                              </button>
                            </div>
                            {formTemplateId && (
                              <div className="template-preview-small">
                                {templates.find(t => t.id === formTemplateId)?.content.substring(0, 100)}...
                              </div>
                            )}
                          </>
                        ) : (
                          <>
                            <div style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: '10px', padding: '10px 12px', marginBottom: '10px', fontSize: '12px', color: '#1e40af' }}>
                              ✨ AI will read the customer's message and generate a personalized reply automatically.
                            </div>
                            <label style={{ fontSize: '12px', fontWeight: 600, color: '#475569', marginBottom: '4px', display: 'block' }}>
                              AI Instructions <span style={{ fontWeight: 400, color: '#94a3b8' }}>(optional)</span>
                            </label>
                            <textarea
                              rows={4}
                              placeholder="e.g. You are a friendly assistant for a cleaning business. Always ask for their availability and confirm the address. Keep responses under 3 sentences."
                              value={formAiSystemPrompt}
                              onChange={e => setFormAiSystemPrompt(e.target.value)}
                              style={{ width: '100%', padding: '8px 12px', borderRadius: '10px', border: '1.5px solid #e2e8f0', fontSize: '13px', resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }}
                            />
                            <p style={{ fontSize: '11px', color: '#94a3b8', marginTop: '4px' }}>
                              Leave blank to use the default prompt. The AI always knows the customer's name, message, service, and location.
                            </p>
                          </>
                        )}
                      </div>

                      <div className="form-group">
                        <label>
                          <Clock size={14} />
                          Delay
                        </label>
                        <div className="select-wrapper">
                          <select
                            value={formDelayMinutes}
                            onChange={e => setFormDelayMinutes(parseInt(e.target.value, 10))}
                          >
                            {DELAY_OPTIONS.map(opt => (
                              <option key={opt.value} value={opt.value}>
                                {opt.label}
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>

                      <div className="form-group checkbox-group">
                        <label className="checkbox-label">
                          <input
                            type="checkbox"
                            checked={formEnabled}
                            onChange={e => setFormEnabled(e.target.checked)}
                          />
                          Enable this rule
                        </label>
                      </div>

                      <div className="form-actions">
                        <button className="btn btn-secondary" onClick={cancelEdit} disabled={saving}>
                          Cancel
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={handleSave}
                          disabled={saving || !formName.trim() || (!formUseAi && !formTemplateId)}
                        >
                          {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                          Save Changes
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ── Customer Texting ──────────────────────────────────────────── */}
        <div className="rules-section" style={{ marginTop: '2rem' }}>
          <div className="section-header">
            <h2>
              <MessageSquare size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Customer Texting
            </h2>
          </div>

          {ctLoading ? (
            <div className="loading-container" style={{ minHeight: 80 }}>
              <Loader2 size={20} className="spinner" />
            </div>
          ) : (
            <div className={`rule-card ${ctEnabled ? 'enabled' : 'disabled'}`} style={{ display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <button
                  className={`toggle-btn ${ctEnabled ? 'on' : 'off'}`}
                  onClick={() => setCtEnabled(e => { const next = !e; if (next) setCtExpanded(true); return next; })}
                  title={ctEnabled ? 'Disable' : 'Enable'}
                  style={{ marginTop: 2, flexShrink: 0 }}
                >
                  {ctEnabled ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div className="rule-header" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setCtExpanded(v => !v)}>
                    <h3>Customer Texting</h3>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={e => { e.stopPropagation(); setCtExpanded(v => !v); }}
                      title={ctExpanded ? 'Collapse' : 'Expand'}
                      style={{ transform: ctExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                    >
                      <ChevronDown size={18} />
                    </button>
                  </div>
                  <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                    Automatically text customers when new leads arrive.
                  </p>

                  {ctExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {/* Auto-reply template */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Auto-Reply Message</label>
                        <p className="form-hint">Sent immediately when a new lead arrives.</p>
                        <textarea
                          value={ctAutoReplyTemplate}
                          onChange={e => setCtAutoReplyTemplate(e.target.value)}
                          rows={3}
                          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', fontSize: 13 }}
                        />
                        <div className="variable-buttons" style={{ marginTop: 6 }}>
                          {TEMPLATE_VARIABLES.map(v => (
                            <button
                              key={v.name}
                              type="button"
                              className="variable-btn"
                              onClick={() => setCtAutoReplyTemplate(prev => prev + v.name)}
                              title={v.description}
                            >
                              {v.name}
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="form-actions" style={{ marginTop: 4 }}>
                        <button
                          className="btn btn-primary"
                          onClick={saveCtSettings}
                          disabled={ctSaving}
                        >
                          {ctSaving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Instant Call Connect ───────────────────────────────────────── */}
        <div className="rules-section" style={{ marginTop: '2rem' }}>
          <div className="section-header">
            <h2>
              <Phone size={18} style={{ marginRight: 6, verticalAlign: 'middle' }} />
              Instant Call Connect
            </h2>
          </div>

          {ccLoading ? (
            <div className="loading-container" style={{ minHeight: 80 }}>
              <Loader2 size={20} className="spinner" />
            </div>
          ) : (
            <div className={`rule-card ${ccEnabled ? 'enabled' : 'disabled'}`} style={{ display: 'block' }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <button
                  className={`toggle-btn ${ccEnabled ? 'on' : 'off'}`}
                  onClick={() => setCcEnabled(e => { const next = !e; if (next) setCcExpanded(true); return next; })}
                  title={ccEnabled ? 'Disable' : 'Enable'}
                  style={{ marginTop: 2, flexShrink: 0 }}
                >
                  {ccEnabled ? <Play size={14} /> : <Pause size={14} />}
                </button>
                <div style={{ flex: 1 }}>
                  <div className="rule-header" style={{ marginBottom: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setCcExpanded(v => !v)}>
                    <h3>Instant Call Connect</h3>
                    <button
                      type="button"
                      className="btn-icon"
                      onClick={e => { e.stopPropagation(); setCcExpanded(v => !v); }}
                      title={ccExpanded ? 'Collapse' : 'Expand'}
                      style={{ transform: ccExpanded ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}
                    >
                      <ChevronDown size={18} />
                    </button>
                  </div>
                  <p style={{ fontSize: 13, color: '#6b7280', marginBottom: 12 }}>
                    When a new lead arrives, automatically call you and connect them to the lead instantly.
                  </p>

                  {ccExpanded && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                      {/* Connection mode */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Connection Mode</label>
                        <div className="radio-group">
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="ccMode"
                              checked={ccMode === 'AGENT_FIRST'}
                              onChange={() => setCcMode('AGENT_FIRST')}
                            />
                            Agent first — we call you, then connect the lead once you answer
                          </label>
                          <label className="radio-label">
                            <input
                              type="radio"
                              name="ccMode"
                              checked={ccMode === 'PARALLEL'}
                              onChange={() => setCcMode('PARALLEL')}
                            />
                            Parallel — call you and the lead simultaneously (fastest)
                          </label>
                        </div>
                      </div>

                      {/* Agent strategy */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Agent Routing</label>
                        <div className="select-wrapper" style={{ maxWidth: 220 }}>
                          <select value={ccAgentStrategy} onChange={e => setCcAgentStrategy(e.target.value as AgentStrategy)}>
                            <option value="owner">Owner</option>
                            <option value="round_robin">Round-robin</option>
                            <option value="on_duty">On duty</option>
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>

                      {/* Agent phone */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Agent Phone (E.164)</label>
                        <input
                          type="tel"
                          value={ccAgentPhone}
                          onChange={e => setCcAgentPhone(e.target.value)}
                          placeholder="+15551234567"
                          style={{ maxWidth: 220 }}
                        />
                        <p className="form-hint">Phone Sigcore will ring when a new lead arrives.</p>
                      </div>

                      {/* Max attempts */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <label>Max agent attempts</label>
                        <div className="select-wrapper" style={{ maxWidth: 120 }}>
                          <select value={ccMaxAttempts} onChange={e => setCcMaxAttempts(Number(e.target.value))}>
                            {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      </div>

                      {/* Quiet hours */}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                          <Moon size={14} />
                          <label style={{ margin: 0 }}>Quiet Hours</label>
                          <button
                            className={`toggle-btn ${ccQuietEnabled ? 'on' : 'off'}`}
                            style={{ transform: 'scale(0.85)', marginLeft: 4 }}
                            onClick={() => setCcQuietEnabled(v => !v)}
                          >
                            {ccQuietEnabled ? <Play size={12} /> : <Pause size={12} />}
                          </button>
                        </div>
                        {ccQuietEnabled && (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <div className="select-wrapper" style={{ maxWidth: 240 }}>
                              <select value={ccQuietTimezone} onChange={e => setCcQuietTimezone(e.target.value)}>
                                {['America/New_York','America/Chicago','America/Denver','America/Los_Angeles','America/Phoenix','America/Anchorage','Pacific/Honolulu'].map(tz => (
                                  <option key={tz} value={tz}>{tz}</option>
                                ))}
                              </select>
                              <ChevronDown size={16} />
                            </div>
                            <div style={{ display: 'flex', gap: 12 }}>
                              <div>
                                <label style={{ fontSize: 12, marginBottom: 4 }}>From</label>
                                <input type="time" value={ccQuietStart} onChange={e => setCcQuietStart(e.target.value)} />
                              </div>
                              <div>
                                <label style={{ fontSize: 12, marginBottom: 4 }}>To</label>
                                <input type="time" value={ccQuietEnd} onChange={e => setCcQuietEnd(e.target.value)} />
                              </div>
                            </div>
                            <p className="form-hint" style={{ marginTop: 0 }}>Calls will not be triggered during quiet hours.</p>
                          </div>
                        )}
                      </div>

                      <div className="form-actions" style={{ marginTop: 4 }}>
                        <button
                          className="btn btn-primary"
                          onClick={saveCcSettings}
                          disabled={ccSaving}
                        >
                          {ccSaving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                          Save
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setDeletingId(null)}>
          <div className="bg-white rounded-3xl p-8 max-w-md w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-2xl font-bold text-slate-900 mb-2">Delete Automation Rule?</h3>
            <p className="text-slate-500 mb-8">
              Are you sure you want to delete this rule? Any pending scheduled messages will be cancelled.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setDeletingId(null)}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(deletingId)}
                disabled={saving}
                className="flex-1 px-6 py-3 bg-red-600 text-white rounded-xl font-semibold hover:bg-red-700 shadow-lg shadow-red-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {saving ? <Loader2 size={16} className="animate-spin" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Quick Template Creation Modal */}
      {showTemplateModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeTemplateModal}>
          <div className="bg-white rounded-3xl p-8 max-w-2xl w-full shadow-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600">
                  <FileText size={20} />
                </div>
                <h3 className="text-2xl font-bold text-slate-900">Create New Template</h3>
              </div>
              <button
                onClick={closeTemplateModal}
                className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-lg transition-all"
              >
                <X size={20} />
              </button>
            </div>

            <div className="space-y-6">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Template Name *</label>
                <input
                  type="text"
                  value={newTemplateName}
                  onChange={e => setNewTemplateName(e.target.value)}
                  placeholder="e.g., Welcome Message"
                  autoFocus
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                />
              </div>

              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Message Content *</label>
                <textarea
                  ref={templateContentRef}
                  value={newTemplateContent}
                  onChange={e => setNewTemplateContent(e.target.value)}
                  placeholder="Hi {firstName}, thanks for reaching out about {category}! I wanted to follow up..."
                  rows={6}
                  className="w-full px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all resize-none font-sans"
                />
                <div className="flex flex-wrap gap-2 mt-3">
                  {TEMPLATE_VARIABLES.map(v => (
                    <button
                      key={v.name}
                      type="button"
                      onClick={() => insertVariable(v.name)}
                      title={v.description}
                      className="px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg text-xs font-mono font-medium border border-blue-100 hover:bg-blue-100 transition-all"
                    >
                      {v.name}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex gap-3 mt-8 pt-6 border-t border-slate-100">
              <button
                onClick={closeTemplateModal}
                disabled={savingTemplate}
                className="flex-1 px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTemplate}
                disabled={savingTemplate || !newTemplateName.trim() || !newTemplateContent.trim()}
                className="flex-1 px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {savingTemplate ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                Create Template
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
