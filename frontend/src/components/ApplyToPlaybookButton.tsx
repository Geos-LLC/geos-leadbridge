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
      // fill_empty is the only mode we expose from this button — protects
      // any user-typed text already in the Playbook. Replace-mode lives
      // only inside the AI Playbook page itself if we ever need it.
      const res = await usersApi.applyPlaybookSeed('fill_empty');
      if (!res.success) {
        notify.warning('Could not apply', res.warning || 'Nothing to apply.');
        return;
      }
      if (res.filled === 0 && res.skipped === 0) {
        notify.info(
          'Nothing to apply',
          'No supported sections were extracted from the site yet.',
        );
        return;
      }
      const filledMsg = res.filled === 0
        ? 'No empty sections to fill.'
        : `Applied website information to ${res.filled} AI Playbook section${res.filled === 1 ? '' : 's'}.`;
      const reviewMsg = res.filled > 0
        ? ' Review and edit the suggestions below.'
        : '';
      notify.success(
        'Applied to AI Playbook',
        filledMsg + reviewMsg,
        5000,
      );
      // Route the user to the Playbook so they can see the badges
      // immediately. The page reads `suggestedFromWebsite` per section
      // and renders a "Suggested from website" pill on each one we
      // just touched.
      navigate('/settings/ai-playbook');
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
