import { useEffect, useState } from 'react';

/**
 * Detects when a newer frontend build has shipped while this tab has been
 * open. Mechanism:
 *
 *   - vite.config.ts injects `__BUILD_VERSION__` (git short SHA) at build
 *     time AND writes the same value to `/version.json` after the bundle
 *     is emitted.
 *   - At runtime, this hook fetches `/version.json` periodically. If the
 *     fetched `version` differs from the embedded `__BUILD_VERSION__`,
 *     the tab is stale → the consumer (UpdateAvailableBanner) prompts the
 *     user to reload.
 *
 * Polling cadence:
 *   - On mount (once).
 *   - Every 5 minutes while the tab is mounted.
 *   - On every `visibilitychange → visible` (the most common case is a
 *     user switching back to a tab they left open for hours).
 *
 * Dev mode (`vite serve`) intentionally skips the poll — `/version.json`
 * doesn't exist there, and HMR handles updates instead.
 */
export interface BuildVersionState {
  /** The version baked into THIS bundle. */
  current: string;
  /** The version the server is now serving, once detected. `null` until first check. */
  latest: string | null;
  /** True iff `latest` is known and differs from `current`. */
  updateAvailable: boolean;
  /** Hard-reload the page to pick up the new bundle. */
  reload: () => void;
}

const POLL_INTERVAL_MS = 5 * 60_000; // 5 min

export function useBuildVersion(): BuildVersionState {
  const current = typeof __BUILD_VERSION__ === 'string' ? __BUILD_VERSION__ : 'dev';
  const [latest, setLatest] = useState<string | null>(null);

  useEffect(() => {
    // Skip the polling loop entirely in dev — there's no /version.json to
    // hit, HMR is doing the work, and the noise would confuse local debugging.
    if (!import.meta.env.PROD) return;

    let cancelled = false;

    const check = async () => {
      try {
        const r = await fetch('/version.json', { cache: 'no-store' });
        if (!r.ok) return;
        const j = (await r.json()) as { version?: string };
        if (cancelled) return;
        if (typeof j.version === 'string' && j.version && j.version !== current) {
          setLatest(j.version);
        }
      } catch {
        // Network blip or offline — try again on next tick. Never log here:
        // a flaky connection shouldn't spam the console every 5 min.
      }
    };

    void check();
    const id = window.setInterval(check, POLL_INTERVAL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [current]);

  return {
    current,
    latest,
    updateAvailable: latest !== null && latest !== current,
    reload: () => {
      // Best-effort: tell the mobile service worker to drop any cached
      // shell so the very next request hits the new index.html. The
      // service worker registered in main.tsx is conservative — it only
      // caches the shell + static assets — but a stale shell is exactly
      // what we're trying to bust through.
      if ('serviceWorker' in navigator) {
        void navigator.serviceWorker
          .getRegistrations()
          .then((regs) => Promise.all(regs.map((r) => r.update())))
          .catch(() => undefined);
      }
      window.location.reload();
    },
  };
}
