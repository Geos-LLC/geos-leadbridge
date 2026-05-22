// Mobile design-system primitives, ported from the design handoff's
// mobile-components.jsx + ui.jsx. Single-file by design — the originals
// were one file each and splitting them adds friction with no benefit.
//
// Render these only inside a .lb-mobile-scoped subtree (see MobileLayout
// in pages/mobile/index.tsx) so the CSS variables resolve correctly.

import type {
  CSSProperties,
  ReactNode,
} from 'react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AlertTriangle, ArrowRight, ArrowUp, BarChart3, Bell, Calendar, CalendarClock, Check,
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clock, CreditCard, DollarSign,
  FileText, HelpCircle, Home, Inbox, Info, Layers, Lightbulb, LogOut, Mail, MapPin,
  Menu, MessageSquare, Moon, MoreHorizontal, Paperclip, Phone, Play, Plus, Repeat, Search,
  Send, SlidersHorizontal, Sparkles, User, Users, Workflow, Zap,
} from 'lucide-react';
import { LB_PLATFORM_META, type LeadStatus, type MobileAccount, type Platform } from './data';

// ── Icon shim ─────────────────────────────────────────────────────────────
// The design handoff uses string-named icons (`<Icon name="search" />`).
// Map to lucide-react components so we keep the design's call shape intact.
const ICONS = {
  'alert-triangle': AlertTriangle, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp,
  'bar-chart-3': BarChart3, bell: Bell, calendar: Calendar, 'calendar-clock': CalendarClock,
  check: Check, 'chevron-down': ChevronDown, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, 'chevron-up': ChevronUp, clock: Clock, 'credit-card': CreditCard,
  'dollar-sign': DollarSign, 'file-text': FileText, 'help-circle': HelpCircle, home: Home,
  inbox: Inbox, info: Info, layers: Layers, lightbulb: Lightbulb, 'log-out': LogOut,
  mail: Mail, 'map-pin': MapPin, menu: Menu, 'message-square': MessageSquare, moon: Moon,
  'more-horizontal': MoreHorizontal, paperclip: Paperclip, phone: Phone, play: Play, plus: Plus,
  repeat: Repeat, search: Search, send: Send, 'sliders-horizontal': SlidersHorizontal,
  sparkles: Sparkles, user: User, users: Users, workflow: Workflow, zap: Zap,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name, size = 16, className, style,
}: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const Cmp = ICONS[name];
  if (!Cmp) return null;
  return <Cmp size={size} className={className} style={style} strokeWidth={2} />;
}

// ── Platform badge / Status pill / Avatar / Toggle ────────────────────────

export function PlatformBadge({ platform, size = 'sm' }: { platform: Platform; size?: 'sm' | 'md' }) {
  const meta = LB_PLATFORM_META[platform] ?? { label: platform, color: '#666', short: '?' };
  const s = size === 'sm' ? 18 : 22;
  return (
    <span title={meta.label} style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: s, height: s, borderRadius: 4,
      background: meta.color, color: 'white',
      fontFamily: 'var(--font-mono)', fontWeight: 600,
      fontSize: s === 18 ? 9 : 10, letterSpacing: 0.02, flexShrink: 0,
    }}>{meta.short}</span>
  );
}

export function StatusPill({ status }: { status: LeadStatus }) {
  const map: Record<LeadStatus, { label: string; fg: string; bg: string; dot: string }> = {
    new: { label: 'New', fg: '#15803d', bg: '#dcfce7', dot: 'var(--success)' },
    replied: { label: 'Replied', fg: '#1e40af', bg: 'var(--accent-tint)', dot: 'var(--accent)' },
    quoted: { label: 'Quoted', fg: '#92400e', bg: 'var(--warn-tint)', dot: 'var(--warn)' },
    won: { label: 'Booked', fg: '#15803d', bg: '#dcfce7', dot: 'var(--success)' },
    lost: { label: 'Lost', fg: 'var(--ink-5)', bg: 'var(--ink-10)', dot: 'var(--ink-6)' },
  };
  const m = map[status] ?? map.new;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      padding: '2px 8px 2px 7px', borderRadius: 999,
      background: m.bg, color: m.fg,
      fontSize: 11, fontWeight: 500, letterSpacing: 0.01,
    }}>
      <span style={{ width: 5, height: 5, borderRadius: 99, background: m.dot }} />
      {m.label}
    </span>
  );
}

