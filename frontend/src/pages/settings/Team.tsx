import { useEffect, useState } from 'react';
import { Users, Shield, UserPlus, MoreVertical, Check, X, Loader2 } from 'lucide-react';
import { useAuthStore } from '../../store/authStore';
import { SettingCard, SectionCard, IconTile } from '../../components/automation/ui';
import { teamsApi } from '../../services/api';

type Member = {
  name: string;
  email: string;
  role: 'Owner' | 'Manager' | 'Agent';
  initials: string;
  tone: 'blue' | 'green' | 'orange' | 'purple';
};

const TONE_CYCLE: Array<Member['tone']> = ['blue', 'green', 'orange', 'purple'];

function toMember(m: any, idx: number, ownerUserId?: string | null): Member {
  const user = m.user || m;
  const name: string = user.name || user.email || 'Member';
  const email: string = user.email || '';
  const apiRole: string = m.role || 'MEMBER';
  const role: Member['role'] = apiRole === 'OWNER' || user.id === ownerUserId
    ? 'Owner'
    : apiRole === 'ADMIN'
      ? 'Manager'
      : 'Agent';
  const initials = (name.split(' ').map((s: string) => s[0] || '').join('').toUpperCase() || 'U').slice(0, 2);
  return { name, email, role, initials, tone: TONE_CYCLE[idx % TONE_CYCLE.length] };
}

export function SettingsTeam() {
  const user = useAuthStore(s => s.user);
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite modal state
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [inviteResult, setInviteResult] = useState<{ ok: boolean; message: string; link?: string } | null>(null);

  const loadTeam = () => {
    setLoading(true); setError(null);
    teamsApi.getMyOrg()
      .then(res => {
        const orgMembers = res?.organization?.memberships || res?.organization?.members || [];
        const ownerId = res?.organization?.ownerUserId || res?.organization?.ownerId;
        if (orgMembers.length > 0) {
          setMembers(orgMembers.map((m: any, i: number) => toMember(m, i, ownerId)));
        } else {
          // No org yet — show just the current user as Owner
          const initials = (user?.name?.split(' ').map(s => s[0]).join('').toUpperCase() || 'U').slice(0, 2);
          setMembers([{
            name: user?.name || user?.email || 'Owner',
            email: user?.email || '',
            role: 'Owner',
            initials,
            tone: 'blue',
          }]);
        }
      })
      .catch(e => setError(e?.response?.data?.message || e?.message || 'Failed to load team'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadTeam(); }, []);  // eslint-disable-line react-hooks/exhaustive-deps

  const handleInvite = async () => {
    if (!inviteEmail.trim()) { setInviteResult({ ok: false, message: 'Enter an email address.' }); return; }
    setInviting(true); setInviteResult(null);
    try {
      const res = await teamsApi.invite(inviteEmail.trim(), inviteRole);
      setInviteResult({ ok: true, message: 'Invite sent.', link: res.inviteLink });
      setInviteEmail('');
      loadTeam();
    } catch (e: any) {
      setInviteResult({ ok: false, message: e?.response?.data?.message || e?.message || 'Failed to send invite' });
    } finally {
      setInviting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
          fontSize: 13, fontWeight: 600,
        }}>{error}</div>
      )}

      <SettingCard
        icon={Users}
        iconTone="violet"
        title="Team members"
        subtitle="People who can sign in to Leadbridge."
        headerRight={
          <button
            type="button"
            onClick={() => { setInviteOpen(true); setInviteResult(null); }}
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
          {loading && (
            <div style={{ padding: '20px 0', display: 'inline-flex', alignItems: 'center', gap: 8, color: 'var(--lb-ink-5)', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading members…
            </div>
          )}
          {!loading && members?.map((m, i) => (
            <div key={(m.email || m.name) + i} style={{
              display: 'flex', alignItems: 'center', gap: 14,
              padding: '14px 0',
              borderBottom: i === (members.length - 1) ? 'none' : '1px solid var(--lb-line-soft)',
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

      {inviteOpen && (
        <InviteModal
          email={inviteEmail}
          onEmailChange={setInviteEmail}
          role={inviteRole}
          onRoleChange={setInviteRole}
          inviting={inviting}
          result={inviteResult}
          onClose={() => setInviteOpen(false)}
          onInvite={handleInvite}
        />
      )}
    </div>
  );
}

function InviteModal({
  email, onEmailChange, role, onRoleChange, inviting, result, onClose, onInvite,
}: {
  email: string;
  onEmailChange: (v: string) => void;
  role: 'ADMIN' | 'MEMBER';
  onRoleChange: (r: 'ADMIN' | 'MEMBER') => void;
  inviting: boolean;
  result: { ok: boolean; message: string; link?: string } | null;
  onClose: () => void;
  onInvite: () => void;
}) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 50,
        background: 'rgba(10,21,48,0.4)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: 'white', borderRadius: 14, width: '100%', maxWidth: 460,
          padding: 24, boxShadow: 'var(--lb-shadow-md)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)' }}>Invite a team member</div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'transparent', border: 0, cursor: 'pointer', color: 'var(--lb-ink-5)', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)', display: 'block', marginBottom: 6 }}>Email address</label>
        <input
          type="email"
          value={email}
          onChange={e => onEmailChange(e.target.value)}
          placeholder="teammate@example.com"
          style={{
            width: '100%', padding: '9px 12px',
            border: '1px solid var(--lb-line)', borderRadius: 8,
            fontSize: 13, fontFamily: 'inherit',
            background: 'white', color: 'var(--lb-ink-1)', outline: 'none',
            marginBottom: 14,
          }}
        />

        <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)', display: 'block', marginBottom: 6 }}>Role</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {(['MEMBER', 'ADMIN'] as const).map(r => (
            <button
              key={r}
              type="button"
              onClick={() => onRoleChange(r)}
              style={{
                flex: 1,
                padding: '9px 12px', fontSize: 13, fontWeight: 600,
                background: role === r ? '#eff6ff' : 'white',
                border: '1.5px solid ' + (role === r ? 'var(--lb-accent)' : 'var(--lb-line)'),
                borderRadius: 8, cursor: 'pointer',
                color: role === r ? 'var(--lb-accent)' : 'var(--lb-ink-3)',
                fontFamily: 'inherit',
              }}
            >
              {r === 'MEMBER' ? 'Agent' : 'Manager'}
            </button>
          ))}
        </div>

        {result && (
          <div style={{
            padding: '10px 12px', borderRadius: 8, marginBottom: 12,
            background: result.ok ? 'var(--lb-success-tint)' : 'var(--lb-danger-tint)',
            color: result.ok ? 'var(--lb-success)' : 'var(--lb-danger)',
            fontSize: 12.5, fontWeight: 600,
          }}>
            {result.message}
            {result.link && (
              <div style={{ marginTop: 6, fontFamily: 'var(--lb-font-mono)', fontSize: 11.5, wordBreak: 'break-all' }}>
                {result.link}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'white', color: 'var(--lb-ink-2)',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >Cancel</button>
          <button
            type="button"
            onClick={onInvite}
            disabled={inviting || !email.trim()}
            style={{
              padding: '8px 14px', fontSize: 13, fontWeight: 600,
              background: 'var(--lb-accent)', color: 'white',
              border: 0, borderRadius: 8,
              cursor: inviting ? 'not-allowed' : 'pointer',
              opacity: inviting || !email.trim() ? 0.7 : 1,
              fontFamily: 'inherit',
            }}
          >
            {inviting ? 'Sending…' : 'Send invite'}
          </button>
        </div>
      </div>
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
