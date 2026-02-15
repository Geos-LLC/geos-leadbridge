import { useEffect, useState, useRef } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { AlertCircle, CheckCircle, Loader2, RefreshCw, Settings, X, Rocket, Link2 } from 'lucide-react';
import { platformsApi, thumbtackApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { notify } from '../store/notificationStore';
import { useDashboardData } from '../hooks/useDashboardData';
import SystemHealth from '../components/dashboard/SystemHealth';
import TodaysActivity from '../components/dashboard/TodaysActivity';
import AttentionNeeded from '../components/dashboard/AttentionNeeded';
import ConversionSnapshot from '../components/dashboard/ConversionSnapshot';
import AccountManagement from '../components/dashboard/AccountManagement';

const SELECTED_ACCOUNT_KEY = 'dashboard_selected_account';

export function Dashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const {
    setPlatforms,
    savedAccounts: storeAccounts, setSavedAccounts, removeSavedAccount: removeFromStore,
  } = useAppStore();

  // Selected account (persisted) for dashboard data filtering
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED_ACCOUNT_KEY);
    } catch {
      return null;
    }
  });

  // Dashboard data hook
  const dashboardData = useDashboardData(selectedAccountId);
  const savedAccounts = dashboardData.savedAccounts.length > 0
    ? dashboardData.savedAccounts
    : storeAccounts;

  // Connection / loading state
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Account management state
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [confirmRemoveAccount, setConfirmRemoveAccount] = useState<{ id: string; name: string } | null>(null);
  const [deleteLeadsOnRemove, setDeleteLeadsOnRemove] = useState(false);
  const [togglingWebhookId, setTogglingWebhookId] = useState<string | null>(null);

  // Inline settings card
  const [settingsExpanded, setSettingsExpanded] = useState(false);

  // Modals
  const [disconnectWarning, setDisconnectWarning] = useState<{
    accountId: string; accountName: string; errorCode: string; errorMessage: string; warning: string;
  } | null>(null);

  // Health check — toast once per session
  const healthCheckDone = useRef(false);

  // Auto-select first account if none selected
  useEffect(() => {
    if (!selectedAccountId && savedAccounts.length > 0) {
      const id = savedAccounts[0].id;
      setSelectedAccountId(id);
      localStorage.setItem(SELECTED_ACCOUNT_KEY, id);
    }
  }, [savedAccounts, selectedAccountId]);

  // Handle OAuth callback params
  useEffect(() => {
    const connected = searchParams.get('connected');
    const oauthError = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    const warning = searchParams.get('warning');
    const skippedAccounts = searchParams.get('skipped_accounts');

    if (connected === 'thumbtack') {
      if (warning === 'already_connected' && skippedAccounts) {
        setSuccess(`Login refreshed for ${skippedAccounts}.`);
      } else {
        setSuccess('Thumbtack account connected successfully!');
      }
      loadPlatformStatus();
      loadSavedAccounts();
      dashboardData.refresh();
      setSearchParams({});
    } else if (oauthError) {
      setError(errorDescription || `OAuth error: ${oauthError}`);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  // Initial loads
  useEffect(() => {
    loadPlatformStatus();
    loadSavedAccounts();
    runHealthCheck();
  }, []);

  // Health check toast
  useEffect(() => {
    if (healthCheckDone.current || dashboardData.healthIssues.length === 0) return;
    healthCheckDone.current = true;
    for (const issue of dashboardData.healthIssues) {
      if (issue.severity === 'error') {
        notify.error(issue.title, issue.message, 3000);
      } else {
        notify.warning(issue.title, issue.message, 3000);
      }
    }
  }, [dashboardData.healthIssues]);

  const loadSavedAccounts = async () => {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setSavedAccounts(accounts);
    } catch (err) {
      console.error('Failed to load saved accounts:', err);
    }
  };

  const loadPlatformStatus = async () => {
    try {
      const { platforms } = await platformsApi.getStatus();
      setPlatforms(platforms);
    } catch (err) {
      console.error('Failed to load platform status:', err);
    }
  };

  const runHealthCheck = async () => {
    if (healthCheckDone.current) return;
    try {
      const { issues } = await platformsApi.getHealth();
      healthCheckDone.current = true;
      for (const issue of issues) {
        if (issue.severity === 'error') {
          notify.error(issue.title, issue.message, 3000);
        } else {
          notify.warning(issue.title, issue.message, 3000);
        }
      }
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  const handleConnectThumbtack = async () => {
    const logoutWindow = window.open('https://www.thumbtack.com/logout', '_blank', 'width=600,height=400');
    setTimeout(async () => {
      if (logoutWindow) logoutWindow.close();
      setConnecting(true);
      setError('');
      try {
        const { authUrl } = await platformsApi.getAuthUrl();
        window.location.href = authUrl;
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to get auth URL');
        setConnecting(false);
      }
    }, 2000);
  };

  const handleDisconnectWebhook = async (account: { id: string; businessName: string }) => {
    setTogglingWebhookId(account.id);
    setError('');
    try {
      const result = await thumbtackApi.disconnectAccount(account.id);
      setSavedAccounts(savedAccounts.map(a =>
        a.id === account.id ? { ...a, webhookId: null } : a
      ));
      if (!result.webhookDeleted && result.errorCode && result.errorCode !== 'webhook_not_found') {
        setDisconnectWarning({
          accountId: account.id, accountName: account.businessName,
          errorCode: result.errorCode,
          errorMessage: result.errorMessage || 'Could not remove webhook from Thumbtack.',
          warning: result.warning || 'Thumbtack may continue sending messages.',
        });
      } else {
        setSuccess(`Webhook disconnected for ${account.businessName}`);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to disconnect webhook');
    } finally {
      setTogglingWebhookId(null);
    }
  };

  const handleReconnectWebhook = async (account: { id: string; businessName: string; emailHint?: string }) => {
    const emailHint = account.emailHint ? ` with ${account.emailHint}` : '';
    setSuccess(`Reconnecting ${account.businessName}${emailHint}. Please log in when prompted.`);
    const logoutWindow = window.open('https://www.thumbtack.com/logout', '_blank', 'width=600,height=400');
    setTimeout(async () => {
      if (logoutWindow) logoutWindow.close();
      setConnecting(true);
      setError('');
      try {
        const { authUrl } = await platformsApi.getAuthUrl();
        window.location.href = authUrl;
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to get auth URL');
        setConnecting(false);
      }
    }, 2000);
  };

  const handleRemoveSavedAccount = async () => {
    if (!confirmRemoveAccount) return;
    setRemovingAccountId(confirmRemoveAccount.id);
    try {
      const result = await thumbtackApi.removeSavedAccount(confirmRemoveAccount.id, deleteLeadsOnRemove);
      removeFromStore(confirmRemoveAccount.id);
      if (deleteLeadsOnRemove && result.deletedLeads > 0) {
        setSuccess(`Account removed along with ${result.deletedLeads} leads`);
      } else {
        setSuccess('Account removed');
      }
      dashboardData.refresh();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove saved account');
    } finally {
      setRemovingAccountId(null);
      setConfirmRemoveAccount(null);
      setDeleteLeadsOnRemove(false);
    }
  };

  const handleUpdateEmail = async (accountId: string, email: string) => {
    await thumbtackApi.updateSavedAccount(accountId, { emailHint: email });
    setSavedAccounts(savedAccounts.map(a =>
      a.id === accountId ? { ...a, emailHint: email } : a
    ));
  };

  if (dashboardData.loading && savedAccounts.length === 0) {
    return (
      <div className="loading-container">
        <Loader2 className="spinner" size={48} />
        <p>Loading...</p>
      </div>
    );
  }

  const hasAccounts = savedAccounts.length > 0;

  return (
    <div className="dashboard">
      <header className="dashboard-header-card">
        <div className="dashboard-header-top">
          <div>
            <h1>Overview</h1>
            <p>Welcome back, {user?.name || user?.email}</p>
          </div>
          <button
            className={`dashboard-settings-toggle ${settingsExpanded ? 'active' : ''}`}
            onClick={() => setSettingsExpanded(!settingsExpanded)}
            title="Quick Settings"
          >
            {settingsExpanded ? <X size={20} /> : <Settings size={20} />}
          </button>
        </div>

        {settingsExpanded && (
          <div className="dashboard-settings-panel">
            <div className="dashboard-settings-grid">
              <div className="dashboard-settings-field">
                <label>Name</label>
                <span>{user?.name || 'Not set'}</span>
              </div>
              <div className="dashboard-settings-field">
                <label>Email</label>
                <span>{user?.email || 'Not set'}</span>
              </div>
              <div className="dashboard-settings-field">
                <label>Time Zone</label>
                <span>{Intl.DateTimeFormat().resolvedOptions().timeZone}</span>
              </div>
              {user?.phoneNumber && (
                <div className="dashboard-settings-field">
                  <label>Phone</label>
                  <span style={{ fontFamily: 'monospace' }}>{user.phoneNumber}</span>
                </div>
              )}
            </div>
            <Link to="/settings" className="dashboard-settings-link">
              <Settings size={14} />
              All Settings
            </Link>
          </div>
        )}
      </header>

      {error && (
        <div className="error-message">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}
      {success && (
        <div className="success-message">
          <CheckCircle size={18} />
          <span>{success}</span>
        </div>
      )}

      {/* ========== NOT CONNECTED: Activation Block ========== */}
      {!hasAccounts && (
        <div className="activation-block">
          <div className="activation-icon">
            <Rocket size={48} />
          </div>
          <h2>Connect Your Thumbtack Account</h2>
          <p>To start automating your leads, connect your marketplace account.</p>
          <button
            className="btn btn-primary btn-lg"
            onClick={handleConnectThumbtack}
            disabled={connecting}
          >
            {connecting ? (
              <><Loader2 className="spinner" size={18} /> Connecting...</>
            ) : (
              <><Link2 size={18} /> Connect Thumbtack</>
            )}
          </button>
        </div>
      )}

      {/* ========== CONNECTED: Dashboard ========== */}
      {hasAccounts && (
        <>
          {/* Health Issues Banner */}
          {dashboardData.healthIssues.filter(i => i.severity === 'error').map((issue, index) => (
            <div
              key={`${issue.code}-${index}`}
              className="health-issue-banner"
              style={{
                background: '#fef2f2', border: '2px solid #f87171', borderRadius: '8px',
                padding: '16px 20px', marginBottom: '20px',
                display: 'flex', alignItems: 'flex-start', gap: '12px',
                boxShadow: '0 2px 8px rgba(239, 68, 68, 0.15)',
              }}
            >
              <AlertCircle size={24} style={{ color: '#dc2626', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '16px', color: '#991b1b', marginBottom: '6px' }}>
                  {issue.title}
                </div>
                <div style={{ fontSize: '14px', color: '#b91c1c', marginBottom: '8px' }}>
                  {issue.message}
                </div>
                {issue.action === 'reconnect' && (
                  <div style={{ fontSize: '13px', color: '#7f1d1d' }}>
                    Click "Reconnect" to log in again with your Thumbtack account.
                  </div>
                )}
              </div>
              {(issue.action === 'connect' || issue.action === 'reconnect') && (
                <button
                  className="btn btn-primary"
                  onClick={handleConnectThumbtack}
                  disabled={connecting}
                  style={{ whiteSpace: 'nowrap' }}
                >
                  {connecting ? (
                    <><Loader2 className="spinner" size={16} /> {issue.action === 'reconnect' ? 'Reconnecting...' : 'Connecting...'}</>
                  ) : issue.action === 'reconnect' ? (
                    <><RefreshCw size={16} style={{ marginRight: '6px' }} /> {issue.actionLabel || 'Reconnect'}</>
                  ) : (
                    issue.actionLabel || 'Connect'
                  )}
                </button>
              )}
            </div>
          ))}

          <AccountManagement
            savedAccounts={savedAccounts}
            connecting={connecting}
            onConnectThumbtack={handleConnectThumbtack}
            onDisconnectWebhook={handleDisconnectWebhook}
            onReconnectWebhook={handleReconnectWebhook}
            onRemoveAccount={(account) => {
              setConfirmRemoveAccount({ id: account.id, name: account.businessName });
              setDeleteLeadsOnRemove(false);
            }}
            onUpdateEmail={handleUpdateEmail}
            togglingWebhookId={togglingWebhookId}
            removingAccountId={removingAccountId}
          />

          <section className="dashboard-section">
            <h2>System Health</h2>
            <SystemHealth
              autoReplyEnabled={dashboardData.autoReplyEnabled}
              customerSmsEnabled={dashboardData.customerSmsEnabled}
              leadAlertsEnabled={dashboardData.leadAlertsEnabled}
            />
          </section>

          <section className="dashboard-section">
            <h2>Today's Activity</h2>
            <TodaysActivity
              leadsToday={dashboardData.leadsToday}
              smsSentToday={dashboardData.smsSentToday}
              avgResponseTime={dashboardData.avgResponseTime}
            />
          </section>

          <AttentionNeeded
            unrepliedLeadCount={dashboardData.unrepliedLeadCount}
            failedSmsCount={dashboardData.failedSmsCount}
            healthIssues={dashboardData.healthIssues}
            onScrollToManage={() => {
              document.getElementById('manage-accounts')?.scrollIntoView({ behavior: 'smooth' });
            }}
          />

          <ConversionSnapshot
            leadsLast7Days={dashboardData.leadsLast7Days}
            customerEngagementRate7d={dashboardData.customerEngagementRate7d}
            totalAutoRepliesSent={dashboardData.totalAutoRepliesSent}
            totalSmsSent={dashboardData.totalSmsSent}
          />
        </>
      )}

      {/* Disconnect Warning Modal */}
      {disconnectWarning && (
        <div className="modal-overlay" onClick={() => setDisconnectWarning(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>
              <AlertCircle size={20} style={{ color: '#f59e0b', marginRight: '8px', verticalAlign: 'middle' }} />
              Webhook Disconnect Warning
            </h3>
            <p><strong>{disconnectWarning.accountName}</strong></p>
            <div style={{ background: '#fef3c7', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
              <p style={{ margin: '0 0 8px 0', fontWeight: 500, color: '#92400e' }}>{disconnectWarning.errorMessage}</p>
              <p style={{ margin: 0, fontSize: '13px', color: '#a16207' }}>{disconnectWarning.warning}</p>
            </div>
            <div style={{ marginBottom: '16px' }}>
              <p style={{ fontWeight: 500, marginBottom: '8px' }}>How to fix:</p>
              {disconnectWarning.errorCode === 'token_expired' && (
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <li>Click "Reconnect" below to refresh your Thumbtack connection</li>
                  <li>Then try disconnecting again</li>
                </ul>
              )}
              {disconnectWarning.errorCode === 'permission_denied' && (
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <li>Your Thumbtack permissions may have changed</li>
                  <li>Click "Reconnect" to re-authorize access</li>
                </ul>
              )}
              {disconnectWarning.errorCode === 'network_error' && (
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <li>Check your internet connection</li>
                  <li>Try disconnecting again in a few moments</li>
                </ul>
              )}
              {(disconnectWarning.errorCode === 'unknown' || disconnectWarning.errorCode === 'token_revoked') && (
                <ul style={{ margin: 0, paddingLeft: '20px', fontSize: '14px', color: 'var(--text-secondary)' }}>
                  <li>Try reconnecting your Thumbtack account</li>
                  <li>Or contact support if the issue persists</li>
                </ul>
              )}
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setDisconnectWarning(null)}>Close</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const account = savedAccounts.find(a => a.id === disconnectWarning.accountId);
                  if (account) { setDisconnectWarning(null); handleReconnectWebhook(account); }
                }}
              >
                <RefreshCw size={16} style={{ marginRight: '6px' }} /> Reconnect Account
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Remove Account Confirmation Modal */}
      {confirmRemoveAccount && (
        <div className="modal-overlay" onClick={() => setConfirmRemoveAccount(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>Remove Account</h3>
            <p>Are you sure you want to remove <strong>{confirmRemoveAccount.name}</strong>?</p>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={deleteLeadsOnRemove}
                onChange={(e) => setDeleteLeadsOnRemove(e.target.checked)}
              />
              Also delete all leads and messages from this account
            </label>
            <p className="modal-hint">
              {deleteLeadsOnRemove
                ? 'This will permanently delete all leads and conversations from this account.'
                : 'Leads will be kept but hidden from the Messages page.'}
            </p>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setConfirmRemoveAccount(null)}>Cancel</button>
              <button
                className="btn btn-danger"
                onClick={handleRemoveSavedAccount}
                disabled={removingAccountId === confirmRemoveAccount.id}
              >
                {removingAccountId === confirmRemoveAccount.id ? (
                  <><Loader2 className="spinner" size={16} /> Removing...</>
                ) : (
                  'Remove Account'
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