export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map(s => s[0]?.toUpperCase()).join('');
  // Deterministic hue from name so the same lead keeps the same color.
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hue = Math.abs(hash) % 360;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      width: size, height: size, borderRadius: 999, flexShrink: 0,
      background: `hsl(${hue} 60% 92%)`, color: `hsl(${hue} 55% 32%)`,
      fontSize: size * 0.38, fontWeight: 700, fontFamily: 'var(--font-sans)',
    }}>{initials || '?'}</span>
  );
}

export function Toggle({ on, onChange, size = 'md' }: { on: boolean; onChange: (v: boolean) => void; size?: 'sm' | 'md' }) {
  const w = size === 'sm' ? 30 : 36;
  const h = size === 'sm' ? 18 : 20;
  const d = h - 4;
  return (
    <button
      type="button" role="switch" aria-checked={on}
      onClick={() => onChange(!on)}
      style={{
        width: w, height: h, borderRadius: 999,
        background: on ? 'var(--accent)' : 'var(--ink-8)',
        border: 0, padding: 0, cursor: 'pointer',
        transition: 'background 160ms ease',
        position: 'relative', flexShrink: 0,
      }}
    >
      <span style={{
        position: 'absolute', top: 2, left: on ? w - d - 2 : 2,
        width: d, height: d, borderRadius: 99, background: 'white',
        transition: 'left 160ms ease', boxShadow: '0 1px 2px rgba(0,0,0,0.15)',
      }} />
    </button>
  );
}

// ── App-bar / Tab-bar / Shell ─────────────────────────────────────────────

