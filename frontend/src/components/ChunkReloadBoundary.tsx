import { Component, type ReactNode } from 'react';
import { PageSkeleton } from './PageSkeleton';

const CHUNK_ERR_PATTERNS = [
  /Failed to fetch dynamically imported module/i,
  /Loading chunk .* failed/i,
  /ChunkLoadError/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const msg = (err as any)?.message ?? String(err);
  return CHUNK_ERR_PATTERNS.some(re => re.test(msg));
}

// After a Vite deploy, the hashed chunk filenames a long-lived tab references
// no longer exist on the CDN. The dynamic import() rejects, React unmounts the
// tree, and the user sees a blank page until they manually reload. Mobile gets
// hit harder because phones background tabs and PWAs hold the same bundle for
// hours. This boundary detects the specific chunk-load failure and forces a
// reload exactly once per session window, falling back to PageSkeleton meanwhile
// so the screen isn't blank. Non-chunk errors get a generic recovery UI instead
// of triggering an infinite reload loop.
export class ChunkReloadBoundary extends Component<
  { children: ReactNode },
  { error: unknown }
> {
  state = { error: null as unknown };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) {
      const RELOAD_KEY = 'lb_chunk_reload_at';
      const RELOAD_DEBOUNCE_MS = 10_000;
      try {
        const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
        const now = Date.now();
        if (now - last > RELOAD_DEBOUNCE_MS) {
          sessionStorage.setItem(RELOAD_KEY, String(now));
          window.location.reload();
        }
      } catch {
        window.location.reload();
      }
    }
  }

  render() {
    if (this.state.error) {
      if (isChunkLoadError(this.state.error)) {
        return <PageSkeleton />;
      }
      return (
        <div style={{
          padding: 24, fontSize: 14, color: '#374151',
          textAlign: 'center', marginTop: 80, fontFamily: 'inherit',
        }}>
          <p style={{ fontWeight: 600, marginBottom: 12, fontSize: 16, color: '#111827' }}>
            Something went wrong loading this page.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '8px 16px', borderRadius: 8,
              border: '1px solid #d1d5db', background: '#fff',
              cursor: 'pointer', fontWeight: 600, color: '#111827',
            }}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
