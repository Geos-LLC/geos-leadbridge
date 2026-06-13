import type { ReactNode } from 'react';

/**
 * Sticky action-button row for the top of a wizard step body.
 *
 * The WizardShell header owns Back / Exit / progress. Steps that need
 * their own Save & Continue (and siblings like "I don't have a website",
 * "Preview default pricing") render those buttons here at the TOP of
 * their body content. The `sticky top-0` keeps them visible while the
 * user scrolls a long step like Automation, so the primary CTA is
 * always one click away.
 *
 * Lives just below the shell's sticky header — z-index sits one notch
 * lower so the shell header still wins if they ever overlap during a
 * resize transition.
 */
export function WizardStepActions({ children }: { children: ReactNode }) {
  return (
    <div
      className="sticky top-0 z-[5] -mx-6 md:-mx-10 px-6 md:px-10 py-3 mb-6 flex items-center gap-3 flex-wrap backdrop-blur-sm"
      style={{
        background: 'rgba(255, 255, 255, 0.94)',
        borderBottom: '1px solid var(--lb-line-soft)',
      }}
    >
      {children}
    </div>
  );
}
