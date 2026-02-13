import { useState, useEffect } from 'react';
import { ArrowLeft, Phone, Loader2, X, ChevronDown, AlertCircle, CheckCircle, Link, Unlink, Key, Shield, ShieldCheck, ShieldX, ShieldAlert } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, thumbtackApi, type SigcorePhoneNumber } from '../services/api';
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

export function PhoneSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Sigcore connection state
  const [sigcoreConnected, setSigcoreConnected] = useState(false);
  const [sigcoreApiKey, setSigcoreApiKey] = useState('');
  const [sigcorePhoneNumbers, setSigcorePhoneNumbers] = useState<SigcorePhoneNumber[]>([]);
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
        setSigcoreConnected(settingsRes.settings.sigcoreConnected);
        setShowApiKeyInput(false);
        if (settingsRes.settings.sigcoreConnected) {
          loadPhoneNumbers(accountId);
        } else {
          setSigcorePhoneNumbers([]);
        }
      } else {
        // Reset to defaults
        setSigcoreConnected(false);
        setSigcoreApiKey('');
        setSigcorePhoneNumbers([]);
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
      const result = await notificationsApi.getSigcorePhoneNumbers(accountId);
      setSigcorePhoneNumbers(result.phoneNumbers);
    } catch (err) {
      console.error('Failed to load phone numbers:', err);
    }
  }

  async function handleConnectSigcore() {
    if (!sigcoreApiKey.trim()) {
      setError('Please enter your Sigcore API key');
      return;
    }

    try {
      setValidatingApiKey(true);
      setError(null);

      const result = await notificationsApi.connectSigcore(selectedAccountId, sigcoreApiKey);

      if (!result.success) {
        setError(result.error || 'Invalid API key. Please check your Sigcore API key and try again.');
        return;
      }

      setSigcoreConnected(true);
      setSigcorePhoneNumbers(result.phoneNumbers);
      setShowApiKeyInput(false);
      setSigcoreApiKey('');
      setSuccessMessage('Connected to Sigcore successfully');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to connect to Sigcore');
    } finally {
      setValidatingApiKey(false);
    }
  }

  async function handleDisconnectSigcore() {
    try {
      setError(null);

      const result = await notificationsApi.disconnectSigcore(selectedAccountId);

      if (!result.success) {
        setError(result.error || 'Failed to disconnect');
        return;
      }

      setSigcoreConnected(false);
      setSigcoreApiKey('');
      setSigcorePhoneNumbers([]);
      setSuccessMessage('Disconnected from Sigcore');
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
            {/* Sigcore Connection Section */}
            <div className="settings-section sigcore-connection">
              <div className="section-header">
                <h2>
                  <Key size={18} />
                  Sigcore Connection
                </h2>
              </div>

              {sigcoreConnected ? (
                <div className="sigcore-connected">
                  <div className="connection-status">
                    <CheckCircle size={18} className="status-icon success" />
                    <span>Connected to Sigcore</span>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={handleDisconnectSigcore}
                    >
                      <Unlink size={14} />
                      Disconnect
                    </button>
                  </div>

                  {sigcorePhoneNumbers.length > 0 ? (
                    <div className="phone-numbers-list">
                      <label>Available Phone Numbers ({sigcorePhoneNumbers.length})</label>
                      <p className="form-hint">These phone numbers can be used when creating SMS alert rules.</p>
                      <div className="phone-cards">
                        {sigcorePhoneNumbers.map(phone => {
                          const a2pInfo = getA2PStatusInfo(phone.a2pStatus);
                          return (
                            <div key={phone.id} className="phone-card">
                              <div className="phone-card-header">
                                <span className="phone-number">{phone.phoneNumber}</span>
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
                  ) : (
                    <div className="warning-message">
                      <AlertCircle size={16} />
                      No phone numbers found in your Sigcore account. Please add a phone number in Sigcore first.
                    </div>
                  )}
                </div>
              ) : (
                <div className="sigcore-disconnected">
                  <p className="connection-info">
                    Connect your Sigcore account to send SMS notifications. Get your API key from the
                    Sigcore settings page.
                  </p>

                  {showApiKeyInput ? (
                    <div className="api-key-form">
                      <div className="form-group">
                        <label>
                          <Key size={14} />
                          Sigcore API Key
                        </label>
                        <input
                          type="password"
                          value={sigcoreApiKey}
                          onChange={e => setSigcoreApiKey(e.target.value)}
                          placeholder="Enter your Sigcore API key"
                        />
                      </div>
                      <div className="form-actions">
                        <button
                          className="btn btn-secondary"
                          onClick={() => {
                            setShowApiKeyInput(false);
                            setSigcoreApiKey('');
                          }}
                        >
                          Cancel
                        </button>
                        <button
                          className="btn btn-primary"
                          onClick={handleConnectSigcore}
                          disabled={validatingApiKey || !sigcoreApiKey.trim()}
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
                      Connect to Sigcore
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
