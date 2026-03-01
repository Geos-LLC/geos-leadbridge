import { useState, useEffect } from 'react';
import { X, Loader2, CheckCircle, AlertCircle, ExternalLink, RefreshCw, LogOut } from 'lucide-react';
import { platformsApi, thumbtackApi } from '../services/api';
import type { SavedAccount, Business } from '../types';

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  accountToReconnect?: SavedAccount | null;
  savedAccounts?: SavedAccount[];
  onSuccess?: () => void;
}

export default function ConnectionModal({ isOpen, onClose, accountToReconnect, savedAccounts = [], onSuccess }: ConnectionModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectSuccess, setReconnectSuccess] = useState(false);

  useEffect(() => {
    if (isOpen && !accountToReconnect) {
      loadBusinesses();
    }
    if (!isOpen) {
      // Reset state when modal closes
      setError(null);
      setReconnectSuccess(false);
      setBusinesses([]);
    }
  }, [isOpen, accountToReconnect]);

  const loadBusinesses = async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await thumbtackApi.getBusinesses();
      if (res.needsReauth) {
        setBusinesses([]);
      } else {
        setBusinesses(res.businesses || []);
      }
    } catch (err: any) {
      if (err.response?.status === 401 || err.response?.status === 404 || err.response?.status === 500) {
        setBusinesses([]);
      } else {
        setError(err.message || 'Failed to load businesses');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleStartOAuth = async (forceLogin = false) => {
    try {
      setLoading(true);
      setError(null);
      const { authUrl } = await platformsApi.getAuthUrl(forceLogin);
      window.location.href = authUrl;
    } catch (err: any) {
      setError(err.message || 'Failed to start connection');
      setLoading(false);
    }
  };

  const handleSwitchAccount = async () => {
    try {
      setLoading(true);
      setError(null);
      // Revoke the stored token so OAuth gives a fresh login
      await platformsApi.disconnect().catch(() => {}); // OK if fails
      // Use prompt=login to force Thumbtack to show the login page
      // even if there's an existing session — no more race with logout
      handleStartOAuth(true);
    } catch (err: any) {
      setError(err.message || 'Failed to switch account');
      setLoading(false);
    }
  };

  const handleReconnect = async () => {
    if (!accountToReconnect) return;

    console.log('[Reconnect] Starting reconnect for account:', accountToReconnect.id, accountToReconnect.businessName);
    try {
      setReconnecting(true);
      setError(null);
      const result = await thumbtackApi.reconnectAccount(accountToReconnect.id);
      console.log('[Reconnect] API success, result:', result);
      setReconnectSuccess(true);
      setTimeout(() => {
        onSuccess?.();
        onClose();
      }, 1500);
    } catch (err: any) {
      console.error('[Reconnect] API failed:', err?.response?.status, err?.response?.data || err?.message);
      setError('Could not reconnect automatically. Redirecting to Thumbtack to re-authorize...');
      setTimeout(handleStartOAuth, 2000);
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

  // Figure out which businesses are already saved
  const savedBusinessIds = new Set(savedAccounts.map(a => a.businessId));
  const newBusinesses = businesses.filter(b => !savedBusinessIds.has(b.businessID));
  const alreadyConnected = businesses.filter(b => savedBusinessIds.has(b.businessID));

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
            ) : newBusinesses.length > 0 ? (
              <>
                <p className="text-sm text-slate-600 mb-4">Select a business to connect:</p>
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {newBusinesses.map((business) => (
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

                {/* Already connected businesses (greyed out) */}
                {alreadyConnected.length > 0 && (
                  <div className="pt-2">
                    <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-2">Already connected</p>
                    {alreadyConnected.map((business) => (
                      <div key={business.businessID} className="p-3 bg-slate-50/50 rounded-xl border border-slate-100 opacity-50">
                        <div className="flex items-center gap-3">
                          {business.imageURL ? (
                            <img src={business.imageURL} alt={business.name} className="w-10 h-10 rounded-lg" />
                          ) : (
                            <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center text-slate-400 font-bold">
                              {business.name[0]}
                            </div>
                          )}
                          <div className="flex-1">
                            <h3 className="font-semibold text-slate-600 text-sm">{business.name}</h3>
                          </div>
                          <CheckCircle size={14} className="text-emerald-500" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Switch to different Thumbtack account */}
                <div className="pt-3 border-t border-slate-100">
                  <button
                    onClick={handleSwitchAccount}
                    disabled={loading}
                    className="w-full px-4 py-3 text-sm text-slate-600 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-all flex items-center justify-center gap-2 font-medium"
                  >
                    <LogOut size={14} />
                    Connect a different Thumbtack account
                  </button>
                  <p className="text-xs text-slate-400 text-center mt-1">
                    This will open Thumbtack logout, then redirect you to sign in with a different account.
                  </p>
                </div>
              </>
            ) : businesses.length > 0 && newBusinesses.length === 0 ? (
              /* All businesses already connected */
              <>
                <div className="text-center py-6">
                  <div className="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <CheckCircle size={24} className="text-emerald-600" />
                  </div>
                  <h3 className="text-lg font-bold text-slate-900 mb-2">All businesses connected</h3>
                  <p className="text-sm text-slate-600 mb-2 max-w-md mx-auto">
                    All Thumbtack businesses on this account are already connected to LeadBridge.
                  </p>
                </div>

                <div className="border-t border-slate-100 pt-4">
                  <button
                    onClick={handleSwitchAccount}
                    disabled={loading}
                    className="w-full px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <><Loader2 size={16} className="animate-spin" /> Switching...</>
                    ) : (
                      <><LogOut size={16} /> Connect a different Thumbtack account</>
                    )}
                  </button>
                  <p className="text-xs text-slate-400 text-center mt-2">
                    This will log you out of Thumbtack and let you sign in with a different account.
                  </p>
                </div>
              </>
            ) : (
              /* No token / needs OAuth */
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
