import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { AutoPageHeader, type BadgeTone } from '../../components/automation/ui';
import { AccountTabs, ScopeBanner, ALL_ACCOUNTS } from '../../components/automation/AccountTabs';
import { PlanSwitcher } from '../../components/automation/PlanSwitcher';
import NoServiceOverlay from '../../components/NoServiceOverlay';
import { serviceProfilesApi } from '../../services/api';
import { AutomationRespond } from './Respond';
import { AutomationFollowups } from './Followups';
import { AutomationConversation } from './Conversation';

type SubTab = 'respond' | 'engage' | 'convert';

const META: Record<SubTab, { title: string; subtitle: string; badge: { label: string; tone: BadgeTone } }> = {
  respond: {
    title: 'First Reply',
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
    subtitle: 'Control when AI responds, follows up, hands off conversations, and sends notifications.',
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

  // Block Automation when the tenant has no active ServiceProfile —
  // qualification + pricing both read from service data, so the page
  // has nothing meaningful to configure without one. ADMIN role is
  // exempt (mirrors NoAccountsOverlay usage in Messages/Analytics).
  const [activeServiceCount, setActiveServiceCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    serviceProfilesApi.list()
      .then(res => {
        if (!alive) return;
        const activeCount = (res.profiles ?? []).filter(p => p.status === 'active').length;
        setActiveServiceCount(activeCount);
      })
      .catch(() => { if (alive) setActiveServiceCount(0); });
    return () => { alive = false; };
  }, []);
  const isAdmin = useAuthStore.getState().user?.role === 'ADMIN';
  const showNoServiceOverlay = activeServiceCount === 0 && !isAdmin;

  return (
    <div className="lb-pad" style={{ padding: '20px 28px 60px', maxWidth: 1180, margin: '0 auto' }}>
      <AutoPageHeader
        title={meta.title}
        badge={meta.badge}
        subtitle={meta.subtitle}
      />
      <PlanSwitcher active={tab} accountId={accountId} />
      <AccountTabs value={accountId} onChange={onChangeScope} accounts={storedAccounts} />
      <ScopeBanner accountId={accountId} accounts={storedAccounts} />

      {tab === 'respond' && <AutomationRespond accountId={accountId} />}
      {tab === 'engage'  && <AutomationFollowups accountId={accountId} />}
      {tab === 'convert' && <AutomationConversation accountId={accountId} />}

      {showNoServiceOverlay && <NoServiceOverlay />}
    </div>
  );
}

export default AutomationPage;
