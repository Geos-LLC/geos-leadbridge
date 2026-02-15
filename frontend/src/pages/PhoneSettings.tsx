import { useState, useEffect } from 'react';
import { ArrowLeft, Phone, Loader2, X, ChevronDown, AlertCircle, CheckCircle, PhoneCall } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usersApi, thumbtackApi } from '../services/api';
import type { SavedAccount, PhonePoolEntry } from '../types';

export function PhoneSettings() {
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage] = useState<string | null>(null);

  // Pool phone state
  const [poolPhones, setPoolPhones] = useState<PhonePoolEntry[]>([]);
  const [loadingPoolPhone, setLoadingPoolPhone] = useState(true);

  useEffect(() => {
    loadAccounts();
    loadPoolPhone();
  }, []);

  async function loadPoolPhone() {
    try {
      setLoadingPoolPhone(true);
      const result = await usersApi.getMyPoolPhone();
      setPoolPhones(result.poolPhones || (result.poolPhone ? [result.poolPhone] : []));
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

  if (loading && accounts.length === 0) {
    return (
      <div className="notification-settings">
        <div className="settings-header">
          <button className="btn-icon" onClick={() => navigate(-1)}>
            <ArrowLeft size={20} />
          </button>
          <h1>
            <Phone size={24} />
            Business Line
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
            Business Line
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
          Business Line
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
        {/* Account Selector - at top */}
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

        <p className="settings-description">
          You have two options for sending SMS: use a phone number assigned by your administrator, or connect your own provider.
        </p>

        {/* Option 1: Assigned Pool Phone */}
        <div className="settings-section pool-phone-section">
          <div className="section-header">
            <h2>
              <PhoneCall size={18} />
              Option 1: Admin-Assigned Phone
            </h2>
          </div>
          {loadingPoolPhone ? (
            <div className="loading-container">
              <Loader2 size={20} className="spinner" />
            </div>
          ) : poolPhones.length > 0 ? (
            <div className="pool-phone-cards">
              {poolPhones.map(phone => (
                <div key={phone.id} className="pool-phone-card">
                  <div className="pool-phone-info">
                    <span className="pool-phone-number">{phone.phoneNumber}</span>
                    <span className="provider-badge">LeadBridge</span>
                  </div>
                  <div className="pool-phone-meta">
                    {phone.areaCode && <span>Area code: {phone.areaCode}</span>}
                    {phone.friendlyName && <span>{phone.friendlyName}</span>}
                  </div>
                </div>
              ))}
              <p className="pool-phone-note">
                Assigned by administrator. Used as default sender for SMS alerts.
              </p>
            </div>
          ) : (
            <p className="pool-phone-note">
              No phone assigned yet. Your administrator can assign a phone number from the pool.
            </p>
          )}
        </div>

        {/* Option 2: Connect Your Own Provider - Coming Soon */}
        <div className="settings-section provider-connection coming-soon-card">
          <div className="section-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <h2 style={{ opacity: 0.5 }}>
              <Phone size={18} />
              Option 2: Connect Your Own Provider
            </h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Coming Soon</span>
              <div
                className="toggle-switch disabled"
                style={{ opacity: 0.5, pointerEvents: 'none' }}
              >
                <input type="checkbox" checked={false} readOnly />
                <span className="toggle-slider"></span>
              </div>
            </div>
          </div>
          <p style={{ fontSize: '14px', color: 'var(--text-muted)', margin: 0 }}>
            Connect your own OpenPhone or LeadBridge account to use your own phone numbers for SMS notifications.
          </p>
        </div>
      </div>
    </div>
  );
}
