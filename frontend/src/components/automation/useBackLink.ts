import { useLocation, useNavigate } from 'react-router-dom';

// Cross-surface back link helper.
//
// When code navigates between Automation and Settings via React Router state
// (e.g. `navigate('/settings?tab=hours', { state: { from: '/automation/respond', fromLabel: 'Automation · Respond' } })`),
// the destination page can call this hook to render a "← Back to X" link.
// Returns null when no state.from is present, otherwise { label, onClick }
// suitable for passing to AutoPageHeader's `backLink` prop.
export type BackLinkState = { from: string; fromLabel?: string } | null;

export function useBackLink(): { label: string; onClick: () => void } | null {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state || null) as BackLinkState;
  if (!state?.from) return null;

  // Derive a sensible label if the source page didn't supply one.
  const label = state.fromLabel || labelFor(state.from);
  return {
    label,
    onClick: () => navigate(state.from, { replace: true }),
  };
}

function labelFor(path: string): string {
  if (path.startsWith('/automation/respond')) return 'When a Lead Arrives';
  if (path.startsWith('/automation/engage'))  return 'Follow-ups';
  if (path.startsWith('/automation/convert')) return 'AI Conversation';
  if (path.startsWith('/automation')) return 'Automation';
  if (path.startsWith('/settings')) return 'Settings';
  return 'previous page';
}
