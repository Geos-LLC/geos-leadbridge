import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { useAuthStore } from '../../store/authStore';
import { useSelectedAccount } from '../../hooks/useSelectedAccount';
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
  // Account scope is shared with the sidebar account switcher (zustand
  // persisted store), so picking an account here updates the sidebar pill
  // and vice versa. The inline <AccountTabs> strip and the sidebar dropdown
  // are two surfaces on the same selection. The legacy
  // `lb_automation_scope` localStorage key is migrated once on mount so
  // existing users don't lose their last pick.
  const { selectedAccountId, setSelectedAccountId } = useSelectedAccount();
  const accountId: string = selectedAccountId ?? ALL_ACCOUNTS;
  const onChangeScope = (id: string) => {
    setSelectedAccountId(id === ALL_ACCOUNTS ? null : id);
  };
  useEffect(() => {
    if (selectedAccountId !== null) return;
    const legacy = localStorage.getItem('lb_automation_scope');
    if (!legacy || legacy === ALL_ACCOUNTS) return;
    if (storedAccounts.some(a => a.id === legacy)) {
      setSelectedAccountId(legacy);
    }
    localStorage.removeItem('lb_automation_scope');
  // Run once after the accounts list hydrates — comparison against
  // storedAccounts guards against pinning a stale id.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storedAccounts.length]);

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
    <div className="lb-pad" style={{ padding: '24px 28px 56px', maxWidth: 1320, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
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
