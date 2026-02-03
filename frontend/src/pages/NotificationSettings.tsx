import { useState, useEffect } from 'react';
import { ArrowLeft, Bell, Loader2, X, ChevronDown, Send, Phone, MessageSquare, AlertCircle, CheckCircle, Plus, Edit2, Trash2, Zap, Save } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, thumbtackApi, type CallioPhoneNumber, type CreateNotificationRuleDto, type UpdateNotificationRuleDto } from '../services/api';
import type { NotificationRule, NotificationLog, SavedAccount } from '../types';

// Available variables for SMS template
const TEMPLATE_VARIABLES = [
  { name: '{{lead.name}}', description: 'Customer name' },
  { name: '{{lead.phone}}', description: 'Customer phone' },
  { name: '{{lead.service}}', description: 'Service category' },
  { name: '{{lead.location}}', description: 'City, State' },
  { name: '{{lead.zip}}', description: 'Zip code' },
  { name: '{{lead.message}}', description: 'Customer request message' },
  { name: '{{lead.serviceDescription}}', description: 'Detailed service description' },
  { name: '{{lead.addons}}', description: 'Service add-ons' },
  { name: '{{lead.frequency}}', description: 'Service frequency' },
];

export function NotificationSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('all');
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Phone numbers for each account (for the rule form)
  const [accountPhoneNumbers, setAccountPhoneNumbers] = useState<Record<string, CallioPhoneNumber[]>>({});
  const [loadingPhoneNumbers, setLoadingPhoneNumbers] = useState<Record<string, boolean>>({});

  // Track which accounts have Callio configured
  const [accountCallioStatus, setAccountCallioStatus] = useState<Record<string, boolean>>({});

  // Notification logs
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);

  // Rule editing state
  const [isCreatingRule, setIsCreatingRule] = useState(false);
  const [editingRule, setEditingRule] = useState<NotificationRule | null>(null);
  const [ruleForm, setRuleForm] = useState({
    accountId: '',
    name: '',
    triggerType: 'new_lead' as 'new_lead' | 'customer_reply',
    replyTriggerMode: 'first_only' as 'first_only' | 'every_reply',
    fromPhone: '',
    toPhone: '',
    template: 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
    enabled: true,
  });

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    // Close any open edit/create forms when changing account filter
    setIsCreatingRule(false);
    setEditingRule(null);

    if (selectedAccountId === 'all') {
      loadAllRules();
      loadAllLogs();
    } else if (selectedAccountId) {
      loadRulesForAccount(selectedAccountId);
      loadLogs(selectedAccountId);
    }
  }, [selectedAccountId]);

  // Load phone numbers when rule form account changes
  useEffect(() => {
    if (ruleForm.accountId && !accountPhoneNumbers[ruleForm.accountId]) {
      loadPhoneNumbersForAccount(ruleForm.accountId);
    }
  }, [ruleForm.accountId]);

  async function loadAccounts() {
    try {
      setLoading(true);
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setAccounts(accounts);
      setSelectedAccountId('all');
      loadAllRules();
      // Check Callio status for all accounts
      checkCallioStatusForAccounts(accounts);
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  async function checkCallioStatusForAccounts(accountsList: SavedAccount[]) {
    const statusMap: Record<string, boolean> = {};

    // Check settings for each account in parallel
    await Promise.all(
      accountsList.map(async (account) => {
        try {
          const result = await notificationsApi.getSettings(account.id);
          // Account has Callio configured if settings exist and have callioApiKey
          statusMap[account.id] = !!(result.settings && result.settings.callioApiKey);
        } catch (err) {
          // If we can't fetch settings, assume not configured
          statusMap[account.id] = false;
        }
      })
    );

    setAccountCallioStatus(statusMap);
  }

  async function loadAllRules() {
    try {
      setLoading(true);
      setError(null);
      const rulesRes = await notificationsApi.getAllRules();
      setRules(rulesRes.rules);
    } catch (err: any) {
      setError(err.message || 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }

  async function loadRulesForAccount(accountId: string) {
    try {
      setLoading(true);
      setError(null);
      const rulesRes = await notificationsApi.getRules(accountId);
      setRules(rulesRes.rules);
    } catch (err: any) {
      setError(err.message || 'Failed to load rules');
    } finally {
      setLoading(false);
    }
  }

  async function loadPhoneNumbersForAccount(accountId: string) {
    try {
      setLoadingPhoneNumbers(prev => ({ ...prev, [accountId]: true }));
      const result = await notificationsApi.getCallioPhoneNumbers(accountId);
      setAccountPhoneNumbers(prev => ({
        ...prev,
        [accountId]: result.phoneNumbers,
      }));
    } catch (err) {
      console.error('Failed to load phone numbers:', err);
      setAccountPhoneNumbers(prev => ({
        ...prev,
        [accountId]: [],
      }));
    } finally {
      setLoadingPhoneNumbers(prev => ({ ...prev, [accountId]: false }));
    }
  }

  async function loadLogs(accountId: string, showLoading = true) {
    try {
      if (showLoading) setLogsLoading(true);
      const result = await notificationsApi.getLogs(accountId, 50);
      setLogs(result.logs);
    } catch (err) {
      console.error('Failed to load notification logs:', err);
      if (showLoading) setLogs([]);
    } finally {
      if (showLoading) setLogsLoading(false);
    }
  }

  async function loadAllLogs(showLoading = true) {
    try {
      if (showLoading) setLogsLoading(true);
      const result = await notificationsApi.getAllLogs(100);
      setLogs(result.logs);
    } catch (err) {
      console.error('Failed to load all notification logs:', err);
      if (showLoading) setLogs([]);
    } finally {
      if (showLoading) setLogsLoading(false);
    }
  }

  // Silently refresh logs and merge updates (for polling - no flicker)
  async function refreshLogs() {
    try {
      let newLogs: any[];
      if (selectedAccountId === 'all') {
        const result = await notificationsApi.getAllLogs(100);
        newLogs = result.logs;
      } else if (selectedAccountId) {
        const result = await notificationsApi.getLogs(selectedAccountId, 50);
        newLogs = result.logs;
      } else {
        return;
      }

      // Merge: update existing logs and add new ones
      setLogs(prevLogs => {
        // Start with existing logs, excluding temporary optimistic entries
        const existingLogs = prevLogs.filter(log => !log.id.startsWith('temp-'));
        const logMap = new Map(existingLogs.map(log => [log.id, log]));

        // Update existing and add new
        for (const newLog of newLogs) {
          logMap.set(newLog.id, newLog);
        }

        // Convert back to array and sort by createdAt (newest first)
        return Array.from(logMap.values())
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      });
    } catch (err) {
      console.error('Failed to refresh logs:', err);
    }
  }

  function insertRuleVariable(variable: string) {
    setRuleForm(prev => ({ ...prev, template: prev.template + variable }));
  }

  function startCreateRule() {
    setIsCreatingRule(true);
    setEditingRule(null);
    // IMPORTANT: Don't default to any account - force user to explicitly choose
    // This prevents accidentally creating rules for the wrong account
    setRuleForm({
      accountId: '', // Empty - user MUST select
      name: '',
      triggerType: 'new_lead',
      replyTriggerMode: 'first_only',
      fromPhone: '',
      toPhone: '',
      template: 'New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}',
      enabled: true,
    });
  }

  function startEditRule(rule: NotificationRule) {
    setEditingRule(rule);
    setIsCreatingRule(false);
    const accountId = rule.savedAccountId || selectedAccountId;
    setRuleForm({
      accountId: accountId === 'all' ? (rule.savedAccountId || '') : accountId,
      name: rule.name,
      triggerType: rule.triggerType,
      replyTriggerMode: rule.replyTriggerMode || 'first_only',
      fromPhone: rule.fromPhone || '',
      toPhone: rule.toPhone || '',
      template: rule.template,
      enabled: rule.enabled,
    });
    // Load phone numbers for this account if not already loaded
    if (rule.savedAccountId && !accountPhoneNumbers[rule.savedAccountId]) {
      loadPhoneNumbersForAccount(rule.savedAccountId);
    }
  }

  function cancelRuleEdit() {
    setIsCreatingRule(false);
    setEditingRule(null);
  }

  async function handleSaveRule() {
    if (!ruleForm.accountId) {
      setError('Please select an account');
      return;
    }
    if (!ruleForm.name.trim()) {
      setError('Please enter a rule name');
      return;
    }
    if (!ruleForm.fromPhone) {
      setError('Please select a From phone number');
      return;
    }
    if (!ruleForm.toPhone.trim()) {
      setError('Please enter a destination phone number');
      return;
    }

    try {
      setSaving(true);
      setError(null);

      if (editingRule) {
        // Update existing rule
        const accountId = editingRule.savedAccountId || ruleForm.accountId;
        const updates: UpdateNotificationRuleDto = {
          name: ruleForm.name,
          triggerType: ruleForm.triggerType,
          replyTriggerMode: ruleForm.triggerType === 'customer_reply' ? ruleForm.replyTriggerMode : undefined,
          fromPhone: ruleForm.fromPhone,
          toPhone: ruleForm.toPhone,
          template: ruleForm.template,
          enabled: ruleForm.enabled,
        };
        const result = await notificationsApi.updateRule(accountId, editingRule.id, updates);
        const updatedRule = { ...result.rule, savedAccountId: editingRule.savedAccountId, savedAccount: editingRule.savedAccount };
        setRules(prev => prev.map(r => r.id === editingRule.id ? updatedRule : r));
        setSuccessMessage('Rule updated successfully');
      } else {
        // Create new rule
        const ruleData: CreateNotificationRuleDto = {
          name: ruleForm.name,
          triggerType: ruleForm.triggerType,
          replyTriggerMode: ruleForm.triggerType === 'customer_reply' ? ruleForm.replyTriggerMode : undefined,
          fromPhone: ruleForm.fromPhone,
          toPhone: ruleForm.toPhone,
          template: ruleForm.template,
          enabled: ruleForm.enabled,
        };
        const result = await notificationsApi.createRule(ruleForm.accountId, ruleData);
        // Add account info to the new rule
        const account = accounts.find(a => a.id === ruleForm.accountId);
        const newRule = {
          ...result.rule,
          savedAccountId: ruleForm.accountId,
          savedAccount: account ? { id: account.id, businessId: account.businessId, businessName: account.businessName } : undefined,
        };
        setRules(prev => [newRule, ...prev]);
        setSuccessMessage('Rule created successfully');
      }

      cancelRuleEdit();
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save rule');
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteRule(ruleId: string) {
    if (!confirm('Are you sure you want to delete this rule?')) return;

    const rule = rules.find(r => r.id === ruleId);
    const accountId = rule?.savedAccountId || selectedAccountId;
    if (!accountId || accountId === 'all') {
      setError('Cannot delete rule - account not found');
      return;
    }

    try {
      setError(null);
      await notificationsApi.deleteRule(accountId, ruleId);
      setRules(prev => prev.filter(r => r.id !== ruleId));
      setSuccessMessage('Rule deleted successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to delete rule');
    }
  }

  async function handleToggleRule(rule: NotificationRule) {
    const accountId = rule.savedAccountId || selectedAccountId;
    if (!accountId || accountId === 'all') {
      setError('Cannot update rule - account not found');
      return;
    }

    const newEnabled = !rule.enabled;

    // Optimistic update - switch immediately
    setRules(prev => prev.map(r => r.id === rule.id ? { ...r, enabled: newEnabled } : r));

    try {
      const result = await notificationsApi.updateRule(accountId, rule.id, {
        enabled: newEnabled,
      });
      // Update with server response (in case of any other field changes)
      const updatedRule = { ...result.rule, savedAccountId: rule.savedAccountId, savedAccount: rule.savedAccount };
      setRules(prev => prev.map(r => r.id === rule.id ? updatedRule : r));
    } catch (err: any) {
      // Revert on error
      setRules(prev => prev.map(r => r.id === rule.id ? { ...r, enabled: rule.enabled } : r));
      setError(err.message || 'Failed to update rule');
    }
  }

  async function handleTestRule(ruleId: string) {
    const rule = rules.find(r => r.id === ruleId);
    const accountId = rule?.savedAccountId || selectedAccountId;
    if (!accountId || accountId === 'all') {
      setError('Cannot test rule - account not found');
      return;
    }

    try {
      setTesting(true);
      setError(null);
      setSuccessMessage(null);

      const result = await notificationsApi.sendTest(accountId, ruleId);

      if (result.success) {
        setSuccessMessage('Test notification sent successfully');

        // Add optimistic log entry immediately (will be updated by next poll)
        const account = accounts.find(a => a.id === accountId);
        const optimisticLog: any = {
          id: `temp-${Date.now()}`, // Temporary ID, will be replaced by real one
          ruleName: `[TEST] ${rule?.name || 'Unknown'}`,
          fromPhone: rule?.fromPhone || '',
          toPhone: rule?.toPhone || '',
          status: 'pending',
          createdAt: new Date().toISOString(),
          deliveredAt: null,
          savedAccountId: accountId,
          savedAccount: account ? {
            id: account.id,
            businessId: account.businessId,
            businessName: account.businessName,
          } : undefined,
        };
        setLogs(prev => [optimisticLog, ...prev]);

        // Silently refresh to get the real log entry with correct ID
        setTimeout(() => refreshLogs(), 1000);
      } else {
        setError(result.message || 'Failed to send test notification');
      }

      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to send test notification');
    } finally {
      setTesting(false);
    }
  }

  // Get phone numbers for the currently selected account in the form
  const formPhoneNumbers = ruleForm.accountId ? (accountPhoneNumbers[ruleForm.accountId] || []) : [];
  const formPhoneNumbersLoading = ruleForm.accountId ? (loadingPhoneNumbers[ruleForm.accountId] || false) : false;

  if (loading && accounts.length === 0) {
    return (
      <div className="notification-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Bell size={24} />
            SMS Alerts
          </h1>
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
      <div className="notification-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Bell size={24} />
            SMS Alerts
          </h1>
        </div>
        <div className="empty-state">
          <p>You need to connect a Thumbtack account before setting up alerts.</p>
          <button className="btn btn-primary" onClick={() => navigate('/')}>
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="notification-settings">
      <div className="settings-header">
        <button className="btn-icon" onClick={() => navigate(-1)}>
          <ArrowLeft size={20} />
        </button>
        <h1>
          <Bell size={24} />
          SMS Alerts
        </h1>
      </div>

      {error && (
        <div className="error-message">
          <AlertCircle size={16} />
          {error}
          <button className="btn-icon" onClick={() => setError(null)}>
            <X size={16} />
          </button>
        </div>
      )}

      {successMessage && (
        <div className="success-message">
          <CheckCircle size={16} />
          {successMessage}
        </div>
      )}

      <div className="settings-content">
        {/* Account Filter */}
        <div className="account-selector">
          <label>Filter by Account:</label>
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
          <span className="account-count">{rules.length} rule{rules.length !== 1 ? 's' : ''}</span>
        </div>

        {loading ? (
          <div className="loading-container">
            <Loader2 size={24} className="spinner" />
          </div>
        ) : (
          <>
            {/* Notification Rules Section */}
            <div className="settings-section rules-section">
              <div className="section-header">
                <h2>
                  <Zap size={18} />
                  Notification Rules
                </h2>
                {!isCreatingRule && !editingRule && (
                  <button className="btn btn-primary btn-sm" onClick={startCreateRule}>
                    <Plus size={14} />
                    Add Rule
                  </button>
                )}
              </div>

              {/* Rule Form - only show at top when creating new rule */}
              {isCreatingRule && !editingRule && (
                <div className="rule-form">
                  <h3>{editingRule ? 'Edit Rule' : 'Create New Rule'}</h3>

                  {/* Account Selector - only show for new rules */}
                  {!editingRule && (
                    <>
                      <div className="form-group account-selector-group">
                        <label className="required-label">
                          <AlertCircle size={14} />
                          Select Business Account
                        </label>
                        <div className="select-wrapper">
                          <select
                            value={ruleForm.accountId}
                            onChange={e => {
                              const newAccountId = e.target.value;
                              setRuleForm(prev => ({ ...prev, accountId: newAccountId, fromPhone: '' }));
                              // Force reload phone numbers for the new account (even if cached)
                              if (newAccountId) {
                                loadPhoneNumbersForAccount(newAccountId);
                              }
                            }}
                            className={!ruleForm.accountId ? 'required' : ''}
                          >
                            <option value="">⚠️ Choose which account this rule applies to...</option>
                            {accounts.map(acc => {
                              const hasCallio = accountCallioStatus[acc.id];
                              return (
                                <option key={acc.id} value={acc.id}>
                                  {hasCallio ? '✓' : '⚠'} {acc.businessName} {!hasCallio ? '(Not configured)' : ''}
                                </option>
                              );
                            })}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        <p className="form-hint warning">
                          <AlertCircle size={14} />
                          This rule will ONLY send notifications for leads from the selected account. Create separate rules for each business location.
                        </p>
                      </div>

                      {/* Warning banner if no account selected */}
                      {!ruleForm.accountId && (
                        <div className="account-warning-banner">
                          <AlertCircle size={18} />
                          <div>
                            <strong>Account Required</strong>
                            <p>Please select which business account this notification rule applies to before continuing.</p>
                          </div>
                        </div>
                      )}

                      {/* Warning banner if account doesn't have Callio configured */}
                      {ruleForm.accountId && !accountCallioStatus[ruleForm.accountId] && (
                        <div className="account-warning-banner" style={{ backgroundColor: '#fff3cd', borderColor: '#ffc107' }}>
                          <AlertCircle size={18} style={{ color: '#856404' }} />
                          <div>
                            <strong>Callio Not Connected</strong>
                            <p>This account doesn't have Callio configured yet. Go to <a href="/phone-settings" style={{ color: '#0066cc', textDecoration: 'underline' }}>Phone Settings</a> to connect Callio for this account before creating notification rules.</p>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {/* From Phone - dropdown of Callio numbers */}
                  {ruleForm.accountId && (
                    <div className="form-group">
                      <label>
                        <Phone size={14} />
                        From Phone Number (Send From)
                      </label>
                      {formPhoneNumbersLoading ? (
                        <div className="loading-phone-numbers" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', color: '#666' }}>
                          <Loader2 size={14} className="spinner" />
                          Loading phone numbers...
                        </div>
                      ) : formPhoneNumbers.length > 0 ? (
                        <div className="select-wrapper">
                          <select
                            value={ruleForm.fromPhone}
                            onChange={e => setRuleForm(prev => ({ ...prev, fromPhone: e.target.value }))}
                          >
                            <option value="">Select phone number...</option>
                            {formPhoneNumbers.map(phone => (
                              <option key={phone.id} value={phone.phoneNumber}>
                                {phone.phoneNumber} ({phone.provider}{phone.friendlyName ? ` - ${phone.friendlyName}` : ''})
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                      ) : (
                        <p className="form-hint warning">
                          <AlertCircle size={14} />
                          No phone numbers available. Go to Phone Settings to connect Callio first.
                        </p>
                      )}
                    </div>
                  )}

                  {/* To Phone - manual input */}
                  <div className="form-group">
                    <label>
                      <Phone size={14} />
                      To Phone Number (Send To)
                    </label>
                    <input
                      type="tel"
                      value={ruleForm.toPhone}
                      onChange={e => setRuleForm(prev => ({ ...prev, toPhone: e.target.value }))}
                      placeholder="+1 555 123 4567"
                      disabled={!ruleForm.accountId && !editingRule}
                    />
                    <p className="form-hint">The phone number to receive SMS alerts</p>
                  </div>

                  <div className="form-group">
                    <label>Rule Name</label>
                    <input
                      type="text"
                      value={ruleForm.name}
                      onChange={e => setRuleForm(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="e.g., New Lead Alert, Customer Reply Alert"
                      disabled={!ruleForm.accountId && !editingRule}
                    />
                  </div>

                  <div className="form-group">
                    <label>Trigger When</label>
                    <div className="select-wrapper">
                      <select
                        value={ruleForm.triggerType}
                        onChange={e => setRuleForm(prev => ({ ...prev, triggerType: e.target.value as 'new_lead' | 'customer_reply' }))}
                        disabled={!ruleForm.accountId && !editingRule}
                      >
                        <option value="new_lead">New Lead Arrives</option>
                        <option value="customer_reply">Customer Replies</option>
                      </select>
                      <ChevronDown size={16} />
                    </div>
                  </div>

                  {ruleForm.triggerType === 'customer_reply' && (
                    <div className="form-group">
                      <label>Reply Mode</label>
                      <div className="select-wrapper">
                        <select
                          value={ruleForm.replyTriggerMode}
                          onChange={e => setRuleForm(prev => ({ ...prev, replyTriggerMode: e.target.value as 'first_only' | 'every_reply' }))}
                          disabled={!ruleForm.accountId && !editingRule}
                        >
                          <option value="first_only">First Reply Only</option>
                          <option value="every_reply">Every Reply</option>
                        </select>
                        <ChevronDown size={16} />
                      </div>
                    </div>
                  )}

                  <div className="form-group">
                    <label>SMS Template</label>
                    <textarea
                      value={ruleForm.template}
                      onChange={e => setRuleForm(prev => ({ ...prev, template: e.target.value }))}
                      rows={4}
                      placeholder="New lead: {{lead.name}}..."
                      disabled={!ruleForm.accountId && !editingRule}
                    />
                    <div className="variable-buttons">
                      {TEMPLATE_VARIABLES.map(v => (
                        <button
                          key={v.name}
                          type="button"
                          className="variable-btn"
                          onClick={() => insertRuleVariable(v.name)}
                          title={v.description}
                          disabled={!ruleForm.accountId && !editingRule}
                        >
                          {v.name}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="form-group checkbox-group">
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={ruleForm.enabled}
                        onChange={e => setRuleForm(prev => ({ ...prev, enabled: e.target.checked }))}
                        disabled={!ruleForm.accountId && !editingRule}
                      />
                      <span className="toggle-slider"></span>
                      <span className="toggle-label">Enable this rule</span>
                    </label>
                  </div>

                  <div className="form-actions">
                    <button className="btn btn-secondary" onClick={cancelRuleEdit}>
                      Cancel
                    </button>
                    <button className="btn btn-primary" onClick={handleSaveRule} disabled={saving}>
                      {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                      {editingRule ? 'Update Rule' : 'Create Rule'}
                    </button>
                  </div>
                </div>
              )}

              {/* Rules List */}
              {rules.length > 0 ? (
                <div className="rules-list">
                  {rules.map(rule => (
                    <div key={rule.id}>
                      <div className={`rule-card ${!rule.enabled ? 'disabled' : ''}`}>
                        <div className="rule-header">
                          <div className="rule-info">
                            <span className="rule-name">{rule.name}</span>
                            <span className={`trigger-badge ${rule.triggerType}`}>
                              {rule.triggerType === 'new_lead' ? 'New Lead' : 'Customer Reply'}
                              {rule.triggerType === 'customer_reply' && rule.replyTriggerMode && (
                                <span className="reply-mode">({rule.replyTriggerMode === 'first_only' ? 'First' : 'Every'})</span>
                              )}
                            </span>
                          </div>
                          <div className="rule-actions">
                            <label className="toggle-switch small">
                              <input
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={() => handleToggleRule(rule)}
                              />
                              <span className="toggle-slider"></span>
                            </label>
                            <button
                              className="btn-icon"
                              onClick={() => handleTestRule(rule.id)}
                              disabled={testing}
                              title="Send test SMS"
                            >
                              <Send size={14} />
                            </button>
                            <button className="btn-icon" onClick={() => startEditRule(rule)} title="Edit rule">
                              <Edit2 size={14} />
                            </button>
                            <button className="btn-icon danger" onClick={() => handleDeleteRule(rule.id)} title="Delete rule">
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                        {/* Always show account name */}
                        {rule.savedAccount && (
                          <div className="rule-account">
                            <span className="account-badge">{rule.savedAccount.businessName}</span>
                          </div>
                        )}
                        {/* Show phone numbers */}
                        <div className="rule-phones">
                          <span className="phone-info">
                            <Phone size={12} />
                            {rule.fromPhone || 'No from'} → {rule.toPhone || 'No to'}
                          </span>
                        </div>
                        <div className="rule-template">
                          <MessageSquare size={12} />
                          <span>{rule.template.substring(0, 60)}{rule.template.length > 60 ? '...' : ''}</span>
                        </div>
                        <div className="rule-stats">
                          <span>Triggered: {rule.triggerCount} time{rule.triggerCount !== 1 ? 's' : ''}</span>
                          {rule.lastTriggeredAt && (
                            <span>Last: {new Date(rule.lastTriggeredAt).toLocaleDateString()}</span>
                          )}
                        </div>
                      </div>

                      {/* Edit Form - appears directly under the rule being edited */}
                      {editingRule && editingRule.id === rule.id && (
                        <div className="rule-form inline-edit">
                          <h3>Edit Rule</h3>

                          {/* Account Selector - editable when editing */}
                          <div className="form-group">
                            <label>
                              <AlertCircle size={14} />
                              Business Account
                            </label>
                            <div className="select-wrapper">
                              <select
                                value={ruleForm.accountId}
                                onChange={e => {
                                  const newAccountId = e.target.value;
                                  setRuleForm(prev => ({ ...prev, accountId: newAccountId, fromPhone: '' }));
                                  // Force reload phone numbers for the new account (even if cached)
                                  if (newAccountId) {
                                    loadPhoneNumbersForAccount(newAccountId);
                                  }
                                }}
                              >
                                <option value="">Select account...</option>
                                {accounts.map(acc => {
                                  const hasCallio = accountCallioStatus[acc.id];
                                  return (
                                    <option key={acc.id} value={acc.id}>
                                      {hasCallio ? '✓' : '⚠'} {acc.businessName} {!hasCallio ? '(Not configured)' : ''}
                                    </option>
                                  );
                                })}
                              </select>
                              <ChevronDown size={16} />
                            </div>
                            <p className="form-hint">
                              This rule will send notifications for leads from the selected account.
                            </p>
                          </div>

                          {/* Warning banner if account doesn't have Callio configured */}
                          {ruleForm.accountId && !accountCallioStatus[ruleForm.accountId] && (
                            <div className="account-warning-banner" style={{ backgroundColor: '#fff3cd', borderColor: '#ffc107' }}>
                              <AlertCircle size={18} style={{ color: '#856404' }} />
                              <div>
                                <strong>Callio Not Connected</strong>
                                <p>This account doesn't have Callio configured yet. Go to <a href="/phone-settings" style={{ color: '#0066cc', textDecoration: 'underline' }}>Phone Settings</a> to connect Callio for this account before saving this rule.</p>
                              </div>
                            </div>
                          )}

                          {/* From Phone - dropdown of Callio numbers */}
                          {ruleForm.accountId && (
                            <div className="form-group">
                              <label>
                                <Phone size={14} />
                                From Phone Number (Send From)
                              </label>
                              {formPhoneNumbersLoading ? (
                                <div className="loading-phone-numbers" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', gap: '8px', color: '#666' }}>
                                  <Loader2 size={14} className="spinner" />
                                  Loading phone numbers...
                                </div>
                              ) : formPhoneNumbers.length > 0 ? (
                                <div className="select-wrapper">
                                  <select
                                    value={ruleForm.fromPhone}
                                    onChange={e => setRuleForm(prev => ({ ...prev, fromPhone: e.target.value }))}
                                  >
                                    <option value="">Select phone number...</option>
                                    {formPhoneNumbers.map(phone => (
                                      <option key={phone.id} value={phone.phoneNumber}>
                                        {phone.phoneNumber} ({phone.provider}{phone.friendlyName ? ` - ${phone.friendlyName}` : ''})
                                      </option>
                                    ))}
                                  </select>
                                  <ChevronDown size={16} />
                                </div>
                              ) : (
                                <p className="form-hint warning">
                                  <AlertCircle size={14} />
                                  No phone numbers available. Go to Phone Settings to connect Callio first.
                                </p>
                              )}
                            </div>
                          )}

                          {/* To Phone - manual input */}
                          <div className="form-group">
                            <label>
                              <Phone size={14} />
                              To Phone Number (Send To)
                            </label>
                            <input
                              type="tel"
                              value={ruleForm.toPhone}
                              onChange={e => setRuleForm(prev => ({ ...prev, toPhone: e.target.value }))}
                              placeholder="+1 555 123 4567"
                            />
                            <p className="form-hint">The phone number to receive SMS alerts</p>
                          </div>

                          <div className="form-group">
                            <label>Rule Name</label>
                            <input
                              type="text"
                              value={ruleForm.name}
                              onChange={e => setRuleForm(prev => ({ ...prev, name: e.target.value }))}
                              placeholder="e.g., New Lead Alert, Customer Reply Alert"
                            />
                          </div>

                          <div className="form-group">
                            <label>Trigger When</label>
                            <div className="select-wrapper">
                              <select
                                value={ruleForm.triggerType}
                                onChange={e => setRuleForm(prev => ({ ...prev, triggerType: e.target.value as 'new_lead' | 'customer_reply' }))}
                              >
                                <option value="new_lead">New Lead Arrives</option>
                                <option value="customer_reply">Customer Replies</option>
                              </select>
                              <ChevronDown size={16} />
                            </div>
                          </div>

                          {ruleForm.triggerType === 'customer_reply' && (
                            <div className="form-group">
                              <label>Reply Mode</label>
                              <div className="select-wrapper">
                                <select
                                  value={ruleForm.replyTriggerMode}
                                  onChange={e => setRuleForm(prev => ({ ...prev, replyTriggerMode: e.target.value as 'first_only' | 'every_reply' }))}
                                >
                                  <option value="first_only">First Reply Only</option>
                                  <option value="every_reply">Every Reply</option>
                                </select>
                                <ChevronDown size={16} />
                              </div>
                            </div>
                          )}

                          <div className="form-group">
                            <label>SMS Template</label>
                            <textarea
                              value={ruleForm.template}
                              onChange={e => setRuleForm(prev => ({ ...prev, template: e.target.value }))}
                              rows={4}
                              placeholder="New lead: {{lead.name}}..."
                            />
                            <div className="variable-buttons">
                              {TEMPLATE_VARIABLES.map(v => (
                                <button
                                  key={v.name}
                                  type="button"
                                  className="variable-btn"
                                  onClick={() => insertRuleVariable(v.name)}
                                  title={v.description}
                                >
                                  {v.name}
                                </button>
                              ))}
                            </div>
                          </div>

                          <div className="form-group checkbox-group">
                            <label className="toggle-switch">
                              <input
                                type="checkbox"
                                checked={ruleForm.enabled}
                                onChange={e => setRuleForm(prev => ({ ...prev, enabled: e.target.checked }))}
                              />
                              <span className="toggle-slider"></span>
                              <span className="toggle-label">Enable this rule</span>
                            </label>
                          </div>

                          <div className="form-actions">
                            <button className="btn btn-secondary" onClick={cancelRuleEdit}>
                              Cancel
                            </button>
                            <button className="btn btn-primary" onClick={handleSaveRule} disabled={saving}>
                              {saving ? <Loader2 size={14} className="spinner" /> : <Save size={14} />}
                              Update Rule
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ) : !isCreatingRule && (
                <div className="empty-rules">
                  <p>No notification rules yet. Create a rule to send SMS alerts when leads arrive or customers reply.</p>
                  <button className="btn btn-primary" onClick={startCreateRule}>
                    <Plus size={16} />
                    Create Your First Rule
                  </button>
                </div>
              )}
            </div>

            {/* Notification Logs Section */}
            <div className="settings-section notification-logs">
              <div className="section-header">
                <h2>
                  <MessageSquare size={18} />
                  Message History
                </h2>
              </div>

              {logsLoading ? (
                <div className="loading-container">
                  <Loader2 size={24} className="spinner" />
                </div>
              ) : logs.length > 0 ? (
                <div className="logs-table-wrapper">
                  <table className="logs-table">
                    <thead>
                      <tr>
                        <th>Time</th>
                        {selectedAccountId === 'all' && <th>Account</th>}
                        <th>Rule</th>
                        <th>From</th>
                        <th>To</th>
                        <th>Status</th>
                        <th>Delivered</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log: any) => (
                        <tr key={log.id} className={log.status === 'failed' ? 'has-error' : ''}>
                          <td className="log-time">
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          {selectedAccountId === 'all' && (
                            <td className="log-account">
                              <span className="account-badge">{log.savedAccount?.businessName || 'Unknown'}</span>
                            </td>
                          )}
                          <td className="log-rule">
                            {log.ruleName ? (
                              <span className="rule-badge">{log.ruleName}</span>
                            ) : (
                              <span className="rule-badge legacy">Legacy</span>
                            )}
                          </td>
                          <td className="log-phone">{log.fromPhone || '-'}</td>
                          <td className="log-phone">{log.toPhone}</td>
                          <td className="log-status">
                            {log.status === 'delivered' ? (
                              <span className="status-badge delivered">
                                <CheckCircle size={12} />
                                Delivered
                              </span>
                            ) : log.status === 'failed' ? (
                              <span className="status-badge failed" title={log.error || 'Unknown error'}>
                                <AlertCircle size={12} />
                                {log.error ? log.error.substring(0, 30) : 'Failed'}
                              </span>
                            ) : log.status === 'sent' ? (
                              <span className="status-badge sent">
                                <Send size={12} />
                                Sent
                              </span>
                            ) : (
                              <span className={`status-badge ${log.status}`}>
                                <Loader2 size={12} className="spinner" />
                                {log.status}
                              </span>
                              )}
                            </td>
                          <td className="log-delivered">
                            {log.deliveredAt ? (
                              <span className="delivered-time">
                                <CheckCircle size={12} />
                                {new Date(log.deliveredAt).toLocaleString()}
                              </span>
                            ) : log.status === 'failed' ? (
                              <span className="not-delivered">—</span>
                            ) : (
                              <span className="pending-delivery">Pending</span>
                            )}
                          </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-logs">
                    <p>No messages sent yet. Messages will appear here when notifications are triggered.</p>
                  </div>
                )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
