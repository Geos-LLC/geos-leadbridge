import type { ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Building, Phone, CalendarClock, Users, Plug, CreditCard, Share2, BookOpen, FileText, Check,
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
import { SettingsServices } from './Services';
import { MessageSettings } from '../MessageSettings';

type TabKey =
  | 'general' | 'communication' | 'hours' | 'ai-playbook'
  | 'templates' | 'team' | 'accounts' | 'billing' | 'partner-network'
  | 'services';

// 'services' was a top-level sidebar tab through PR-B.1. In PR-D it
// becomes a section inside General → Services Offered, and the AI
// Playbook Service tabs hold the full service playbook content (pricing
// + FAQ + qualification editors). The route + tab handler below stay
// alive so existing `?tab=services` deep links and the standalone
// SettingsServices page keep working — they're just not in the sidebar
// any more. Direct URL access surfaces a deep-link banner at the top of
// the legacy Services page nudging users to General.
const TABS: { key: TabKey; label: string; icon: LucideIcon; sublabel: string; beta?: true }[] = [
  { key: 'general',         label: 'General',           icon: Building,      sublabel: 'Profile, services & timezone' },
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
  services: 'Per-service configuration — pricing, FAQ, and qualification questions. Create profiles from curated presets.',
  templates: 'Pre-written messages used when you choose Custom Template instead of AI in your automation settings.',
  team: 'People who can use Leadbridge and what they can do.',
  accounts: 'Manage Thumbtack, Yelp, Angi and other connected sources.',
  billing: 'Plan, payment method, and invoices.',
  'partner-network': 'Refer leads between businesses with QR codes, intent forms, and lead-value tracking. Beta.',
};

export default function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = (searchParams.get('tab') as TabKey | null) ?? 'general';
  // `services` is no longer in TABS but the route stays accessible via
  // ?tab=services (legacy deep links + a "Manage services" link from
  // the General → Services Offered section). All other unknown tabs
  // still fall back to General.
  const KNOWN_TABS = new Set<TabKey>([...TABS.map(t => t.key), 'services']);
  const tab: TabKey = KNOWN_TABS.has(tabParam) ? tabParam : 'general';
  const setTab = (next: TabKey) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('tab', next);
    setSearchParams(sp, { replace: true });
  };
  // Tabs hidden from the sidebar still render the same page chrome —
  // borrow the meta off the closest sibling so the AutoPageHeader does
  // not blow up when `?tab=services` lands here from a deep link.
  const meta =
    TABS.find(t => t.key === tab) ??
    (tab === 'services'
      ? { key: 'services' as TabKey, label: 'Services', icon: Building, sublabel: 'Per-service config' }
      : TABS[0]);

  let body: ReactNode = null;
  switch (tab) {
    case 'general':         body = <SettingsGeneral />; break;
    case 'communication':   body = <SettingsCommunication />; break;
    case 'hours':           body = <SettingsHours />; break;
    case 'ai-playbook':     body = <SettingsAiPlaybook />; break;
    case 'services':        body = <SettingsServices />; break;
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
        headerActions={
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 11px',
              borderRadius: 999,
              background: 'var(--lb-success-tint)',
              color: 'var(--lb-success)',
              border: '1px solid #a7f3d0',
              fontSize: 12,
              fontWeight: 600,
            }}
            title="Settings auto-save as you make changes."
          >
            <Check size={13} />
            Saved
          </span>
        }
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
    <div
      className="lb-settings-tabs"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        background: 'var(--lb-surface)',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        padding: 5,
        boxShadow: 'var(--lb-shadow-sm)',
        marginBottom: 22,
      }}
    >
      {TABS.map(t => {
        const active = value === t.key;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            title={t.sublabel}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 12px',
              borderRadius: 8,
              background: active ? 'var(--lb-accent-tint)' : 'transparent',
              border: 0,
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: active ? 700 : 600,
              color: active ? 'var(--lb-accent)' : 'var(--lb-ink-4)',
              transition: 'background 120ms, color 120ms',
              flexShrink: 0,
            }}
          >
            <Icon size={14} />
            <span>{t.label}</span>
            {t.beta && (
              <span
                style={{
                  fontSize: 9,
                  fontWeight: 700,
                  letterSpacing: 0.06,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#ede9fe',
                  color: '#6d28d9',
                  textTransform: 'uppercase',
                }}
              >
                Beta
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
