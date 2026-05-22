import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Phone, PhoneCall, MessageSquare, Reply, Shield, Bell, FileText, Check, Zap, Loader2, Building2, Pencil, X, AlertCircle,
} from 'lucide-react';
import {
  SettingCard, FieldRow, InfoTile, Checkbox, ActionLink,
} from '../../components/automation/ui';
import { usersApi, templatesApi, thumbtackApi, notificationsApi, type TenantPhoneNumber } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import type { MessageTemplate, SavedAccount } from '../../types';

function formatPhone(e164: string | null): string {
  if (!e164) return '—';
  // +18139212100 → +1 (813) 921-2100
  const m = /^\+?1?(\d{3})(\d{3})(\d{4})$/.exec(e164.replace(/\D/g, ''));
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export function SettingsCommunication() {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'Settings · Communication' };
  const user = useAuthStore(s => s.user) as any;
  const [leadBridgeNumber, setLeadBridgeNumber] = useState<string | null>(null);
  const [loadingPhone, setLoadingPhone] = useState(true);
  const [twoWay, setTwoWay] = useState(true);
  const [routeReplies, setRouteReplies] = useState(true);
  const [honorStop, setHonorStop] = useState(true);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [loadingPerBusiness, setLoadingPerBusiness] = useState(true);
  const [editingOverrideId, setEditingOverrideId] = useState<string | null>(null);
  const [overrideValue, setOverrideValue] = useState('');
  const [savingOverrideId, setSavingOverrideId] = useState<string | null>(null);
  const [overrideError, setOverrideError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      usersApi.getMyPhoneNumber().catch(() => ({ phoneNumber: null as string | null, allocationId: null, hasPhoneNumber: false })),
      templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[], count: 0 })),
      thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
      notificationsApi.listTenantPhones().catch(() => ({ success: false, data: [] as TenantPhoneNumber[] })),
    ]).then(([phoneRes, tplRes, acctRes, tpnRes]) => {
      if (!alive) return;
      setLeadBridgeNumber(phoneRes.phoneNumber);
      setTemplates(tplRes.templates || []);
      setAccounts(acctRes.accounts || []);
      setTenantPhones((tpnRes.data || []).filter((p: TenantPhoneNumber) => p.status === 'ACTIVE'));
    }).finally(() => {
      if (!alive) return;
      setLoadingPhone(false);
      setLoadingPerBusiness(false);
    });
    return () => { alive = false; };
  }, []);

  // Conventional alert template names — match what TemplateEditorModal seeds.
  const findTpl = (...candidates: string[]): MessageTemplate | undefined => {
    for (const name of candidates) {
      const exact = templates.find(t => t.name === name);
      if (exact) return exact;
    }
    // Loose match — first template whose name contains every candidate token.
    const tokens = candidates.flatMap(c => c.toLowerCase().split(/[\s\-]+/));
    return templates.find(t => {
      const lower = t.name.toLowerCase();
      return tokens.every(tok => lower.includes(tok));
    });
  };
  const readyToBookTpl = findTpl('Ready to Book Alert', 'TT - Ready to Book Alert', 'AI Ready to Book Alert', 'ready book');
  const liveContactTpl = findTpl('Live Contact Alert', 'TT - Live Contact Alert', 'AI Live Contact Alert', 'live contact');

  const businessPhone = (user?.businessPhone as string | null | undefined) ?? null;
  const goEditProfile = () => navigate('/settings?tab=general');

  function toE164(raw: string): string {
    const digits = (raw || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10) return '+1' + digits;
    if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
    return raw.trim().startsWith('+') ? raw.trim() : '+' + digits;
  }
  function isValidE164(value: string): boolean {
    return /^\+[1-9]\d{7,14}$/.test(value);
  }

  async function handleSaveOverride(accountId: string) {
    setOverrideError(null);
    const trimmed = overrideValue.trim();
    // Empty → clear override (inherit User.businessPhone).
    // Equal to tenant default → also clear; storing the same number as the
    // default is just noise and the resolver falls through to it anyway.
    let value: string | null;
    if (!trimmed) {
      value = null;
    } else {
      const e164 = toE164(trimmed);
      if (!isValidE164(e164)) {
        setOverrideError('Phone must be E.164 (e.g. +12125550100)');
        return;
      }
      value = (businessPhone && e164 === businessPhone) ? null : e164;
    }
    setSavingOverrideId(accountId);
    try {
      await thumbtackApi.updateSavedAccount(accountId, { agentPhoneOverride: value });
      setAccounts(prev => prev.map(a => a.id === accountId ? { ...a, agentPhoneOverride: value } : a));
      setEditingOverrideId(null);
      setOverrideValue('');
    } catch (err: any) {
      setOverrideError(err?.response?.data?.message || err?.message || 'Failed to save');
    } finally {
      setSavingOverrideId(null);
    }
  }

  const goTemplate = (tpl: MessageTemplate | undefined) => {
    const params = new URLSearchParams();
    if (tpl) {
      params.set('highlight', tpl.id);
      params.set('filter', tpl.type === 'prompt' ? 'prompts' : 'alerts');
    } else {
      params.set('filter', 'alerts');
    }
    navigate(`/templates?${params.toString()}`, { state: fromState });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <SettingCard
        icon={Phone}
        iconTone="violet"
        title="Phone numbers"
        subtitle="Numbers Leadbridge uses to send and receive calls and texts."
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Phone} iconTone="violet" label="Business phone" sublabel="Where lead calls forward when bridged.">
          <PhoneTile
            number={formatPhone(businessPhone)}
            label={businessPhone ? 'Primary' : 'Set your business phone in profile'}
            verified={!!businessPhone}
            onEdit={goEditProfile}
          />
        </FieldRow>
        <FieldRow icon={PhoneCall} iconTone="blue" label="Leadbridge number" sublabel="The number Leadbridge texts customers from." noBorder>
          {loadingPhone ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <PhoneTile
              number={formatPhone(leadBridgeNumber)}
              label={leadBridgeNumber ? 'Provisioned by Leadbridge' : 'No dedicated number yet'}
              leadbridge
              onEdit={goEditProfile}
            />
          )}
        </FieldRow>
      </SettingCard>

      <SettingCard
        icon={Building2}
        iconTone="blue"
        title="Per business"
        subtitle="Which LeadBridge number and alert phone each connected source uses."
        contentPad="8px 24px 24px"
      >
        {loadingPerBusiness ? (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13, padding: '12px 0' }}>
            <Loader2 size={14} className="animate-spin" /> Loading…
          </div>
        ) : accounts.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', padding: '12px 0' }}>
            No connected sources yet. Connect Thumbtack, Yelp or Angi from the
            {' '}<ActionLink onClick={() => navigate('/settings?tab=accounts')}>Connected Sources</ActionLink> tab.
          </div>
        ) : (
          accounts.map((acct, idx) => {
            // Mirror backend resolveBotPhone: account-scoped → unassigned → any active TPN.
            // When only one number exists tenant-wide, it serves every business as "Shared".
            const assignedPhone = tenantPhones.find(p => p.savedAccountId === acct.id)
              || tenantPhones.find(p => !p.savedAccountId)
              || tenantPhones[0]
              || null;
            const lbShared = !!assignedPhone && assignedPhone.savedAccountId !== acct.id;
            const alertPhone = acct.agentPhoneOverride || businessPhone;
            const usingOverride = !!acct.agentPhoneOverride;
            return (
              <FieldRow
                key={acct.id}
                icon={Building2}
                iconTone={acct.platform === 'yelp' ? 'orange' : 'blue'}
                label={acct.businessName}
                sublabel={acct.platform.charAt(0).toUpperCase() + acct.platform.slice(1)}
                align="top"
                noBorder={idx === accounts.length - 1}
              >
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                  <PerBusinessTile
                    icon={PhoneCall}
                    label="LeadBridge number"
                    value={assignedPhone ? formatPhone(assignedPhone.phoneNumber) : 'Not assigned'}
                    badge={!assignedPhone ? null : lbShared ? { text: 'Shared', tone: 'slate' } : { text: 'Dedicated', tone: 'blue' }}
                    muted={!assignedPhone}
                  />
                  {editingOverrideId === acct.id ? (
                    <AlertPhoneEditor
                      value={overrideValue}
                      onChange={setOverrideValue}
                      onSave={() => handleSaveOverride(acct.id)}
                      onCancel={() => { setEditingOverrideId(null); setOverrideValue(''); setOverrideError(null); }}
                      saving={savingOverrideId === acct.id}
                      placeholder={businessPhone || '+12125550100'}
                      error={overrideError}
                    />
                  ) : (
                    <PerBusinessTile
                      icon={Phone}
                      label="Alert phone"
                      value={alertPhone ? formatPhone(alertPhone) : 'Not set'}
                      badge={!alertPhone ? null : usingOverride ? { text: 'Override', tone: 'amber' } : { text: 'Default', tone: 'slate' }}
                      muted={!alertPhone}
                      onEdit={() => {
                        setOverrideValue(acct.agentPhoneOverride || '');
                        setEditingOverrideId(acct.id);
                        setOverrideError(null);
                      }}
                    />
                  )}
                </div>
              </FieldRow>
            );
          })
        )}
      </SettingCard>

      <SettingCard
        icon={MessageSquare}
        iconTone="green"
        title="SMS"
        subtitle="How Leadbridge sends and receives text messages."
        enabled={twoWay}
        onToggle={setTwoWay}
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Reply} iconTone="green" label="Two-way SMS" sublabel="Customer replies route into Lead Activity.">
          <Checkbox
            checked={routeReplies}
            onChange={setRouteReplies}
            label="Route customer SMS replies into the lead's thread"
            sublabel="Replies appear in Lead Activity and trigger automation."
          />
        </FieldRow>
        <FieldRow icon={Shield} iconTone="orange" label="STOP / HELP" sublabel="Compliance keywords required for SMS." noBorder>
          <Checkbox
            checked={honorStop}
            onChange={setHonorStop}
            label="Automatically honor STOP, UNSUBSCRIBE and HELP"
            sublabel="Required by carriers. Customers who reply STOP won't receive further texts."
          />
        </FieldRow>
      </SettingCard>

      <SettingCard
        icon={Bell}
        iconTone="orange"
        title="AI Human Takeover Alerts"
        subtitle="Templates used when AI alerts your team. Referenced from Automation."
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={FileText} iconTone="violet" label="Ready to book">
          <InfoTile
            title={readyToBookTpl?.name || 'Ready to Book Alert'}
            body={readyToBookTpl?.content || 'Lead is ready to book a job. Phone: {customerPhone}…'}
            badge={readyToBookTpl?.type === 'prompt' ? { label: 'AI Prompt', tone: 'violet' } : { label: 'Template', tone: 'blue' }}
            tooltip={readyToBookTpl?.content || undefined}
            actionLabel={readyToBookTpl?.type === 'prompt' ? 'Edit Prompt' : 'Edit Template'}
            onAction={() => goTemplate(readyToBookTpl)}
          />
        </FieldRow>
        <FieldRow icon={FileText} iconTone="violet" label="Wants live contact" noBorder>
          <InfoTile
            title={liveContactTpl?.name || 'Live Contact Alert'}
            body={liveContactTpl?.content || 'Lead wants to talk to a person. Reach them at {customerPhone}…'}
            badge={liveContactTpl?.type === 'prompt' ? { label: 'AI Prompt', tone: 'violet' } : { label: 'Template', tone: 'blue' }}
            tooltip={liveContactTpl?.content || undefined}
            actionLabel={liveContactTpl?.type === 'prompt' ? 'Edit Prompt' : 'Edit Template'}
            onAction={() => goTemplate(liveContactTpl)}
          />
        </FieldRow>
      </SettingCard>
    </div>
  );
}

