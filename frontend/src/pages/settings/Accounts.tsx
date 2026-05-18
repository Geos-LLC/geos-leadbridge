import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plug, Plus, AlertTriangle, Info } from 'lucide-react';
import { useAppStore } from '../../store/appStore';
import { SettingCard, ActionLink, FooterBanner } from '../../components/automation/ui';
import type { SavedAccount } from '../../types';
import ConnectionModal from '../../components/ConnectionModal';

const PLATFORM_LABEL: Record<string, string> = {
  thumbtack: 'Thumbtack',
  yelp:      'Yelp',
  angi:      'Angi',
  google:    'Google',
};

const PLATFORM_COLOR: Record<string, string> = {
  thumbtack: 'var(--lb-thumbtack)',
  yelp:      'var(--lb-yelp)',
  angi:      'var(--lb-angi)',
  google:    'var(--lb-google)',
};

export function SettingsAccounts() {
  const navigate = useNavigate();
  const accounts = useAppStore(s => s.savedAccounts);
  const [modal, setModal] = useState<{ open: boolean; reconnect?: SavedAccount | null }>({ open: false });

  // "Configure" jumps to the legacy Services screen which still owns per-account
  // settings UI today; remembered last-account is read from localStorage there.
  const goConfigure = (a: SavedAccount) => {
    localStorage.setItem('lb_last_account_id', a.id);
    navigate('/automation-classic');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={Plug}
        iconTone="violet"
        title="Connected sources"
        subtitle="Manage authentication and lead routing for each platform."
        headerRight={
          <button
            type="button"
            onClick={() => setModal({ open: true, reconnect: null })}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--lb-accent)', color: 'white',
              border: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <Plus size={14} /> Connect new
          </button>
        }
        contentPad="8px 24px 24px"
      >
        <div style={{ paddingTop: 4 }}>
          {accounts.length === 0 && (
            <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--lb-ink-5)', fontSize: 13 }}>
              No sources connected yet. Click "Connect new" to get started.
            </div>
          )}
          {accounts.map((a: SavedAccount, i: number) => (
            <div key={a.id} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 0',
              borderBottom: i === accounts.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
            }}>
              <PlatformBadge platform={a.platform} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{a.businessName || PLATFORM_LABEL[a.platform] || a.platform}</div>
                <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>
                  {PLATFORM_LABEL[a.platform] || a.platform}{a.emailHint ? ` · ${a.emailHint}` : ''}
                </div>
              </div>
              {a.tokenDead ? (
                <button
                  type="button"
                  onClick={() => setModal({ open: true, reconnect: a })}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '4px 10px', borderRadius: 999,
                    background: '#fef3c7', color: '#92400e',
                    fontSize: 11, fontWeight: 600,
                    border: 0, cursor: 'pointer', fontFamily: 'inherit',
                  }}
                >
                  <AlertTriangle size={11} /> Reconnect required
                </button>
              ) : (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', borderRadius: 999,
                  background: '#dcfce7', color: '#16a34a',
                  fontSize: 11, fontWeight: 600,
                }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: '#16a34a' }} />
                  Connected
                </span>
              )}
              <ActionLink onClick={() => goConfigure(a)}>Configure</ActionLink>
            </div>
          ))}
        </div>
      </SettingCard>

      <FooterBanner
        icon={Info}
        body="Disconnecting a source pauses automation for that account but preserves the historical lead data."
      />

      <ConnectionModal
        isOpen={modal.open}
        onClose={() => setModal({ open: false, reconnect: null })}
        accountToReconnect={modal.reconnect}
        savedAccounts={accounts}
        onSuccess={() => setModal({ open: false, reconnect: null })}
      />
    </div>
  );
}

function PlatformBadge({ platform }: { platform: string }) {
  const label = PLATFORM_LABEL[platform] || platform;
  const color = PLATFORM_COLOR[platform] || 'var(--lb-ink-5)';
  const letter = (label[0] || '?').toUpperCase();
  return (
    <div style={{
      width: 36, height: 36, borderRadius: 8,
      background: color, color: 'white',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 14, fontWeight: 700, flexShrink: 0,
    }}>
      {letter}
    </div>
  );
}
