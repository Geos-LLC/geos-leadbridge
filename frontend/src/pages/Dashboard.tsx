import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink, Download, X, Unlink, Trash2, Mail, Pencil, Check, RefreshCw } from 'lucide-react';
import { platformsApi, thumbtackApi, leadsApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';

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

  // Handle OAuth callback params
  useEffect(() => {
    const connected = searchParams.get('connected');
    const oauthError = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (connected === 'thumbtack') {
      setSuccess('Thumbtack account connected successfully!');
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
      await thumbtackApi.disconnectAccount(account.id);
      setSavedAccounts(savedAccounts.map(a =>
        a.id === account.id ? { ...a, webhookId: null } : a
      ));
      setSuccess(`Webhook disconnected for ${account.businessName}`);
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

    for (const id of ids) {
      console.log('[Dashboard] Importing negotiation:', id);
      try {
        const result = await leadsApi.importNegotiation(id);
        console.log('[Dashboard] Import success for', id, result);
        results.push({ id, success: true, isNew: result.isNew });
      } catch (err: any) {
        console.error('[Dashboard] Import failed for', id, err);
        results.push({
          id,
          success: false,
          error: err.response?.data?.message || 'Failed to import',
        });
      }
      // Update results as we go
      setImportResults([...results]);
    }

    setImporting(false);

    const newCount = results.filter(r => r.success && r.isNew).length;
    const updatedCount = results.filter(r => r.success && !r.isNew).length;
    const failCount = results.filter(r => !r.success).length;

    if (newCount > 0 && updatedCount === 0 && failCount === 0) {
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
            Import existing negotiations by ID. Paste one or multiple IDs (comma, newline, or space separated).
          </p>

          <div className="import-section">
            <textarea
              className="import-textarea"
              placeholder="Paste negotiation IDs here...&#10;&#10;Example:&#10;abc123&#10;def456&#10;ghi789&#10;&#10;Or: abc123, def456, ghi789"
              value={importIds}
              onChange={(e) => setImportIds(e.target.value)}
              disabled={importing}
              rows={6}
            />

            <div className="import-actions">
              <button
                className="btn btn-primary"
                onClick={handleImportNegotiations}
                disabled={importing || !importIds.trim()}
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
