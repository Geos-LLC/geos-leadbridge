import { Layers, MapPin, type LucideIcon } from 'lucide-react';
import type { SavedAccount } from '../../types';

const PLATFORM_LABEL: Record<string, string> = {
  thumbtack: 'Thumbtack',
  yelp:      'Yelp',
  angi:      'Angi',
  google:    'Google',
};

export const ALL_ACCOUNTS = 'all' as const;

function getShortName(a: SavedAccount): string {
  return PLATFORM_LABEL[a.platform] || a.platform;
}

function AccountTab({
  active, onClick, icon: Icon, label, sublabel, applyHint, warning,
}: {
  active: boolean;
  onClick: () => void;
  icon: LucideIcon;
  label: string;
  sublabel?: string;
  applyHint?: boolean;
  warning?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 14px 12px',
        background: 'transparent',
        border: 0,
        borderBottom: '2px solid ' + (active ? 'var(--lb-accent)' : 'transparent'),
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: active ? 'var(--lb-ink-1)' : 'var(--lb-ink-5)',
        transition: 'color 120ms, border-color 120ms',
        marginBottom: -1,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      <Icon size={14} style={{ color: active ? 'var(--lb-accent)' : 'var(--lb-ink-6)' }} />
      <div style={{ textAlign: 'left' }}>
        <div style={{
          fontSize: 13, fontWeight: active ? 700 : 500, lineHeight: 1.2,
          display: 'flex', alignItems: 'center', gap: 6,
        }}>
          {label}
          {warning && <span style={{ width: 6, height: 6, borderRadius: 99, background: 'var(--lb-warn)' }} />}
        </div>
        {sublabel && (
          <div style={{
            fontSize: 10.5, color: 'var(--lb-ink-6)', marginTop: 2,
            fontFamily: 'var(--lb-font-mono)', letterSpacing: 0.04,
            textTransform: 'uppercase', fontWeight: 500,
          }}>
            {sublabel}
            {applyHint && <span style={{ color: 'var(--lb-accent)' }}> · APPLIES TO ALL</span>}
          </div>
        )}
      </div>
    </button>
  );
}

export function AccountTabs({
  value, onChange, accounts,
}: {
  value: string;
  onChange: (id: string) => void;
  accounts: SavedAccount[];
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 2,
      borderBottom: '1px solid var(--lb-line)',
      marginBottom: 22,
      overflowX: 'auto',
      paddingBottom: 1,
    }}>
      <AccountTab
        active={value === ALL_ACCOUNTS}
        onClick={() => onChange(ALL_ACCOUNTS)}
        icon={Layers}
        label="All accounts"
        sublabel={`${accounts.length} ${accounts.length === 1 ? 'source' : 'sources'}`}
        applyHint
      />
      {accounts.map(a => (
        <AccountTab
          key={a.id}
          active={value === a.id}
          onClick={() => onChange(a.id)}
          icon={MapPin}
          label={getShortName(a)}
          sublabel={a.businessName || PLATFORM_LABEL[a.platform] || a.platform}
          warning={!!a.tokenDead}
        />
      ))}
    </div>
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
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '12px 16px',
      // Single-account scope deserves a strong visual cue — when the user is
      // editing per-account values, the banner is amber-tinted with a left
      // accent stripe so it stands out from the All-accounts blue banner.
      background: isAll ? '#eff6ff' : '#fffbeb',
      border: '1.5px solid ' + (isAll ? '#c3d4ff' : '#fcd34d'),
      borderLeft: '5px solid ' + (isAll ? 'var(--lb-accent)' : '#f59e0b'),
      borderRadius: 10,
      fontSize: 13.5, fontWeight: 500,
      color: isAll ? 'var(--lb-accent)' : '#92400e',
      marginBottom: 18,
      boxShadow: isAll ? 'none' : '0 1px 2px rgba(245,158,11,0.15)',
    }}>
      {isAll ? <Layers size={14} /> : <MapPin size={14} />}
      <div style={{ flex: 1 }}>
        {isAll
          ? <>Editing settings for <strong>all {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</strong>. Changes apply everywhere.</>
          : <>Editing settings for <strong>{acct?.businessName || 'this account'}</strong> only. Other accounts keep their own values.</>
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
