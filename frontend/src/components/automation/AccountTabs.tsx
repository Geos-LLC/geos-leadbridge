import { Layers } from 'lucide-react';
import type { SavedAccount } from '../../types';

const PLATFORM_LABEL: Record<string, string> = {
  thumbtack: 'Thumbtack',
  yelp:      'Yelp',
  angi:      'Angi',
  google:    'Google',
};

// Each platform gets a 18px brand-color tile with a short mono code
// ("TT" / "Y" / etc.) per the LeadBridge Automation Bundle.
const PLATFORM_BRAND: Record<string, { bg: string; short: string }> = {
  thumbtack: { bg: 'var(--lb-thumbtack)', short: 'TT' },
  yelp:      { bg: 'var(--lb-yelp)',      short: 'Y' },
  angi:      { bg: 'var(--lb-angi)',      short: 'A' },
  google:    { bg: 'var(--lb-google)',    short: 'G' },
};

export const ALL_ACCOUNTS = 'all' as const;

export function AccountTabs({
  value, onChange, accounts,
}: {
  value: string;
  onChange: (id: string) => void;
  accounts: SavedAccount[];
}) {
  return (
    <div
      className="lb-account-tabs lb-tabscroll"
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '1px solid var(--lb-line)',
        overflowX: 'auto',
        paddingBottom: 0,
      }}
    >
      <UnderlineTab
        active={value === ALL_ACCOUNTS}
        onClick={() => onChange(ALL_ACCOUNTS)}
        label="All accounts"
        leading={<Layers size={14} />}
      />
      {accounts.map(a => {
        const brand = PLATFORM_BRAND[a.platform] || { bg: 'var(--lb-ink-6)', short: '?' };
        const label = a.businessName || PLATFORM_LABEL[a.platform] || a.platform;
        return (
          <UnderlineTab
            key={a.id}
            active={value === a.id}
            onClick={() => onChange(a.id)}
            label={label}
            leading={
              <span style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, borderRadius: 4,
                background: brand.bg, color: '#fff',
                fontFamily: 'var(--lb-font-mono)', fontWeight: 600, fontSize: 9,
              }}>{brand.short}</span>
            }
            warning={!!a.tokenDead}
          />
        );
      })}
    </div>
  );
}

function UnderlineTab({
  active, onClick, leading, label, warning,
}: {
  active: boolean;
  onClick: () => void;
  leading?: React.ReactNode;
  label: string;
  warning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '9px 14px 11px',
        background: 'transparent',
        border: 0,
        borderBottom: '2px solid ' + (active ? 'var(--lb-accent)' : 'transparent'),
        marginBottom: -1,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: active ? 700 : 500,
        color: active ? 'var(--lb-ink-1)' : 'var(--lb-ink-5)',
        flexShrink: 0,
      }}
    >
      {leading}
      <span>{label}</span>
      {warning && (
        <span
          aria-label="Token issue"
          style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--lb-warn)' }}
        />
      )}
    </button>
  );
}

export function ScopeBanner({
  accountId, accounts, onCopyFrom,
}: {
  accountId: string;
  accounts: SavedAccount[];
  onCopyFrom?: () => void;
}) {
  const isAll = accountId === ALL_ACCOUNTS;
  const acct = accounts.find(a => a.id === accountId);
  // Per LeadBridge Automation Bundle: single flat accent-tint card,
  // 12-radius, no left stripe. The per-account amber variant is kept
  // for visibility but uses the same chrome (just warn-tint colors).
  const palette = isAll
    ? { bg: 'var(--lb-accent-tint)', border: 'var(--lb-accent-line)', fg: 'var(--lb-ink-3)', icon: 'var(--lb-accent)' }
    : { bg: 'var(--lb-warn-tint)',   border: '#fcd34d',                 fg: '#92400e',         icon: '#f59e0b' };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '11px 16px',
      background: palette.bg,
      border: '1px solid ' + palette.border,
      borderRadius: 12,
      fontSize: 12.5,
      color: palette.fg,
      minWidth: 0,
    }}>
      <Layers size={15} style={{ color: palette.icon, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0, lineHeight: 1.45 }}>
        {isAll
          ? <>Editing <strong style={{ color: 'var(--lb-ink-1)' }}>all {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</strong>. Changes apply to every connected source. Switch a tab above to edit one account.</>
          : <>Editing <strong style={{ color: 'var(--lb-ink-1)' }}>{acct?.businessName || 'this account'}</strong> only. Other accounts keep their own values.</>
        }
      </div>
      {!isAll && onCopyFrom && (
        <button
          type="button"
          onClick={onCopyFrom}
          style={{
            background: 'transparent', border: 0, padding: 0, cursor: 'pointer',
            fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            color: 'var(--lb-accent)',
          }}
        >
          Copy settings from another account →
        </button>
      )}
    </div>
  );
}
