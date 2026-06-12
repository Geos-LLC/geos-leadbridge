import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Plus, Facebook, Globe, AlertCircle } from 'lucide-react';
import ConnectionModal from '../../../components/ConnectionModal';
import { useAppStore } from '../../../store/appStore';
import { thumbtackApi } from '../../../services/api';
import { PlatformBadge } from '../../../components/ui';
import { getStepMeta } from '../wizardConfig';
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

  const meta = getStepMeta('connect');

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

  return (
    <div className="pt-2">
      <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight mb-2">
        {meta.title}
      </h1>
      <p className="text-base text-slate-500 leading-relaxed mb-8 max-w-xl">
        {meta.description}
      </p>

      {/* Connected accounts — only render the section when we have data */}
      {!loading && savedAccounts.length > 0 && (
        <div className="mb-6">
          <div className="text-[11px] font-bold uppercase tracking-widest text-slate-400 mb-2">
            Connected
          </div>
          <ul className="space-y-2">
            {savedAccounts.map(acct => (
              <li
                key={acct.id}
                className="flex flex-col gap-3 px-4 py-3 rounded-2xl border"
                style={{ background: 'var(--lb-surface)', borderColor: 'var(--lb-line-soft)' }}
              >
                <div className="flex items-center gap-3">
                  <PlatformBadge platform={acct.platform} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-slate-900 truncate">
                      {acct.businessName || 'Untitled business'}
                    </div>
                    <div className="text-xs text-slate-400 capitalize">{acct.platform}</div>
                  </div>
                  {acct.webhookId ? (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-emerald-700">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Connected
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-bold text-amber-600">
                      <AlertCircle className="w-3.5 h-3.5" />
                      Needs attention
                    </span>
                  )}
                </div>
                {/* Thumbtack profile URL input moved to the Business
                    Website step — it's a data-source input, not an OAuth
                    setting. Connect this step intentionally keeps just
                    the OAuth list. */}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add a source */}
      <div className="mb-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
        {savedAccounts.length > 0 ? 'Add another source' : 'Connect a source'}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PlatformTile
          name="Thumbtack"
          dotColor="rgb(37,99,235)"
          subtitle={byPlatform.thumbtack?.length ? `${byPlatform.thumbtack.length} connected` : 'OAuth login'}
          onClick={openConnectionModal}
        />
        <PlatformTile
          name="Yelp"
          dotColor="rgb(220,38,38)"
          subtitle={byPlatform.yelp?.length ? `${byPlatform.yelp.length} connected` : 'OAuth login'}
          onClick={openConnectionModal}
        />
        <PlatformTile
          name="Website form"
          icon={<Globe className="w-4 h-4" />}
          subtitle="Coming soon"
          disabled
        />
        <PlatformTile
          name="Facebook / Ads"
          icon={<Facebook className="w-4 h-4" />}
          subtitle="Coming soon"
          disabled
        />
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

interface PlatformTileProps {
  name: string;
  subtitle: string;
  dotColor?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  onClick?: () => void;
}

function PlatformTile({ name, subtitle, dotColor, icon, disabled, onClick }: PlatformTileProps) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={`flex items-center gap-3 px-4 py-3.5 rounded-2xl border text-left transition-all ${
        disabled
          ? 'opacity-50 cursor-not-allowed'
          : 'hover:border-blue-300 hover:shadow-sm cursor-pointer'
      }`}
      style={{ background: 'var(--lb-surface)', borderColor: 'var(--lb-line-soft)' }}
    >
      {icon ? (
        <span className="w-8 h-8 rounded-xl bg-slate-100 text-slate-500 inline-flex items-center justify-center shrink-0">
          {icon}
        </span>
      ) : (
        <span
          className="w-3 h-3 rounded-full shrink-0"
          style={{ background: dotColor ?? 'var(--lb-accent)' }}
          aria-hidden
        />
      )}
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-slate-900">{name}</div>
        <div className="text-xs text-slate-500">{subtitle}</div>
      </div>
      {!disabled && (
        <Plus className="w-4 h-4 text-slate-400 shrink-0" />
      )}
    </button>
  );
}
