import { useState, useEffect } from 'react';
import { ArrowLeft, Phone, Loader2, X, ChevronDown, AlertCircle, CheckCircle, Link, Unlink, Key, Shield, ShieldCheck, ShieldX, ShieldAlert, Clock, Save } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, thumbtackApi, type CallioPhoneNumber } from '../services/api';
import type { SavedAccount } from '../types';

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

// Timezone options
const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Phoenix', label: 'Arizona (MST)' },
];

export function PhoneSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [destinationPhone, setDestinationPhone] = useState('');
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

      const settingsRes = await notificationsApi.getSettings(accountId);

      if (settingsRes.settings) {
        setEnabled(settingsRes.settings.enabled);
        setDestinationPhone(settingsRes.settings.destinationPhone || '');
        setQuietHoursEnabled(!!settingsRes.settings.quietHoursStart);
        setQuietHoursStart(settingsRes.settings.quietHoursStart || '22:00');
        setQuietHoursEnd(settingsRes.settings.quietHoursEnd || '08:00');
        setQuietHoursTimezone(settingsRes.settings.quietHoursTimezone || 'America/New_York');
        setRequirePhone(settingsRes.settings.requirePhone);
        setCallioConnected(settingsRes.settings.callioConnected);
        setCallioFromPhone(settingsRes.settings.callioFromPhone || '');
        setShowApiKeyInput(false);
        if (settingsRes.settings.callioConnected) {
          loadPhoneNumbers(accountId);
        }
      } else {
        // Reset to defaults
        setEnabled(false);
        setDestinationPhone('');
        setQuietHoursEnabled(false);
        setQuietHoursStart('22:00');
        setQuietHoursEnd('08:00');
        setQuietHoursTimezone('America/New_York');
        setRequirePhone(true);
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

  async function loadPhoneNumbers(accountId: string) {
    try {
      const result = await notificationsApi.getCallioPhoneNumbers(accountId);
      setCallioPhoneNumbers(result.phoneNumbers);
    } catch (err) {
      console.error('Failed to load phone numbers:', err);
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
        callioFromPhone: callioFromPhone || undefined,
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

  async function handleConnectCallio() {
    if (!callioApiKey.trim()) {
      setError('Please enter your Callio API key');
      return;
    }

    try {
      setValidatingApiKey(true);
      setError(null);

      const result = await notificationsApi.connectCallio(selectedAccountId, callioApiKey);

      if (!result.success) {
        setError(result.error || 'Invalid API key. Please check your Callio API key and try again.');
        return;
      }

      setCallioConnected(true);
      setCallioPhoneNumbers(result.phoneNumbers);
      setShowApiKeyInput(false);
      setCallioApiKey('');
      setSuccessMessage('Connected to Callio successfully');
      setTimeout(() => setSuccessMessage(null), 3000);

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

  if (loading && accounts.length === 0) {
    return (
      <div className="notification-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Phone size={24} />
            Phone Settings
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
            <Phone size={24} />
            Phone Settings
          </h1>
        </div>
        <div className="empty-state">
          <p>You need to connect a Thumbtack account first.</p>
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
          <Phone size={24} />
          Phone Settings
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
        <div className="account-selector">
          <label>Account:</label>
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
                          Default Send From Number
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
                      </div>

                      {/* Phone Numbers List */}
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
                      No phone numbers found in your Callio account.
                    </div>
                  )}
                </div>
              ) : (
                <div className="callio-disconnected">
                  <p className="connection-info">
                    Connect your Callio account to send SMS notifications.
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

            {/* Notification Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h2>Notification Settings</h2>
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
                    Enable SMS notifications for this account
                  </span>
                </label>
              </div>

              <div className="form-group">
                <label>
                  <Phone size={14} />
                  Destination Phone Number
                </label>
                <input
                  type="tel"
                  value={destinationPhone}
                  onChange={e => setDestinationPhone(e.target.value)}
                  placeholder="+1 555 123 4567"
                />
                <p className="form-hint">Your phone number to receive lead notifications</p>
              </div>
            </div>

            {/* General Settings */}
            <div className="settings-section">
              <div className="section-header">
                <h2>
                  <Clock size={18} />
                  General Settings
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

            {/* Save Button */}
            <div className="settings-actions">
              <button
                className="btn btn-primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? <Loader2 size={16} className="spinner" /> : <Save size={16} />}
                Save Settings
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
