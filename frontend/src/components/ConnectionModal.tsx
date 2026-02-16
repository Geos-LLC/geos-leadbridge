import { useState, useEffect } from 'react';
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink, RefreshCw } from 'lucide-react';
import { platformsApi, thumbtackApi } from '../services/api';
import type { SavedAccount, Business } from '../types';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountToReconnect?: SavedAccount | null;
  onSuccess?: () => void;
}

export default function ConnectionModal({ isOpen, onClose, accountToReconnect, onSuccess }: ConnectionModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectSuccess, setReconnectSuccess] = useState(false);

  useEffect(() => {
    if (isOpen && !accountToReconnect) {
      // Load available businesses if not reconnecting specific account
      loadBusinesses();
    }
  }, [isOpen, accountToReconnect]);

  const loadBusinesses = async () => {
    try {
      setLoading(true);
      setError(null);
      const { businesses: biz } = await thumbtackApi.getBusinesses();
      setBusinesses(biz);
    } catch (err: any) {
      // If no businesses, user needs to OAuth first
      if (err.response?.status === 401 || err.response?.status === 404) {
        setBusinesses([]);
      } else {
        setError(err.message || 'Failed to load businesses');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStartOAuth = async () => {
    try {
      setLoading(true);
      setError(null);
      const { authUrl } = await platformsApi.getAuthUrl();
      window.location.href = authUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start connection');
      setLoading(false);
    }
  };

  const handleReconnect = async () => {
    if (!accountToReconnect) return;

    try {
      setReconnecting(true);
      setError(null);
      await thumbtackApi.reconnectAccount(accountToReconnect.id);
      setReconnectSuccess(true);
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1500);
    } catch (err: any) {
      // If token expired, redirect to OAuth
      if (err.response?.data?.errorCode === 'token_expired' || err.response?.data?.errorCode === 'token_revoked') {
        setError('Your Thumbtack session has expired. Redirecting to reconnect...');
        setTimeout(handleStartOAuth, 2000);
      } else {
        setError(err.response?.data?.message || err.message || 'Failed to reconnect account');
      }
    } finally {
      setReconnecting(false);
    }
  };

  const handleSetupWebhook = async (business: Business) => {
    try {
      setLoading(true);
      setError(null);
      await thumbtackApi.setupWebhook(business.businessID, business.name, business.imageURL);
      onSuccess?.();
      onClose();
    } catch (err: any) {
      setError(err.message || 'Failed to setup webhook');
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-3xl p-8 max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-slate-900">
              {accountToReconnect ? 'Reconnect Account' : 'Connect Thumbtack'}
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              {accountToReconnect
                ? `Reconnect "${accountToReconnect.businessName}" to resume automation`
                : 'Connect your Thumbtack business to start automating'}
            </p>
          </div>
          <button
            className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <span className="text-sm">{error}</span>
          </div>
        )}

        {reconnectSuccess && (
          <div className="mb-6 p-4 bg-emerald-50 border border-emerald-200 rounded-xl flex items-start gap-3 text-emerald-700">
            <CheckCircle size={16} className="shrink-0 mt-0.5" />
            <span className="text-sm font-semibold">Successfully reconnected! Refreshing...</span>
          </div>
        )}

        {/* Reconnect specific account */}
        {accountToReconnect && (
          <div className="space-y-4">
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 text-lg font-bold">
                  {accountToReconnect.businessName[0]}
                </div>
                <div className="flex-1">
                  <h3 className="font-bold text-slate-900">{accountToReconnect.businessName}</h3>
                  <p className="text-xs text-slate-500">ID: {accountToReconnect.businessId}</p>
                </div>
              </div>
              <p className="text-sm text-slate-600">
                This will re-register webhooks and resume automation for this account. You may need to authenticate with Thumbtack if your session expired.
              </p>
            </div>

            <button
              onClick={handleReconnect}
              disabled={reconnecting || reconnectSuccess}
              className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {reconnecting ? (
                <><Loader2 size={16} className="animate-spin" /> Reconnecting...</>
              ) : reconnectSuccess ? (
                <><CheckCircle size={16} /> Reconnected!</>
              ) : (
                <><RefreshCw size={16} /> Reconnect Account</>
              )}
            </button>
          </div>
        )}

        {/* Connect new account or choose business */}
        {!accountToReconnect && (
          <div className="space-y-4">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-12">
                <Loader2 size={32} className="animate-spin text-blue-600 mb-4" />
                <p className="text-slate-500">Loading your businesses...</p>
              </div>
            ) : businesses.length > 0 ? (
              <>
                <p className="text-sm text-slate-600 mb-4">Select a business to connect:</p>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {businesses.map((business) => (
                    <div
                      key={business.businessID}
                      className="p-4 bg-slate-50 rounded-2xl border border-slate-100 hover:border-blue-200 transition-all cursor-pointer group"
                      onClick={() => handleSetupWebhook(business)}
                    >
                      <div className="flex items-center gap-3">
                        {business.imageURL ? (
                          <img src={business.imageURL} alt={business.name} className="w-12 h-12 rounded-xl" />
                        ) : (
                          <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center text-blue-600 text-lg font-bold">
                            {business.name[0]}
                          </div>
                        )}
                        <div className="flex-1">
                          <h3 className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors">{business.name}</h3>
                          <p className="text-xs text-slate-500">ID: {business.businessID}</p>
                        </div>
                        <ExternalLink size={16} className="text-slate-400 group-hover:text-blue-600 transition-colors" />
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="text-center py-8">
                  <div className="w-16 h-16 bg-blue-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <ExternalLink size={24} className="text-blue-600" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-2">Connect to Thumbtack</h3>
                  <p className="text-sm text-slate-600 mb-6 max-w-md mx-auto">
                    Authorize LeadBridge to access your Thumbtack account and start automating your lead responses.
                  </p>
                </div>
                <button
                  onClick={handleStartOAuth}
                  disabled={loading}
                  className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                >
                  {loading ? (
                    <><Loader2 size={16} className="animate-spin" /> Connecting...</>
                  ) : (
                    <><ExternalLink size={16} /> Connect with Thumbtack</>
                  )}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
