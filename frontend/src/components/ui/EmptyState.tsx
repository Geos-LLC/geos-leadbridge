import type { ReactNode } from 'react';

interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  body?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, title, body, action }: EmptyStateProps) {
  return (
    <div
      style={{
        padding: '40px 24px',
        textAlign: 'center',
        border: '1px dashed var(--lb-line)',
        borderRadius: 'var(--lb-radius-lg)',
        background: 'var(--lb-surface)',
      }}
    >
      {icon && (
        <div
          style={{
            width: 40,
            height: 40,
            borderRadius: 10,
            background: 'var(--lb-ink-10)',
            color: 'var(--lb-ink-4)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 10,
          }}
        >
          {icon}
        </div>
      )}
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</div>
      {body && (
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginTop: 4, maxWidth: 360, margin: '4px auto 0' }}>
          {body}
        </div>
      )}
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  );
}
