import type { CSSProperties, ReactNode } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Check,
  MoreHorizontal,
  ExternalLink,
  ArrowLeft,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

// Color tokens — mirror the design handoff
export const ICON_TONES = {
  blue:   { bg: '#dbeafe', fg: '#2563eb' },
  green:  { bg: '#d1fae5', fg: '#059669' },
  purple: { bg: '#ede9fe', fg: '#7c3aed' },
  violet: { bg: '#e0e7ff', fg: '#6366f1' },
  pink:   { bg: '#fce7f3', fg: '#db2777' },
  rose:   { bg: '#ffe4e6', fg: '#e11d48' },
  orange: { bg: '#ffedd5', fg: '#ea580c' },
  amber:  { bg: '#fef3c7', fg: '#d97706' },
  teal:   { bg: '#ccfbf1', fg: '#0d9488' },
  red:    { bg: '#fee2e2', fg: '#dc2626' },
  cyan:   { bg: '#cffafe', fg: '#0891b2' },
  gray:   { bg: '#f1f5f9', fg: '#64748b' },
} as const;

export type IconTone = keyof typeof ICON_TONES;

const BADGE_TONES = {
  green:  { bg: '#dcfce7', fg: '#16a34a' },
  purple: { bg: '#ede9fe', fg: '#7c3aed' },
  blue:   { bg: '#dbeafe', fg: '#2563eb' },
  orange: { bg: '#ffedd5', fg: '#ea580c' },
  rose:   { bg: '#ffe4e6', fg: '#e11d48' },
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

// ===================================================================
// IconTile — tinted icon square
// ===================================================================
export function IconTile({
  icon: Icon, tone = 'blue', size = 'md',
}: {
  icon: LucideIcon;
  tone?: IconTone;
  size?: 'sm' | 'md' | 'lg';
}) {
  const t = ICON_TONES[tone] || ICON_TONES.blue;
  const dims = size === 'sm'
    ? { w: 28, r: 8,  i: 14 }
    : size === 'lg'
    ? { w: 44, r: 12, i: 20 }
    : { w: 36, r: 10, i: 17 };
  return (
    <div style={{
      width: dims.w, height: dims.w, borderRadius: dims.r,
      background: t.bg, color: t.fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0,
    }}>
      <Icon size={dims.i} />
    </div>
  );
}

// ===================================================================
// AutoBadge — colored pill (Respond/Engage/Convert)
// ===================================================================
export function AutoBadge({ tone = 'green', children }: { tone?: BadgeTone; children: ReactNode }) {
  const t = BADGE_TONES[tone] || BADGE_TONES.green;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '4px 12px', borderRadius: 999,
      background: t.bg, color: t.fg,
      fontSize: 12, fontWeight: 600,
    }}>{children}</span>
  );
}

// ===================================================================
// BackLink — small "← Back to X" link above a page header
// ===================================================================
export function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        background: 'transparent', border: 0, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
        color: 'var(--lb-ink-5)', padding: 0,
        marginBottom: 10,
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--lb-accent)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--lb-ink-5)'; }}
    >
      <ArrowLeft size={14} />
      Back to {label}
    </button>
  );
}

// ===================================================================
// AutoPageHeader — H1 + badge + subtitle + actions
// ===================================================================
export function AutoPageHeader({
  title, badge, subtitle, onSave, saving, headerActions, backLink,
}: {
  title: ReactNode;
  badge?: { label: string; tone: BadgeTone };
  subtitle?: ReactNode;
  onSave?: () => void;
  saving?: boolean;
  headerActions?: ReactNode;
  backLink?: { label: string; onClick: () => void };
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      gap: 16, marginBottom: 22,
    }}>
      <div style={{ minWidth: 0, flex: 1 }}>
        {backLink && <BackLink label={backLink.label} onClick={backLink.onClick} />}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
          <h1 style={{
            margin: 0, fontSize: 22, fontWeight: 700,
            color: 'var(--lb-ink-1)', letterSpacing: '-0.02em', lineHeight: 1.2,
          }}>{title}</h1>
          {badge && <AutoBadge tone={badge.tone}>{badge.label}</AutoBadge>}
        </div>
        {subtitle && <p style={{ margin: 0, fontSize: 13.5, color: 'var(--lb-ink-5)' }}>{subtitle}</p>}
      </div>
      <div style={{ display: 'flex', gap: 8, flexShrink: 0, alignItems: 'center' }}>
        {headerActions}
        <button title="More" style={{
          width: 38, height: 38, borderRadius: 10,
          background: 'white', border: '1px solid var(--lb-line)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', color: 'var(--lb-ink-4)',
        }}>
          <MoreHorizontal size={16} />
        </button>
        {onSave && (
          <button
            onClick={onSave}
            disabled={saving}
            style={{
              padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
              background: 'var(--lb-accent)', color: 'white',
              border: 0, borderRadius: 10,
              cursor: saving ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              opacity: saving ? 0.7 : 1,
            }}
          >
            {saving ? 'Saving...' : 'Save changes'}
          </button>
        )}
      </div>
    </div>
  );
}