export function MAppBar({
  title, leading, trailing, subtitle, large = false, blue = false,
}: {
  title?: ReactNode; subtitle?: ReactNode;
  leading?: ReactNode; trailing?: ReactNode;
  large?: boolean; blue?: boolean;
}) {
  return (
    <div style={{
      paddingTop: large ? 8 : 6,
      paddingBottom: large ? 6 : 10,
      paddingLeft: 18, paddingRight: 14,
      background: blue ? 'var(--accent)' : 'var(--surface)',
      borderBottom: blue ? '1px solid var(--accent-hover)' : '1px solid var(--line)',
      color: blue ? 'white' : 'var(--ink-1)', flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 36 }}>
        {leading}
        <div style={{ flex: 1, minWidth: 0 }}>
          {!large && (
            <div style={{
              fontSize: 16, fontWeight: 700, color: 'inherit',
              letterSpacing: '-0.01em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{title}</div>
          )}
          {subtitle && !large && (
            <div style={{ fontSize: 11, color: blue ? 'rgba(255,255,255,0.85)' : 'var(--ink-5)', marginTop: 1, fontFamily: 'var(--font-mono)' }}>{subtitle}</div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>{trailing}</div>
      </div>
      {large && (
        <div style={{ paddingTop: 6, paddingBottom: 4 }}>
          <h1 style={{ margin: 0, fontSize: 28, fontWeight: 700, letterSpacing: '-0.025em', color: 'inherit', lineHeight: 1.1 }}>{title}</h1>
          {subtitle && <div style={{ fontSize: 13, color: blue ? 'rgba(255,255,255,0.85)' : 'var(--ink-5)', marginTop: 6 }}>{subtitle}</div>}
        </div>
      )}
    </div>
  );
}

export type MobileTab = 'overview' | 'leads' | 'auto' | 'insights' | 'more';

const TAB_DEFS: Array<{ key: MobileTab; label: string; icon: IconName; path: string; badge?: number }> = [
  { key: 'overview', label: 'Today', icon: 'home', path: '/m/today' },
  { key: 'leads', label: 'Leads', icon: 'inbox', path: '/m/leads', badge: 4 },
  { key: 'auto', label: 'Auto', icon: 'workflow', path: '/m/automation' },
  { key: 'insights', label: 'Insights', icon: 'bar-chart-3', path: '/m/insights' },
  { key: 'more', label: 'More', icon: 'menu', path: '/m/more' },
];

export function MTabBar({ active }: { active: MobileTab }) {
  const navigate = useNavigate();
  return (
    <div style={{
      flexShrink: 0, display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
      background: 'var(--surface)', borderTop: '1px solid var(--line)',
      paddingTop: 6, paddingBottom: 'max(22px, env(safe-area-inset-bottom))',
    }}>
      {TAB_DEFS.map((t) => {
        const isActive = active === t.key;
        return (
          <button key={t.key} type="button" onClick={() => navigate(t.path)} style={{
            background: 'transparent', border: 0, padding: '6px 4px 4px', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
            color: isActive ? 'var(--accent)' : 'var(--ink-5)', position: 'relative',
          }}>
            <span style={{ position: 'relative', display: 'inline-flex' }}>
              <Icon name={t.icon} size={20} />
              {t.badge && (
                <span style={{
                  position: 'absolute', top: -4, right: -8,
                  minWidth: 14, height: 14, borderRadius: 99, padding: '0 4px',
                  background: 'var(--danger)', color: 'white',
                  fontSize: 9, fontWeight: 700,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  border: '1.5px solid var(--surface)',
                }}>{t.badge}</span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: '-0.01em' }}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

export function MShell({
  children, tab = 'overview', appBar, hideTabBar = false,
}: {
  children: ReactNode;
  tab?: MobileTab;
  appBar?: ReactNode;
  hideTabBar?: boolean;
}) {
  // Column flex layout pinned to the parent's height (the .lb-mobile
  // wrapper is locked to 100dvh). The app bar and tab bar are flex-fixed
  // at top and bottom; the middle region owns the only scroll context,
  // so the tab bar stays visible while the user scrolls through content.
  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg)', color: 'var(--ink-2)', fontSize: 14,
      overflow: 'hidden',
    }}>
      {appBar}
      <div style={{
        flex: 1, minHeight: 0,
        overflowY: 'auto', overflowX: 'hidden',
        position: 'relative',
        WebkitOverflowScrolling: 'touch' as 'touch',
      }}>
        {children}
      </div>
      {!hideTabBar && <MTabBar active={tab} />}
    </div>
  );
}

// ── Section / Card / Row / IconBox / Chip / IconBtn / Stat / Toggle row ──

export function MSection({
  title, children, action, style,
}: { title?: ReactNode; children: ReactNode; action?: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ marginTop: 18, ...style }}>
      {title && (
        <div style={{
          display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
          padding: '0 18px 8px',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{title}</div>
          {action}
        </div>
      )}
      <div style={{ padding: '0 14px' }}>{children}</div>
    </div>
  );
}

export function MCard({
  children, style, onClick,
}: { children: ReactNode; style?: CSSProperties; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{
      background: 'var(--surface)',
      border: '1px solid var(--line)',
      borderRadius: 14, overflow: 'hidden',
      ...style,
    }}>{children}</div>
  );
}

export function MRow({
  leading, title, subtitle, trailing, onClick, last = false, dense = false, danger = false,
}: {
  leading?: ReactNode; title?: ReactNode; subtitle?: ReactNode; trailing?: ReactNode;
  onClick?: () => void; last?: boolean; dense?: boolean; danger?: boolean;
}) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: dense ? '10px 14px' : '13px 14px',
      borderBottom: last ? 'none' : '1px solid var(--line-soft)',
      cursor: onClick ? 'pointer' : 'default',
    }}>
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 14, fontWeight: 500,
          color: danger ? 'var(--danger)' : 'var(--ink-1)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 12, color: 'var(--ink-5)', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</div>
        )}
      </div>
      {trailing}
    </div>
  );
}

export function MIconBox({
  icon, color = 'var(--accent)', bg = 'var(--accent-tint)', size = 32,
}: { icon: IconName; color?: string; bg?: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 9,
      background: bg, color,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
    }}>
      <Icon name={icon} size={Math.round(size * 0.52)} />
    </div>
  );
}

