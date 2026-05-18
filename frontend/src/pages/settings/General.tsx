import { useEffect, useState } from 'react';
import { Building, Bell, Mail, Smartphone, Info } from 'lucide-react';
import {
  SettingCard, FieldRow, Dropdown, FooterBanner,
} from '../../components/automation/ui';
import { useAuthStore } from '../../store/authStore';

export function SettingsGeneral() {
  const user = useAuthStore(s => s.user);
  const [business, setBusiness] = useState<string>((user as any)?.businessName || user?.name || '');
  const [tz, setTz] = useState<string>('America/New_York');
  const [industry, setIndustry] = useState<string>('Cleaning & home services');

  // Keep local state synced if auth user updates after mount
  useEffect(() => {
    if (!business && ((user as any)?.businessName || user?.name)) {
      setBusiness((user as any)?.businessName || user?.name || '');
    }
  }, [user, business]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
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
