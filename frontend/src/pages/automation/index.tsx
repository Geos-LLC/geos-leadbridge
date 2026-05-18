import { useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { AutoPageHeader, type BadgeTone } from '../../components/automation/ui';
import { AccountTabs, ScopeBanner, ALL_ACCOUNTS } from '../../components/automation/AccountTabs';
import { useBackLink } from '../../components/automation/useBackLink';
import { AutomationRespond } from './Respond';
import { AutomationFollowups } from './Followups';
import { AutomationConversation } from './Conversation';

type SubTab = 'respond' | 'engage' | 'convert';

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
  convert: {
    title: 'AI Conversation',
    subtitle: 'Let the system continue the conversation based on previous messages.',
    badge: { label: 'Convert', tone: 'blue' },
  },
};

function pathToTab(path: string): SubTab {
  if (path.endsWith('/engage')) return 'engage';
  if (path.endsWith('/convert')) return 'convert';
  return 'respond';
}

export function AutomationPage() {
  const location = useLocation();
  const tab = pathToTab(location.pathname);
  const meta = META[tab];
  const backLink = useBackLink();

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
        backLink={backLink || undefined}
      />
      <AccountTabs value={accountId} onChange={onChangeScope} accounts={storedAccounts} />
      <ScopeBanner accountId={accountId} accounts={storedAccounts} />

      {tab === 'respond' && <AutomationRespond accountId={accountId} />}
      {tab === 'engage'  && <AutomationFollowups accountId={accountId} />}
      {tab === 'convert' && <AutomationConversation accountId={accountId} />}
    </div>
  );
}

export default AutomationPage;
