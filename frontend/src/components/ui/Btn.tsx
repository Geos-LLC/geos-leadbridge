import type { ReactNode, MouseEvent, CSSProperties } from 'react';

type Variant = 'default' | 'primary' | 'accent' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface BtnProps {
  children?: ReactNode;
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  iconRight?: ReactNode;
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void;
  style?: CSSProperties;
  title?: string;
  type?: 'button' | 'submit' | 'reset';
  disabled?: boolean;
  className?: string;
}

export function Btn({
  children, variant = 'default', size = 'md', icon, iconRight,
  onClick, style = {}, title, type = 'button', disabled, className,
}: BtnProps) {
  const pad = size === 'sm' ? '5px 10px' : size === 'lg' ? '10px 16px' : '7px 12px';
  const fs = size === 'sm' ? 12 : size === 'lg' ? 14 : 13;
  const variantStyles: Record<Variant, CSSProperties> = {
    default: { background: 'var(--lb-surface)', color: 'var(--lb-ink-2)', border: '1px solid var(--lb-line)' },
    primary: { background: 'var(--lb-ink-1)',   color: 'white',           border: '1px solid var(--lb-ink-1)' },
    accent:  { background: 'var(--lb-accent)',  color: 'var(--lb-accent-fg)', border: '1px solid var(--lb-accent)' },
    ghost:   { background: 'transparent',       color: 'var(--lb-ink-4)',  border: '1px solid transparent' },
    danger:  { background: 'var(--lb-surface)', color: 'var(--lb-danger)', border: '1px solid oklch(0.85 0.05 27)' },
  };
  return (
    <button
      type={type}
      onClick={onClick}
      title={title}
      disabled={disabled}
      className={className}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: pad, fontSize: fs, fontWeight: 500,
        borderRadius: 'var(--lb-radius)', cursor: disabled ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
        transition: 'background 120ms ease, opacity 120ms ease',
        opacity: disabled ? 0.5 : 1,
        ...variantStyles[variant],
        ...style,
      }}
    >
      {icon}
      {children && <span>{children}</span>}
      {iconRight}
    </button>
  );
}
