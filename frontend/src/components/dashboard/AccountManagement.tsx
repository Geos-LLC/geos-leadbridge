import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2, Link2, CheckCircle, AlertCircle, Loader2, ExternalLink,
  X, Unlink, Trash2, Mail, Pencil, Check, RefreshCw,
} from 'lucide-react';
import type { SavedAccount } from '../../types';

interface AccountManagementProps {
  savedAccounts: SavedAccount[];
  connecting: boolean;
  onConnectThumbtack: () => void;
  onDisconnectWebhook: (account: SavedAccount) => void;
  onReconnectWebhook: (account: SavedAccount) => void;
  onRemoveAccount: (account: { id: string; businessName: string }) => void;
  onUpdateEmail: (accountId: string, email: string) => Promise<void>;
  togglingWebhookId: string | null;
  removingAccountId: string | null;
}

export default function AccountManagement({
  savedAccounts,
  connecting,
  onConnectThumbtack,
  onDisconnectWebhook,
  onReconnectWebhook,
  onRemoveAccount,
  onUpdateEmail,
  togglingWebhookId,
  removingAccountId,
}: AccountManagementProps) {
  const navigate = useNavigate();

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

  return (
    <section className="manage-accounts-section" id="manage-accounts">
      {savedAccounts.length > 0 && (
        <div className="account-cards-compact">
          <div className="account-cards-header">
            <h3>Your Accounts</h3>
            <button
              className="btn btn-primary btn-sm"
              onClick={onConnectThumbtack}
              disabled={connecting}
            >
              {connecting ? (
                <><Loader2 className="spinner" size={14} /> Connecting...</>
              ) : (
                <><Link2 size={14} /> Add Account</>
              )}
            </button>
          </div>
          {savedAccounts.map((account) => (
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
    </section>
  );
}
