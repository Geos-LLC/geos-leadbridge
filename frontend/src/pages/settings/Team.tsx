import { Users, Shield, UserPlus, MoreVertical, Check, X } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { SettingCard, SectionCard, IconTile } from '../../components/automation/ui';

export function SettingsTeam() {
  const user = useAuthStore(s => s.user);

  const initials = (user?.name?.split(' ').map(s => s[0]).join('').toUpperCase() || 'U').slice(0, 2);
  const ownerName = user?.name || user?.email || 'Owner';
  const ownerEmail = user?.email || '';

  const team = [
    { name: ownerName, email: ownerEmail, role: 'Owner' as const, initials, tone: 'blue' as const },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={Users}
        iconTone="violet"
        title="Team members"
        subtitle="People who can sign in to Leadbridge."
        headerRight={
          <button
            type="button"
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--lb-accent)', color: 'white',
              border: 0, borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit',
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}
          >
            <UserPlus size={14} /> Invite
          </button>
        }
        contentPad="8px 24px 24px"
      >
        <div style={{ paddingTop: 4 }}>
          {team.map((m, i) => (
            <div key={m.email || m.name} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 0',
              borderBottom: i === team.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
            }}>
              <TeamAvatar initials={m.initials} tone={m.tone} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{m.name}</div>
                <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>{m.email}</div>
              </div>
              <RoleChip role={m.role} />
              <button
                type="button"
                style={{
                  width: 30, height: 30, borderRadius: 8,
                  background: 'transparent', border: '1px solid transparent',
                  cursor: 'pointer', color: 'var(--lb-ink-5)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                <MoreVertical size={14} />
              </button>
            </div>
          ))}
        </div>
      </SettingCard>

      <SectionCard padding="20px 24px">
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 10 }}>
          <IconTile icon={Shield} tone="green" size="md" />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>Roles & permissions</div>
            <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>What each role can do across Leadbridge.</div>
          </div>
        </div>
        <RolesGrid />
      </SectionCard>
    </div>
  );
}

function TeamAvatar({ initials, tone }: { initials: string; tone: 'blue' | 'green' | 'orange' | 'purple' }) {
  const tones = {
    blue:   { bg: '#dbeafe', fg: '#2563eb' },
    green:  { bg: '#dcfce7', fg: '#16a34a' },
    orange: { bg: '#fed7aa', fg: '#ea580c' },
    purple: { bg: '#ede9fe', fg: '#7c3aed' },
  };
  const t = tones[tone];
  return (
    <div style={{
      width: 36, height: 36, borderRadius: 99,
      background: t.bg, color: t.fg,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, fontWeight: 700, flexShrink: 0,
    }}>{initials}</div>
  );
}

function RoleChip({ role }: { role: 'Owner' | 'Manager' | 'Agent' }) {
  const tones = {
    Owner:   { bg: '#fef3c7', fg: '#92400e' },
    Manager: { bg: '#dbeafe', fg: '#1d4ed8' },
    Agent:   { bg: '#f1f5f9', fg: '#475569' },
  };
  const t = tones[role];
  return (
    <span style={{
      padding: '3px 10px', borderRadius: 999,
      background: t.bg, color: t.fg,
      fontSize: 11, fontWeight: 600,
    }}>{role}</span>
  );
}

function RolesGrid() {
  const perms = [
    { feature: 'View leads',           Owner: true, Manager: true,  Agent: true  },
    { feature: 'Reply to leads',       Owner: true, Manager: true,  Agent: true  },
    { feature: 'Edit automation',      Owner: true, Manager: true,  Agent: false },
    { feature: 'Connect sources',      Owner: true, Manager: true,  Agent: false },
    { feature: 'Manage team & roles',  Owner: true, Manager: false, Agent: false },
    { feature: 'Billing & invoices',   Owner: true, Manager: false, Agent: false },
  ];
  return (
    <div style={{
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10, overflow: 'hidden',
    }}>
      <div style={{
        display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
        background: '#f8fafc',
        padding: '10px 14px',
        fontSize: 11, fontWeight: 600,
        fontFamily: 'var(--lb-font-mono)',
        color: 'var(--lb-ink-5)',
        textTransform: 'uppercase', letterSpacing: 0.06,
        borderBottom: '1px solid var(--lb-line-soft)',
      }}>
        <div>Capability</div>
        <div style={{ textAlign: 'center' }}>Owner</div>
        <div style={{ textAlign: 'center' }}>Manager</div>
        <div style={{ textAlign: 'center' }}>Agent</div>
      </div>
      {perms.map((p, i) => (
        <div key={p.feature} style={{
          display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
          padding: '12px 14px',
          fontSize: 13,
          borderBottom: i === perms.length - 1 ? 'none' : '1px solid var(--lb-line-soft)',
          alignItems: 'center',
        }}>
          <div style={{ color: 'var(--lb-ink-2)' }}>{p.feature}</div>
          <PermCell on={p.Owner} />
          <PermCell on={p.Manager} />
          <PermCell on={p.Agent} />
        </div>
      ))}
    </div>
  );
}

function PermCell({ on }: { on: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'center' }}>
      {on ? (
        <span style={{
          width: 22, height: 22, borderRadius: 99,
          background: '#dcfce7', color: '#16a34a',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}><Check size={12} /></span>
      ) : (
        <span style={{
          width: 22, height: 22, borderRadius: 99,
          background: '#f1f5f9', color: '#94a3b8',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }}><X size={12} /></span>
      )}
    </div>
  );
}