// ===================================================================
// BigToggle — 44x24 pill toggle
//
// `mixed` mode: when accounts disagree on this setting in All-Accounts scope,
// the toggle renders in an amber indeterminate state (thumb centered, amber
// track, warning icon overlay). Clicking still works — flipping it commits a
// single value to every account.
// ===================================================================
export function BigToggle({
  on, onChange, disabled, mixed, mixedTooltip,
}: {
  on: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={mixed ? 'mixed' : on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      title={mixed ? mixedTooltip : undefined}
      style={{
        width: 44, height: 24, borderRadius: 999,
        background: mixed ? '#f59e0b' : on ? 'var(--lb-accent)' : '#cbd5e1',
        border: 0, padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', flexShrink: 0,
        transition: 'background 160ms ease',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{
        position: 'absolute', top: 3,
        left: mixed ? 13 : on ? 23 : 3,
        width: 18, height: 18, borderRadius: 99, background: 'white',
        transition: 'left 160ms ease',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {mixed && <AlertTriangle size={10} style={{ color: '#d97706' }} />}
      </span>
    </button>
  );
}

// ===================================================================
// SettingCard — big section card with header + body
//
// `mixed` mode: drawn with an amber-tinted border and a "Differs across
// accounts" warning pill in the header. Combined with BigToggle's mixed
// rendering this gives the user a clear signal that flipping the toggle
// will overwrite per-account values.
// ===================================================================
export function SettingCard({
  icon, iconTone, title, subtitle, enabled, onToggle, headerRight, children, contentPad,
  mixed, mixedTooltip,
}: {
  icon: LucideIcon;
  iconTone?: IconTone;
  title: ReactNode;
  subtitle?: ReactNode;
  enabled?: boolean;
  onToggle?: (v: boolean) => void;
  headerRight?: ReactNode;
  children?: ReactNode;
  contentPad?: CSSProperties['padding'];
  mixed?: boolean;
  mixedTooltip?: string;
}) {
  return (
    <div style={{
      background: mixed ? '#fffbeb' : 'white',
      border: '1.5px solid ' + (mixed ? '#f59e0b' : 'var(--lb-line)'),
      borderRadius: 14,
      boxShadow: mixed
        ? '0 0 0 3px rgba(245,158,11,0.14), 0 1px 2px rgba(10,21,48,0.03)'
        : '0 1px 2px rgba(10,21,48,0.03)',
      overflow: 'hidden',
    }}>
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 14,
        padding: '20px 24px',
        background: mixed ? 'rgba(255,255,255,0.6)' : 'transparent',
      }}>
        <IconTile icon={icon} tone={iconTone} size="lg" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>{title}</div>
            {mixed && <MixedBadge tooltip={mixedTooltip} />}
          </div>
          {subtitle && <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>{subtitle}</div>}
        </div>
        {headerRight}
        {onToggle && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 2 }}>
            <BigToggle on={!!enabled} onChange={onToggle} mixed={mixed} mixedTooltip={mixedTooltip} />
            <span style={{ fontSize: 13, fontWeight: 600, color: mixed ? '#92400e' : enabled ? 'var(--lb-ink-1)' : 'var(--lb-ink-5)', minWidth: 22 }}>
              {mixed ? 'Mixed' : enabled ? 'On' : 'Off'}
            </span>
          </div>
        )}
      </div>
      {/* Inline amber banner explaining what the mixed state means and what
          saving will do. Sits between the header and the card body so the
          user can't miss it. */}
      {mixed && (
        <div
          title={mixedTooltip}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 24px',
            background: '#fef3c7',
            borderTop: '1px solid #fde68a',
            borderBottom: '1px solid #fde68a',
            fontSize: 12.5, color: '#92400e', fontWeight: 600,
            cursor: mixedTooltip ? 'help' : 'default',
          }}
        >
          <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0 }} />
          <span>Accounts disagree on this setting. Changing it here will apply the new value to all accounts.</span>
        </div>
      )}
      {children && enabled !== false && (
        <div style={{
          borderTop: mixed ? 'none' : '1px solid var(--lb-line-soft)',
          padding: contentPad ?? '16px 24px 24px',
          background: 'white',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// Floating top-right status pill — used for the inline "Saving" / "Saved" /
// "Loading" indicators on auto-saving pages. Positioned `position: fixed`
// so it doesn't shift page layout when it appears or disappears.
export function StatusPill({
  status, message,
}: {
  status: 'saving' | 'saved' | 'error' | 'loading';
  message?: string;
}) {
  const palette = {
    saving:  { bg: '#eff6ff', fg: '#1d4ed8', border: '#c3d4ff', label: 'Saving…' },
    saved:   { bg: '#dcfce7', fg: '#15803d', border: '#a7f3d0', label: 'Saved' },
    error:   { bg: 'var(--lb-danger-tint)', fg: 'var(--lb-danger)', border: '#fecaca', label: 'Error' },
    loading: { bg: '#f1f5f9', fg: '#475569', border: 'var(--lb-line)', label: 'Loading…' },
  }[status];
  return (
    <div style={{
      position: 'fixed', top: 78, right: 24, zIndex: 40,
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '6px 12px',
      background: palette.bg, color: palette.fg,
      border: '1px solid ' + palette.border,
      borderRadius: 999,
      fontSize: 12, fontWeight: 600,
      boxShadow: '0 2px 8px rgba(10,21,48,0.08)',
      pointerEvents: 'none',
    }}>
      {message || palette.label}
    </div>
  );
}

// Full-width amber "differs across accounts" banner shown ABOVE or INSIDE a
// card body. Use this when the warning should sit clearly on the card itself
// rather than be a small pill on the side of the title.
export function MixedCardBanner({
  tooltip,
  message = 'Accounts disagree on this setting. Changing it here will apply the new value to all accounts.',
}: {
  tooltip?: string;
  message?: string;
}) {
  return (
    <div
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 14px',
        background: '#fef3c7',
        border: '1.5px solid #f59e0b',
        borderRadius: 10,
        fontSize: 12.5, color: '#92400e', fontWeight: 600,
        cursor: tooltip ? 'help' : 'default',
        marginBottom: 12,
        boxShadow: '0 0 0 3px rgba(245,158,11,0.10)',
      }}
    >
      <AlertTriangle size={14} style={{ color: '#d97706', flexShrink: 0 }} />
      <span>{message}</span>
    </div>
  );
}

// Amber "Differs across accounts" pill rendered next to a card title or row
// label when accounts disagree on a setting in All-Accounts scope. Hovering
// shows a per-account breakdown via the native title tooltip.
export function MixedBadge({ tooltip, label = 'Differs across accounts' }: { tooltip?: string; label?: string }) {
  return (
    <span
      title={tooltip}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 999,
        background: '#fef3c7', color: '#92400e',
        fontSize: 10.5, fontWeight: 700,
        letterSpacing: 0.04, textTransform: 'uppercase',
        fontFamily: 'var(--lb-font-mono)',
        cursor: tooltip ? 'help' : 'default',
        border: '1px solid #fde68a',
      }}
    >
      <AlertTriangle size={10} />
      {label}
    </span>
  );
}

