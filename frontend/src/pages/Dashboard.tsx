import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink, Webhook, Unlink } from 'lucide-react';
import { platformsApi, thumbtackApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import type { Business } from '../types';

export function Dashboard() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const { platforms, setPlatforms, businesses, setBusinesses, setSelectedBusiness } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [settingUpWebhook, setSettingUpWebhook] = useState<string | null>(null);
  const [configuredBusinessId, setConfiguredBusinessId] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const thumbtackConnected = platforms.find((p) => p.platformName === 'thumbtack')?.connected ?? false;

  // Handle OAuth callback params
  useEffect(() => {
    const connected = searchParams.get('connected');
    const oauthError = searchParams.get('error');
    const errorDescription = searchParams.get('error_description');

    if (connected === 'thumbtack') {
      setSuccess('Thumbtack account connected successfully!');
      // Reload platform status to reflect the new connection
      loadPlatformStatus();
      // Clear the URL params
      setSearchParams({});
    } else if (oauthError) {
      setError(errorDescription || `OAuth error: ${oauthError}`);
      setSearchParams({});
    }
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    loadPlatformStatus();
  }, []);

  useEffect(() => {
    if (thumbtackConnected) {
      loadBusinesses();
    }
  }, [thumbtackConnected]);

  const loadPlatformStatus = async () => {
    try {
      const [statusResponse, connectionResponse] = await Promise.all([
        platformsApi.getStatus(),
        platformsApi.getConnection(),
      ]);
      setPlatforms(statusResponse.platforms);
      setConfiguredBusinessId(connectionResponse.thumbtack.configuredBusinessId);
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

  const handleDisconnectThumbtack = async () => {
    if (!confirm('Are you sure you want to disconnect your Thumbtack account? You will stop receiving leads.')) {
      return;
    }
    setDisconnecting(true);
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
      setSuccess('Thumbtack account disconnected successfully.');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to disconnect Thumbtack');
    } finally {
      setDisconnecting(false);
    }
  };

  const handleSetupWebhook = async (business: Business) => {
    setSettingUpWebhook(business.businessID);
    setError('');
    setSuccess('');
    try {
      await thumbtackApi.setupWebhook(business.businessID);
      setSelectedBusiness(business);
      setConfiguredBusinessId(business.businessID);
      setSuccess(`Webhook configured for ${business.name}! You can now receive leads.`);
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
            {!thumbtackConnected ? (
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
                    Connect Thumbtack
                  </>
                )}
              </button>
            ) : (
              <button
                className="btn btn-danger"
                onClick={handleDisconnectThumbtack}
                disabled={disconnecting}
              >
                {disconnecting ? (
                  <>
                    <Loader2 className="spinner" size={18} />
                    Disconnecting...
                  </>
                ) : (
                  <>
                    <Unlink size={18} />
                    Disconnect
                  </>
                )}
              </button>
            )}
          </div>
        </div>
      </section>

      {thumbtackConnected && (
        <section className="dashboard-section">
          <h2>Your Businesses</h2>
          <p className="section-description">
            Select a business to set up webhooks and start receiving leads
          </p>

          {businesses.length === 0 ? (
            <div className="empty-state">
              <Building2 size={48} />
              <p>No businesses found in your Thumbtack account</p>
              <p className="empty-state-hint">
                This usually means you're connected to the wrong Thumbtack account.
              </p>
              <div className="empty-state-actions">
                <p><strong>To connect your Pro account:</strong></p>
                <ol className="reconnect-steps">
                  <li>Click "Disconnect" above</li>
                  <li>
                    <a href="https://www.thumbtack.com/logout" target="_blank" rel="noopener noreferrer">
                      Log out of Thumbtack
                    </a>
                    {' '}in a new tab
                  </li>
                  <li>Come back here and click "Connect Thumbtack"</li>
                  <li>Log in with your <strong>Pro account</strong> credentials</li>
                </ol>
              </div>
            </div>
          ) : (
            <div className="businesses-grid">
              {businesses.map((business) => {
                const isConfigured = configuredBusinessId === business.businessID;
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
            </div>
          )}
        </section>
      )}
    </div>
  );
}