function PerBusinessTile({
  icon: Icon, label, value, badge, muted, onEdit,
}: {
  icon: typeof Phone;
  label: string;
  value: string;
  badge: { text: string; tone: 'blue' | 'amber' | 'slate' } | null;
  muted?: boolean;
  onEdit?: () => void;
}) {
  const tonePalette: Record<'blue' | 'amber' | 'slate', { bg: string; fg: string }> = {
    blue:  { bg: '#dbeafe', fg: '#1d4ed8' },
    amber: { bg: '#fef3c7', fg: '#b45309' },
    slate: { bg: '#f1f5f9', fg: '#475569' },
  };
  const tone = badge ? tonePalette[badge.tone] : null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '10px 12px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
      minWidth: 0,
    }}>
      <Icon size={14} style={{ color: 'var(--lb-ink-6)', flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13, fontWeight: 700,
          color: muted ? 'var(--lb-ink-5)' : 'var(--lb-ink-1)',
          fontFamily: 'var(--lb-font-mono)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        }}>
          {value}
        </div>
        <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 1 }}>{label}</div>
      </div>
      {badge && tone && (
        <span style={{
          padding: '2px 8px', borderRadius: 999,
          background: tone.bg, color: tone.fg,
          fontSize: 10.5, fontWeight: 600,
          whiteSpace: 'nowrap',
        }}>
          {badge.text}
        </span>
      )}
      {onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label="Edit"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 24, height: 24, padding: 0,
            background: 'transparent', border: 0,
            color: 'var(--lb-ink-6)', cursor: 'pointer',
            borderRadius: 6, flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.background = '#eef2f7'; e.currentTarget.style.color = 'var(--lb-ink-2)'; }}
          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--lb-ink-6)'; }}
        >
          <Pencil size={13} />
        </button>
      )}
    </div>
  );
}