// ===================================================================
// SectionCard — bare card wrapper
// ===================================================================
export function SectionCard({
  children, padding = '20px 24px', style,
}: {
  children: ReactNode;
  padding?: CSSProperties['padding'];
  style?: CSSProperties;
}) {
  return (
    <div style={{
      background: 'white',
      border: '1px solid var(--lb-line)',
      borderRadius: 14,
      padding,
      boxShadow: '0 1px 2px rgba(10,21,48,0.03)',
      ...style,
    }}>
      {children}
    </div>
  );
}

// ===================================================================
// FieldRow — horizontal row inside a card body
// ===================================================================
export function FieldRow({
  icon, iconTone, label, sublabel, children, align = 'center', noBorder,
}: {
  icon?: LucideIcon;
  iconTone?: IconTone;
  label: ReactNode;
  sublabel?: ReactNode;
  children: ReactNode;
  align?: 'top' | 'center';
  noBorder?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', gap: 16, alignItems: align === 'top' ? 'flex-start' : 'center',
      padding: '16px 0',
      borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
    }}>
      {icon && <IconTile icon={icon} tone={iconTone} size="sm" />}
      <div style={{ minWidth: 0, width: 170, flexShrink: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-2)' }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>{sublabel}</div>}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  );
}

// ===================================================================
// Radio — circular dot
// ===================================================================
export function Radio({ selected }: { selected: boolean }) {
  return (
    <div style={{
      width: 18, height: 18, borderRadius: 99,
      border: '2px solid ' + (selected ? 'var(--lb-accent)' : '#cbd5e1'),
      background: selected ? 'var(--lb-accent)' : 'white',
      flexShrink: 0, marginTop: 1,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {selected && <span style={{ width: 6, height: 6, borderRadius: 99, background: 'white' }} />}
    </div>
  );
}

// ===================================================================
// OptionCard — radio-style picker card
// ===================================================================
export function OptionCard({
  selected, onClick, title, body, icon: TrailingIcon, illustration, compact,
}: {
  selected: boolean;
  onClick: () => void;
  title: ReactNode;
  body?: ReactNode;
  icon?: LucideIcon;
  illustration?: ReactNode;
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1, textAlign: 'left',
        padding: compact ? '14px 16px' : '16px 18px',
        background: selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 12,
        cursor: 'pointer',
        fontFamily: 'inherit',
        display: 'flex', alignItems: 'flex-start', gap: 12,
        transition: 'border-color 120ms, background 120ms',
        minWidth: 0,
      }}
    >
      <Radio selected={selected} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</div>
          {TrailingIcon && <TrailingIcon size={15} style={{ color: 'var(--lb-ink-5)', flexShrink: 0 }} />}
        </div>
        {body && <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.45 }}>{body}</div>}
        {illustration && <div style={{ marginTop: 10 }}>{illustration}</div>}
      </div>
    </button>
  );
}

