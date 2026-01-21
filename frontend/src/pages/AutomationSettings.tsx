import { useState, useEffect } from 'react';
import { ArrowLeft, Plus, Pencil, Trash2, Loader2, Save, X, Zap, Clock, Play, Pause, ChevronDown, FileText } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { automationApi, thumbtackApi, templatesApi } from '../services/api';
import type { AutomationRule, SavedAccount, MessageTemplate } from '../types';

// Available variables for templates
const TEMPLATE_VARIABLES = [
  { name: '{customerName}', description: 'Full customer name' },
  { name: '{firstName}', description: 'First name only' },
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

export function AutomationSettings() {
  const navigate = useNavigate();
  const [rules, setRules] = useState<AutomationRule[]>([]);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
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

  // Delete confirmation
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Quick template creation modal
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [newTemplateName, setNewTemplateName] = useState('');
  const [newTemplateContent, setNewTemplateContent] = useState('');
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    try {
      setLoading(true);
      setError(null);

      const [rulesRes, accountsRes, templatesRes] = await Promise.all([
        automationApi.getRules(),
        thumbtackApi.getSavedAccounts(),
        templatesApi.getTemplates(),
      ]);

      setRules(rulesRes.rules);
      setAccounts(accountsRes.accounts);
      setTemplates(templatesRes.templates);

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
  }

  function startEdit(rule: AutomationRule) {
    setEditingRule(rule);
    setIsCreating(false);
    setFormName(rule.name);
    setFormAccountId(rule.savedAccountId);
    setFormTriggerType(rule.triggerType);
    setFormReplyMode(rule.replyTriggerMode || 'first_only');
    setFormTemplateId(rule.templateId);
    setFormDelayMinutes(rule.delayMinutes);
    setFormEnabled(rule.enabled);
  }

  function cancelEdit() {
    setEditingRule(null);
    setIsCreating(false);
  }

  async function handleSave() {
    if (!formName.trim() || !formAccountId || !formTemplateId) {
      setError('Please fill in all required fields');
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
          templateId: formTemplateId,
          delayMinutes: formDelayMinutes,
          enabled: formEnabled,
        });
        setRules(prev => [rule, ...prev]);
      } else if (editingRule) {
        const { rule } = await automationApi.updateRule(editingRule.id, {
          name: formName.trim(),
          triggerType: formTriggerType,
          replyTriggerMode: formTriggerType === 'customer_reply' ? formReplyMode : undefined,
          templateId: formTemplateId,
          delayMinutes: formDelayMinutes,
          enabled: formEnabled,
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
    return rule.replyTriggerMode === 'every_reply' ? 'Every Customer Reply' : 'First Customer Reply';
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
    setNewTemplateContent(prev => prev + variable);
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
  if (accounts.length === 0) {
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
          <p>You need to connect a Thumbtack account before creating automations.</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

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
        {/* Account Filter */}
        {accounts.length > 1 && (
          <div className="account-filter">
            <label>Filter by account:</label>
            <div className="select-wrapper">
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
              >
                <option value="all">All Accounts</option>
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.businessName}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} />
            </div>
          </div>
        )}

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

          {/* Create/Edit Form */}
          {(isCreating || editingRule) && (
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

              {isCreating && (
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
              )}

              <div className="form-group">
                <label>Trigger *</label>
                <div className="select-wrapper">
                  <select
                    value={formTriggerType}
                    onChange={e => setFormTriggerType(e.target.value as 'new_lead' | 'customer_reply')}
                  >
                    <option value="new_lead">New Lead Received</option>
                    <option value="customer_reply">Customer Replies</option>
                  </select>
                  <ChevronDown size={16} />
                </div>
              </div>

              {formTriggerType === 'customer_reply' && (
                <div className="form-group">
                  <label>When to trigger</label>
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
                <label>Template *</label>
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
                  disabled={saving || !formName.trim() || !formTemplateId}
                >
                  {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                  {isCreating ? 'Create Rule' : 'Save Changes'}
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
                <div
                  key={rule.id}
                  className={`rule-card ${rule.enabled ? 'enabled' : 'disabled'}`}
                >
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
                          onClick={() => startEdit(rule)}
                          title="Edit rule"
                        >
                          <Pencil size={16} />
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
                      Template: <strong>{rule.template?.name}</strong>
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
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {deletingId && (
        <div className="modal-overlay" onClick={() => setDeletingId(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h3>Delete Automation Rule?</h3>
            <p>
              Are you sure you want to delete this rule? Any pending scheduled messages will be cancelled.
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDeletingId(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => handleDelete(deletingId)}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spinner" /> : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}

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
