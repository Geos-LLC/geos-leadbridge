import { useState, useEffect } from 'react';
import { ArrowLeft, Phone, Loader2, X, ChevronDown, AlertCircle, CheckCircle, Link, Unlink, Key, Shield, ShieldCheck, ShieldX, ShieldAlert, PhoneCall } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { notificationsApi, usersApi, thumbtackApi, type SigcorePhoneNumber } from '../services/api';
import type { SavedAccount, PhonePoolEntry } from '../types';

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

type ProviderTab = 'openphone' | 'twilio';

export function PhoneSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Pool phone state
  const [poolPhone, setPoolPhone] = useState<PhonePoolEntry | null>(null);
  const [loadingPoolPhone, setLoadingPoolPhone] = useState(true);

  // Provider connection state
  const [activeTab, setActiveTab] = useState<ProviderTab>('openphone');
  const [sigcoreConnected, setSigcoreConnected] = useState(false);
  const [connectedProvider, setConnectedProvider] = useState<string | null>(null);
  const [phoneNumbers, setPhoneNumbers] = useState<SigcorePhoneNumber[]>([]);
  const [connecting, setConnecting] = useState(false);
  const [showConnectForm, setShowConnectForm] = useState(false);

  // Provider-specific form fields
  const [openPhoneApiKey, setOpenPhoneApiKey] = useState('');
  const [twilioAccountSid, setTwilioAccountSid] = useState('');
  const [twilioAuthToken, setTwilioAuthToken] = useState('');

  useEffect(() => {
    loadAccounts();
    loadPoolPhone();
  }, []);

  useEffect(() => {
    if (selectedAccountId) {
      loadSettings(selectedAccountId);
    }
  }, [selectedAccountId]);

  async function loadPoolPhone() {
    try {
      setLoadingPoolPhone(true);
      const result = await usersApi.getMyPoolPhone();
      setPoolPhone(result.poolPhone);
    } catch (err) {
      console.error('Failed to load pool phone:', err);
    } finally {
      setLoadingPoolPhone(false);
    }
  }

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
        const s = settingsRes.settings;
        setSigcoreConnected(s.sigcoreConnected);
        setConnectedProvider(s.sigcoreProvider || null);
        setShowConnectForm(false);
        if (s.sigcoreConnected) {
          loadPhoneNumbers(accountId);
        } else {
          setPhoneNumbers([]);
        }
      } else {
        setSigcoreConnected(false);
        setConnectedProvider(null);
        resetProviderForm();
        setPhoneNumbers([]);
        setShowConnectForm(false);
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
      setPhoneNumbers(result.phoneNumbers);
    } catch (err) {
      console.error('Failed to load phone numbers:', err);
    }
  }

  function resetProviderForm() {
    setOpenPhoneApiKey('');
    setTwilioAccountSid('');
    setTwilioAuthToken('');
  }

  function isProviderFormValid(): boolean {
    if (activeTab === 'openphone') {
      return !!openPhoneApiKey.trim();
    } else {
      return !!twilioAccountSid.trim() && !!twilioAuthToken.trim();
    }
  }

  async function handleConnect() {
    if (!isProviderFormValid()) {
      setError('Please fill in all required fields');
      return;
    }

    try {
      setConnecting(true);
      setError(null);

      const providerCredentials = activeTab === 'openphone'
        ? { apiKey: openPhoneApiKey }
        : { accountSid: twilioAccountSid, authToken: twilioAuthToken };

      const result = await notificationsApi.connectSigcore(
        selectedAccountId,
        activeTab,
        providerCredentials,
      );

      if (!result.success) {
        setError(result.error || 'Connection failed. Please check your credentials.');
        return;
      }

      setSigcoreConnected(true);
      setConnectedProvider(activeTab);
      setPhoneNumbers(result.phoneNumbers);
      setShowConnectForm(false);
      resetProviderForm();
      setSuccessMessage(`Connected to ${activeTab === 'openphone' ? 'OpenPhone' : 'Twilio'} successfully`);
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to connect');
    } finally {
      setConnecting(false);
    }
  }

  async function handleDisconnect() {
    try {
      setError(null);

      const result = await notificationsApi.disconnectSigcore(selectedAccountId);

      if (!result.success) {
        setError(result.error || 'Failed to disconnect');
        return;
      }

      setSigcoreConnected(false);
      setConnectedProvider(null);
      resetProviderForm();
      setPhoneNumbers([]);
      setSuccessMessage('Provider disconnected');
      setTimeout(() => setSuccessMessage(null), 3000);
    } catch (err: any) {
      setError(err.message || 'Failed to disconnect');
    }
  }

  const providerLabel = activeTab === 'openphone' ? 'OpenPhone' : 'Twilio';
  const connectedProviderLabel = connectedProvider === 'openphone' ? 'OpenPhone' : connectedProvider === 'twilio' ? 'Twilio' : 'Provider';

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
          <p>You need to connect an account first.</p>
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
        {/* Section 1: Assigned Pool Phone */}
        {loadingPoolPhone ? (
          <div className="settings-section">
            <div className="loading-container">
              <Loader2 size={20} className="spinner" />
            </div>
          </div>
        ) : poolPhone ? (
          <div className="settings-section pool-phone-section">
            <div className="section-header">
              <h2>
                <PhoneCall size={18} />
                Your Assigned Phone
              </h2>
            </div>
            <div className="pool-phone-card">
              <div className="pool-phone-info">
                <span className="pool-phone-number">{poolPhone.phoneNumber}</span>
                <span className="provider-badge">{poolPhone.provider}</span>
              </div>
              <div className="pool-phone-meta">
                {poolPhone.areaCode && <span>Area code: {poolPhone.areaCode}</span>}
                {poolPhone.assignedAt && (
                  <span>Assigned: {new Date(poolPhone.assignedAt).toLocaleDateString()}</span>
                )}
              </div>
              <p className="pool-phone-note">
                Assigned by administrator. Used as default sender for SMS alerts.
              </p>
            </div>
          </div>
        ) : null}

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
          <div className="settings-section provider-connection">
            <div className="section-header">
              <h2>
                <Phone size={18} />
                Connect Your Own Provider
              </h2>
            </div>

            {/* Provider Tabs */}
            <div className="provider-tabs">
              <button
                className={`provider-tab ${activeTab === 'openphone' ? 'active' : ''}`}
                onClick={() => { setActiveTab('openphone'); setShowConnectForm(false); resetProviderForm(); }}
              >
                OpenPhone
              </button>
              <button
                className={`provider-tab ${activeTab === 'twilio' ? 'active' : ''}`}
                onClick={() => { setActiveTab('twilio'); setShowConnectForm(false); resetProviderForm(); }}
              >
                Twilio
              </button>
            </div>

            {sigcoreConnected ? (
              <div className="sigcore-connected">
                <div className="connection-status">
                  <CheckCircle size={18} className="status-icon success" />
                  <span>Connected to {connectedProviderLabel}</span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleDisconnect}
                  >
                    <Unlink size={14} />
                    Disconnect
                  </button>
                </div>

                {phoneNumbers.length > 0 ? (
                  <div className="phone-numbers-list">
                    <label>Available Phone Numbers ({phoneNumbers.length})</label>
                    <p className="form-hint">These phone numbers can be used when creating SMS alert rules.</p>
                    <div className="phone-cards">
                      {phoneNumbers.map(phone => {
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
                    No phone numbers found. Please add a phone number in your {connectedProviderLabel} account first.
                  </div>
                )}
              </div>
            ) : (
              <div className="sigcore-disconnected">
                <p className="connection-info">
                  Connect your {providerLabel} account to use your own phone numbers for SMS notifications.
                </p>

                {showConnectForm ? (
                  <div className="api-key-form">
                    {activeTab === 'openphone' ? (
                      <div className="form-group">
                        <label>
                          <Key size={14} />
                          OpenPhone API Key
                        </label>
                        <input
                          type="password"
                          value={openPhoneApiKey}
                          onChange={e => setOpenPhoneApiKey(e.target.value)}
                          placeholder="Enter your OpenPhone API key"
                        />
                        <p className="form-hint">Get your API key from the OpenPhone settings page.</p>
                      </div>
                    ) : (
                      <>
                        <div className="form-group">
                          <label>
                            <Key size={14} />
                            Twilio Account SID
                          </label>
                          <input
                            type="text"
                            value={twilioAccountSid}
                            onChange={e => setTwilioAccountSid(e.target.value)}
                            placeholder="AC..."
                          />
                        </div>
                        <div className="form-group">
                          <label>
                            <Key size={14} />
                            Twilio Auth Token
                          </label>
                          <input
                            type="password"
                            value={twilioAuthToken}
                            onChange={e => setTwilioAuthToken(e.target.value)}
                            placeholder="Enter your Twilio auth token"
                          />
                          <p className="form-hint">Get your credentials from the Twilio console.</p>
                        </div>
                      </>
                    )}

                    <div className="form-actions">
                      <button
                        className="btn btn-secondary"
                        onClick={() => {
                          setShowConnectForm(false);
                          resetProviderForm();
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        className="btn btn-primary"
                        onClick={handleConnect}
                        disabled={connecting || !isProviderFormValid()}
                      >
                        {connecting ? (
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
                    onClick={() => setShowConnectForm(true)}
                  >
                    <Link size={16} />
                    Connect to {providerLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
