import { useState, useEffect } from 'react';
import { Users, UserPlus, Mail, Shield, Crown, Loader2, Trash2, X, Copy, Check } from 'lucide-react';
import { teamsApi } from '../services/api';

const ROLE_CONFIG: Record<string, { label: string; icon: any; color: string }> = {
  OWNER: { label: 'Owner', icon: Crown, color: 'text-amber-600 bg-amber-50 border-amber-200' },
  ADMIN: { label: 'Admin', icon: Shield, color: 'text-blue-600 bg-blue-50 border-blue-200' },
  MEMBER: { label: 'Member', icon: Users, color: 'text-slate-600 bg-slate-50 border-slate-200' },
};

export default function TeamSection() {
  const [org, setOrg] = useState<any>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [orgName, setOrgName] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'ADMIN' | 'MEMBER'>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [inviteLink, setInviteLink] = useState('');
  const [copied, setCopied] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => { loadOrg(); }, []);

  const loadOrg = async () => {
    setLoading(true);
    try {
      const res = await teamsApi.getMyOrg();
      setOrg(res.organization);
      setMyRole(res.myRole);
    } catch { /* no org */ }
    finally { setLoading(false); }
  };

  const handleCreateOrg = async () => {
    if (!orgName.trim()) return;
    setCreating(true);
    try {
      await teamsApi.createOrg(orgName.trim());
      await loadOrg();
      setOrgName('');
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to create team');
    } finally { setCreating(false); }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      const res = await teamsApi.invite(inviteEmail.trim(), inviteRole);
      setInviteLink(window.location.origin + res.inviteLink);
      setInviteEmail('');
      await loadOrg();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to send invitation');
    } finally { setInviting(false); }
  };

  const handleRemove = async (userId: string) => {
    if (!confirm('Remove this team member?')) return;
    setActionLoading(userId);
    try {
      await teamsApi.removeMember(userId);
      await loadOrg();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to remove member');
    } finally { setActionLoading(null); }
  };

  const handleRoleChange = async (userId: string, role: 'ADMIN' | 'MEMBER') => {
    setActionLoading(userId);
    try {
      await teamsApi.updateRole(userId, role);
      await loadOrg();
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to change role');
    } finally { setActionLoading(null); }
  };

  const handleRevokeInvite = async (id: string) => {
    setActionLoading(id);
    try {
      await teamsApi.revokeInvitation(id);
      await loadOrg();
    } catch { /* ignore */ }
    finally { setActionLoading(null); }
  };

  const handleDeleteOrg = async () => {
    if (!confirm('Delete this team? All members will be removed and shared access revoked. This cannot be undone.')) return;
    try {
      await teamsApi.deleteOrg();
      setOrg(null);
      setMyRole(null);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to delete team');
    }
  };

  const handleLeave = async () => {
    if (!confirm('Leave this team? You will lose access to shared accounts.')) return;
    try {
      await teamsApi.leaveOrg();
      setOrg(null);
      setMyRole(null);
    } catch (err: any) {
      alert(err.response?.data?.message || 'Failed to leave team');
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (loading) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden p-8">
        <div className="flex items-center gap-3">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
          <span className="text-sm text-slate-400">Loading team...</span>
        </div>
      </div>
    );
  }

  // No organization — show create
  if (!org) {
    return (
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
        <div className="p-8">
          <div className="flex items-center gap-3 mb-1">
            <Users className="w-5 h-5 text-blue-600" />
            <h2 className="text-xl font-bold text-slate-900">Team</h2>
          </div>
          <p className="text-sm text-slate-500 mb-6">
            Create a team to share accounts and leads with your team members.
          </p>
          <div className="flex gap-2">
            <input
              type="text"
              value={orgName}
              onChange={e => setOrgName(e.target.value)}
              placeholder="Team name (e.g. Spotless Homes)"
              className="flex-1 px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={e => e.key === 'Enter' && handleCreateOrg()}
            />
            <button
              onClick={handleCreateOrg}
              disabled={creating || !orgName.trim()}
              className="px-5 py-2.5 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {creating ? <Loader2 size={16} className="animate-spin" /> : <UserPlus size={16} />}
              Create Team
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Has organization
  const isOwner = myRole === 'OWNER';
  const isAdmin = myRole === 'ADMIN';
  const canManage = isOwner || isAdmin;

  return (
    <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden">
      <div className="p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <Users className="w-5 h-5 text-blue-600" />
              <h2 className="text-xl font-bold text-slate-900">{org.name}</h2>
            </div>
            <p className="text-sm text-slate-500">
              {org.members?.length || 0} member{org.members?.length !== 1 ? 's' : ''}
              {' '}&middot;{' '}
              <span className="capitalize">{myRole?.toLowerCase()}</span>
            </p>
          </div>
        </div>

        {/* Members list */}
        <div className="space-y-2 mb-6">
          <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Members</h3>
          {org.members?.map((m: any) => {
            const roleConf = ROLE_CONFIG[m.role] || ROLE_CONFIG.MEMBER;
            const RoleIcon = roleConf.icon;
            return (
              <div key={m.id} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 font-bold text-sm">
                    {(m.user?.name?.[0] || m.user?.email?.[0] || '?').toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-900">{m.user?.name || m.user?.email}</p>
                    <p className="text-xs text-slate-400">{m.user?.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {isOwner && m.role !== 'OWNER' ? (
                    <select
                      value={m.role}
                      onChange={e => handleRoleChange(m.user.id, e.target.value as 'ADMIN' | 'MEMBER')}
                      disabled={actionLoading === m.user.id}
                      className={`text-[11px] px-2 py-1 rounded-lg border font-semibold ${roleConf.color}`}
                    >
                      <option value="ADMIN">Admin</option>
                      <option value="MEMBER">Member</option>
                    </select>
                  ) : (
                    <span className={`text-[11px] px-2 py-1 rounded-lg border font-semibold flex items-center gap-1 ${roleConf.color}`}>
                      <RoleIcon size={12} /> {roleConf.label}
                    </span>
                  )}
                  {canManage && m.role !== 'OWNER' && m.user.id !== undefined && (
                    <button
                      onClick={() => handleRemove(m.user.id)}
                      disabled={actionLoading === m.user.id}
                      className="text-slate-300 hover:text-red-500 transition-colors"
                    >
                      {actionLoading === m.user.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Pending invitations */}
        {org.invitations?.length > 0 && (
          <div className="mb-6">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Pending Invitations</h3>
            <div className="space-y-2">
              {org.invitations.map((inv: any) => (
                <div key={inv.id} className="flex items-center justify-between p-3 bg-amber-50 rounded-xl border border-amber-100">
                  <div className="flex items-center gap-3">
                    <Mail size={16} className="text-amber-500" />
                    <div>
                      <p className="text-sm font-semibold text-slate-700">{inv.email}</p>
                      <p className="text-[10px] text-amber-600">Invited as {inv.role.toLowerCase()} &middot; Expires {new Date(inv.expiresAt).toLocaleDateString()}</p>
                    </div>
                  </div>
                  {canManage && (
                    <button
                      onClick={() => handleRevokeInvite(inv.id)}
                      disabled={actionLoading === inv.id}
                      className="text-amber-400 hover:text-red-500 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Invite form */}
        {canManage && (
          <div className="mb-6">
            <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2">Invite Team Member</h3>
            <div className="flex gap-2">
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder="Email address"
                className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                onKeyDown={e => e.key === 'Enter' && handleInvite()}
              />
              <select
                value={inviteRole}
                onChange={e => setInviteRole(e.target.value as 'ADMIN' | 'MEMBER')}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
              >
                <option value="MEMBER">Member</option>
                {isOwner && <option value="ADMIN">Admin</option>}
              </select>
              <button
                onClick={handleInvite}
                disabled={inviting || !inviteEmail.trim()}
                className="px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                {inviting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
                Invite
              </button>
            </div>
            {inviteLink && (
              <div className="mt-3 flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">
                <span className="text-xs text-emerald-700 flex-1 truncate">{inviteLink}</span>
                <button onClick={copyLink} className="text-emerald-600 hover:text-emerald-800 transition-colors shrink-0">
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-2">
          {isOwner && (
            <button onClick={handleDeleteOrg} className="text-xs text-red-500 hover:text-red-700 font-semibold">
              Delete Team
            </button>
          )}
          {!isOwner && (
            <button onClick={handleLeave} className="text-xs text-red-500 hover:text-red-700 font-semibold">
              Leave Team
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
