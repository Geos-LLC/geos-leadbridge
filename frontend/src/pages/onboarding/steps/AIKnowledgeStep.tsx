import { useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../../store/appStore';
import { thumbtackApi } from '../../../services/api';
import AccountFaqForm from '../../../components/AccountFaqForm';
import { WizardStepActions } from '../WizardStepActions';

interface Props {
  onSaveContinue: () => Promise<void> | void;
  saving: boolean;
  setSaving: (v: boolean) => void;
}

/**
 * Wizard step 4 — AI Knowledge.
 *
 * Now embeds the full `AccountFaqForm` (the same form used on
 * Settings → AI Playbook → FAQ). Pre-fill from the website seed happens
 * BEFORE the user lands here — `BusinessWebsiteStep` chains
 * `applyFaqFromWebsiteSeed` after `applyPlaybookSeed`, so by the time
 * the user opens this step the form's initial values already include
 * whatever the AI extracted from the homepage.
 *
 * The FAQ form manages its own Save button + cascade-to-all behaviour.
 * The wizard provides a separate `Continue` button that just advances
 * (the user must save first via the form, which also lights up the
 * "Saved" badge on the card).
 */
export default function AIKnowledgeStep({ onSaveContinue, saving, setSaving }: Props) {
  const navigate = useNavigate();
  const savedAccounts = useAppStore(s => s.savedAccounts);
  const setSavedAccounts = useAppStore(s => s.setSavedAccounts);
  // Title + description live in WizardShell header (2026-06-13 redesign).

  const [accountsLoading, setAccountsLoading] = useState(savedAccounts.length === 0);

  // Refresh saved accounts in case the store is empty from a deep link or
  // the user landed here without going through Connect.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (savedAccounts.length > 0) return;
      try {
        const { accounts } = await thumbtackApi.getSavedAccounts();
        if (cancelled) return;
        setSavedAccounts(accounts);
      } catch {
        /* non-fatal — user can skip via "Set up later" */
      } finally {
        if (!cancelled) setAccountsLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The form writes to the first account, but we pass saveToAll so the
  // cascade applies across every connected SavedAccount in one click. This
  // matches "Custom instructions apply to all connected accounts." copy on
  // the Settings → AI Playbook FAQ card.
  const primaryAccount = savedAccounts[0];
  const allIds = useMemo(() => savedAccounts.map(a => a.id), [savedAccounts]);

  async function handleContinue() {
    if (saving) return;
    setSaving(true);
    try {
      await onSaveContinue();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="pt-2">
      {/* Sticky top action row — primary CTA + secondary deep link.
          Always visible so users on long FAQ forms can save without
          scrolling back up. */}
      <WizardStepActions>
        <button
          type="button"
          onClick={() => void handleContinue()}
          disabled={saving}
          style={{
            padding: '10px 22px', borderRadius: 10,
            border: 0, background: 'var(--lb-accent)', color: '#fff',
            fontSize: 13, fontWeight: 700,
            cursor: saving ? 'not-allowed' : 'pointer',
            opacity: saving ? 0.5 : 1,
            fontFamily: 'inherit',
          }}
        >
          {saving ? 'Continuing…' : 'Continue'}
        </button>
      </WizardStepActions>

      {/* Title + description moved to WizardShell header (2026-06-13 redesign). */}

      {/* "Pre-filled from your website" hint when verify produced an FAQ
          patch. We can't strictly verify what was filled here without a
          per-account API round-trip, so the hint is shown whenever the
          user has a verified website with a Playbook seed — the form
          will surface whatever ended up in faqJson. */}
      <div className="mb-5 flex items-start gap-2 rounded-xl border border-amber-100 bg-amber-50/60 px-3 py-2.5 text-xs text-amber-900">
        <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
        <div>
          <strong>Pre-filled from your website where we could.</strong> Review the
          answers below — anything left "Not set" is something we couldn't
          confidently extract. The AI uses these answers verbatim, so
          confirming them now saves time later.
        </div>
      </div>

      {accountsLoading ? (
        <div className="py-12 text-center text-sm text-slate-400">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      ) : !primaryAccount ? (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-5 text-sm text-slate-600">
          You haven't connected any accounts yet, so there's nowhere to save
          FAQ answers. You can fill these in from{' '}
          <button
            type="button"
            onClick={() => navigate('/settings?tab=ai-playbook')}
            className="text-blue-600 hover:underline font-semibold"
          >
            Settings → AI Playbook
          </button>{' '}
          once an account is connected.
        </div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white p-5">
          <AccountFaqForm
            accountId={primaryAccount.id}
            accountName={primaryAccount.businessName ?? primaryAccount.platform ?? 'Your account'}
            saveToAll={allIds.length > 1 ? allIds : undefined}
          />
        </div>
      )}

      {savedAccounts.length > 1 && (
        <p className="mt-6 text-xs text-slate-400 max-w-md">
          FAQ answers apply to all connected accounts. You can customize each account later in Settings → AI Playbook → FAQ.
        </p>
      )}
    </div>
  );
}
