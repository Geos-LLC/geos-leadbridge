import { useState, useEffect } from 'react';
import { ArrowLeft, Bell, Save, Loader2, X, ChevronDown, Send, Phone, Clock, MessageSquare, AlertCircle, CheckCircle, XCircle, Link, Unlink, Key, Shield, ShieldCheck, ShieldX, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, thumbtackApi, type CallioPhoneNumber } from '../services/api';
import type { NotificationLog, SavedAccount } from '../types';

// Helper function to get A2P status display
function getA2PStatusInfo(status?: string): { icon: React.ReactNode; label: string; className: string } {
  switch (status) {
    case 'approved':
      return { icon: <ShieldCheck size={14} />, label: 'A2P Approved', className: 'status-approved' };
    case 'pending':
      return { icon: <ShieldAlert size={14} />, label: 'A2P Pending', className: 'status-pending' };
    case 'rejected':
      return { icon: <ShieldX size={14} />, label: 'A2P Rejected', className: 'status-rejected' };
    case 'not_required':
      return { icon: <Shield size={14} />, label: 'A2P Not Required', className: 'status-info' };
    default:
      return { icon: <Shield size={14} />, label: 'Unknown', className: 'status-unknown' };
  }
}

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

  // Callio connection state
  const [callioConnected, setCallioConnected] = useState(false);
  const [callioApiKey, setCallioApiKey] = useState('');
  const [callioFromPhone, setCallioFromPhone] = useState('');
  const [callioPhoneNumbers, setCallioPhoneNumbers] = useState<CallioPhoneNumber[]>([]);
  const [validatingApiKey, setValidatingApiKey] = useState(false);
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);

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
        // Callio settings
        setCallioConnected(settingsRes.settings.callioConnected);
        setCallioFromPhone(settingsRes.settings.callioFromPhone || '');
        setShowApiKeyInput(false);
        // If connected, fetch phone numbers
        if (settingsRes.settings.callioConnected) {
          loadPhoneNumbers(accountId);
        }
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
        // Reset Callio settings
        setCallioConnected(false);
        setCallioApiKey('');
        setCallioFromPhone('');
        setCallioPhoneNumbers([]);
        setShowApiKeyInput(false);
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
        callioFromPhone: callioFromPhone || undefined,
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

  async function loadPhoneNumbers(accountId: string) {
    try {
      const result = await notificationsApi.getCallioPhoneNumbers(accountId);
      setCallioPhoneNumbers(result.phoneNumbers);
    } catch (err) {
      console.error('Failed to load phone numbers:', err);
    }
  }

  async function handleConnectCallio() {
    if (!callioApiKey.trim()) {
      setError('Please enter your Callio API key');
      return;
    }

    try {
      setValidatingApiKey(true);
      setError(null);

      // Use the new connect endpoint that validates, creates webhook, and stores settings
      const result = await notificationsApi.connectCallio(selectedAccountId, callioApiKey);

      if (!result.success) {
        setError(result.error || 'Invalid API key. Please check your Callio API key and try again.');
        return;
      }

      setCallioConnected(true);
      setCallioPhoneNumbers(result.phoneNumbers);
      setShowApiKeyInput(false);
      setCallioApiKey(''); // Clear the API key from state for security
      setSuccessMessage('Connected to Callio successfully (webhook auto-configured)');
      setTimeout(() => setSuccessMessage(null), 3000);

      // Auto-select first phone number if available
      if (result.phoneNumbers.length > 0 && !callioFromPhone) {
        setCallioFromPhone(result.phoneNumbers[0].phoneNumber);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to connect to Callio');
    } finally {
      setValidatingApiKey(false);
    }
  }

  async function handleDisconnectCallio() {
    try {
      setError(null);

      // Use the new disconnect endpoint that deletes webhook and clears settings
      const result = await notificationsApi.disconnectCallio(selectedAccountId);

      if (!result.success) {
        setError(result.error || 'Failed to disconnect');
        return;
      }

      setCallioConnected(false);
      setCallioApiKey('');
      setCallioFromPhone('');
      setCallioPhoneNumbers([]);
      setSuccessMessage('Disconnected from Callio');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect');
    }
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
            {/* Callio Connection Section */}
            <div className="settings-section callio-connection">
              <div className="section-header">
                <h2>
                  <Key size={18} />
                  Callio Connection
                </h2>
              </div>

              {callioConnected ? (
                <div className="callio-connected">
                  <div className="connection-status">
                    <CheckCircle size={18} className="status-icon success" />
                    <span>Connected to Callio</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleDisconnectCallio}
                    >
                      <Unlink size={14} />
                      Disconnect
                    </button>
                  </div>

                  {callioPhoneNumbers.length > 0 && (
                    <>
                      <div className="form-group">
                        <label>
                          <Phone size={14} />
                          Send From Phone Number
                        </label>
                        <div className="select-wrapper">
                          <select
                            value={callioFromPhone}
                            onChange={e => setCallioFromPhone(e.target.value)}
                          >
                            <option value="">Auto-select</option>
                            {callioPhoneNumbers.map(phone => (
                              <option key={phone.id} value={phone.phoneNumber}>
                                {phone.phoneNumber} ({phone.provider}{phone.friendlyName ? ` - ${phone.friendlyName}` : ''})
                              </option>
                            ))}
                          </select>
                          <ChevronDown size={16} />
                        </div>
                        <p className="form-hint">Select which of your Callio phone numbers to send SMS from</p>
                      </div>

                      {/* Phone Numbers List with Status */}
                      <div className="phone-numbers-list">
                        <label>Available Phone Numbers</label>
                        <div className="phone-cards">
                          {callioPhoneNumbers.map(phone => {
                            const a2pInfo = getA2PStatusInfo(phone.a2pStatus);
                            const isSelected = callioFromPhone === phone.phoneNumber;
                            return (
                              <div
                                key={phone.id}
                                className={`phone-card ${isSelected ? 'selected' : ''}`}
                                onClick={() => setCallioFromPhone(phone.phoneNumber)}
                              >
                                <div className="phone-card-header">
                                  <span className="phone-number">{phone.phoneNumber}</span>
                                  {isSelected && <CheckCircle size={16} className="selected-icon" />}
                                </div>
                                <div className="phone-card-details">
                                  <span className="provider-badge">{phone.provider}</span>
                                  {phone.friendlyName && (
                                    <span className="friendly-name">{phone.friendlyName}</span>
                                  )}
                                </div>
                                <div className="phone-card-status">
                                  <span className={`a2p-status ${a2pInfo.className}`}>
                                    {a2pInfo.icon}
                                    {a2pInfo.label}
                                  </span>
                                  <div className="capabilities">
                                    {phone.smsEnabled && <span className="cap-badge sms">SMS</span>}
                                    {phone.mmsEnabled && <span className="cap-badge mms">MMS</span>}
                                    {phone.voiceEnabled && <span className="cap-badge voice">Voice</span>}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    </>
                  )}

                  {callioPhoneNumbers.length === 0 && (
                    <div className="warning-message">
                      <AlertCircle size={16} />
                      No phone numbers found in your Callio account. Please add a phone number in Callio first.
                    </div>
                  )}
                </div>
              ) : (
                <div className="callio-disconnected">
                  <p className="connection-info">
                    Connect your Callio account to send SMS notifications. Get your API key from the
                    Callio settings page.
                  </p>

                  {showApiKeyInput ? (
                    <div className="api-key-form">
                      <div className="form-group">
                        <label>
                          <Key size={14} />
                          Callio API Key
                        </label>
                        <input
                          type="password"
                          value={callioApiKey}
                          onChange={e => setCallioApiKey(e.target.value)}
                          placeholder="Enter your Callio API key"
                        />
                      </div>
                      <div className="form-actions">
                        <button
                          className="btn btn-secondary"
                          onClick={() => {
                            setShowApiKeyInput(false);
                            setCallioApiKey('');
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={handleConnectCallio}
                          disabled={validatingApiKey || !callioApiKey.trim()}
                        >
                          {validatingApiKey ? (
                            <>
                              <Loader2 size={14} className="spinner" />
                              Connecting...
                            </>
                          ) : (
                            <>
                              <Link size={14} />
                              Connect
                            </>
                          )}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      className="btn btn-primary"
                      onClick={() => setShowApiKeyInput(true)}
                    >
                      <Link size={16} />
                      Connect to Callio
                    </button>
                  )}
                </div>
              )}
            </div>

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
                disabled={testing || !destinationPhone || !callioConnected}
                title={!callioConnected ? 'Connect to Callio first' : ''}
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
                        <th>Delivery</th>
                        <th>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map(log => (
                        <tr key={log.id} className={log.error ? 'has-error' : ''}>
                          <td className="log-time">
                            {new Date(log.createdAt).toLocaleString()}
                          </td>
                          <td className="log-phone">{log.toPhone}</td>
                          <td className="log-status">
                            {getStatusIcon(log.status)}
                            <span>{log.status}</span>
                          </td>
                          <td className="log-delivery">
                            {log.deliveredAt ? (
                              <span className="delivery-success">
                                <CheckCircle size={14} />
                                {new Date(log.deliveredAt).toLocaleTimeString()}
                              </span>
                            ) : log.status === 'failed' ? (
                              <span className="delivery-failed">
                                <XCircle size={14} />
                                Failed
                              </span>
                            ) : log.sentAt ? (
                              <span className="delivery-pending">
                                <Clock size={14} />
                                Sent, awaiting
                              </span>
                            ) : (
                              <span className="delivery-pending">
                                <Clock size={14} />
                                Pending
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
                  {/* Show errors in detail below the table */}
                  {logs.some(log => log.error) && (
                    <div className="log-errors-section">
                      <h4><AlertCircle size={14} /> Errors</h4>
                      {logs.filter(log => log.error).map(log => (
                        <div key={log.id} className="log-error-detail">
                          <span className="error-phone">{log.toPhone}</span>
                          <span className="error-time">{new Date(log.createdAt).toLocaleString()}</span>
                          <span className="error-message">{log.error}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
