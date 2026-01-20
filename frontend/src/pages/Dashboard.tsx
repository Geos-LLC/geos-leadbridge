import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink, Download, X, Unlink, Trash2, Mail, Pencil, Check, RefreshCw } from 'lucide-react';
import { platformsApi, thumbtackApi, leadsApi, type HealthIssue } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import { notify } from '../store/notificationStore';

interface ImportResult {
  id: string;
  success: boolean;
  isNew?: boolean;
  error?: string;
}

export function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const {
    setPlatforms,
    savedAccounts, setSavedAccounts, removeSavedAccount: removeFromStore
  } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Import negotiations state
  const [importIds, setImportIds] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [showImportResults, setShowImportResults] = useState(false);
  const [selectedImportAccountId, setSelectedImportAccountId] = useState<string | null>(null);

  // Account management state
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [confirmRemoveAccount, setConfirmRemoveAccount] = useState<{ id: string; name: string } | null>(null);
  const [deleteLeadsOnRemove, setDeleteLeadsOnRemove] = useState(false);

  // Email editing state
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editEmailValue, setEditEmailValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

  // Webhook disconnect/reconnect state
  const [togglingWebhookId, setTogglingWebhookId] = useState<string | null>(null);

  // Disconnect warning modal state
  const [disconnectWarning, setDisconnectWarning] = useState<{
    accountId: string;
    accountName: string;
    errorCode: string;
    errorMessage: string;
    warning: string;
  } | null>(null);

  // Health check state - track issues and whether we've shown notifications
  const [healthIssues, setHealthIssues] = useState<HealthIssue[]>([]);
  const healthCheckDone = useRef(false);

  // Session expired state - track which account needs reconnection
  const [sessionExpiredAccount, setSessionExpiredAccount] = useState<{
    id: string;
    businessName: string;
    emailHint?: string;
  } | null>(null);

  // Handle OAuth callback params
  useEffect(() => {
    const connected = searchParams.get('connected');
    const oauthError = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');
    const warning = searchParams.get('warning');
    const skippedAccounts = searchParams.get('skipped_accounts');

    if (connected === 'thumbtack') {
      // Check if any accounts were skipped because they're already connected
      if (warning === 'already_connected' && skippedAccounts) {
        setError(`The following account(s) already have active webhooks and were skipped: ${skippedAccounts}. To reconnect, first disconnect the webhook from the existing connection.`);
      } else {
        setSuccess('Thumbtack account connected successfully!');
      }
      // Reload platform status and saved accounts to reflect the new connection
      loadPlatformStatus();
      loadSavedAccounts();
      // Clear the URL params
      setSearchParams({});
    } else if (oauthError) {
      setError(errorDescription || `OAuth error: ${oauthError}`);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    loadPlatformStatus();
    loadSavedAccounts();
    runHealthCheck();
  }, []);

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
    } finally {
      setLoading(false);
    }
  };

  // Run health check and show toast notifications for any issues
  const runHealthCheck = async () => {
    // Only run once per session to avoid spamming notifications
    if (healthCheckDone.current) return;

    try {
      const { issues } = await platformsApi.getHealth();
      setHealthIssues(issues);

      // Show toast notifications for each issue (only once)
      healthCheckDone.current = true;

      for (const issue of issues) {
        if (issue.severity === 'error') {
          notify.error(issue.title, issue.message, 2000); // auto-dismiss after 2 seconds
        } else {
          notify.warning(issue.title, issue.message, 2000); // auto-dismiss after 2 seconds
        }
      }
    } catch (err) {
      console.error('Health check failed:', err);
    }
  };

  const handleConnectThumbtack = async () => {
    // Open Thumbtack logout in a new window first to clear any existing session
    const logoutWindow = window.open('https://www.thumbtack.com/logout', '_blank', 'width=600,height=400');

    // Wait a moment for logout to process, then close popup and redirect to OAuth
    setTimeout(async () => {
      if (logoutWindow) {
        logoutWindow.close();
      }

      setConnecting(true);
      setError('');
      try {
        const { authUrl } = await platformsApi.getAuthUrl();
        window.location.href = authUrl;
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to get auth URL');
        setConnecting(false);
      }
    }, 2000); // 2 second delay to allow logout to complete
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
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove saved account');
    } finally {
      setRemovingAccountId(null);
      setConfirmRemoveAccount(null);
      setDeleteLeadsOnRemove(false);
    }
  };

  const openRemoveConfirmation = (account: { id: string; businessName: string }) => {
    setConfirmRemoveAccount({ id: account.id, name: account.businessName });
    setDeleteLeadsOnRemove(false);
  };

  const startEditingEmail = (account: { id: string; emailHint?: string }) => {
    setEditingEmailId(account.id);
    setEditEmailValue(account.emailHint || '');
  };

  const cancelEditingEmail = () => {
    setEditingEmailId(null);
    setEditEmailValue('');
  };

  const saveEmail = async (accountId: string) => {
    setSavingEmail(true);
    try {
      await thumbtackApi.updateSavedAccount(accountId, { emailHint: editEmailValue });
      // Update local state
      setSavedAccounts(savedAccounts.map(a =>
        a.id === accountId ? { ...a, emailHint: editEmailValue } : a
      ));
      setEditingEmailId(null);
      setEditEmailValue('');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update email');
    } finally {
      setSavingEmail(false);
    }
  };

  const handleDisconnectWebhook = async (account: { id: string; businessName: string }) => {
    setTogglingWebhookId(account.id);
    setError('');
    try {
      const result = await thumbtackApi.disconnectAccount(account.id);

      // Update local state regardless of API result
      setSavedAccounts(savedAccounts.map(a =>
        a.id === account.id ? { ...a, webhookId: null } : a
      ));

      // Check if there was a warning (webhook not fully deleted from Thumbtack)
      if (!result.webhookDeleted && result.errorCode && result.errorCode !== 'webhook_not_found') {
        // Show warning modal with details and solutions
        setDisconnectWarning({
          accountId: account.id,
          accountName: account.businessName,
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
    // Reconnect uses the same OAuth flow as "Add Another Account"
    // Show which email to use if we have it
    const emailHint = account.emailHint ? ` with ${account.emailHint}` : '';
    setSuccess(`Reconnecting ${account.businessName}${emailHint}. Please log in when prompted.`);

    // Open Thumbtack logout in a new window first to clear any existing session
    const logoutWindow = window.open('https://www.thumbtack.com/logout', '_blank', 'width=600,height=400');

    // Wait a moment for logout to process, then close popup and redirect to OAuth
    setTimeout(async () => {
      if (logoutWindow) {
        logoutWindow.close();
      }

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

  const handleImportNegotiations = async () => {
    console.log('[Dashboard] handleImportNegotiations called');
    console.log('[Dashboard] importIds value:', importIds);
    console.log('[Dashboard] selectedImportAccountId:', selectedImportAccountId);

    if (!selectedImportAccountId) {
      setError('Please select an account to import from');
      return;
    }

    // Parse IDs - split by comma, newline, tab, or space
    const ids = importIds
      .split(/[,\n\t\s]+/)
      .map(id => id.trim())
      .filter(id => id.length > 0);

    console.log('[Dashboard] Parsed IDs:', ids);

    if (ids.length === 0) {
      setError('Please enter at least one negotiation ID');
      return;
    }

    setImporting(true);
    setError('');
    setSuccess('');
    setImportResults([]);
    setShowImportResults(true);

    const results: ImportResult[] = [];

    let sessionExpired = false;

    for (const id of ids) {
      console.log('[Dashboard] Importing negotiation:', id, 'for account:', selectedImportAccountId);
      try {
        const result = await leadsApi.importNegotiation(id, selectedImportAccountId);
        console.log('[Dashboard] Import success for', id, result);
        results.push({ id, success: true, isNew: result.isNew });
      } catch (err: any) {
        console.error('[Dashboard] Import failed for', id, err);
        const errorMsg = err.response?.data?.message || 'Failed to import';

        // Check if it's a session expired error
        if (errorMsg.toLowerCase().includes('session') ||
            errorMsg.toLowerCase().includes('reconnect') ||
            errorMsg.toLowerCase().includes('expired')) {
          sessionExpired = true;
        }

        results.push({
          id,
          success: false,
          error: errorMsg,
        });
      }
      // Update results as we go
      setImportResults([...results]);
    }

    setImporting(false);

    const newCount = results.filter(r => r.success && r.isNew).length;
    const updatedCount = results.filter(r => r.success && !r.isNew).length;
    const failCount = results.filter(r => !r.success).length;

    if (sessionExpired) {
      // Show session expired error with reconnect option - handled by sessionExpiredAccount state
      setSessionExpiredAccount(savedAccounts.find(a => a.id === selectedImportAccountId) || null);
    } else if (newCount > 0 && updatedCount === 0 && failCount === 0) {
      setSuccess(`Successfully imported ${newCount} new negotiation(s)`);
      setImportIds('');
    } else if (newCount > 0 || updatedCount > 0) {
      const parts = [];
      if (newCount > 0) parts.push(`${newCount} new`);
      if (updatedCount > 0) parts.push(`${updatedCount} already existed (updated)`);
      if (failCount > 0) parts.push(`${failCount} failed`);
      setSuccess(parts.join(', '));
      if (failCount === 0) setImportIds('');
    } else {
      setError(`Failed to import all ${failCount} negotiation(s)`);
    }
  };

  if (loading) {
    return (
      <div className="loading-container">
        <Loader2 className="spinner" size={48} />
        <p>Loading...</p>
      </div>
    );
  }

  return (
    <div className="dashboard">
      <header className="dashboard-header">
        <div>
          <h1>Dashboard</h1>
          <p>Welcome back, {user?.name || user?.email}</p>
        </div>
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

      {/* Session Expired Banner - shows when import fails due to expired token */}
      {sessionExpiredAccount && (
        <div
          style={{
            background: '#fef2f2',
            border: '2px solid #f87171',
            borderRadius: '8px',
            padding: '16px 20px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'center',
            gap: '16px',
            boxShadow: '0 2px 8px rgba(239, 68, 68, 0.15)',
          }}
        >
          <AlertCircle size={24} style={{ color: '#dc2626', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '16px', color: '#991b1b', marginBottom: '4px' }}>
              Session Expired - {sessionExpiredAccount.businessName}
            </div>
            <div style={{ fontSize: '14px', color: '#b91c1c' }}>
              {sessionExpiredAccount.emailHint
                ? `Please log in with ${sessionExpiredAccount.emailHint} to reconnect this account.`
                : 'Please log in to reconnect this account.'}
            </div>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => {
              setSessionExpiredAccount(null);
              handleReconnectWebhook(sessionExpiredAccount);
            }}
            disabled={connecting}
            style={{ whiteSpace: 'nowrap' }}
          >
            {connecting ? (
              <>
                <Loader2 className="spinner" size={16} />
                Reconnecting...
              </>
            ) : (
              <>
                <RefreshCw size={16} style={{ marginRight: '6px' }} />
                Reconnect Now
              </>
            )}
          </button>
          <button
            className="btn-icon btn-secondary-subtle"
            onClick={() => setSessionExpiredAccount(null)}
            title="Dismiss"
            style={{ flexShrink: 0 }}
          >
            <X size={18} />
          </button>
        </div>
      )}

      {/* Health Issues Banner - persistent warning for critical issues */}
      {healthIssues.filter(i => i.severity === 'error').map((issue, index) => (
        <div
          key={`${issue.code}-${index}`}
          className="health-issue-banner"
          style={{
            background: '#fef2f2',
            border: '2px solid #f87171',
            borderRadius: '8px',
            padding: '16px 20px',
            marginBottom: '20px',
            display: 'flex',
            alignItems: 'flex-start',
            gap: '12px',
            boxShadow: '0 2px 8px rgba(239, 68, 68, 0.15)',
          }}
        >
          <AlertCircle
            size={24}
            style={{ color: '#dc2626', flexShrink: 0, marginTop: '2px' }}
          />
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
          {issue.action === 'connect' && (
            <button
              className="btn btn-primary"
              onClick={handleConnectThumbtack}
              disabled={connecting}
              style={{ whiteSpace: 'nowrap' }}
            >
              {connecting ? (
                <>
                  <Loader2 className="spinner" size={16} />
                  Connecting...
                </>
              ) : (
                issue.actionLabel || 'Connect'
              )}
            </button>
          )}
          {issue.action === 'reconnect' && (
            <button
              className="btn btn-primary"
              onClick={handleConnectThumbtack}
              disabled={connecting}
              style={{ whiteSpace: 'nowrap' }}
            >
              {connecting ? (
                <>
                  <Loader2 className="spinner" size={16} />
                  Reconnecting...
                </>
              ) : (
                <>
                  <RefreshCw size={16} style={{ marginRight: '6px' }} />
                  {issue.actionLabel || 'Reconnect'}
                </>
              )}
            </button>
          )}
        </div>
      ))}

      <section className="dashboard-section">
        <h2>Platform Connections</h2>

        <div className="platform-card">
          <div className="platform-info">
            <div className="platform-logo thumbtack-logo">TT</div>
            <div>
              <h3>Thumbtack</h3>
              <p>Connect your Thumbtack Pro accounts to receive and manage leads</p>
            </div>
          </div>

          <div className="platform-actions">
            <button
              className="btn btn-primary"
              onClick={handleConnectThumbtack}
              disabled={connecting}
            >
              {connecting ? (
                <>
                  <Loader2 className="spinner" size={18} />
                  Connecting...
                </>
              ) : (
                <>
                  <Link2 size={18} />
                  {savedAccounts.length > 0 ? 'Add Another Account' : 'Connect Thumbtack'}
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Accounts Section - shows all saved accounts */}
      {savedAccounts.length > 0 && (
        <section className="dashboard-section">
          <h2>Your Accounts</h2>
          <p className="section-description">
            All accounts are receiving leads via webhooks. Click "View Leads" to see messages.
          </p>

          <div className="businesses-grid">
            {savedAccounts.map((account) => (
              <div key={account.id} className="business-card">
                {/* Status badge based on webhookId */}
                <div className={`account-status-badge ${account.webhookId ? 'connected' : 'disconnected'}`}>
                  {account.webhookId ? (
                    <>
                      <CheckCircle size={12} />
                      Connected
                    </>
                  ) : (
                    <>
                      <AlertCircle size={12} />
                      Disconnected
                    </>
                  )}
                </div>
                {account.imageUrl ? (
                  <img
                    src={account.imageUrl}
                    alt={account.businessName}
                    className="business-image"
                  />
                ) : (
                  <div className="business-image-placeholder">
                    <Building2 size={32} />
                  </div>
                )}
                <div className="business-info">
                  <h3>{account.businessName}</h3>
                  <p className="business-id">ID: {account.businessId}</p>
                  {editingEmailId === account.id ? (
                    <div className="email-edit-row">
                      <Mail size={14} />
                      <input
                        type="email"
                        value={editEmailValue}
                        onChange={(e) => setEditEmailValue(e.target.value)}
                        placeholder="account@email.com"
                        className="email-input"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveEmail(account.id);
                          if (e.key === 'Escape') cancelEditingEmail();
                        }}
                      />
                      <button
                        className="btn-icon btn-success-subtle"
                        onClick={() => saveEmail(account.id)}
                        disabled={savingEmail}
                        title="Save"
                      >
                        {savingEmail ? <Loader2 className="spinner" size={14} /> : <Check size={14} />}
                      </button>
                      <button
                        className="btn-icon btn-secondary-subtle"
                        onClick={cancelEditingEmail}
                        title="Cancel"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div className="email-display-row" onClick={() => startEditingEmail(account)}>
                      <Mail size={14} />
                      <span className="email-hint">
                        {account.emailHint || 'Add email...'}
                      </span>
                      <Pencil size={12} className="edit-icon" />
                    </div>
                  )}
                </div>
                <div className="business-actions">
                  <button
                    className="btn btn-primary"
                    onClick={() => navigate(`/messages?account=${account.businessId}`)}
                  >
                    <ExternalLink size={16} />
                    View Leads
                  </button>
                  <button
                    className={`btn-icon ${account.webhookId ? 'btn-secondary-subtle' : 'btn-success-subtle'}`}
                    onClick={() => account.webhookId
                      ? handleDisconnectWebhook(account)
                      : handleReconnectWebhook(account)
                    }
                    disabled={togglingWebhookId === account.id || connecting}
                    title={account.webhookId ? 'Disconnect webhooks' : 'Reconnect (re-authenticate with Thumbtack)'}
                  >
                    {togglingWebhookId === account.id ? (
                      <Loader2 className="spinner" size={16} />
                    ) : account.webhookId ? (
                      <Unlink size={16} />
                    ) : (
                      <RefreshCw size={16} />
                    )}
                  </button>
                  <button
                    className="btn-icon btn-danger-subtle"
                    onClick={() => openRemoveConfirmation(account)}
                    disabled={removingAccountId === account.id}
                    title="Delete account"
                  >
                    {removingAccountId === account.id ? (
                      <Loader2 className="spinner" size={16} />
                    ) : (
                      <Trash2 size={16} />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Import Negotiations Section */}
      {savedAccounts.length > 0 && (
        <section className="dashboard-section">
          <h2>Import Negotiations</h2>
          <p className="section-description">
            Select an account and import existing negotiations by ID.
          </p>

          <div className="import-section">
            {/* Account Selection for Import */}
            <div className="import-account-selection" style={{ marginBottom: '16px' }}>
              <label style={{ fontWeight: 500, marginBottom: '8px', display: 'block' }}>
                Select account to import from:
              </label>
              <div className="import-account-cards" style={{ display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                {savedAccounts.map((account) => {
                  const isSelected = selectedImportAccountId === account.id;
                  return (
                    <div
                      key={account.id}
                      onClick={() => setSelectedImportAccountId(account.id)}
                      style={{
                        padding: '12px 16px',
                        border: isSelected ? '2px solid var(--primary)' : '1px solid var(--border)',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        background: isSelected ? 'var(--primary-light, #f0f7ff)' : 'var(--surface)',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        transition: 'all 0.15s ease',
                      }}
                    >
                      {account.imageUrl ? (
                        <img
                          src={account.imageUrl}
                          alt=""
                          style={{ width: '28px', height: '28px', borderRadius: '4px', objectFit: 'cover' }}
                        />
                      ) : (
                        <Building2 size={28} style={{ color: 'var(--text-secondary)' }} />
                      )}
                      <div>
                        <div style={{ fontWeight: 500, fontSize: '14px' }}>{account.businessName}</div>
                        {account.emailHint && (
                          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{account.emailHint}</div>
                        )}
                      </div>
                      {isSelected && (
                        <CheckCircle size={18} style={{ color: 'var(--primary)', marginLeft: 'auto' }} />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Warning if no account selected */}
            {!selectedImportAccountId && (
              <div
                style={{
                  background: '#fef3c7',
                  border: '1px solid #fde68a',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <AlertCircle size={18} style={{ color: '#d97706', flexShrink: 0 }} />
                <span style={{ fontSize: '14px', color: '#92400e' }}>
                  Please select an account above before importing negotiations.
                </span>
              </div>
            )}

            {/* Selected account confirmation */}
            {selectedImportAccountId && (
              <div
                style={{
                  background: '#ecfdf5',
                  border: '1px solid #a7f3d0',
                  borderRadius: '8px',
                  padding: '12px',
                  marginBottom: '16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <CheckCircle size={18} style={{ color: '#059669', flexShrink: 0 }} />
                <span style={{ fontSize: '14px', color: '#065f46' }}>
                  Importing for: <strong>{savedAccounts.find(a => a.id === selectedImportAccountId)?.businessName}</strong>
                </span>
              </div>
            )}

            <textarea
              className="import-textarea"
              placeholder="Paste negotiation IDs here...&#10;&#10;Example:&#10;abc123&#10;def456&#10;ghi789&#10;&#10;Or: abc123, def456, ghi789"
              value={importIds}
              onChange={(e) => setImportIds(e.target.value)}
              disabled={importing || !selectedImportAccountId}
              rows={6}
            />

            <div className="import-actions">
              <button
                className="btn btn-primary"
                onClick={handleImportNegotiations}
                disabled={importing || !importIds.trim() || !selectedImportAccountId}
              >
                {importing ? (
                  <>
                    <Loader2 className="spinner" size={18} />
                    Importing...
                  </>
                ) : (
                  <>
                    <Download size={18} />
                    Import Negotiations
                  </>
                )}
              </button>

              {importIds && !importing && (
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setImportIds('');
                    setImportResults([]);
                    setShowImportResults(false);
                  }}
                >
                  <X size={18} />
                  Clear
                </button>
              )}
            </div>

            {/* Import Results */}
            {showImportResults && importResults.length > 0 && (
              <div className="import-results">
                <h4>Import Results ({importResults.length} processed)</h4>
                <div className="results-list">
                  {importResults.map((result, idx) => (
                    <div
                      key={idx}
                      className={`result-item ${result.success ? (result.isNew ? 'success' : 'duplicate') : 'failed'}`}
                    >
                      <span className="result-id">{result.id}</span>
                      {result.success ? (
                        <span className="result-status">
                          <CheckCircle size={16} className={`result-icon ${result.isNew ? 'success' : 'duplicate'}`} />
                          {result.isNew ? 'New' : 'Already exists'}
                        </span>
                      ) : (
                        <span className="result-error">
                          <AlertCircle size={16} className="result-icon failed" />
                          {result.error}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </section>
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

            <div className="warning-details" style={{ background: '#fef3c7', padding: '12px', borderRadius: '8px', marginBottom: '16px' }}>
              <p style={{ margin: '0 0 8px 0', fontWeight: 500, color: '#92400e' }}>
                {disconnectWarning.errorMessage}
              </p>
              <p style={{ margin: 0, fontSize: '13px', color: '#a16207' }}>
                {disconnectWarning.warning}
              </p>
            </div>

            <div className="warning-solution" style={{ marginBottom: '16px' }}>
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
                  <li>Or manually remove the webhook from your Thumbtack account settings</li>
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
              <button
                className="btn btn-secondary"
                onClick={() => setDisconnectWarning(null)}
              >
                Close
              </button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  // Find the account and trigger reconnect
                  const account = savedAccounts.find(a => a.id === disconnectWarning.accountId);
                  if (account) {
                    setDisconnectWarning(null);
                    handleReconnectWebhook(account);
                  }
                }}
              >
                <RefreshCw size={16} style={{ marginRight: '6px' }} />
                Reconnect Account
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
              <button
                className="btn btn-secondary"
                onClick={() => setConfirmRemoveAccount(null)}
              >
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={handleRemoveSavedAccount}
                disabled={removingAccountId === confirmRemoveAccount.id}
              >
                {removingAccountId === confirmRemoveAccount.id ? (
                  <>
                    <Loader2 className="spinner" size={16} />
                    Removing...
                  </>
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
