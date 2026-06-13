import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Icon, MAppBar, MCard, MIconBox, MIconBtn, MRow, MScopeBar, MSection, MShell, MToggleRow,
} from '../components';
import type { IconName } from '../components';
import { useMobileAccounts, useAccountSettings } from '../hooks';
import { MLoading } from '../states';

function MAutoCard({
  title, sub, badge, icon, color, bg, status, last, onClick,
}: {
  title: string; sub: string;
  badge: { label: string; bg: string; fg: string };
  icon: IconName; color: string; bg: string; status: string; last?: boolean;
  onClick?: () => void;
}) {
  return (
    <div onClick={onClick} style={{
      padding: '14px 14px',
      borderBottom: last ? 'none' : '1px solid var(--line-soft)',
      display: 'flex', alignItems: 'center', gap: 12,
      cursor: onClick ? 'pointer' : 'default',
    }}>
      <MIconBox icon={icon} color={color} bg={bg} size={38} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--ink-1)' }}>{title}</span>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 99,
            background: badge.bg, color: badge.fg, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}>{badge.label}</span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--ink-5)', marginTop: 3 }}>{sub}</div>
        <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 5, fontFamily: 'var(--font-mono)', fontWeight: 600 }}>● {status}</div>
      </div>
      <Icon name="chevron-right" size={18} style={{ color: 'var(--ink-6)' }} />
    </div>
  );
}

export default function MAutomationHub() {
  const [accountId, setAccountId] = useState('all');
  const [instantCall, setInstantCall] = useState(true);
  const [offHours, setOffHours] = useState(true);
  const navigate = useNavigate();

  const accounts = useMobileAccounts();
  const settings = useAccountSettings(accountId === 'all' ? null : accountId);

  const respondStatus = settings.data?.followUpReplyType === 'ai' ? 'On · AI mode'
    : settings.data?.followUpReplyType === 'template' ? 'On · Template'
    : accountId === 'all' ? 'Account-by-account' : 'Off';
  const followUpStatus = settings.data?.followUpMode && settings.data.followUpMode !== 'off'
    ? `On · ${settings.data.followUpMode}`
    : accountId === 'all' ? 'Account-by-account' : 'Off';

  return (
    <MShell
      tab="auto"
      appBar={
        <MAppBar
          large
          title="Automation"
          subtitle="Reply, follow up, convert — on autopilot."
          trailing={<MIconBtn icon="help-circle" />}
        />
      }
    >
      {accounts.loading && <MLoading label="Loading your accounts…" />}
      {!accounts.loading && (
        <MScopeBar accountId={accountId} setAccountId={setAccountId} accounts={accounts.data || []} />
      )}

      <MSection title="Modes">
        <MCard>
          <MAutoCard
            title="First Reply" sub="What AI does when a new lead lands"
            badge={{ label: 'Respond', bg: '#dcfce7', fg: '#15803d' }}
            icon="zap" color="var(--success)" bg="var(--success-tint)"
            status={respondStatus}
            onClick={() => navigate('/m/automation/respond')}
          />
          <MAutoCard
            title="Follow-ups" sub="Nudge silent leads on a schedule"
            badge={{ label: 'Engage', bg: '#ede9fe', fg: '#6d28d9' }}
            icon="repeat" color="#6d28d9" bg="#ede9fe"
            status={followUpStatus}
            onClick={() => navigate('/m/automation/engage')}
          />
          <MAutoCard
            title="AI Conversation" sub="Continue the chat for you"
            badge={{ label: 'Convert', bg: 'var(--accent-tint)', fg: 'var(--accent)' }}
            icon="sparkles" color="var(--accent)" bg="var(--accent-tint)"
            status={accountId === 'all' ? 'Account-by-account' : 'See details'}
            last
            onClick={() => navigate('/m/automation/convert')}
          />
        </MCard>
      </MSection>

      <MSection title="Quick toggles">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="phone" color="var(--success)" bg="var(--success-tint)" />}
            title="Instant Call" sub="Ring you when a hot lead arrives"
            on={instantCall} onChange={setInstantCall}
          />
          <MToggleRow
            leading={<MIconBox icon="moon" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Off-hours auto-reply" sub="Polite hold-message after hours"
            on={offHours} onChange={setOffHours}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Alerts">
        <MCard>
          <MRow
            leading={<MIconBox icon="message-square" color="#92400e" bg="var(--warn-tint)" />}
            title="SMS alerts" subtitle="Configured in desktop settings"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
          />
          <MRow
            leading={<MIconBox icon="mail" color="var(--accent)" bg="var(--accent-tint)" />}
            title="Email alerts" subtitle="Configured in desktop settings"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <div style={{ height: 80 }} />
    </MShell>
  );
}
