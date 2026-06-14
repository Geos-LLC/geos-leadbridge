import { ArrowRight, Check, Loader2, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { authApi, thumbtackApi } from '../../../services/api';
import { useAppStore } from '../../../store/appStore';
import { useAuthStore } from '../../../store/authStore';
import type { WizardChecklist, WizardStep } from '../../../types';
import { deriveDisplayChecklist } from '../SetupProgressCard';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  checklist: WizardChecklist;
  onFinish: () => void;
  saving?: boolean;
}

// Display labels for the completion checklist. These map onto the
// actionable middle-six wizard steps (welcome + done are excluded).
const COMPLETION_ITEMS: { step: WizardStep; label: string }[] = [
  { step: 'connect', label: 'Accounts connected' },
  { step: 'business', label: 'Business website' },
  { step: 'ai', label: 'AI trained' },
  { step: 'pricing', label: 'Pricing added' },
  { step: 'automation', label: 'Automation enabled' },
  { step: 'ai_rules', label: 'AI rules configured' },
];

export default function DoneStep({ checklist, onFinish, saving }: Props) {
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const setAuth = useAuthStore(s => s.setAuth);
  const storeAccounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);

  // Title + description live in WizardShell header (2026-06-13 redesign).

  // The checklist passed in by SetupWizard is already derived against
  // its view of user state. But Done is the last step the user sees,
  // and we want to GUARANTEE the summary reflects DB truth rather
  // than whatever the persisted authStore is showing. A user who
  // walked the wizard with a stale authStore (eg. logged in before
  // the `website` field existed in auth responses) would see Business
  // unchecked here even though they entered a website.
  //
  // Re-fetch live state on mount and re-derive locally with hasWebsite +
  // accountCount from fresh sources. The fetch also re-syncs authStore
  // so a return visit to /overview reads the same state.
  const [liveWebsite, setLiveWebsite] = useState<string | null>(user?.website ?? null);
  const [liveAccountCount, setLiveAccountCount] = useState<number>(storeAccounts.length);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      authApi.getProfile().catch(() => null),
      thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as any[] })),
    ]).then(([freshUser, accountsRes]) => {
      if (cancelled) return;
      if (freshUser) {
        setLiveWebsite(freshUser.website ?? null);
        if (user) {
          const token = localStorage.getItem('token') || '';
          setAuth(
            {
              ...user,
              website: freshUser.website ?? null,
              websiteMetadataJson: freshUser.websiteMetadataJson ?? null,
              businessPhone: freshUser.businessPhone ?? user.businessPhone ?? null,
            },
            token,
          );
        }
      }
      const accounts = (accountsRes as any)?.accounts ?? [];
      setLiveAccountCount(accounts.length);
      if (accounts.length > 0) setSavedAccounts(accounts);
    });
    return () => { cancelled = true; };
    // Intentionally fire-once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-derived view of the checklist. Same data-driven rules as the
  // Overview SetupProgressCard, just sourced from this step's own
  // freshly-fetched signals so a wizard walk with a stale authStore
  // can't mislead the user about what got configured.
  const displayChecklist = useMemo(
    () => deriveDisplayChecklist(checklist, {
      accountCount: liveAccountCount,
      hasWebsite: !!liveWebsite && liveWebsite.trim().length > 0,
    }),
    [checklist, liveAccountCount, liveWebsite],
  );

  return (
    <div className="pt-2">
      <WizardStepActions>
        <button
          type="button"
          onClick={onFinish}
          disabled={saving}
          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl shadow-md shadow-blue-200 transition-all"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
          {saving ? 'Finishing…' : 'Go to Dashboard'}
          {!saving && <ArrowRight className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={() => navigate('/settings')}
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-all"
        >
          <SettingsIcon className="w-4 h-4" />
          Explore settings
        </button>
      </WizardStepActions>

      <div className="text-center">
      <div className="w-16 h-16 mx-auto mb-6 rounded-2xl inline-flex items-center justify-center bg-emerald-100 text-emerald-600 shadow-sm">
        <Check className="w-9 h-9" />
      </div>
      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      <ul className="mt-10 mx-auto max-w-sm text-left space-y-2">
        {COMPLETION_ITEMS.map(({ step, label }) => {
          const status = displayChecklist[step];
          const done = status === 'done';
          const skipped = status === 'skipped';
          return (
            <li
              key={step}
              className="flex items-center gap-3 px-4 py-3 rounded-xl border"
              style={{
                background: done ? 'rgba(16,185,129,0.06)' : 'var(--lb-surface)',
                borderColor: done ? 'rgba(16,185,129,0.2)' : 'var(--lb-line-soft)',
              }}
            >
              <span
                className={`w-6 h-6 rounded-full inline-flex items-center justify-center ${
                  done
                    ? 'bg-emerald-500 text-white'
                    : skipped
                      ? 'bg-slate-200 text-slate-500'
                      : 'bg-slate-100 text-slate-400'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
              </span>
              <span className={`flex-1 text-sm font-semibold ${done ? 'text-slate-900' : 'text-slate-500'}`}>
                {label}
              </span>
              {skipped && (
                <span className="text-[10px] font-bold uppercase tracking-widest text-slate-400">
                  skipped
                </span>
              )}
            </li>
          );
        })}
      </ul>

      </div>
    </div>
  );
}
