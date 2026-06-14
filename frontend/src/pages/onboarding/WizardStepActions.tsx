import { useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { WizardHeaderSlotContext } from './WizardShell';

/**
 * Step-rendered action buttons (Save & Continue + siblings like
 * "I don't have a website", "Preview default pricing", "Go to
 * Dashboard"). Children are portaled into the WizardShell header
 * slot so the buttons sit on a single top row next to Back / Exit,
 * not as a floating sticky shelf above the step body.
 *
 * Before this refactor (2026-06-13), the buttons rendered inline as
 * a `sticky top-0` bar at the top of the step body — fine in the
 * full-page route but visually disconnected from the shell header
 * in the in-app Setup modal (940x640 frame). The portal keeps the
 * buttons exactly where the header puts everything else.
 *
 * Fallback: if the context value is null (e.g. WizardStepActions
 * mounted outside a WizardShell, or before first paint), the
 * children render inline as a no-op block so nothing disappears.
 */
export function WizardStepActions({ children }: { children: ReactNode }) {
  const slot = useContext(WizardHeaderSlotContext);
  if (!slot) {
    return (
      <div className="flex items-center gap-3 mb-6">
        {children}
      </div>
    );
  }
  return createPortal(children, slot);
}
