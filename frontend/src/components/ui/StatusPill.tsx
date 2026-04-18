import type { ReactNode } from 'react';

type Status = 'new' | 'replied' | 'quoted' | 'won' | 'lost' | 'warning' | 'error' | 'neutral';

interface PillSpec { label: string; fg: string; bg: string; dot: string; }

const MAP: Record<Status, PillSpec> = {
  new:     { label: 'New',     fg: '#0c4a2b',        bg: 'oklch(0.95 0.04 150)', dot: 'var(--lb-success)' },
  replied: { label: 'Replied', fg: '#183d63',        bg: 'oklch(0.95 0.03 235)', dot: 'var(--lb-info)' },
  quoted:  { label: 'Quoted',  fg: '#5e3b0a',        bg: 'oklch(0.95 0.04 75)',  dot: 'var(--lb-warn)' },
  won:     { label: 'Booked',  fg: '#0c4a2b',        bg: 'oklch(0.95 0.04 150)', dot: 'var(--lb-success)' },
  lost:    { label: 'Lost',    fg: 'var(--lb-ink-5)', bg: 'var(--lb-ink-10)',    dot: 'var(--lb-ink-6)' },
  warning: { label: 'Warning', fg: '#5e3b0a',        bg: 'oklch(0.95 0.04 75)',  dot: 'var(--lb-warn)' },
  error:   { label: 'Error',   fg: '#7a1a14',        bg: 'oklch(0.96 0.04 27)',  dot: 'var(--lb-danger)' },
  neutral: { label: '—',       fg: 'var(--lb-ink-5)', bg: 'var(--lb-ink-10)',    dot: 'var(--lb-ink-6)' },
};

interface StatusPillProps {
  status: Status;
  label?: ReactNode;
}

export function StatusPill({ status, label }: StatusPillProps) {
  const m = MAP[status] || MAP.neutral;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px 2px 7px',
        borderRadius: 999,
        background: m.bg,
        color: m.fg,
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: 0.01,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 5, height: 5, borderRadius: 99, background: m.dot }} />
      {label ?? m.label}
    </span>
  );
}
