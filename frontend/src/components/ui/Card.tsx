import type { ReactNode, CSSProperties } from 'react';

interface CardProps {
  children: ReactNode;
  padding?: number | string;
  style?: CSSProperties;
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function Card({ children, padding = 16, style = {}, title, subtitle, action, className }: CardProps) {
  return (
    <div
      className={className}
      style={{
        background: 'var(--lb-surface)',
        border: '1px solid var(--lb-line)',
        borderRadius: 'var(--lb-radius-lg)',
        ...style,
      }}
    >
      {(title || action) && (
        <div
          style={{
            padding: '12px 14px',
            borderBottom: '1px solid var(--lb-line-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
          }}
        >
          <div>
            {title && <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</div>}
            {subtitle && <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>{subtitle}</div>}
          </div>
          {action}
        </div>
      )}
      <div style={{ padding }}>{children}</div>
    </div>
  );
}
