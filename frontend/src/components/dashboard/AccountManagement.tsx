import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink,
  Download, X, Unlink, Trash2, Mail, Pencil, Check, RefreshCw,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import type { SavedAccount } from '../../types';

interface ImportResult {
  id: string;
  success: boolean;
  isNew?: boolean;
  error?: string;
}

interface AccountManagementProps {
  savedAccounts: SavedAccount[];
  selectedAccountId: string | null; // from the top dropdown
  connecting: boolean;
  onConnectThumbtack: () => void;
  onDisconnectWebhook: (account: SavedAccount) => void;
  onReconnectWebhook: (account: SavedAccount) => void;
  onRemoveAccount: (account: { id: string; businessName: string }) => void;
  onUpdateEmail: (accountId: string, email: string) => Promise<void>;
  onImportNegotiations: (accountId: string, ids: string) => void;
  importing: boolean;
  importResults: ImportResult[];
  importTotal: number;
  showImportResults: boolean;
  importIds: string;
  onImportIdsChange: (ids: string) => void;
  onClearImport: () => void;
  togglingWebhookId: string | null;
  removingAccountId: string | null;
}

const IMPORT_COLLAPSE_KEY = 'dashboard_import_collapsed';

export default function AccountManagement({
  savedAccounts,
  selectedAccountId,
  connecting,
  onConnectThumbtack,
  onDisconnectWebhook,
  onReconnectWebhook,
  onRemoveAccount,
  onUpdateEmail,
  onImportNegotiations,
  importing,
  importResults,
  importTotal,
  showImportResults,
  importIds,
  onImportIdsChange,
  onClearImport,
  togglingWebhookId,
  removingAccountId,
}: AccountManagementProps) {
  const navigate = useNavigate();

  // Import collapse state
  const [importCollapsed, setImportCollapsed] = useState(() => {
    try {
      const stored = localStorage.getItem(IMPORT_COLLAPSE_KEY);
      return stored !== null ? stored === 'true' : true;
    } catch {
      return true;
    }
  });

  const toggleImportCollapsed = () => {
    const next = !importCollapsed;
    setImportCollapsed(next);
    localStorage.setItem(IMPORT_COLLAPSE_KEY, String(next));
  };

  // Email editing local state
  const [editingEmailId, setEditingEmailId] = useState<string | null>(null);
  const [editEmailValue, setEditEmailValue] = useState('');
  const [savingEmail, setSavingEmail] = useState(false);

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
      await onUpdateEmail(accountId, editEmailValue);
      setEditingEmailId(null);
      setEditEmailValue('');
    } finally {
      setSavingEmail(false);
    }
  };

  // Which accounts to display: selected one, or all if "All Accounts" is chosen
  const displayAccounts = selectedAccountId
    ? savedAccounts.filter(a => a.id === selectedAccountId)
    : savedAccounts;

  const canImport = selectedAccountId !== null;

  return (
    <section className="manage-accounts-section" id="manage-accounts">
      {/* Platform Connections */}
      <div className="platform-card compact">
        <div className="platform-info">
          <div className="platform-logo thumbtack-logo">TT</div>
          <div>
            <h3>Thumbtack</h3>
            <p>Connect your Thumbtack Pro accounts</p>
          </div>
        </div>
        <div className="platform-actions">
          <button
            className="btn btn-primary btn-sm"
            onClick={onConnectThumbtack}
            disabled={connecting}
          >
            {connecting ? (
              <><Loader2 className="spinner" size={14} /> Connecting...</>
            ) : (
              <><Link2 size={14} /> {savedAccounts.length > 0 ? 'Add Account' : 'Connect'}</>
            )}
          </button>
        </div>
      </div>

      {/* Account Cards - compact, filtered by dropdown */}
      {displayAccounts.length > 0 && (
        <div className="account-cards-compact">
          {displayAccounts.map((account) => (
            <div key={account.id} className="account-card-compact">
              <div className="account-card-left">
                {account.imageUrl ? (
                  <img src={account.imageUrl} alt={account.businessName} className="account-card-avatar" />
                ) : (
                  <div className="account-card-avatar placeholder"><Building2 size={20} /></div>
                )}
                <div className="account-card-details">
                  <div className="account-card-name">{account.businessName}</div>
                  <div className="account-card-meta">
                    <span className="account-card-id">ID: {account.businessId}</span>
                    <span className={`account-card-status ${account.webhookId ? 'connected' : 'disconnected'}`}>
                      {account.webhookId ? <><CheckCircle size={10} /> Connected</> : <><AlertCircle size={10} /> Disconnected</>}
                    </span>
                  </div>
                  {editingEmailId === account.id ? (
                    <div className="email-edit-row compact">
                      <Mail size={12} />
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
                      <button className="btn-icon btn-success-subtle" onClick={() => saveEmail(account.id)} disabled={savingEmail} title="Save">
                        {savingEmail ? <Loader2 className="spinner" size={12} /> : <Check size={12} />}
                      </button>
                      <button className="btn-icon btn-secondary-subtle" onClick={cancelEditingEmail} title="Cancel">
                        <X size={12} />
                      </button>
                    </div>
                  ) : (
                    <div className="email-display-row compact" onClick={() => startEditingEmail(account)}>
                      <Mail size={12} />
                      <span className="email-hint">{account.emailHint || 'Add email...'}</span>
                      <Pencil size={10} className="edit-icon" />
                    </div>
                  )}
                </div>
              </div>
              <div className="account-card-actions">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => navigate(`/messages?account=${account.businessId}`)}
                >
                  <ExternalLink size={14} /> Leads
                </button>
                <button
                  className={`btn-icon btn-sm ${account.webhookId ? 'btn-secondary-subtle' : 'btn-success-subtle'}`}
                  onClick={() => account.webhookId ? onDisconnectWebhook(account) : onReconnectWebhook(account)}
                  disabled={togglingWebhookId === account.id || connecting}
                  title={account.webhookId ? 'Disconnect' : 'Reconnect'}
                >
                  {togglingWebhookId === account.id ? <Loader2 className="spinner" size={14} /> : account.webhookId ? <Unlink size={14} /> : <RefreshCw size={14} />}
                </button>
                <button
                  className="btn-icon btn-sm btn-danger-subtle"
                  onClick={() => onRemoveAccount(account)}
                  disabled={removingAccountId === account.id}
                  title="Delete account"
                >
                  {removingAccountId === account.id ? <Loader2 className="spinner" size={14} /> : <Trash2 size={14} />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Import Negotiations - collapsible */}
      {savedAccounts.length > 0 && (
        <div className="import-section-collapsible">
          <div className="import-section-header" onClick={toggleImportCollapsed}>
            <h3>
              <Download size={16} />
              Import Negotiations
            </h3>
            {importCollapsed ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
          </div>

          <div className={`import-section-content ${importCollapsed ? 'collapsed' : ''}`}>
            {!canImport ? (
              <div style={{
                background: '#fef3c7', border: '1px solid #fde68a', borderRadius: '8px',
                padding: '12px', display: 'flex', alignItems: 'center', gap: '10px',
              }}>
                <AlertCircle size={18} style={{ color: '#d97706', flexShrink: 0 }} />
                <span style={{ fontSize: '14px', color: '#92400e' }}>
                  Select a specific account from the dropdown above to import negotiations.
                </span>
              </div>
            ) : (
              <>
                <div style={{
                  background: '#ecfdf5', border: '1px solid #a7f3d0', borderRadius: '8px',
                  padding: '10px 12px', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px',
                  fontSize: '13px',
                }}>
                  <CheckCircle size={14} style={{ color: '#059669', flexShrink: 0 }} />
                  <span style={{ color: '#065f46' }}>
                    Importing for: <strong>{savedAccounts.find(a => a.id === selectedAccountId)?.businessName}</strong>
                  </span>
                </div>

                <textarea
                  className="import-textarea"
                  placeholder={'Paste negotiation IDs here...\n\nExample: abc123, def456, ghi789'}
                  value={importIds}
                  onChange={(e) => onImportIdsChange(e.target.value)}
                  disabled={importing}
                  rows={4}
                />

                <div className="import-actions">
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => onImportNegotiations(selectedAccountId, importIds)}
                    disabled={importing || !importIds.trim()}
                  >
                    {importing ? (
                      <><Loader2 className="spinner" size={14} /> Importing...</>
                    ) : (
                      <><Download size={14} /> Import</>
                    )}
                  </button>
                  {importIds && !importing && (
                    <button className="btn btn-secondary btn-sm" onClick={onClearImport}>
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
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
