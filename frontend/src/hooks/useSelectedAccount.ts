import { useMemo } from 'react';
import { useAppStore } from '../store/appStore';
import type { SavedAccount } from '../types';

/**
 * Cross-page account scope shared by the sidebar account switcher and every
 * per-account surface (AI Playbook, Automation filters, ...). Backed by the
 * persisted zustand store so the choice survives page navigation and full
 * reloads — picking an account on one page sticks when the user moves to
 * another. `selectedAccountId === null` means "All accounts" (default).
 */
export function useSelectedAccount(): {
  accounts: SavedAccount[];
  selectedAccountId: string | null;
  selectedAccount: SavedAccount | null;
  setSelectedAccountId: (id: string | null) => void;
} {
  const accounts = useAppStore((s) => s.savedAccounts);
  const selectedAccountId = useAppStore((s) => s.selectedAccountId);
  const setSelectedAccountId = useAppStore((s) => s.setSelectedAccountId);

  const selectedAccount = useMemo(
    () => (selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) ?? null : null),
    [selectedAccountId, accounts],
  );

  return { accounts, selectedAccountId, selectedAccount, setSelectedAccountId };
}
