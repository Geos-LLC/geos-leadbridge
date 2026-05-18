import { useState } from 'react';
import {
  Phone, PhoneCall, MessageSquare, Reply, Shield, Bell, FileText, Check, Zap,
} from 'lucide-react';
import {
  SettingCard, FieldRow, InfoTile, Checkbox, ActionLink,
} from '../../components/automation/ui';

export function SettingsCommunication() {
  const [twoWay, setTwoWay] = useState(true);
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
          <PhoneTile number="—" label="Set your business phone in profile" verified />
        </FieldRow>
        <FieldRow icon={PhoneCall} iconTone="blue" label="Leadbridge number" sublabel="The number Leadbridge texts customers from." noBorder>
          <PhoneTile number="—" label="Provisioned by Leadbridge" leadbridge />
        </FieldRow>
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
            checked
            onChange={() => { /* TODO wire */ }}
            label="Route customer SMS replies into the lead's thread"
            sublabel="Replies appear in Lead Activity and trigger automation."
          />
        </FieldRow>
        <FieldRow icon={Shield} iconTone="orange" label="STOP / HELP" sublabel="Compliance keywords required for SMS." noBorder>
          <Checkbox
            checked
            onChange={() => { /* TODO wire */ }}
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
            title="TT - Ready to Book Alert"
            body="Lead is ready to book a job. Phone: {customerPhone}…"
            actionLabel="Edit Template"
          />
        </FieldRow>
        <FieldRow icon={FileText} iconTone="violet" label="Wants live contact" noBorder>
          <InfoTile
            title="TT - Live Contact Alert"
            body="Lead wants to talk to a person. Reach them at {customerPhone}…"
            actionLabel="Edit Template"
          />
        </FieldRow>
      </SettingCard>
    </div>
  );
}

function PhoneTile({
  number, label, verified, leadbridge,
}: {
  number: string;
  label: string;
  verified?: boolean;
  leadbridge?: boolean;
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
      <ActionLink>Edit</ActionLink>
    </div>
  );
}
