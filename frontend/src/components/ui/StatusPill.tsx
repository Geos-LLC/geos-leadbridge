import type { ReactNode } from 'react';

type Status =
  // Legacy kinds — kept so existing call-sites compile.
  | 'new' | 'replied' | 'quoted' | 'won'
  | 'warning' | 'error' | 'neutral'
  // Canonical group kinds (2026-06-08 simplification — mirrors STATUS_GROUPS
  // in lib/leadStatus.ts: active / booked / completed / lost).
  | 'active' | 'booked' | 'completed' | 'lost'
  // Retired but still referenced by older call-sites — alias to current
  // canonical kinds. Remove once no usages remain.
  | 'scheduled' | 'in_progress' | 'done' | 'no_hire' | 'archived';

interface PillSpec { label: string; fg: string; bg: string; dot: string; }

const MAP: Record<Status, PillSpec> = {
  // Legacy
  new:     { label: 'New',     fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  replied: { label: 'Replied', fg: '#1e40af',        bg: 'var(--lb-accent-tint)',  dot: 'var(--lb-accent)' },
  quoted:  { label: 'Quoted',  fg: '#92400e',        bg: 'var(--lb-warn-tint)',    dot: 'var(--lb-warn)' },
  won:     { label: 'Booked',  fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  warning: { label: 'Warning', fg: '#92400e',        bg: 'var(--lb-warn-tint)',    dot: 'var(--lb-warn)' },
  error:   { label: 'Error',   fg: '#991b1b',        bg: 'var(--lb-danger-tint)',  dot: 'var(--lb-danger)' },
  neutral: { label: '—',       fg: 'var(--lb-ink-5)', bg: 'var(--lb-ink-10)',       dot: 'var(--lb-ink-6)' },
  // Canonical group kinds — marketplace labels (Scheduled / Done).
  active:    { label: 'Active',    fg: '#1e40af',        bg: 'var(--lb-accent-tint)',  dot: 'var(--lb-accent)' },
  booked:    { label: 'Scheduled', fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  completed: { label: 'Done',      fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  lost:      { label: 'Lost',      fg: '#991b1b',        bg: 'var(--lb-danger-tint)',  dot: 'var(--lb-danger)' },
  // Retired kinds aliased to current canonical labels for back-compat:
  scheduled:   { label: 'Scheduled', fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  in_progress: { label: 'Active',    fg: '#1e40af',        bg: 'var(--lb-accent-tint)',  dot: 'var(--lb-accent)' },
  done:        { label: 'Done',      fg: '#15803d',        bg: 'var(--lb-success-tint)', dot: 'var(--lb-success)' },
  no_hire:     { label: 'Lost',      fg: '#991b1b',        bg: 'var(--lb-danger-tint)',  dot: 'var(--lb-danger)' },
  archived:    { label: 'Lost',      fg: '#991b1b',        bg: 'var(--lb-danger-tint)',  dot: 'var(--lb-danger)' },
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
