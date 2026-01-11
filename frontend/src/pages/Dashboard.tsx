import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
import { platformsApi, thumbtackApi } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import type { Business } from '../types';

export function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const { platforms, setPlatforms, businesses, setBusinesses, setSelectedBusiness } = useAppStore();
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [settingUpWebhook, setSettingUpWebhook] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const thumbtackConnected = platforms.find((p) => p.platformName === 'thumbtack')?.connected ?? false;

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
      const { platforms } = await platformsApi.getStatus();
      setPlatforms(platforms);
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
    setConnecting(true);
    setError('');
    try {
      const { authUrl } = await platformsApi.getAuthUrl();
      window.location.href = authUrl;
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to get auth URL');
      setConnecting(false);
    }
  };

  const handleSetupWebhook = async (business: Business) => {
    setSettingUpWebhook(business.businessID);
    setError('');
    setSuccess('');
    try {
      await thumbtackApi.setupWebhook(business.businessID);
      setSelectedBusiness(business);
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

          {!thumbtackConnected && (
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
          )}
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
            </div>
          ) : (
            <div className="businesses-grid">
              {businesses.map((business) => (
                <div key={business.businessID} className="business-card">
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
                  </div>
                  <div className="business-actions">
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
                    <button
                      className="btn btn-primary"
                      onClick={() => handleGoToMessages(business)}
                    >
                      <ExternalLink size={16} />
                      View Leads
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