function AlertPhoneEditor({
  value, onChange, onSave, onCancel, saving, placeholder, error,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  placeholder: string;
  error: string | null;
}) {
  return (
    <div style={{
      padding: '8px 10px',
      background: '#fffbeb',
      border: '1.5px solid #fcd34d',
      borderRadius: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <Phone size={14} style={{ color: '#b45309', flexShrink: 0 }} />
        <input
          type="tel"
          autoFocus
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') onSave();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder={placeholder}
          disabled={saving}
          style={{
            flex: 1, minWidth: 0,
            padding: '4px 6px',
            background: 'white',
            border: '1px solid #fcd34d',
            borderRadius: 6,
            fontSize: 13, fontFamily: 'var(--lb-font-mono)',
            color: 'var(--lb-ink-1)',
            outline: 'none',
          }}
        />
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          aria-label="Save"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0,
            background: '#16a34a', color: 'white', border: 0,
            borderRadius: 6, cursor: saving ? 'wait' : 'pointer', flexShrink: 0,
            opacity: saving ? 0.6 : 1,
          }}
        >
          {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={14} />}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          aria-label="Cancel"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 26, height: 26, padding: 0,
            background: 'white', color: 'var(--lb-ink-5)', border: '1px solid var(--lb-line)',
            borderRadius: 6, cursor: 'pointer', flexShrink: 0,
          }}
        >
          <X size={14} />
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', marginTop: 4, paddingLeft: 20 }}>
        {error ? (
          <span style={{ color: '#dc2626', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={11} /> {error}
          </span>
        ) : (
          'Leave empty to use the business default. E.164 format (+12125550100).'
        )}
      </div>
    </div>
  );
}

function PhoneTile({
  number, label, verified, leadbridge, onEdit,
}: {
  number: string;
  label: string;
  verified?: boolean;
  leadbridge?: boolean;
  onEdit?: () => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '12px 14px',
      background: '#f8fafc',
      border: '1px solid var(--lb-line-soft)',
      borderRadius: 10,
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', fontFamily: 'var(--lb-font-mono)' }}>{number}</div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>{label}</div>
      </div>
      {verified && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 9px', borderRadius: 999,
          background: '#dcfce7', color: '#16a34a',
          fontSize: 11, fontWeight: 600,
        }}>
          <Check size={10} /> Verified
        </span>
      )}
      {leadbridge && (
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '3px 9px', borderRadius: 999,
          background: '#dbeafe', color: '#2563eb',
          fontSize: 11, fontWeight: 600,
        }}>
          <Zap size={10} /> Leadbridge
        </span>
      )}
      <ActionLink onClick={onEdit}>Edit</ActionLink>
    </div>
  );
}
