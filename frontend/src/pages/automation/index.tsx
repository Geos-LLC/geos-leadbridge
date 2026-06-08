import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { AutoPageHeader, type BadgeTone } from '../../components/automation/ui';
import { AccountTabs, ScopeBanner, ALL_ACCOUNTS } from '../../components/automation/AccountTabs';
import { AutomationRespond } from './Respond';
import { AutomationFollowups } from './Followups';
import { AutomationConversation } from './Conversation';
import { AutomationPlaybook } from './Playbook';

type SubTab = 'respond' | 'engage' | 'playbook' | 'convert';

const META: Record<SubTab, { title: string; subtitle: string; badge: { label: string; tone: BadgeTone } }> = {
  respond: {
    title: 'When a Lead Arrives',
    subtitle: 'Choose what happens immediately when a new lead comes in.',
    badge: { label: 'Respond', tone: 'green' },
  },
  engage: {
    title: 'Follow-ups',
    subtitle: 'Automatically follow up with leads who stop responding.',
    badge: { label: 'Engage', tone: 'purple' },
  },
  playbook: {
    title: 'AI Playbook',
    subtitle: 'How AI should behave in common conversation moments — booking, defers, opt-outs, key details.',
    badge: { label: 'Playbook', tone: 'blue' },
  },
  convert: {
    title: 'AI Conversation (Advanced)',
    subtitle: 'Original AI Conversation settings — same data as the Playbook, technical grouping. Use the Playbook for day-to-day setup.',
    badge: { label: 'Advanced', tone: 'gray' },
  },
};

function pathToTab(path: string): SubTab {
  if (path.endsWith('/engage')) return 'engage';
  if (path.endsWith('/playbook')) return 'playbook';
  if (path.endsWith('/convert')) return 'convert';
  return 'respond';
}

export function AutomationPage() {
  const location = useLocation();
  const tab = pathToTab(location.pathname);
  const meta = META[tab];

  const storedAccounts = useAppStore(s => s.savedAccounts);
  // Remember the last picked account so navigating between sub-pages doesn't reset.
  const initialId = useMemo(() => {
    const last = localStorage.getItem('lb_automation_scope');
    if (last === ALL_ACCOUNTS) return ALL_ACCOUNTS;
    if (last && storedAccounts.some(a => a.id === last)) return last;
    return ALL_ACCOUNTS;
  }, [storedAccounts]);
  const [accountId, setAccountId] = useState<string>(initialId);
  const onChangeScope = (id: string) => {
    setAccountId(id);
    localStorage.setItem('lb_automation_scope', id);
  };

  return (
    <div style={{ padding: '20px 28px 60px', maxWidth: 1180, margin: '0 auto' }}>
      <AutoPageHeader
        title={meta.title}
        badge={meta.badge}
        subtitle={meta.subtitle}
      />
      <AccountTabs value={accountId} onChange={onChangeScope} accounts={storedAccounts} />
      <ScopeBanner accountId={accountId} accounts={storedAccounts} />

      {tab === 'respond'  && <AutomationRespond accountId={accountId} />}
      {tab === 'engage'   && <AutomationFollowups accountId={accountId} />}
      {tab === 'playbook' && <AutomationPlaybook accountId={accountId} />}
      {tab === 'convert'  && <AutomationConversation accountId={accountId} />}
    </div>
  );
}

export default AutomationPage;
