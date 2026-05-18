import { useEffect, useState } from 'react';
import { Building, Bell, Mail, Smartphone, Info, Loader2 } from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';
import { usersApi, authApi } from '../../services/api';

export function SettingsGeneral() {
  const user = useAuthStore(s => s.user);
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);

  const [business, setBusiness] = useState<string>((user as any)?.businessName || user?.name || '');
  const [tz, setTz] = useState<string>('America/New_York');
  const [industry, setIndustry] = useState<string>('Cleaning & home services');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Pull timezone from business-hours endpoint (single source of truth).
  useEffect(() => {
    let alive = true;
    setLoading(true);
    usersApi.getBusinessHours()
      .then(bh => { if (alive && bh.timezone) setTz(bh.timezone); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!business && ((user as any)?.businessName || user?.name)) {
      setBusiness((user as any)?.businessName || user?.name || '');
    }
  }, [user, business]);

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // Persist business name via the user profile endpoint.
      await usersApi.updateProfile({ name: business });
      // Persist timezone via the business-hours endpoint (canonical home for tz).
      await usersApi.updateBusinessHours({ timezone: tz });
      // Refresh cached auth user so the rest of the app sees the new name.
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) setAuth(u, token);
        } catch { /* silent */ }
      }
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
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
      {savedAt && !error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-success-tint)', color: 'var(--lb-success)',
          fontSize: 13, fontWeight: 600,
        }}>Saved.</div>
      )}

      <SettingCard
        icon={Building}
        iconTone="violet"
        title="Business profile"
        subtitle="How your business shows up in customer replies and notifications."
        contentPad="8px 24px 24px"
      >
        <FieldRow label="Business name">
          <SettingsInput value={business} onChange={setBusiness} />
        </FieldRow>
        <FieldRow label="Industry">
          <Dropdown
            value={industry}
            onChange={setIndustry}
            width="100%"
            options={[
              'Cleaning & home services',
              'Lawn care & landscaping',
              'Handyman & repair',
              'Pest control',
              'Other',
            ]}
          />
        </FieldRow>
        <FieldRow label="Timezone" noBorder>
          {loading ? (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-5)', fontSize: 13 }}>
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          ) : (
            <Dropdown
              value={tz}
              onChange={setTz}
              width="100%"
              options={[
                'America/New_York',
                'America/Chicago',
                'America/Denver',
                'America/Los_Angeles',
                'America/Phoenix',
              ]}
            />
          )}
        </FieldRow>
      </SettingCard>

      <SettingCard
        icon={Bell}
        iconTone="orange"
        title="Notifications"
        subtitle="How and where Leadbridge pings you about activity."
        contentPad="8px 24px 24px"
      >
        <NotifRow label="New lead arrived" desc="When a new lead lands from any source." defaultChannels={{ email: true, sms: true, push: true }} />
        <NotifRow label="AI handed off to you" desc="AI marked the conversation as needing human attention." defaultChannels={{ email: true, sms: true, push: false }} />
        <NotifRow label="Customer agreed on price" desc="A lead replied with a yes on the quote." defaultChannels={{ email: true, sms: false, push: true }} />
        <NotifRow label="Job booked" desc="A lead converted to a booked job." defaultChannels={{ email: true, sms: false, push: true }} noBorder />
      </SettingCard>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
            background: 'var(--lb-accent)', color: 'white',
            border: 0, borderRadius: 10,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: saving ? 0.7 : 1,
          }}
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>

      <FooterBanner icon={Info} body="Account-level changes apply across all your connected sources." />
    </div>
  );
}

function NotifRow({
  label, desc, defaultChannels, noBorder,
}: {
  label: string;
  desc: string;
  defaultChannels: { email: boolean; sms: boolean; push: boolean };
  noBorder?: boolean;
}) {
  const [ch, setCh] = useState(defaultChannels);
  const set = (k: keyof typeof ch) => setCh(c => ({ ...c, [k]: !c[k] }));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 16,
      padding: '14px 0',
      borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{label}</div>
        <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>{desc}</div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <ChannelChip icon="mail"    label="Email" on={ch.email} onClick={() => set('email')} />
        <ChannelChip icon="phone"   label="SMS"   on={ch.sms}   onClick={() => set('sms')} />
        <ChannelChip icon="bell"    label="Push"  on={ch.push}  onClick={() => set('push')} />
      </div>
    </div>
  );
}

function ChannelChip({ icon, label, on, onClick }: { icon: 'mail' | 'phone' | 'bell'; label: string; on: boolean; onClick: () => void }) {
  const Icon = icon === 'mail' ? Mail : icon === 'phone' ? Smartphone : Bell;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        padding: '5px 10px', borderRadius: 999,
        background: on ? '#eff6ff' : 'white',
        border: '1px solid ' + (on ? 'var(--lb-accent)' : 'var(--lb-line)'),
        color: on ? 'var(--lb-accent)' : 'var(--lb-ink-5)',
        fontFamily: 'inherit', fontSize: 11.5, fontWeight: 600,
        cursor: 'pointer', transition: 'all 120ms',
      }}
    >
      <Icon size={11} />
      {label}
    </button>
  );
}

function SettingsInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <input
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
      style={{
        width: '100%', padding: '9px 12px',
        border: '1px solid var(--lb-line)', borderRadius: 8,
        fontSize: 13, fontFamily: 'inherit',
        background: 'white', color: 'var(--lb-ink-1)',
        outline: 'none',
      }}
    />
  );
}
