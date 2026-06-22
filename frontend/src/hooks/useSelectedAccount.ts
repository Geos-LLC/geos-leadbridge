import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAppStore } from '../store/appStore';
import type { SavedAccount } from '../types';

/**
 * URL-backed account selection shared across per-account settings/automation
 * pages. `?account=<id>` pins to one account; `?account=all` (or absent)
 * means the page should treat its data as cross-account. `selectedAccountId`
 * is null in the "all" case so existing call sites that already branch on
 * `null` keep working.
 */
export function useSelectedAccount(): {
  accounts: SavedAccount[];
  selectedAccountId: string | null;
  selectedAccount: SavedAccount | null;
  setSelectedAccountId: (id: string | null) => void;
} {
  const accounts = useAppStore((s) => s.savedAccounts);
  const [searchParams, setSearchParams] = useSearchParams();

  const raw = searchParams.get('account');
  const selectedAccountId = useMemo(() => {
    if (!raw || raw === 'all') return null;
    return raw;
  }, [raw]);

  const selectedAccount = useMemo(
    () => (selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) ?? null : null),
    [selectedAccountId, accounts],
  );

  const setSelectedAccountId = useCallback(
    (id: string | null) => {
      const sp = new URLSearchParams(searchParams);
      if (id) sp.set('account', id);
      else sp.delete('account');
      setSearchParams(sp, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  return { accounts, selectedAccountId, selectedAccount, setSelectedAccountId };
}
