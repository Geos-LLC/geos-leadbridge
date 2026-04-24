import type { ReactNode } from 'react';

/**
 * Full-page skeleton used as the Suspense fallback while a lazy route is
 * downloading its chunk. Approximates the post-login app shell (header + main
 * content area with a loading card) so the handoff from lazy load → rendered
 * page doesn't feel like a blank screen.
 */
export function PageSkeleton({ children }: { children?: ReactNode }) {
  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header strip — matches the general shape of Layout's header */}
      <div className="h-14 border-b border-slate-200 bg-white px-6 flex items-center gap-4">
        <div className="h-5 w-32 rounded bg-slate-200 animate-pulse" />
        <div className="flex-1" />
        <div className="h-8 w-8 rounded-full bg-slate-200 animate-pulse" />
      </div>

      {/* Content area */}
      <div className="mx-auto max-w-6xl p-6">
        <div className="mb-6 flex items-center gap-3">
          <div className="h-7 w-48 rounded bg-slate-200 animate-pulse" />
          <div className="flex-1" />
          <div className="h-9 w-24 rounded bg-slate-200 animate-pulse" />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200 bg-white p-5"
              aria-hidden="true"
            >
              <div className="mb-3 h-4 w-24 rounded bg-slate-200 animate-pulse" />
              <div className="h-8 w-16 rounded bg-slate-200 animate-pulse" />
              <div className="mt-4 h-3 w-full rounded bg-slate-100 animate-pulse" />
              <div className="mt-2 h-3 w-3/4 rounded bg-slate-100 animate-pulse" />
            </div>
          ))}
        </div>

        <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
          <div className="mb-4 h-5 w-40 rounded bg-slate-200 animate-pulse" />
          <div className="space-y-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex items-center gap-4" aria-hidden="true">
                <div className="h-10 w-10 rounded-full bg-slate-200 animate-pulse" />
                <div className="flex-1">
                  <div className="h-3 w-1/3 rounded bg-slate-200 animate-pulse" />
                  <div className="mt-2 h-3 w-2/3 rounded bg-slate-100 animate-pulse" />
                </div>
                <div className="h-8 w-20 rounded bg-slate-200 animate-pulse" />
              </div>
            ))}
          </div>
        </div>

        {children}

        <span className="sr-only" role="status" aria-live="polite">
          Loading page…
        </span>
      </div>
    </div>
  );
}
