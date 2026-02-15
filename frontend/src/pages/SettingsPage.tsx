import { useState, useEffect } from 'react';
import { Settings, CheckCircle, AlertCircle, Rocket, Zap, Lock, MessageSquare, PhoneCall, Reply, Download, ChevronDown, ChevronUp, Loader2, X } from 'lucide-react';
import { billingApi, thumbtackApi, leadsApi, usersApi } from '../services/api';
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

  // Import negotiations state
  const [importCollapsed, setImportCollapsed] = useState(true);
  const [importAccountId, setImportAccountId] = useState<string | null>(null);
  const [importIds, setImportIds] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<{ id: string; success: boolean; isNew?: boolean; error?: string }[]>([]);
  const [importTotal, setImportTotal] = useState(0);
  const [showImportResults, setShowImportResults] = useState(false);
  const [importError, setImportError] = useState('');

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

  const handleImportNegotiations = async () => {
    if (!importAccountId) { setImportError('Select an account first'); return; }
    const ids = importIds.split(/[,\n\t\s]+/).map(id => id.trim()).filter(id => id.length > 0);
    if (ids.length === 0) { setImportError('Enter at least one negotiation ID'); return; }

    setImporting(true);
    setImportError('');
    setImportResults([]);

    // Validate token first
    try {
      const validation = await thumbtackApi.validateToken(importAccountId);
      if (!validation.valid) {
        setImportError('Session expired. Please reconnect this account from the Overview page, then try again.');
        setImporting(false);
        return;
      }
    } catch {
      setImportError('Session expired. Please reconnect this account from the Overview page, then try again.');
      setImporting(false);
      return;
    }

    setImportTotal(ids.length);
    setShowImportResults(true);

    const results: typeof importResults = [];
    for (const id of ids) {
      try {
        const result = await leadsApi.importNegotiation(id, importAccountId);
        results.push({ id, success: true, isNew: result.isNew });
      } catch (err: any) {
        const errorMsg = err.response?.data?.message || err.response?.data?.error || err.message || 'Failed to import';
        results.push({ id, success: false, error: errorMsg });
      }
      setImportResults([...results]);
    }

    setImporting(false);
    const newCount = results.filter(r => r.success && r.isNew).length;
    const failCount = results.filter(r => !r.success).length;
    if (newCount > 0 && failCount === 0) {
      notify.success('Import Complete', `Successfully imported ${newCount} negotiation(s)`);
      setImportIds('');
    } else if (failCount > 0 && newCount > 0) {
      notify.warning('Import Partial', `${newCount} imported, ${failCount} failed`);
    } else if (failCount > 0) {
      setImportError(`Failed to import all ${failCount} negotiation(s)`);
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
  const isActivePaid = hasSubscription && !isCancelled && subscription?.status !== 'TRIALING';
  const trial = subscription?.trial;
  const isTrialActive = trial?.isOnTrial && !trial?.trialExpired;
  const isTrialExpired = trial?.trialExpired;
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

          {/* Import Negotiations - collapsible */}
          {accounts.length > 0 && (
            <div className="import-section-collapsible" style={{ marginTop: '12px' }}>
              <div className="import-section-header" onClick={() => setImportCollapsed(!importCollapsed)}>
                <h3>
                  <Download size={16} />
                  Import Negotiations
                </h3>
                {importCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
              </div>

              <div className={`import-section-content ${importCollapsed ? 'collapsed' : ''}`}>
                {importError && (
                  <div style={{
                    background: '#fef2f2', border: '1px solid #fecaca', borderRadius: '8px',
                    padding: '10px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px',
                    fontSize: '13px', color: '#991b1b',
                  }}>
                    <AlertCircle size={14} style={{ flexShrink: 0 }} />
                    <span>{importError}</span>
                    <button
                      className="btn-icon"
                      onClick={() => setImportError('')}
                      style={{ marginLeft: 'auto', padding: '2px' }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                )}

                <div style={{ marginBottom: '12px' }}>
                  <label style={{ fontSize: '13px', fontWeight: 500, color: '#475569', display: 'block', marginBottom: '6px' }}>
                    Account
                  </label>
                  <select
                    className="account-dropdown"
                    value={importAccountId || ''}
                    onChange={(e) => setImportAccountId(e.target.value || null)}
                    style={{ width: '100%', padding: '8px 12px', borderRadius: '6px', border: '1px solid #e2e8f0', fontSize: '14px' }}
                  >
                    <option value="">Select account...</option>
                    {accounts.map(a => (
                      <option key={a.id} value={a.id}>{a.businessName}</option>
                    ))}
                  </select>
                </div>

                <textarea
                  className="import-textarea"
                  placeholder={'Paste negotiation IDs here...\n\nExample: abc123, def456, ghi789'}
                  value={importIds}
                  onChange={(e) => setImportIds(e.target.value)}
                  disabled={importing}
                  rows={4}
                />

                <div className="import-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={handleImportNegotiations}
                    disabled={importing || !importIds.trim() || !importAccountId}
                  >
                    {importing ? (
                      <><Loader2 className="spinner" size={14} /> Importing...</>
                    ) : (
                      <><Download size={14} /> Import</>
                    )}
                  </button>
                  {importIds && !importing && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => { setImportIds(''); setImportResults([]); setShowImportResults(false); setImportError(''); }}
                    >
                      <X size={14} /> Clear
                    </button>
                  )}
                </div>

                {/* Import Progress */}
                {importing && importTotal > 0 && (
                  <div style={{ marginTop: '12px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                      <span style={{ fontSize: '13px', fontWeight: 500 }}>Importing...</span>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {importResults.length} / {importTotal}
                      </span>
                    </div>
                    <div style={{
                      width: '100%', height: '6px', background: 'var(--border, #e5e7eb)',
                      borderRadius: '3px', overflow: 'hidden',
                    }}>
                      <div style={{
                        width: `${(importResults.length / importTotal) * 100}%`,
                        height: '100%', background: 'var(--primary, #3b82f6)',
                        borderRadius: '3px', transition: 'width 0.3s ease',
                      }} />
                    </div>
                  </div>
                )}

                {/* Import Results */}
                {showImportResults && importResults.length > 0 && !importing && (
                  <div className="import-results" style={{ marginTop: '12px' }}>
                    <h4 style={{ fontSize: '13px' }}>Results ({importResults.length} / {importTotal})</h4>
                    <div className="results-list">
                      {importResults.map((result, idx) => (
                        <div key={idx} className={`result-item ${result.success ? (result.isNew ? 'success' : 'duplicate') : 'failed'}`}>
                          <span className="result-id">{result.id}</span>
                          {result.success ? (
                            <span className="result-status">
                              <CheckCircle size={14} className={`result-icon ${result.isNew ? 'success' : 'duplicate'}`} />
                              {result.isNew ? 'New' : 'Exists'}
                            </span>
                          ) : (
                            <span className="result-error">
                              <AlertCircle size={14} className="result-icon failed" />
                              {result.error}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
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

        {/* STATE 1: Free Trial Active */}
        {isTrialActive && !isActivePaid && trial && (
          <div className="billing-state-trial">
            <div className="billing-trial-header">
              <div className="billing-trial-badge">
                <Rocket size={18} />
                <span>Free Trial Active</span>
              </div>
            </div>
            <div className="billing-trial-details">
              <div className="billing-trial-stat">
                <span className="billing-trial-stat-label">Days Remaining</span>
                <span className="billing-trial-stat-value">{trial.trialDaysRemaining}</span>
              </div>
              <div className="billing-trial-stat">
                <span className="billing-trial-stat-label">Leads Used</span>
                <span className="billing-trial-stat-value">{trial.trialLeadsHandled} / {trial.trialLeadsLimit}</span>
              </div>
              {trial.trialEndDate && (
                <div className="billing-trial-stat">
                  <span className="billing-trial-stat-label">Trial Ends</span>
                  <span className="billing-trial-stat-value">
                    {new Date(trial.trialEndDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}
                  </span>
                </div>
              )}
            </div>
            <p className="billing-trial-note">
              After your trial, choose a plan starting at ${tierPrices.STARTER}/month.
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <Link to="/pricing" className="btn btn-primary btn-sm">
                <Zap size={14} /> Choose a Plan
              </Link>
            </div>
          </div>
        )}

        {/* STATE 2: Trial Expired / No Plan */}
        {isTrialExpired && !isActivePaid && (
          <div className="billing-state-expired">
            <div className="billing-expired-header">
              <AlertCircle size={22} />
              <h3>Subscription Required</h3>
            </div>
            <p className="billing-expired-text">Your trial has ended. Upgrade to continue using automation.</p>
            <div className="billing-feature-locks">
              <div className="billing-feature-lock">
                <Lock size={14} />
                <Reply size={14} />
                <span>Auto Reply</span>
              </div>
              <div className="billing-feature-lock">
                <Lock size={14} />
                <MessageSquare size={14} />
                <span>Follow-Ups</span>
              </div>
              <div className="billing-feature-lock">
                <Lock size={14} />
                <MessageSquare size={14} />
                <span>Customer SMS</span>
              </div>
              <div className="billing-feature-lock">
                <Lock size={14} />
                <PhoneCall size={14} />
                <span>Call Connect</span>
              </div>
            </div>
            <Link to="/pricing" className="btn btn-primary btn-sm" style={{ marginTop: '16px' }}>
              <Zap size={14} /> View Plans
            </Link>
          </div>
        )}

        {/* STATE 2b: No trial data at all, no subscription */}
        {!isTrialActive && !isTrialExpired && !isActivePaid && !isCancelled && (
          <div className="billing-state-expired">
            <div className="billing-expired-header">
              <Rocket size={22} />
              <h3>Start Your Plan</h3>
            </div>
            <p className="billing-expired-text">Unlock powerful features for lead management and automation.</p>
            <div className="billing-feature-locks" style={{ borderColor: '#e0e7ff' }}>
              <div className="billing-feature-lock" style={{ color: '#4f46e5' }}>
                <CheckCircle size={14} />
                <span>Auto Reply</span>
              </div>
              <div className="billing-feature-lock" style={{ color: '#4f46e5' }}>
                <CheckCircle size={14} />
                <span>Follow-Ups</span>
              </div>
              <div className="billing-feature-lock" style={{ color: '#4f46e5' }}>
                <CheckCircle size={14} />
                <span>Customer SMS</span>
              </div>
              <div className="billing-feature-lock" style={{ color: '#4f46e5' }}>
                <CheckCircle size={14} />
                <span>Call Connect</span>
              </div>
            </div>
            <Link to="/pricing" className="btn btn-primary btn-sm" style={{ marginTop: '16px' }}>
              <Zap size={14} /> View Plans
            </Link>
          </div>
        )}

        {/* STATE 3: Active Paid Subscription */}
        {isActivePaid && subscription && (
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
                </div>
                <div style={{ fontSize: '13px', color: '#94a3b8' }}>/month</div>
              </div>
            </div>

            {subscription.cancelAtPeriodEnd && subscription.periodEnd && (
              <div className="subscription-notice cancelled-notice" style={{ backgroundColor: '#fff3cd', borderColor: '#ffc107' }}>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9h2v5H9V9zm0-4h2v2H9V5z" fill="currentColor" style={{ color: '#856404' }}/>
                </svg>
                <div>
                  <strong style={{ color: '#856404' }}>Subscription Ending</strong>
                  <p style={{ color: '#856404' }}>You'll continue to have access until {new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Reactivate anytime through the billing portal.</p>
                </div>
              </div>
            )}

            {!subscription.cancelAtPeriodEnd && subscription.periodEnd && (
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
        )}

        {/* STATE 3b: Cancelled subscription */}
        {isCancelled && subscription && (
          <>
            <div className="subscription-notice cancelled-notice">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M10 18a8 8 0 100-16 8 8 0 000 16zM9 9h2v5H9V9zm0-4h2v2H9V5z" fill="currentColor"/>
              </svg>
              <div>
                <strong>Subscription Cancelled</strong>
                <p>Your subscription has been cancelled. {subscription.periodEnd && `Access continues until ${new Date(subscription.periodEnd).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}.`} Reactivate anytime.</p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '10px', marginTop: '16px' }}>
              <button
                className="btn btn-primary btn-sm"
                onClick={handleManageSubscription}
                disabled={portalLoading}
              >
                {portalLoading ? 'Opening...' : 'Reactivate'}
              </button>
              <Link to="/pricing" className="btn btn-secondary btn-sm">
                View Plans
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
