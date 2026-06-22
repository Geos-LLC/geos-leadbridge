import { useEffect, useRef, useState } from 'react';
import { Building2, ChevronDown, Check } from 'lucide-react';
import type { SavedAccount } from '../types';

/**
 * Upper-left context pill that scopes per-account settings/automation pages
 * to a single SavedAccount. Selecting "All accounts" returns null. Hidden
 * automatically when the tenant has no connected accounts — there's nothing
 * to switch between.
 */
export function AccountSwitcherPill({
  accounts,
  selectedAccountId,
  onSelect,
  label = 'Account',
}: {
  accounts: SavedAccount[];
  selectedAccountId: string | null;
  onSelect: (id: string | null) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (accounts.length === 0) return null;

  const selected = selectedAccountId
    ? accounts.find((a) => a.id === selectedAccountId) ?? null
    : null;

  const buttonLabel = selected
    ? selected.businessName
    : `All accounts (${accounts.length})`;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={selected ? `${label}: ${selected.businessName}` : `${label}: all`}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 10px 6px 8px',
          borderRadius: 999,
          background: 'var(--lb-surface, #ffffff)',
          border: '1px solid var(--lb-line, #e4e7ec)',
          boxShadow: 'var(--lb-shadow-sm, 0 1px 2px rgba(16,24,40,0.04))',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--lb-ink-2, #1f2937)',
          maxWidth: 280,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            background: 'var(--lb-accent-tint, #eef2ff)',
            color: 'var(--lb-accent, #4f46e5)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Building2 size={12} />
        </span>
        <span style={{ color: 'var(--lb-ink-5, #6b7280)', fontWeight: 500 }}>{label}:</span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 180,
          }}
        >
          {buttonLabel}
        </span>
        <ChevronDown
          size={14}
          style={{
            transition: 'transform 120ms',
            transform: open ? 'rotate(180deg)' : 'none',
            color: 'var(--lb-ink-5, #6b7280)',
            flexShrink: 0,
          }}
        />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            left: 0,
            zIndex: 30,
            minWidth: 260,
            maxWidth: 340,
            background: 'var(--lb-surface, #ffffff)',
            border: '1px solid var(--lb-line, #e4e7ec)',
            borderRadius: 12,
            boxShadow: '0 8px 24px rgba(16,24,40,0.12)',
            padding: 6,
            maxHeight: 360,
            overflowY: 'auto',
          }}
        >
          <SwitcherRow
            label={`All accounts (${accounts.length})`}
            sub="Show data across every connected source"
            active={selectedAccountId === null}
            onClick={() => {
              onSelect(null);
              setOpen(false);
            }}
          />
          <div
            style={{
              height: 1,
              background: 'var(--lb-line, #e4e7ec)',
              margin: '4px 6px',
            }}
          />
          {accounts.map((a) => (
            <SwitcherRow
              key={a.id}
              label={a.businessName || a.platform || a.id}
              sub={a.platform ? a.platform.charAt(0).toUpperCase() + a.platform.slice(1) : undefined}
              active={selectedAccountId === a.id}
              onClick={() => {
                onSelect(a.id);
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SwitcherRow({
  label,
  sub,
  active,
  onClick,
}: {
  label: string;
  sub?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={active}
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 8,
        background: active ? 'var(--lb-accent-tint, #eef2ff)' : 'transparent',
        border: 0,
        cursor: 'pointer',
        textAlign: 'left',
        fontFamily: 'inherit',
        color: active ? 'var(--lb-accent, #4f46e5)' : 'var(--lb-ink-2, #1f2937)',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--lb-ink-bg-soft, #f3f4f6)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent';
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: active ? 700 : 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </div>
        {sub && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--lb-ink-5, #6b7280)',
              marginTop: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {sub}
          </div>
        )}
      </div>
      {active && <Check size={14} />}
    </button>
  );
}
