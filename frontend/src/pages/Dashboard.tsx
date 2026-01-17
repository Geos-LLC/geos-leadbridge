import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink, Webhook, Unlink, Download, X, Users, Trash2, RefreshCw } from 'lucide-react';
import { platformsApi, thumbtackApi, leadsApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import type { Business, SavedAccount } from '../types';

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
    platforms, setPlatforms,
    businesses, setBusinesses,
    setSelectedBusiness,
    setConfiguredBusinessId: setGlobalConfiguredBusinessId,
    savedAccounts, setSavedAccounts, removeSavedAccount: removeFromStore
  } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [settingUpWebhook, setSettingUpWebhook] = useState<string | null>(null);
  const [configuredBusinessId, setConfiguredBusinessId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Import negotiations state
  const [importIds, setImportIds] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResults, setImportResults] = useState<ImportResult[]>([]);
  const [showImportResults, setShowImportResults] = useState(false);

  // Switch account modal state
  const [switchingAccount, setSwitchingAccount] = useState<SavedAccount | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [disconnectingBusinessId, setDisconnectingBusinessId] = useState<string | null>(null);

  const thumbtackConnected = platforms.find((p) => p.platformName === 'thumbtack')?.connected ?? false;

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

  useEffect(() => {
    if (thumbtackConnected) {
      loadBusinesses();
    }
  }, [thumbtackConnected]);

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
      const [statusResponse, connectionResponse] = await Promise.all([
        platformsApi.getStatus(),
        platformsApi.getConnection(),
      ]);
      setPlatforms(statusResponse.platforms);
      const businessId = connectionResponse.thumbtack.configuredBusinessId;
      setConfiguredBusinessId(businessId);
      setGlobalConfiguredBusinessId(businessId); // Also set in global store for Messages page
    } catch (err) {
      console.error('Failed to load platform status:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadBusinesses = async () => {
    try {
      const { businesses } = await thumbtackApi.getBusinesses();
      setBusinesses(businesses);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load businesses');
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

  const handleDisconnectThumbtack = async (businessId: string) => {
    if (!confirm('Are you sure you want to disconnect this Thumbtack account?\n\nNote: Leads will still be received via webhook. Disconnecting only removes API access for sending messages.')) {
      return;
    }
    setDisconnectingBusinessId(businessId);
    setError('');
    setSuccess('');
    try {
      await platformsApi.disconnect();
      // Reset state
      setPlatforms(platforms.map(p =>
        p.platformName === 'thumbtack' ? { ...p, connected: false } : p
      ));
      setBusinesses([]);
      setConfiguredBusinessId(null);
      setGlobalConfiguredBusinessId(null);
      setSuccess('Thumbtack account disconnected successfully.');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to disconnect Thumbtack');
    } finally {
      setDisconnectingBusinessId(null);
    }
  };

  const handleSetupWebhook = async (business: Business, emailHint?: string) => {
    setSettingUpWebhook(business.businessID);
    setError('');
    setSuccess('');
    try {
      // Setup webhook and save account for multi-account switching
      await thumbtackApi.setupWebhook(
        business.businessID,
        business.name,
        business.imageURL,
        emailHint
      );
      setSelectedBusiness(business);
      setConfiguredBusinessId(business.businessID);
      setGlobalConfiguredBusinessId(business.businessID);
      setSuccess(`Webhook configured for ${business.name}! You can now receive leads.`);
      // Reload saved accounts to include the new one
      loadSavedAccounts();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to setup webhook');
    } finally {
      setSettingUpWebhook(null);
    }
  };

  const handleGoToMessages = (business: Business) => {
    setSelectedBusiness(business);
    navigate('/messages');
  };

  const handleSwitchAccount = async (account: SavedAccount) => {
    setSwitchingAccount(account);
  };

  const confirmSwitchAccount = async () => {
    if (!switchingAccount) return;

    // Disconnect current account
    try {
      await platformsApi.disconnect();
    } catch (err) {
      console.error('Failed to disconnect:', err);
    }

    // Reset state
    setPlatforms(platforms.map(p =>
      p.platformName === 'thumbtack' ? { ...p, connected: false } : p
    ));
    setBusinesses([]);
    setConfiguredBusinessId(null);
    setSwitchingAccount(null);

    // Open Thumbtack logout and then OAuth
    const logoutWindow = window.open('https://www.thumbtack.com/logout', '_blank', 'width=600,height=400');

    setTimeout(async () => {
      if (logoutWindow) {
        logoutWindow.close();
      }

      setConnecting(true);
      try {
        const { authUrl } = await platformsApi.getAuthUrl();
        window.location.href = authUrl;
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to get auth URL');
        setConnecting(false);
      }
    }, 2000);
  };

  const handleRemoveSavedAccount = async (accountId: string) => {
    setRemovingAccountId(accountId);
    try {
      await thumbtackApi.removeSavedAccount(accountId);
      removeFromStore(accountId);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to remove saved account');
    } finally {
      setRemovingAccountId(null);
    }
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
              <p>Connect your Thumbtack Pro account to receive and manage leads</p>
            </div>
          </div>

          <div className="platform-status">
            {thumbtackConnected ? (
              <span className="status connected">
                <CheckCircle size={16} />
                Connected
              </span>
            ) : (
              <span className="status disconnected">
                <AlertCircle size={16} />
                Not Connected
              </span>
            )}
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
                  {thumbtackConnected ? 'Add Another Account' : 'Connect Thumbtack'}
                </>
              )}
            </button>
          </div>
        </div>
      </section>

      {/* Accounts Section - shows both live businesses and saved accounts */}
      {(thumbtackConnected || savedAccounts.length > 0) && (
        <section className="dashboard-section">
          <h2>Your Accounts</h2>
          <p className="section-description">
            {thumbtackConnected
              ? 'Manage your connected businesses and saved accounts'
              : 'Your saved accounts (connect to Thumbtack to access them)'}
          </p>

          <div className="businesses-grid">
            {/* Show connected businesses from API */}
            {businesses.map((business) => {
              const isConfigured = configuredBusinessId === business.businessID;
              const savedAccount = savedAccounts.find(a => a.businessId === business.businessID);
              return (
                <div key={business.businessID} className={`business-card ${isConfigured ? 'configured' : ''}`}>
                  {isConfigured && (
                    <div className="configured-badge">
                      <Webhook size={14} />
                      Active
                    </div>
                  )}
                  {business.imageURL && (
                    <img
                      src={business.imageURL}
                      alt={business.name}
                      className="business-image"
                    />
                  )}
                  <div className="business-info">
                    <h3>{business.name}</h3>
                    <p className="business-id">ID: {business.businessID}</p>
                    {savedAccount?.emailHint && (
                      <p className="email-hint">{savedAccount.emailHint}</p>
                    )}
                    {isConfigured && (
                      <p className="webhook-status">
                        <CheckCircle size={14} />
                        Webhook configured - receiving leads
                      </p>
                    )}
                  </div>
                  <div className="business-actions">
                    {!isConfigured && (
                      <button
                        className="btn btn-secondary"
                        onClick={() => handleSetupWebhook(business)}
                        disabled={settingUpWebhook === business.businessID}
                      >
                        {settingUpWebhook === business.businessID ? (
                          <>
                            <Loader2 className="spinner" size={16} />
                            Setting up...
                          </>
                        ) : (
                          <>
                            <Link2 size={16} />
                            Setup Webhook
                          </>
                        )}
                      </button>
                    )}
                    {isConfigured && (
                      <>
                        <button
                          className="btn btn-danger"
                          onClick={() => handleDisconnectThumbtack(business.businessID)}
                          disabled={disconnectingBusinessId === business.businessID}
                          title="Disconnect this account"
                        >
                          {disconnectingBusinessId === business.businessID ? (
                            <>
                              <Loader2 className="spinner" size={16} />
                              Disconnecting...
                            </>
                          ) : (
                            <>
                              <Unlink size={16} />
                              Disconnect
                            </>
                          )}
                        </button>
                        {savedAccount && (
                          <button
                            className="btn-icon btn-danger-subtle"
                            onClick={() => handleRemoveSavedAccount(savedAccount.id)}
                            disabled={removingAccountId === savedAccount.id}
                            title="Remove from saved accounts"
                          >
                            {removingAccountId === savedAccount.id ? (
                              <Loader2 className="spinner" size={16} />
                            ) : (
                              <Trash2 size={16} />
                            )}
                          </button>
                        )}
                      </>
                    )}
                    <button
                      className="btn btn-primary"
                      onClick={() => handleGoToMessages(business)}
                    >
                      <ExternalLink size={16} />
                      View Leads
                    </button>
                  </div>
                </div>
              );
            })}

            {/* Show saved accounts that are NOT in the current businesses list (from other connections) */}
            {savedAccounts
              .filter(account => !businesses.some(b => b.businessID === account.businessId))
              .map((account) => {
                const isCurrentAccount = configuredBusinessId === account.businessId;
                return (
                  <div
                    key={account.id}
                    className={`business-card saved-only ${isCurrentAccount ? 'configured' : ''}`}
                  >
                    {isCurrentAccount && (
                      <div className="configured-badge">
                        <CheckCircle size={14} />
                        Current
                      </div>
                    )}
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
                      {account.emailHint && (
                        <p className="email-hint">{account.emailHint}</p>
                      )}
                      <p className="saved-account-note">
                        <Users size={14} />
                        Saved account (switch to access)
                      </p>
                    </div>
                    <div className="business-actions">
                      {thumbtackConnected && !isCurrentAccount && (
                        <button
                          className="btn btn-primary"
                          onClick={() => handleSwitchAccount(account)}
                          disabled={connecting}
                        >
                          <RefreshCw size={16} />
                          Switch Account
                        </button>
                      )}
                      <button
                        className="btn btn-danger-subtle"
                        onClick={() => handleRemoveSavedAccount(account.id)}
                        disabled={removingAccountId === account.id}
                        title="Remove saved account"
                      >
                        {removingAccountId === account.id ? (
                          <Loader2 className="spinner" size={16} />
                        ) : (
                          <Trash2 size={16} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          {/* Show hint if no businesses and no saved accounts */}
          {businesses.length === 0 && savedAccounts.length === 0 && thumbtackConnected && (
            <div className="empty-state-hint-box">
              <AlertCircle size={18} />
              <div>
                <p><strong>No businesses found</strong></p>
                <p>This usually means you're connected with a consumer account instead of a Pro account.</p>
                <p>Try disconnecting and logging in with your Thumbtack Pro credentials.</p>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Import Negotiations Section */}
      {thumbtackConnected && (
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

      {/* Switch Account Modal */}
      {switchingAccount && (
        <div className="modal-overlay" onClick={() => setSwitchingAccount(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Switch Account</h3>
              <button className="btn-icon" onClick={() => setSwitchingAccount(null)}>
                <X size={20} />
              </button>
            </div>
            <div className="modal-body">
              <p>You're about to switch to:</p>
              <div className="switch-account-preview">
                {switchingAccount.imageUrl ? (
                  <img src={switchingAccount.imageUrl} alt={switchingAccount.businessName} />
                ) : (
                  <div className="saved-account-placeholder">
                    <Building2 size={32} />
                  </div>
                )}
                <div>
                  <strong>{switchingAccount.businessName}</strong>
                  {switchingAccount.emailHint && (
                    <p className="email-hint">Log in with: {switchingAccount.emailHint}</p>
                  )}
                </div>
              </div>
              <div className="switch-steps">
                <p><strong>This will:</strong></p>
                <ol>
                  <li>Disconnect your current Thumbtack account</li>
                  <li>Open Thumbtack logout page</li>
                  <li>Redirect to Thumbtack login</li>
                </ol>
                {switchingAccount.emailHint && (
                  <p className="switch-reminder">
                    <AlertCircle size={16} />
                    Remember to log in with <strong>{switchingAccount.emailHint}</strong>
                  </p>
                )}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setSwitchingAccount(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={confirmSwitchAccount}>
                <RefreshCw size={16} />
                Switch Account
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
