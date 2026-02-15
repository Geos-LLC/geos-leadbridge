import { useState, useEffect } from 'react';
import { Settings, CheckCircle, AlertCircle, CreditCard } from 'lucide-react';
import { billingApi, thumbtackApi, usersApi } from '../services/api';
import { notify } from '../store/notificationStore';
import { useAuthStore } from '../store/authStore';
import type { SubscriptionDetails, SavedAccount } from '../types';
import { Link } from 'react-router-dom';

const tierNames: Record<string, string> = {
  STARTER: 'Instant Reply',
  PRO: 'Call Assist',
  ENTERPRISE: 'AI Conversations',
};

const tierPrices: Record<string, number> = {
  STARTER: 49,
  PRO: 99,
  ENTERPRISE: 129,
};

export default function SettingsPage() {
  const user = useAuthStore(state => state.user);
  const setAuth = useAuthStore(state => state.setAuth);
  const [subscription, setSubscription] = useState<SubscriptionDetails | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [portalLoading, setPortalLoading] = useState(false);
  const [provisioningPhone, setProvisioningPhone] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      setLoading(true);
      const [subResult, acctResult] = await Promise.all([
        billingApi.getSubscription().catch(() => null),
        thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
      ]);
      setSubscription(subResult);
      setAccounts(acctResult.accounts);
    } catch (error: any) {
      console.error('Failed to load settings data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleManageSubscription = async () => {
    try {
      setPortalLoading(true);
      const { portalUrl } = await billingApi.createPortalSession();
      window.location.href = portalUrl;
    } catch (error: any) {
      console.error('Failed to open billing portal:', error);
      notify.error('Error', 'Failed to open billing portal');
      setPortalLoading(false);
    }
  };

  const handleProvisionPhone = async () => {
    try {
      setProvisioningPhone(true);
      const result = await usersApi.provisionPhoneNumber();

      if (result.phoneNumber) {
        notify.success('Success', `Phone number ${result.phoneNumber} provisioned successfully!`);
        if (user) {
          const token = localStorage.getItem('token');
          if (token) {
            setAuth({ ...user, phoneNumber: result.phoneNumber }, token);
          }
        }
      } else {
        notify.error('Error', result.message || 'Failed to provision phone number');
      }
    } catch (error: any) {
      console.error('Failed to provision phone:', error);
      notify.error('Error', error.response?.data?.message || 'Failed to provision phone number');
    } finally {
      setProvisioningPhone(false);
    }
  };

  if (loading) {
    return (
      <div className="settings-page">
        <div className="settings-page-header">
          <Settings size={24} />
          <div>
            <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Settings</h1>
          </div>
        </div>
        <div className="loading-state">
          <p>Loading settings...</p>
        </div>
      </div>
    );
  }

  const hasSubscription = Boolean(subscription?.tier && subscription?.status);
  const isCancelled = subscription?.status === 'CANCELLED';
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  return (
    <div className="settings-page">
      <div className="settings-page-header">
        <Settings size={24} />
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: 0 }}>Settings</h1>
          <p style={{ fontSize: '14px', color: '#64748b', margin: 0 }}>Account, connections & subscription</p>
        </div>
      </div>

      {/* Section 1: Account Info */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Account Info</h2>
        <div className="settings-field-grid">
          <div className="settings-field">
            <label>Name</label>
            <div className="settings-field-value">{user?.name || 'Not set'}</div>
          </div>
          <div className="settings-field">
            <label>Email</label>
            <div className="settings-field-value">{user?.email || 'Not set'}</div>
          </div>
          {user?.phoneNumber && (
            <div className="settings-field">
              <label>Notification Number</label>
              <div className="settings-field-value" style={{ fontFamily: 'monospace' }}>{user.phoneNumber}</div>
            </div>
          )}
          <div className="settings-field">
            <label>Time Zone</label>
            <div className="settings-field-value">{timeZone}</div>
          </div>
        </div>
        {!user?.phoneNumber && (
          <div style={{ marginTop: '16px', padding: '12px 16px', background: '#f8fafc', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ fontSize: '13px', color: '#64748b', marginBottom: '10px' }}>
              Get a dedicated phone number for SMS notifications from your leads.
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={handleProvisionPhone}
              disabled={provisioningPhone}
            >
              {provisioningPhone ? 'Provisioning...' : 'Get Phone Number'}
            </button>
          </div>
        )}
      </div>

      {/* Section 2: Marketplace Connections */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Marketplace Connections</h2>

        {/* Thumbtack */}
        <div className="settings-connection-group">
          <div className="settings-connection-group-header">
            <div className="platform-logo thumbtack-logo" style={{ width: '28px', height: '28px', fontSize: '11px' }}>TT</div>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Thumbtack</span>
          </div>
          {accounts.length > 0 ? (
            <div className="settings-connections-list">
              {accounts.map(account => (
                <div key={account.id} className="settings-connection-row">
                  <div className="settings-connection-info">
                    <span className="settings-connection-name">{account.businessName}</span>
                    <span className="settings-connection-meta">ID: {account.businessId}</span>
                  </div>
                  <span className={`connection-badge ${account.webhookId ? 'connected' : 'disconnected'}`}>
                    {account.webhookId ? (
                      <><CheckCircle size={12} /> Connected</>
                    ) : (
                      <><AlertCircle size={12} /> Disconnected</>
                    )}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '12px 16px', background: '#f8fafc', borderRadius: '8px', fontSize: '13px', color: '#94a3b8' }}>
              No accounts connected. Connect from the Overview page.
            </div>
          )}
        </div>

        {/* Yelp */}
        <div className="settings-connection-group" style={{ marginTop: '16px' }}>
          <div className="settings-connection-group-header">
            <div className="platform-logo yelp-logo" style={{ width: '28px', height: '28px', fontSize: '12px', fontWeight: 700 }}>Y</div>
            <span style={{ fontWeight: 600, fontSize: '15px' }}>Yelp</span>
            <span className="connection-badge coming-soon">Coming Soon</span>
          </div>
        </div>
      </div>

      {/* Section 3: Subscription & Billing */}
      <div className="settings-section-card">
        <h2 className="settings-section-title">Subscription & Billing</h2>

        {hasSubscription && subscription ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
              <div>
                <h3 style={{ fontSize: '18px', fontWeight: 700, margin: 0 }}>
                  {subscription.tier ? tierNames[subscription.tier] : 'Unknown'} Plan
                </h3>
                <div className={`subscription-status status-${subscription.status?.toLowerCase()}`} style={{ marginTop: '6px' }}>
                  {subscription.status}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: '28px', fontWeight: 700, color: '#1e293b' }}>
                  ${subscription.tier ? tierPrices[subscription.tier] : 0}
                  {subscription.hasOwnNumber && ' + $29'}
                </div>
                <div style={{ fontSize: '13px', color: '#94a3b8' }}>/month</div>
              </div>
            </div>

            {isCancelled && (
              <div className="subscription-notice cancelled-notice">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9h2v5H9V9zm0-4h2v2H9V5z" fill="currentColor"/>
                </svg>
                <div>
                  <strong>Subscription Cancelled</strong>
                  <p>Your subscription has been cancelled. {subscription.periodEnd && `Access will continue until ${new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`} You can reactivate anytime through the billing portal.</p>
                </div>
              </div>
            )}

            {!isCancelled && subscription.cancelAtPeriodEnd && subscription.periodEnd && (
              <div className="subscription-notice cancelled-notice" style={{ backgroundColor: '#fff3cd', borderColor: '#ffc107' }}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9h2v5H9V9zm0-4h2v2H9V5z" fill="currentColor" style={{ color: '#856404' }}/>
                </svg>
                <div>
                  <strong style={{ color: '#856404' }}>Subscription Ending</strong>
                  <p style={{ color: '#856404' }}>You've cancelled your subscription. You'll continue to have access until {new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. You can reactivate anytime through the billing portal.</p>
                </div>
              </div>
            )}

            {!isCancelled && !subscription.cancelAtPeriodEnd && subscription.periodEnd && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: '#475569', marginBottom: '12px' }}>
                <span>Next billing date</span>
                <span style={{ fontWeight: 600 }}>
                  {new Date(subscription.periodEnd).toLocaleDateString('en-US', {
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </span>
              </div>
            )}

            {subscription.hasOwnNumber && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', color: '#475569', marginBottom: '12px' }}>
                <span>Add-ons</span>
                <span style={{ fontWeight: 600 }}>Own Business Number (+$29/month)</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? 'Opening...' : 'Manage Subscription'}
              </button>
              <Link to="/pricing" className="btn btn-secondary btn-sm">
                View All Plans
              </Link>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '24px 0' }}>
            <CreditCard size={40} style={{ color: '#cbd5e1', marginBottom: '12px' }} />
            <h3 style={{ fontSize: '16px', fontWeight: 600, margin: '0 0 8px' }}>No Active Subscription</h3>
            <p style={{ fontSize: '14px', color: '#94a3b8', marginBottom: '16px' }}>
              Subscribe to unlock powerful features for lead management and automation
            </p>
            <Link to="/pricing" className="btn btn-primary btn-sm">
              View Pricing Plans
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
