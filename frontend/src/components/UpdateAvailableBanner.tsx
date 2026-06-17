import { RefreshCw } from 'lucide-react';
import { useBuildVersion } from '../hooks/useBuildVersion';

/**
 * Fixed bottom-right toast that appears when `/version.json` reports a
 * newer build than the one this tab loaded. Clicking "Reload" triggers a
 * hard reload (and best-effort service-worker update).
 *
 * Renders nothing when no update is available. Safe to mount once at the
 * App root — the underlying hook handles polling + cleanup.
 *
 * Why this exists: the 2026-06-16 PR-E cascade left 16 TT accounts dead,
 * and the UI improvements (clearer "Reconnect now" CTA, etc.) shipped in
 * a deploy. Tenants with the OLD bundle open in a long-lived tab don't
 * see the new CTA until they refresh. This banner makes the prompt
 * explicit instead of relying on a chunk-load error to force a reload.
 */
export function UpdateAvailableBanner() {
  const { updateAvailable, reload } = useBuildVersion();
  if (!updateAvailable) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 20,
        right: 20,
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 16px',
        borderRadius: 14,
        background: '#0f172a',
        color: '#ffffff',
        fontSize: 13,
        fontWeight: 500,
        fontFamily: 'inherit',
        boxShadow: '0 10px 32px rgba(0,0,0,0.22)',
        maxWidth: 'calc(100vw - 40px)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <RefreshCw size={14} aria-hidden="true" />
        Update available
      </span>
      <button
        type="button"
        onClick={reload}
        style={{
          padding: '7px 16px',
          borderRadius: 8,
          background: '#3b82f6',
          color: '#ffffff',
          border: 0,
          fontSize: 13,
          fontWeight: 700,
          cursor: 'pointer',
          fontFamily: 'inherit',
          boxShadow: '0 1px 2px rgba(0,0,0,0.08)',
        }}
        title="Reload to pick up the latest version"
      >
        Reload
      </button>
    </div>
  );
}
