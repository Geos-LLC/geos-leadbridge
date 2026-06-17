/**
 * Shared Save / Add-row controls for the AI Playbook pricing + FAQ
 * forms. The playbook surfaces three different pricing shapes
 * (cleaning bed/bath grid, item rows, hourly) and two FAQ shapes
 * (structured cleaning fields, generic Q&A pairs) — each historically
 * had its own button styling, which made the tabs look like different
 * products. This module is the single source of truth for those two
 * primitives so every form wears the same Save pill and the same
 * dashed Add-row button.
 *
 * Not a behavior change — the buttons forward their click handlers
 * verbatim. Per-form dirty / saving / saved state is still owned by
 * each form.
 */

import { Loader2, Plus, Save } from 'lucide-react';
import type { CSSProperties } from 'react';

export function UnifiedSaveButton({
  label,
  dirty,
  saving,
  savedAt,
  onClick,
  align = 'end',
  idleLabel = 'No changes',
}: {
  label: string;
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  onClick: () => void;
  align?: 'start' | 'end';
  idleLabel?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
      }}
    >
      {savedAt && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--lb-success, #16a34a)',
            fontWeight: 600,
          }}
        >
          Saved.
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={!dirty || saving}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 14px',
          borderRadius: 8,
          background: dirty ? 'var(--lb-accent, #2563eb)' : '#cbd5e1',
          color: 'white',
          border: 0,
          fontSize: 13,
          fontWeight: 600,
          cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit',
          opacity: saving ? 0.7 : 1,
          transition: 'background 160ms ease',
        }}
      >
        {saving ? (
          <Loader2 size={13} className="animate-spin" />
        ) : (
          <Save size={13} />
        )}
        {saving ? 'Saving…' : dirty ? label : idleLabel}
      </button>
    </div>
  );
}

export const UNIFIED_ADD_ROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px dashed var(--lb-accent-line, #c3d4ff)',
  background: 'var(--lb-accent-tint, #e7efff)',
  color: 'var(--lb-accent, #2563eb)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export function UnifiedAddRowButton({
  label,
  onClick,
  fullWidth = false,
}: {
  label: string;
  onClick: () => void;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...UNIFIED_ADD_ROW_STYLE,
        width: fullWidth ? '100%' : undefined,
        justifyContent: fullWidth ? 'center' : undefined,
      }}
    >
      <Plus size={13} /> {label}
    </button>
  );
}
