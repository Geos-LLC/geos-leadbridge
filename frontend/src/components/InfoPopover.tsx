import { type ReactNode } from 'react';
import { Info } from 'lucide-react';

/**
 * Click-to-toggle info icon + inline tip surface. Extracted from the
 * Automation wizard so production pages (Settings General, Automation
 * Respond / Followups / Conversation) can render the same canonical
 * pattern: a small (i) icon next to a section title that, when clicked,
 * reveals a soft-gray tip below the header.
 *
 * Usage:
 *   const [open, setOpen] = useState(false);
 *   <InfoDot open={open} onClick={() => setOpen(o => !o)} />
 *   {open && <InfoTip>Explanation text…</InfoTip>}
 */
export function InfoDot({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      aria-label="More info"
      aria-pressed={open}
      style={{
        background: 'transparent', border: 0, padding: 0,
        cursor: 'pointer', flexShrink: 0, lineHeight: 0,
      }}
    >
      <Info size={13} style={{ color: open ? 'var(--lb-ink-1)' : 'var(--lb-accent)' }} />
    </button>
  );
}

export function InfoTip({ children }: { children: ReactNode }) {
  return (
    <div style={{
      marginTop: 10,
      padding: '10px 12px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 9,
      fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}