// ===================================================================
// InfoTile — read-only-looking tile with action link
// ===================================================================
export function InfoTile({
  icon, iconTone, title, body, actionLabel, onAction, big, tooltip, badge,
}: {
  icon?: LucideIcon;
  iconTone?: IconTone;
  title: ReactNode;
  body?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  big?: boolean;
  /** Plain-text tooltip shown on hover — typically the full template/prompt content. */
  tooltip?: string;
  /** Small pill rendered to the right of the title (e.g. "PROMPT" / "MESSAGE"). */
  badge?: { label: string; tone: 'violet' | 'green' | 'blue' | 'gray' };
}) {
  const badgeTones = {
    violet: { bg: '#ede9fe', fg: '#6d28d9' },
    green:  { bg: '#dcfce7', fg: '#15803d' },
    blue:   { bg: '#dbeafe', fg: '#1d4ed8' },
    gray:   { bg: '#f1f5f9', fg: '#475569' },
  };
  const badgeStyle = badge ? badgeTones[badge.tone] : null;
  return (
    <div
      title={tooltip}
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        padding: big ? '14px 16px' : '12px 14px',
        background: '#f8fafc',
        border: '1px solid var(--lb-line-soft)',
        borderRadius: 10,
        cursor: tooltip ? 'help' : 'default',
      }}
    >
      {icon && <IconTile icon={icon} tone={iconTone || 'violet'} size="sm" />}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</div>
          {badge && badgeStyle && (
            <span style={{
              display: 'inline-flex', alignItems: 'center',
              padding: '2px 7px', borderRadius: 999,
              background: badgeStyle.bg, color: badgeStyle.fg,
              fontSize: 9.5, fontWeight: 700,
              letterSpacing: 0.04, textTransform: 'uppercase',
              fontFamily: 'var(--lb-font-mono)',
            }}>{badge.label}</span>
          )}
        </div>
        {body && <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{body}</div>}
      </div>
      {actionLabel && (
        <button
          type="button"
          onClick={onAction}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            background: 'transparent', border: 0, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
            color: 'var(--lb-accent)',
          }}
        >
          {actionLabel} <ChevronRight size={13} />
        </button>
      )}
    </div>
  );
}

