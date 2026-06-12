import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building, Phone, CalendarClock, Users, Plug, CreditCard, Share2, BookOpen, FileText,
  type LucideIcon,
} from 'lucide-react';
import { AutoPageHeader } from '../../components/automation/ui';
import { SettingsGeneral } from './General';
import { SettingsCommunication } from './Communication';
import { SettingsHours } from './Hours';
import { SettingsTeam } from './Team';
import { SettingsAccounts } from './Accounts';
import { SettingsBilling } from './Billing';
import { SettingsPartnerNetwork } from './PartnerNetwork';
import { SettingsAiPlaybook } from './AiPlaybook';
import { MessageSettings } from '../MessageSettings';

type TabKey =
  | 'general' | 'communication' | 'hours' | 'ai-playbook'
  | 'templates' | 'team' | 'accounts' | 'billing' | 'partner-network';

const TABS: { key: TabKey; label: string; icon: LucideIcon; sublabel: string; beta?: true }[] = [
  { key: 'general',         label: 'General',           icon: Building,      sublabel: 'Profile & timezone' },
  { key: 'communication',   label: 'Communication',     icon: Phone,         sublabel: 'Phone & SMS' },
  { key: 'hours',           label: 'Business Hours',    icon: CalendarClock, sublabel: "When you're open" },
  { key: 'ai-playbook',     label: 'AI Playbook',       icon: BookOpen,      sublabel: 'How AI communicates' },
  { key: 'templates',       label: 'Templates',         icon: FileText,      sublabel: 'Pre-written messages' },
  { key: 'team',            label: 'Team',              icon: Users,         sublabel: 'Members & roles' },
  { key: 'accounts',        label: 'Connected Sources', icon: Plug,          sublabel: 'Thumbtack, Yelp, Angi' },
  { key: 'billing',         label: 'Billing',           icon: CreditCard,    sublabel: 'Plan & invoices' },
  // Tucked away in Settings while in beta. Has its own internal sub-nav for
  // Dashboard / Businesses / Relationships / Referral codes / Leads.
  { key: 'partner-network', label: 'Partner Network',   icon: Share2,        sublabel: 'Referral partners', beta: true },
];

const SUBTITLES: Record<TabKey, string> = {
  general: 'Your business profile and basic preferences.',
  communication: 'Phone numbers, notifications and alert routing.',
  hours: "When you're open, and how Leadbridge behaves outside hours.",
  'ai-playbook': 'Define how AI communicates with customers. Timing, automation, follow-ups, stop rules, and notifications are configured in Automation settings.',
  templates: 'Pre-written messages used when you choose Custom Template instead of AI in your automation settings.',
  team: 'People who can use Leadbridge and what they can do.',
  accounts: 'Manage Thumbtack, Yelp, Angi and other connected sources.',
  billing: 'Plan, payment method, and invoices.',
  'partner-network': 'Refer leads between businesses with QR codes, intent forms, and lead-value tracking. Beta.',
};

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = (searchParams.get('tab') as TabKey | null) ?? 'general';
  const tab: TabKey = TABS.some(t => t.key === tabParam) ? tabParam : 'general';
  const setTab = (next: TabKey) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };
  const meta = TABS.find(t => t.key === tab)!;

  let body: ReactNode = null;
  switch (tab) {
    case 'general':         body = <SettingsGeneral />; break;
    case 'communication':   body = <SettingsCommunication />; break;
    case 'hours':           body = <SettingsHours />; break;
    case 'ai-playbook':     body = <SettingsAiPlaybook />; break;
    case 'templates':       body = <SettingsTemplates />; break;
    case 'team':            body = <SettingsTeam />; break;
    case 'accounts':        body = <SettingsAccounts />; break;
    case 'billing':         body = <SettingsBilling />; break;
    case 'partner-network': body = <SettingsPartnerNetwork />; break;
  }

  return (
    <div style={{ padding: '20px 28px 60px', maxWidth: 1180, margin: '0 auto' }}>
      <AutoPageHeader
        title={meta.label}
        badge={{ label: 'Settings', tone: 'blue' }}
        subtitle={SUBTITLES[tab]}
      />

      <SettingsTabs value={tab} onChange={setTab} />

      {body}
    </div>
  );
}

/**
 * Renders the existing /templates page inline inside the Settings layout.
 * MessageSettings has its own outer padding (p-6 lg:p-10) and a 5xl
 * max-width — the negative-margin wrapper cancels the Settings page's
 * own outer padding so we don't end up with double-padded content.
 * The /templates standalone route stays intact for direct deep-links
 * (Edit Template buttons scattered through the Automation pages).
 */
function SettingsTemplates() {
  return (
    <div style={{ marginLeft: -28, marginRight: -28 }}>
      <MessageSettings />
    </div>
  );
}

function SettingsTabs({ value, onChange }: { value: TabKey; onChange: (k: TabKey) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-end', gap: 2,
      borderBottom: '1px solid var(--lb-line)',
      marginBottom: 22,
      overflowX: 'auto',
      paddingBottom: 1,
    }}>
      {TABS.map(t => {
        const active = value === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px 12px',
              background: 'transparent',
              border: 0,
              borderBottom: '2px solid ' + (active ? 'var(--lb-accent)' : 'transparent'),
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: active ? 'var(--lb-ink-1)' : 'var(--lb-ink-5)',
              transition: 'color 120ms, border-color 120ms',
              marginBottom: -1,
              flexShrink: 0,
            }}
          >
            <Icon size={14} style={{ color: active ? 'var(--lb-accent)' : 'var(--lb-ink-6)' }} />
            <div style={{ textAlign: 'left' }}>
              <div style={{
                fontSize: 13, fontWeight: active ? 700 : 500, lineHeight: 1.2,
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}>
                {t.label}
                {t.beta && (
                  <span style={{
                    fontSize: 9, fontWeight: 700, letterSpacing: 0.06,
                    padding: '1px 5px', borderRadius: 4,
                    background: '#ede9fe', color: '#6d28d9',
                    textTransform: 'uppercase',
                  }}>Beta</span>
                )}
              </div>
              <div style={{
                fontSize: 10.5, color: 'var(--lb-ink-6)', marginTop: 2,
                fontFamily: 'var(--lb-font-mono)', letterSpacing: 0.04,
                textTransform: 'uppercase', fontWeight: 500,
              }}>
                {t.sublabel}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
