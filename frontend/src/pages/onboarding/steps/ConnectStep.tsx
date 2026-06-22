import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus } from 'lucide-react';
import ConnectionModal from '../../../components/ConnectionModal';
import { useAppStore } from '../../../store/appStore';
import { thumbtackApi } from '../../../services/api';
import type { SavedAccount } from '../../../types';

// Sentinel checked by Dashboard after an OAuth callback to decide
// whether the user should be sent back into the wizard. Set before
// the OAuth redirect fires, consumed (and cleared) on the wizard
// return.
const WIZARD_OAUTH_RETURN_FLAG = 'lb_wizard_oauth_return';

interface Props {
  // True when wizardChecklistStatus.connect === 'done'. Used to
  // suppress the auto-mark patch when nothing's changed.
  alreadyDone: boolean;
  // Called on mount when accounts exist and the step isn't yet marked
  // done. Marks the step done WITHOUT advancing currentStep — the
  // user still drives navigation via the wizard footer.
  onMarkDone: () => Promise<void> | void;
}

// Connect Sources step. Reuses the existing ConnectionModal — which
// already owns the Thumbtack/Yelp OAuth flows — so this component is a
// thin presentational shell that lists connected SavedAccounts and
// hands off to the modal when the user wants to add another one.
//
// Two behaviors that make the step feel "live":
//   1. If the user arrives with at least one SavedAccount (because
//      they connected before the wizard, OAuthed in a different tab,
//      or just came back from OAuth), we auto-mark connect=done so
//      the sidebar checkmark and the Overview progress card both
//      turn green without needing a manual Continue click.
//   2. When the user clicks a platform tile we set a sessionStorage
//      flag. The OAuth callback redirects back to /overview; the
//      Dashboard sees the flag and routes the user back into the
//      wizard (with connect=done already, advancing to Business).
export default function ConnectStep({ alreadyDone, onMarkDone }: Props) {
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);
  const [modalOpen, setModalOpen] = useState(false);
  const [loading, setLoading] = useState(savedAccounts.length === 0);

  // Title + description live in WizardShell header (2026-06-13 redesign).

  // Pull the latest account list on mount so the step shows a fresh
  // count even if the user reached this page via a deep link.
  useEffect(() => {
    let cancelled = false;
    thumbtackApi.getSavedAccounts()
      .then(({ accounts }) => { if (!cancelled) setSavedAccounts(accounts); })
      .catch(() => { /* non-fatal — show whatever's in the store */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-mark connect=done when accounts exist and the wizard hasn't
  // already recorded the step as done. Runs on every render where the
  // inputs change; onMarkDone itself no-ops on duplicate writes thanks
  // to the backend's merge semantics (and the alreadyDone gate stops
  // the loop after the first successful patch).
  useEffect(() => {
    if (savedAccounts.length > 0 && !alreadyDone) {
      void onMarkDone();
    }
  }, [savedAccounts.length, alreadyDone, onMarkDone]);

  // The per-account public Thumbtack profile URL input used to live here.
  // It moved to the Business Website step (and Settings → General already
  // has its own copy) so onboarding's "where do my business facts come
  // from" surface owns all of it — this Connect step is about OAuth
  // wiring, not data sourcing.

  function openConnectionModal() {
    // Tell Dashboard "if you see ?connected=… on your next mount,
    // assume the user wants to be back in the wizard." Cleared by
    // Dashboard once consumed.
    try { sessionStorage.setItem(WIZARD_OAUTH_RETURN_FLAG, '1'); } catch { /* ignore */ }
    setModalOpen(true);
  }

  const byPlatform = useMemo(() => {
    const groups: Record<string, SavedAccount[]> = {};
    for (const acct of savedAccounts) {
      const key = acct.platform || 'other';
      (groups[key] ||= []).push(acct);
    }
    return groups;
  }, [savedAccounts]);

  // Bundle layout: a single vertical list with one row per platform
  // (always shown, "Connected" or "Connect") + a dashed "Add another
  // source" row underneath. Per-platform connection state collapses
  // multi-account tenants into a single status row — the actual
  // per-business list lives in /settings/accounts.
  const ttCount = byPlatform.thumbtack?.length ?? 0;
  const yelpCount = byPlatform.yelp?.length ?? 0;

  return (
    <div className="pt-2">
      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <PlatformRow
          name="Thumbtack"
          short="TT"
          color="#009fd9"
          connectedCount={ttCount}
          onConnect={openConnectionModal}
        />
        <PlatformRow
          name="Yelp"
          short="Y"
          color="#c4302b"
          connectedCount={yelpCount}
          onConnect={openConnectionModal}
        />
        <AddSourceRow onClick={openConnectionModal} />
      </div>

      {savedAccounts.length === 0 && !loading && (
        <p className="mt-5 text-xs text-slate-400 max-w-md">
          No accounts connected yet. You can skip this step and connect later from the Dashboard — but most automations need at least one source to do anything useful.
        </p>
      )}

      <ConnectionModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        savedAccounts={savedAccounts}
        onSuccess={() => {
          setModalOpen(false);
          // Refresh the local list — the OAuth callback may have just
          // landed a new SavedAccount in the store, but we re-fetch to
          // be sure.
          thumbtackApi.getSavedAccounts().then(({ accounts }) => setSavedAccounts(accounts)).catch(() => {});
        }}
      />
    </div>
  );
}

// Single per-platform row matching the LeadBridge Wizard Bundle —
// 38px brand-color badge + name + status / Connect button. When the
// tenant has 2+ accounts on the platform we surface the count in the
// status line so the row still reflects what's connected.
function PlatformRow({
  name, short, color, connectedCount, onConnect,
}: {
  name: string;
  short: string;
  color: string;
  connectedCount: number;
  onConnect: () => void;
}) {
  const connected = connectedCount > 0;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 13,
      padding: 16, background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 12,
    }}>
      <span style={{
        width: 38, height: 38, borderRadius: 9,
        background: color, color: '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: 'var(--lb-font-mono)', fontWeight: 700, fontSize: 13,
        flexShrink: 0,
      }}>{short}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{name}</div>
        <div style={{
          fontSize: 12, fontWeight: 600,
          color: connected ? 'var(--lb-success)' : 'var(--lb-ink-5)',
        }}>
          {connected
            ? (connectedCount > 1 ? `${connectedCount} connected` : 'Connected')
            : 'Not connected'}
        </div>
      </div>
      {connected ? (
        <CheckCircle2 size={18} strokeWidth={2.5} style={{ color: 'var(--lb-success)' }} />
      ) : (
        <button
          type="button"
          onClick={onConnect}
          style={{
            padding: '7px 14px', borderRadius: 8, border: 0,
            background: 'var(--lb-accent)', color: '#fff',
            fontSize: 12.5, fontWeight: 600, cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Connect
        </button>
      )}
    </div>
  );
}

// "Add another source" row — dashed border, gray tile + plus icon, two
// text lines. Opens the ConnectionModal so Angi / Google / etc. can be
// added without leaving the wizard.
function AddSourceRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 13,
        padding: 16, background: '#fff',
        border: '1px dashed var(--lb-line)',
        borderRadius: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        width: '100%',
      }}
    >
      <span style={{
        width: 38, height: 38, borderRadius: 9,
        background: 'var(--lb-ink-10)', color: 'var(--lb-ink-5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Plus size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)' }}>Add another source</div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>Angi, Google, and more</div>
      </div>
    </button>
  );
}