// ===================================================================
// ToggleRow — icon + label + toggle (Stop Rules / Takeover)
// ===================================================================
export function ToggleRow({
  icon, iconTone, label, on, onChange,
}: {
  icon: LucideIcon;
  iconTone?: IconTone;
  label: ReactNode;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      borderRadius: 8,
    }}>
      <IconTile icon={icon} tone={iconTone} size="sm" />
      <div style={{ flex: 1, fontSize: 13.5, fontWeight: 500, color: 'var(--lb-ink-1)' }}>{label}</div>
      <BigToggle on={on} onChange={onChange} />
    </div>
  );
}

// ===================================================================
// Checkbox — 18x18 square
// ===================================================================
export function Checkbox({
  checked, onChange, label, sublabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  sublabel?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: 'transparent', border: 0, cursor: 'pointer',
        fontFamily: 'inherit', textAlign: 'left', padding: 0,
      }}
    >
      <div style={{
        width: 18, height: 18, borderRadius: 5,
        background: checked ? 'var(--lb-accent)' : 'white',
        border: '1.5px solid ' + (checked ? 'var(--lb-accent)' : '#cbd5e1'),
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, marginTop: 1,
      }}>
        {checked && <Check size={11} style={{ color: 'white' }} />}
      </div>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{label}</div>
        {sublabel && <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 1 }}>{sublabel}</div>}
      </div>
    </button>
  );
}

// ===================================================================
// Dropdown — light gray select
// ===================================================================
export type DropdownOption = string | { value: string; label: string };

export function Dropdown({
  value, onChange, options, width,
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  width?: number | string;
}) {
  const normalize = (o: DropdownOption): { value: string; label: string } => typeof o === 'string' ? { value: o, label: o } : o;
  return (
    <div style={{ position: 'relative', display: 'inline-block', width: width || 'auto' }}>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: '9px 32px 9px 12px',
          border: '1px solid var(--lb-line)', borderRadius: 8,
          fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
          background: 'white', color: 'var(--lb-ink-1)',
          appearance: 'none', cursor: 'pointer', outline: 'none',
          width: '100%',
        }}
      >
        {options.map((o) => {
          const opt = normalize(o);
          return <option key={opt.value} value={opt.value}>{opt.label}</option>;
        })}
      </select>
      <ChevronDown
        size={14}
        style={{
          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
          color: 'var(--lb-ink-5)', pointerEvents: 'none',
        }}
      />
    </div>
  );
}

// ===================================================================
// ActionLink — text link in accent with trailing chevron
// ===================================================================
export function ActionLink({
  children, onClick, external,
}: {
  children: ReactNode;
  onClick?: () => void;
  external?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        background: 'transparent', border: 0, cursor: 'pointer',
        fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
        color: 'var(--lb-accent)', padding: 0,
      }}
    >
      {children}
      {external ? <ExternalLink size={13} /> : <ChevronRight size={13} />}
    </button>
  );
}

// ===================================================================
// FooterBanner — info pill at the bottom of a sub-page
// ===================================================================
export function FooterBanner({ icon: Icon, body }: { icon: LucideIcon; body: ReactNode }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 16px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
      fontSize: 13, color: 'var(--lb-ink-5)',
    }}>
      <Icon size={15} style={{ color: 'var(--lb-ink-5)', flexShrink: 0 }} />
      <div style={{ flex: 1 }}>{body}</div>
    </div>
  );
}