export function MChip({
  label, active = false, onClick, count, icon,
}: { label: string; active?: boolean; onClick?: () => void; count?: number; icon?: IconName }) {
  return (
    <button type="button" onClick={onClick} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '7px 12px', borderRadius: 999,
      border: '1px solid ' + (active ? 'var(--accent)' : 'var(--line)'),
      background: active ? 'var(--accent)' : 'var(--surface)',
      color: active ? 'white' : 'var(--ink-3)',
      fontSize: 12.5, fontWeight: 600, cursor: 'pointer', flexShrink: 0,
    }}>
      {icon && <Icon name={icon} size={12} />}
      {label}
      {count != null && (
        <span style={{
          fontSize: 10.5, fontFamily: 'var(--font-mono)',
          padding: '1px 6px', borderRadius: 99,
          background: active ? 'rgba(255,255,255,0.22)' : 'var(--ink-10)',
          color: active ? 'white' : 'var(--ink-5)',
        }}>{count}</span>
      )}
    </button>
  );
}

export function MBack({ label = 'Back', onClick }: { label?: string; onClick?: () => void }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={onClick ?? (() => navigate(-1))} style={{
      background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 2, color: 'var(--accent)',
      fontSize: 14, fontWeight: 500, marginLeft: -4,
    }}>
      <Icon name="chevron-left" size={22} />
      {label}
    </button>
  );
}

export function MIconBtn({
  icon, onClick, badge, color = 'inherit',
}: { icon: IconName; onClick?: () => void; badge?: boolean; color?: string }) {
  return (
    <button type="button" onClick={onClick} style={{
      width: 36, height: 36, borderRadius: 999,
      background: 'transparent', border: 0, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      color, position: 'relative',
    }}>
      <Icon name={icon} size={18} />
      {badge && (
        <span style={{
          position: 'absolute', top: 5, right: 5,
          width: 8, height: 8, borderRadius: 99,
          background: 'var(--danger)', border: '1.5px solid var(--surface)',
        }} />
      )}
    </button>
  );
}

export function MStat({
  label, value, delta, deltaDir = 'up', sub,
}: { label: string; value: ReactNode; delta?: string; deltaDir?: 'up' | 'down'; sub?: string }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10.5, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--ink-1)', marginTop: 3, lineHeight: 1.05, letterSpacing: '-0.015em' }}>{value}</div>
      {delta && (
        <div style={{
          marginTop: 3, fontSize: 11, fontFamily: 'var(--font-mono)',
          color: deltaDir === 'down' ? 'var(--danger)' : 'var(--success)', fontWeight: 500,
        }}>{deltaDir === 'down' ? '↓' : '↑'} {delta}</div>
      )}
      {sub && <div style={{ marginTop: 3, fontSize: 11, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)' }}>{sub}</div>}
    </div>
  );
}

export function MToggleRow({
  title, sub, on, onChange, leading, last = false,
}: {
  title: ReactNode; sub?: ReactNode;
  on: boolean; onChange: (v: boolean) => void;
  leading?: ReactNode; last?: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '14px 14px',
      borderBottom: last ? 'none' : '1px solid var(--line-soft)',
    }}>
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-1)' }}>{title}</div>
        {sub && <div style={{ fontSize: 12, color: 'var(--ink-5)', marginTop: 2 }}>{sub}</div>}
      </div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

export function MSegmented<T extends string>({
  options, value, onChange,
}: { options: Array<{ value: T; label: string }>; value: T; onChange: (v: T) => void }) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: `repeat(${options.length}, 1fr)`,
      gap: 2, background: 'var(--ink-10)', border: '1px solid var(--line)',
      borderRadius: 10, padding: 2,
    }}>
      {options.map(o => (
        <button key={o.value} type="button" onClick={() => onChange(o.value)} style={{
          padding: '8px 8px', fontSize: 12.5, fontWeight: 600,
          border: 0, borderRadius: 7, cursor: 'pointer',
          background: value === o.value ? 'var(--surface)' : 'transparent',
          color: value === o.value ? 'var(--ink-1)' : 'var(--ink-5)',
          boxShadow: value === o.value ? '0 1px 2px rgba(0,0,0,0.07)' : 'none',
        }}>{o.label}</button>
      ))}
    </div>
  );
}

