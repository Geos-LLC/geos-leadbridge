import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  tabs?: ReactNode;
}

export function PageHeader({ title, subtitle, actions, tabs }: PageHeaderProps) {
  return (
    <div
      style={{
        padding: '22px 28px 0',
        borderBottom: '1px solid var(--lb-line)',
        background: 'var(--lb-surface)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          paddingBottom: tabs ? 12 : 20,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1
            style={{
              margin: 0,
              fontSize: 22,
              fontWeight: 800,
              color: 'var(--lb-ink-1)',
              letterSpacing: '-0.025em',
              fontFamily: 'var(--lb-font-sans)',
            }}
          >
            {title}
          </h1>
          {subtitle && (
            <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--lb-ink-4)' }}>
              {subtitle}
            </p>
          )}
        </div>
        {actions && <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>{actions}</div>}
      </div>
      {tabs}
    </div>
  );
}
