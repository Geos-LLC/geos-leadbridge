import { useNavigate } from 'react-router-dom';
import {
  Avatar, Icon, MAppBar, MCard, MIconBox, MIconBtn, MRow, MSection, MShell, PlatformBadge,
} from '../components';
import { LB_ACCOUNTS, LB_USER } from '../data';

export default function MSettings() {
  const navigate = useNavigate();
  return (
    <MShell tab="more" appBar={<MAppBar large title="More" subtitle={LB_USER.business} trailing={<MIconBtn icon="search" />} />}>
      <MSection>
        <MCard style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Avatar name={LB_USER.name} size={52} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink-1)' }}>{LB_USER.name}</div>
            <div style={{ fontSize: 12, color: 'var(--ink-5)', fontFamily: 'var(--font-mono)' }}>{LB_USER.email}</div>
            <div style={{ marginTop: 6 }}>
              <span style={{
                fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
                background: 'var(--accent-tint)', color: 'var(--accent)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>{LB_USER.tier} plan</span>
            </div>
          </div>
          <Icon name="chevron-right" size={18} style={{ color: 'var(--ink-6)' }} />
        </MCard>
      </MSection>

      <MSection title="Connected accounts">
        <MCard>
          {LB_ACCOUNTS.slice(0, 4).map((a, i) => (
            <MRow
              key={a.id}
              leading={<PlatformBadge platform={a.platform} size="md" />}
              title={a.shortName}
              subtitle={a.city}
              trailing={
                <span style={{
                  fontSize: 10.5, padding: '3px 8px', borderRadius: 99,
                  background: a.status === 'connected' ? 'var(--success-tint)' : 'var(--warn-tint)',
                  color: a.status === 'connected' ? '#15803d' : '#92400e',
                  textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700,
                }}>{a.status === 'connected' ? 'Live' : 'Warn'}</span>
              }
              last={i === 3}
            />
          ))}
        </MCard>
        <div style={{ marginTop: 8, textAlign: 'center' }}>
          <button type="button" style={{
            background: 'transparent', border: 0, color: 'var(--accent)',
            fontWeight: 600, fontSize: 13, cursor: 'pointer',
          }}>+ Connect another source</button>
        </div>
      </MSection>

      <MSection title="Manage">
        <MCard>
          <MRow
            leading={<MIconBox icon="calendar-clock" color="var(--accent)" bg="var(--accent-tint)" />}
            title="Availability" subtitle="Mon–Sat 7am–6pm"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            onClick={() => navigate('/m/availability')}
          />
          <MRow
            leading={<MIconBox icon="file-text" color="#6d28d9" bg="#ede9fe" />}
            title="Templates" subtitle="5 saved replies"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
          />
          <MRow
            leading={<MIconBox icon="bell" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Notifications" subtitle="SMS, email"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
          />
          <MRow
            leading={<MIconBox icon="credit-card" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Billing" subtitle="Pro · $49 / month"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <MSection title="Support">
        <MCard>
          <MRow
            leading={<MIconBox icon="help-circle" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Help center"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
          />
          <MRow
            leading={<MIconBox icon="message-square" color="var(--ink-4)" bg="var(--ink-10)" />}
            title="Contact support"
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <MSection>
        <MCard>
          <MRow
            leading={<MIconBox icon="log-out" color="var(--danger)" bg="var(--danger-tint)" />}
            title="Sign out" danger
            trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
            last
          />
        </MCard>
      </MSection>

      <div style={{ textAlign: 'center', padding: '20px 0 8px', fontSize: 11, color: 'var(--ink-6)', fontFamily: 'var(--font-mono)' }}>
        Leadbridge v2.4.1
      </div>
      <div style={{ height: 40 }} />
    </MShell>
  );
}
