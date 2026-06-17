import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';
import { notify } from '../store/notificationStore';

interface Props {
  /** Disabled when there's no playbookSeed on file (verify hasn't succeeded). */
  hasSeed: boolean;
  /** "wizard" vs "settings" — only affects styling so it fits each surface. */
  tone?: 'wizard' | 'settings';
}

/**
 * "Apply to AI Playbook" — silent fill_empty apply + toast + navigate.
 *
 * Philosophy: maximum automation, manual refinement only when needed.
 * No confirmation modal — fill_empty mode never overwrites user-typed
 * text, so there's nothing destructive to confirm. The destination page
 * (Settings → AI Playbook) renders a "Suggested from website" badge over
 * every section we just filled so the user knows exactly what to review.
 *
 * Used in Settings → Business Website and the onboarding Business step.
 */
export function ApplyToPlaybookButton({ hasSeed, tone = 'wizard' }: Props) {
  const navigate = useNavigate();
  const [applying, setApplying] = useState(false);

  const buttonClass = tone === 'wizard'
    ? 'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors'
    : 'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors';

  const onClick = async () => {
    if (!hasSeed || applying) return;
    setApplying(true);
    try {
      // V2.4 apply is always additive line-level on the backend — the
      // mode parameter is preserved in the API for back-compat but the
      // server ignores it. Existing custom instructions are never erased;
      // new fact-lines are appended only if not already present.
      const res = await usersApi.applyPlaybookSeed('fill_empty');
      if (!res.success) {
        notify.warning('Could not apply', res.warning || 'Nothing to apply.');
        return;
      }
      // Tolerate either response shape — line-level (new) or section-level
      // (legacy) — so a stale frontend never crashes on a freshly-deployed
      // backend or vice versa. The new fields are linesAdded /
      // linesDuplicate / sectionsTouched; the old were filled / skipped.
      const r = res as any;
      const linesAdded: number   = typeof r.linesAdded   === 'number' ? r.linesAdded   : (r.filled ?? 0);
      const linesDuplicate: number = typeof r.linesDuplicate === 'number' ? r.linesDuplicate : 0;

      if (linesAdded === 0) {
        notify.info(
          'AI Playbook already up to date',
          linesDuplicate > 0
            ? 'AI Playbook already includes this website information.'
            : 'No supported sections were extracted from the site yet.',
          4000,
        );
        return;
      }
      notify.success(
        'Applied to AI Playbook',
        'Website information applied to AI Playbook. Review AI Playbook below.',
        5000,
      );
      // Route to the Playbook so the "Suggested from website" badges are
      // immediately visible.
      navigate('/settings?tab=ai-playbook');
    } catch (e: any) {
      notify.error(
        'Apply failed',
        e?.response?.data?.message || e?.message || 'Could not apply website info.',
      );
    } finally {
      setApplying(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={!hasSeed || applying}
      title={hasSeed ? undefined : 'Verify your website first to extract Playbook facts.'}
      className={buttonClass}
    >
      {applying ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
      {applying ? 'Applying…' : 'Apply to AI Playbook'}
    </button>
  );
}
