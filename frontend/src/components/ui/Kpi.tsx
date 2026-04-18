import type { ReactNode } from 'react';

interface KpiProps {
  label: ReactNode;
  value: ReactNode;
  delta?: ReactNode;
  deltaDir?: 'up' | 'down';
  muted?: boolean;
  loading?: boolean;
}

export function Kpi({ label, value, delta, deltaDir, muted, loading }: KpiProps) {
  return (
    <div style={{ padding: '14px 16px', borderRight: muted ? 'none' : '1px solid var(--lb-line-soft)' }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--lb-ink-5)',
          textTransform: 'uppercase',
          letterSpacing: 0.06,
          fontWeight: 500,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 600,
          color: 'var(--lb-ink-1)',
          marginTop: 4,
          lineHeight: 1.1,
          letterSpacing: '-0.01em',
          opacity: loading ? 0.35 : 1,
          transition: 'opacity 160ms ease',
        }}
      >
        {value}
      </div>
      {delta && (
        <div
          style={{
            marginTop: 4,
            fontSize: 11,
            fontWeight: 500,
            color: deltaDir === 'down' ? 'var(--lb-danger)' : 'var(--lb-success)',
            fontFamily: 'var(--lb-font-mono)',
          }}
        >
          {deltaDir === 'down' ? '↓' : '↑'} {delta}
        </div>
      )}
    </div>
  );
}
