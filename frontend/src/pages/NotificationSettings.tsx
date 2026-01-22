import { useState, useEffect } from 'react';
import { ArrowLeft, Bell, Save, Loader2, X, ChevronDown, Send, Phone, Clock, MessageSquare, AlertCircle, CheckCircle, XCircle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, thumbtackApi } from '../services/api';
import type { NotificationLog, SavedAccount } from '../types';

// Available variables for SMS template
const TEMPLATE_VARIABLES = [
  { name: '{{lead.name}}', description: 'Customer name' },
  { name: '{{lead.phone}}', description: 'Customer phone' },
  { name: '{{lead.service}}', description: 'Service category' },
  { name: '{{lead.location}}', description: 'City, State' },
];

// Timezone options
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Phoenix', label: 'Arizona (MST)' },
];

export function NotificationSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [logs, setLogs] = useState<NotificationLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [destinationPhone, setDestinationPhone] = useState('');
  const [senderMode, setSenderMode] = useState<'shared' | 'dedicated' | 'openphone'>('shared');
  const [template, setTemplate] = useState('New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}');
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false);
  const [quietHoursStart, setQuietHoursStart] = useState('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState('08:00');
  const [quietHoursTimezone, setQuietHoursTimezone] = useState('America/New_York');
  const [requirePhone, setRequirePhone] = useState(true);

  useEffect(() => {
    loadAccounts();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadSettings(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadAccounts() {
    try {
      setLoading(true);
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setAccounts(accounts);
      if (accounts.length > 0) {
        setSelectedAccountId(accounts[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  async function loadSettings(accountId: string) {
    try {
      setLoading(true);
      setError(null);

      const [settingsRes, logsRes] = await Promise.all([
        notificationsApi.getSettings(accountId),
        notificationsApi.getLogs(accountId, 20),
      ]);

      setLogs(logsRes.logs);

      // Populate form with existing settings
      if (settingsRes.settings) {
        setEnabled(settingsRes.settings.enabled);
        setDestinationPhone(settingsRes.settings.destinationPhone || '');
        setSenderMode(settingsRes.settings.senderMode as 'shared' | 'dedicated' | 'openphone');
        setTemplate(settingsRes.settings.template);
        setQuietHoursEnabled(!!settingsRes.settings.quietHoursStart);
        setQuietHoursStart(settingsRes.settings.quietHoursStart || '22:00');
        setQuietHoursEnd(settingsRes.settings.quietHoursEnd || '08:00');
        setQuietHoursTimezone(settingsRes.settings.quietHoursTimezone || 'America/New_York');
        setRequirePhone(settingsRes.settings.requirePhone);
      } else {
        // Reset to defaults for new settings
        setEnabled(false);
        setDestinationPhone('');
        setSenderMode('shared');
        setTemplate('New lead: {{lead.name}}\nPhone: {{lead.phone}}\nService: {{lead.service}}\nLocation: {{lead.location}}');
        setQuietHoursEnabled(false);
        setQuietHoursStart('22:00');
        setQuietHoursEnd('08:00');
        setQuietHoursTimezone('America/New_York');
        setRequirePhone(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!selectedAccountId) return;

    try {
      setSaving(true);
      setError(null);
      setSuccessMessage(null);

      await notificationsApi.updateSettings(selectedAccountId, {
        enabled,
        destinationPhone: destinationPhone || undefined,
        senderMode,
        template,
        quietHoursStart: quietHoursEnabled ? quietHoursStart : undefined,
        quietHoursEnd: quietHoursEnabled ? quietHoursEnd : undefined,
        quietHoursTimezone: quietHoursEnabled ? quietHoursTimezone : undefined,
        requirePhone,
      });

      setSuccessMessage('Settings saved successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    if (!selectedAccountId) return;

    if (!destinationPhone) {
      setError('Please enter a destination phone number first');
      return;
    }

    try {
      setTesting(true);
      setError(null);
      setSuccessMessage(null);

      const result = await notificationsApi.sendTest(selectedAccountId);

      if (result.success) {
        setSuccessMessage('Test notification sent successfully');
        // Refresh logs to show the test
        const logsRes = await notificationsApi.getLogs(selectedAccountId, 20);
        setLogs(logsRes.logs);
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

  function insertVariable(variable: string) {
    setTemplate(prev => prev + variable);
  }

  function getStatusIcon(status: string) {
    switch (status) {
      case 'delivered':
      case 'sent':
        return <CheckCircle size={14} className="status-icon success" />;
      case 'failed':
        return <XCircle size={14} className="status-icon error" />;
      case 'queued':
      case 'pending':
        return <Clock size={14} className="status-icon pending" />;
      default:
        return <AlertCircle size={14} className="status-icon" />;
    }
  }

  if (loading && accounts.length === 0) {
    return (
      <div className="notification-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Bell size={24} />
            SMS Notifications
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
            SMS Notifications
          </h1>
        </div>
        <div className="empty-state">
          <p>You need to connect a Thumbtack account before setting up notifications.</p>
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
          SMS Notifications
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
        {/* Account Selector */}
        {accounts.length > 1 && (
          <div className="account-selector">
            <label>Select Account:</label>
            <div className="select-wrapper">
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
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

        {loading ? (
          <div className="loading-container">
            <Loader2 size={24} className="spinner" />
          </div>
        ) : (
          <>
            {/* Enable Notifications Section */}
            <div className="settings-section">
              <div className="section-header">
                <h2>Enable Notifications</h2>
              </div>
              <div className="form-group checkbox-group">
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={e => setEnabled(e.target.checked)}
                  />
                  <span className="toggle-slider"></span>
                  <span className="toggle-label">
                    Send SMS notification when a new lead arrives
                  </span>
                </label>
              </div>

              <div className="form-group">
                <label>
                  <Phone size={14} />
                  Send to Phone Number
                </label>
                <input
                  type="tel"
                  value={destinationPhone}
                  onChange={e => setDestinationPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                />
                <p className="form-hint">Your company phone number to receive lead notifications</p>
              </div>
            </div>

            {/* Sender Mode Section */}
            <div className="settings-section">
              <div className="section-header">
                <h2>Sender Options</h2>
              </div>
              <div className="form-group">
                <label>Sender Mode</label>
                <div className="radio-group vertical">
                  <label className="radio-label">
                    <input
                      type="radio"
                      name="senderMode"
                      checked={senderMode === 'shared'}
                      onChange={() => setSenderMode('shared')}
                    />
                    <span className="radio-content">
                      <strong>Shared Number</strong>
                      <span className="radio-description">Use our shared Callio number (free)</span>
                    </span>
                  </label>
                  <label className="radio-label disabled">
                    <input
                      type="radio"
                      name="senderMode"
                      checked={senderMode === 'dedicated'}
                      onChange={() => setSenderMode('dedicated')}
                      disabled
                    />
                    <span className="radio-content">
                      <strong>Dedicated Number</strong>
                      <span className="radio-description">Get your own dedicated number (Pro plan)</span>
                    </span>
                  </label>
                  <label className="radio-label disabled">
                    <input
                      type="radio"
                      name="senderMode"
                      checked={senderMode === 'openphone'}
                      onChange={() => setSenderMode('openphone')}
                      disabled
                    />
                    <span className="radio-content">
                      <strong>OpenPhone Integration</strong>
                      <span className="radio-description">Use your OpenPhone number (Premium plan)</span>
                    </span>
                  </label>
                </div>
              </div>
            </div>

            {/* Message Template Section */}
            <div className="settings-section">
              <div className="section-header">
                <h2>
                  <MessageSquare size={18} />
                  Message Template
                </h2>
              </div>
              <div className="form-group">
                <textarea
                  value={template}
                  onChange={e => setTemplate(e.target.value)}
                  rows={5}
                  placeholder="New lead: {{lead.name}}..."
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

            {/* Rules Section */}
            <div className="settings-section">
              <div className="section-header">
                <h2>
                  <Clock size={18} />
                  Notification Rules
                </h2>
              </div>

              <div className="form-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={requirePhone}
                    onChange={e => setRequirePhone(e.target.checked)}
                  />
                  Only send if lead has a phone number
                </label>
              </div>

              <div className="form-group checkbox-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={quietHoursEnabled}
                    onChange={e => setQuietHoursEnabled(e.target.checked)}
                  />
                  Enable quiet hours (no notifications during this time)
                </label>
              </div>

              {quietHoursEnabled && (
                <div className="quiet-hours-config">
                  <div className="form-row">
                    <div className="form-group">
                      <label>From</label>
                      <input
                        type="time"
                        value={quietHoursStart}
                        onChange={e => setQuietHoursStart(e.target.value)}
                      />
                    </div>
                    <div className="form-group">
                      <label>To</label>
                      <input
                        type="time"
                        value={quietHoursEnd}
                        onChange={e => setQuietHoursEnd(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="form-group">
                    <label>Timezone</label>
                    <div className="select-wrapper">
                      <select
                        value={quietHoursTimezone}
                        onChange={e => setQuietHoursTimezone(e.target.value)}
                      >
                        {TIMEZONE_OPTIONS.map(tz => (
                          <option key={tz.value} value={tz.value}>
                            {tz.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="settings-actions">
              <button
                className="btn btn-secondary"
                onClick={handleSendTest}
                disabled={testing || !destinationPhone}
              >
                {testing ? <Loader2 size={16} className="spinner" /> : <Send size={16} />}
                Send Test SMS
              </button>
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                Save Settings
              </button>
            </div>

            {/* Notification Logs */}
            {logs.length > 0 && (
              <div className="settings-section">
                <div className="section-header">
                  <h2>Recent Notifications</h2>
                </div>
                <div className="notification-logs">
                  <table>
                    <thead>
                      <tr>
                        <th>Time</th>
                        <th>To</th>
                        <th>Status</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(log => (
                        <tr key={log.id}>
                          <td className="log-time">
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          <td className="log-phone">{log.toPhone}</td>
                          <td className="log-status">
                            {getStatusIcon(log.status)}
                            <span>{log.status}</span>
                            {log.error && (
                              <span className="log-error" title={log.error}>
                                !
                              </span>
                            )}
                          </td>
                          <td className="log-message">
                            {log.messageBody.substring(0, 50)}
                            {log.messageBody.length > 50 ? '...' : ''}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
