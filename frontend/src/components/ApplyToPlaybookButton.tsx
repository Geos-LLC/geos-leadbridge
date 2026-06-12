import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, X, CheckCircle2, AlertCircle, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

interface Props {
  /** Disabled when there's no playbookSeed on file (verify hasn't succeeded). */
  hasSeed: boolean;
  /** "wizard" vs "settings" — only affects styling so it fits each surface. */
  tone?: 'wizard' | 'settings';
}

/**
 * "Apply to AI Playbook" button + confirmation modal.
 *
 * Behaviour matches the spec:
 *   - Fill empty sections only (default)
 *   - Replace existing Playbook text (explicit opt-in)
 *   - Cancel
 *
 * On success, replaces itself with a result summary + a "Review AI Playbook"
 * link to /settings/ai-playbook. No silent overwrites — the user always
 * sees the modal before anything is written.
 *
 * Shared between Settings → Business Website and the onboarding wizard's
 * Business step.
 */
export function ApplyToPlaybookButton({ hasSeed, tone = 'wizard' }: Props) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'fill_empty' | 'replace'>('fill_empty');
  const [applying, setApplying] = useState(false);
  const [result, setResult] = useState<{
    filled: number;
    skipped: number;
    overwritten: number;
    accountsAffected: number;
    warning?: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const buttonClass = tone === 'wizard'
    ? 'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors'
    : 'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors';

  const onApply = async () => {
    setApplying(true);
    setError(null);
    try {
      const res = await usersApi.applyPlaybookSeed(mode);
      if (!res.success) {
        setError(res.warning || 'Could not apply the playbook seed.');
        return;
      }
      setResult({
        filled: res.filled,
        skipped: res.skipped,
        overwritten: res.overwritten,
        accountsAffected: res.accountsAffected,
        warning: res.warning,
      });
      setOpen(false);
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Apply failed.');
    } finally {
      setApplying(false);
    }
  };

  // Result banner — replaces the button after a successful apply.
  if (result) {
    return (
      <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 flex items-start gap-3">
        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0 text-xs">
          <div className="text-sm font-bold text-emerald-900">
            {result.filled} section{result.filled === 1 ? '' : 's'} filled
            {result.accountsAffected > 1 && ` across ${result.accountsAffected} accounts`}
          </div>
          <div className="text-emerald-700 mt-0.5">
            {result.skipped > 0 && `${result.skipped} skipped (already customized). `}
            {result.overwritten > 0 && `${result.overwritten} overwritten. `}
            {result.filled === 0 && result.skipped === 0 && result.overwritten === 0
              && 'No supported sections were extracted from the site.'}
          </div>
          <button
            type="button"
            onClick={() => navigate('/settings/ai-playbook')}
            className="mt-1 text-emerald-800 hover:text-emerald-900 font-semibold underline"
          >
            Review AI Playbook →
          </button>
        </div>
        <button
          type="button"
          onClick={() => setResult(null)}
          className="text-emerald-600 hover:text-emerald-800 shrink-0"
          aria-label="Dismiss"
        >
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => { setOpen(true); setError(null); setMode('fill_empty'); }}
        disabled={!hasSeed}
        title={hasSeed ? undefined : 'Verify your website first to extract Playbook facts.'}
        className={buttonClass}
      >
        <Sparkles size={14} />
        Apply to AI Playbook
      </button>

      {open && (
        <div
          onClick={() => !applying && setOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(15, 19, 26, 0.55)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 16,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="apply-playbook-title"
            className="bg-white rounded-xl shadow-2xl w-full max-w-md p-6"
          >
            <h3
              id="apply-playbook-title"
              className="text-lg font-bold text-slate-900 mb-1"
            >
              Apply website facts to AI Playbook?
            </h3>
            <p className="text-sm text-slate-600 mb-4">
              This will fill empty AI Playbook sections using information extracted
              from your website. Existing custom instructions will not be
              overwritten unless you choose <strong>Replace</strong>.
            </p>

            <div className="space-y-2 mb-4">
              <label className="flex items-start gap-2 p-3 rounded-lg border border-slate-200 hover:border-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="apply-mode"
                  value="fill_empty"
                  checked={mode === 'fill_empty'}
                  onChange={() => setMode('fill_empty')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-slate-900">
                    Fill empty sections only
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Safer. Leaves anything you've already written alone.
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 p-3 rounded-lg border border-slate-200 hover:border-slate-300 cursor-pointer">
                <input
                  type="radio"
                  name="apply-mode"
                  value="replace"
                  checked={mode === 'replace'}
                  onChange={() => setMode('replace')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="text-sm font-semibold text-slate-900">
                    Replace existing Playbook text
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    Overwrites any custom instructions in the 6 supported sections.
                  </div>
                </div>
              </label>
            </div>

            <p className="text-xs text-slate-500 mb-4">
              Applies to: Business Information, Pricing Guidance, Booking Guidance,
              Objection Handling, Human Handoff Guidance, AI Personality &amp; Brand Voice.
              <br />
              Does NOT touch your FAQ, pricing table, qualification guidance, follow-up
              tone, or phone-call guidance.
            </p>

            {error && (
              <div className="mb-3 px-3 py-2 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-start gap-2">
                <AlertCircle size={14} className="shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={applying}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void onApply()}
                disabled={applying}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-bold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                {applying ? <Loader2 size={14} className="animate-spin" /> : null}
                {applying ? 'Applying…' : mode === 'replace' ? 'Replace' : 'Fill empty'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