// ── Scope picker (Automation surfaces) ────────────────────────────────────

function MScopeOption({
  label, sub, active, onClick, leading, last = false,
}: {
  label: ReactNode; sub: ReactNode; active: boolean;
  onClick: () => void; leading?: ReactNode; last?: boolean;
}) {
  return (
    <button type="button" onClick={onClick} style={{
      width: '100%', padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: 11,
      background: active ? 'var(--accent-tint)' : 'transparent',
      border: 0, borderBottom: last ? 'none' : '1px solid var(--line-soft)',
      cursor: 'pointer', textAlign: 'left',
    }}>
      {leading}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--ink-1)' }}>{label}</div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-5)', marginTop: 1 }}>{sub}</div>
      </div>
      <span style={{
        width: 20, height: 20, borderRadius: 99,
        border: '2px solid ' + (active ? 'var(--accent)' : 'var(--ink-7)'),
        background: active ? 'var(--accent)' : 'transparent',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        {active && <Icon name="check" size={11} style={{ color: 'white' }} />}
      </span>
    </button>
  );
}

export function MScopeBar({
  accountId, setAccountId, accounts,
}: {
  accountId: string;
  setAccountId: (v: string) => void;
  accounts: MobileAccount[];
}) {
  const [open, setOpen] = useState(false);
  const isAll = accountId === 'all';
  const acct = accounts.find(a => a.id === accountId);
  const count = accounts.length;
  if (count === 0) {
    return (
      <div style={{ padding: '14px 14px 0' }}>
        <div style={{
          padding: 14, borderRadius: 14, border: '1px dashed var(--line)',
          background: 'var(--surface)', fontSize: 12.5, color: 'var(--ink-5)',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Icon name="info" size={14} />
          No accounts connected yet. Connect a source from More to start.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: '14px 14px 0' }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 14, overflow: 'hidden' }}>
        <button type="button" onClick={() => setOpen(o => !o)} style={{
          width: '100%', padding: '11px 12px',
          display: 'flex', alignItems: 'center', gap: 11,
          background: isAll ? 'linear-gradient(180deg, #f0f5ff 0%, #ffffff 100%)' : 'var(--surface)',
          border: 0, cursor: 'pointer', textAlign: 'left',
        }}>
          {isAll || !acct ? (
            <MIconBox icon="layers" color="var(--accent)" bg="var(--accent-tint)" size={34} />
          ) : (
            <div style={{
              width: 34, height: 34, borderRadius: 9,
              background: 'var(--ink-10)', border: '1px solid var(--line)',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            }}>
              <PlatformBadge platform={acct.platform} size="md" />
            </div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 10, color: 'var(--ink-5)', textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 700 }}>Applies to</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink-1)', marginTop: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {isAll || !acct ? `All ${count} accounts` : acct.shortName}
              {!isAll && acct && acct.city && (
                <span style={{ fontWeight: 400, color: 'var(--ink-5)', fontSize: 12 }}> · {acct.city.split(',')[0]}</span>
              )}
            </div>
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
            Change
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
          </span>
        </button>
        {open && (
          <div style={{ borderTop: '1px solid var(--line-soft)', background: 'var(--ink-10)' }}>
            <MScopeOption
              label={`All ${count} accounts`}
              sub="Apply settings everywhere"
              active={isAll}
              onClick={() => { setAccountId('all'); setOpen(false); }}
              leading={<MIconBox icon="layers" color="var(--accent)" bg="var(--accent-tint)" size={30} />}
            />
            {accounts.map((a, i) => (
              <MScopeOption
                key={a.id}
                label={a.shortName}
                sub={a.city || a.name}
                active={a.id === accountId}
                onClick={() => { setAccountId(a.id); setOpen(false); }}
                leading={<PlatformBadge platform={a.platform} size="md" />}
                last={i === accounts.length - 1}
              />
            ))}
          </div>
        )}
      </div>
      {!isAll && !open && (
        <div style={{ marginTop: 8, fontSize: 11.5, color: 'var(--ink-5)', padding: '0 6px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="info" size={11} />
          Editing this account only — others keep their settings.
        </div>
      )}
    </div>
  );
}
