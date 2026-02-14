import { Building2, ChevronDown, CheckCircle } from 'lucide-react';
import type { SavedAccount } from '../../types';

interface AccountSelectorProps {
  accounts: SavedAccount[];
  selectedAccountId: string | null;
  onSelectAccount: (id: string | null) => void;
}

export default function AccountSelector({
  accounts,
  selectedAccountId,
  onSelectAccount,
}: AccountSelectorProps) {
  if (accounts.length === 0) return null;

  const selectedAccount = accounts.find(a => a.id === selectedAccountId);

  // Single account — display only, no dropdown
  if (accounts.length === 1) {
    const account = accounts[0];
    return (
      <div className="account-selector single">
        <Building2 size={18} />
        <span className="account-name">{account.businessName}</span>
        {account.webhookId && (
          <span className="account-badge connected">
            <CheckCircle size={12} />
            Connected
          </span>
        )}
      </div>
    );
  }

  // Multi-account — dropdown
  return (
    <div className="account-selector multi">
      <label className="account-selector-label">Account:</label>
      <div className="account-dropdown-wrapper">
        <select
          className="account-dropdown"
          value={selectedAccountId || '__all__'}
          onChange={(e) => {
            const val = e.target.value;
            onSelectAccount(val === '__all__' ? null : val);
          }}
        >
          {accounts.map(account => (
            <option key={account.id} value={account.id}>
              {account.businessName}
            </option>
          ))}
          <option value="__all__">All Accounts</option>
        </select>
        <ChevronDown size={16} className="dropdown-chevron" />
      </div>
      {selectedAccount?.webhookId && (
        <span className="account-badge connected">
          <CheckCircle size={12} />
          Connected
        </span>
      )}
    </div>
  );
}
