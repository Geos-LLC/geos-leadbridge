import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { followUpApi } from '../../services/api';
import { useAppStore } from '../../store/appStore';
import { ALL_ACCOUNTS } from './AccountTabs';

export type PlanKey = 'respond' | 'engage' | 'convert';

interface PlanDef {
  key: PlanKey;
  label: string;
  dot: string;
  route: string;
}

const PLANS: PlanDef[] = [
  { key: 'respond', label: 'First Reply',     dot: '#16a34a', route: '/automation/respond' },
  { key: 'engage',  label: 'Follow-ups',      dot: '#7c3aed', route: '/automation/engage'  },
  { key: 'convert', label: 'AI Conversation', dot: '#2563eb', route: '/automation/convert' },
];

// 32x18 mini toggle (track 32, thumb 13)
function MiniToggle({
  on, onClick, disabled, title,
}: {
  on: boolean;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: 32, height: 18, borderRadius: 999,
        background: on ? 'var(--lb-accent)' : '#cbd5e1',
        border: 0, padding: 0,
        cursor: disabled ? 'not-allowed' : 'pointer',
        position: 'relative', flexShrink: 0,
        transition: 'background 160ms ease',
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <span
        style={{
          position: 'absolute', top: 2.5,
          left: on ? 16.5 : 2.5,
          width: 13, height: 13,
          borderRadius: 99, background: 'white',
          transition: 'left 160ms ease',
          boxShadow: '0 1px 2px rgba(0,0,0,0.18)',
        }}
      />
    </button>
  );
}

export function PlanSwitcher({ active, accountId }: { active: PlanKey; accountId: string }) {
  const navigate = useNavigate();
  const authUser = useAuthStore(s => s.user);
  const authToken = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const accounts = useAppStore(s => s.savedAccounts);

  // AI Conversation master — single source of truth on User. Live-wired.
  // First Reply + Follow-ups master enables live in per-plan/per-account
  // surfaces (NotificationRule / CallConnectSettings / followUpsEnabled
  // inside followUpSettingsJson). Wiring them into the shell requires
  // lifting state out of each plan page — deferred. Their toggles render
  // disabled with a tooltip directing the user to open the plan page.
  const aiOn = !!authUser?.aiConversationEnabled;

  const onToggleAi = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!authUser || !authToken) return;
    const next = !aiOn;
    // Optimistic store update; the plan page's own toggle does the API write
    // when navigated to. Here we only flip the store flag so the dot reflects.
    setAuth({ ...authUser, aiConversationEnabled: next }, authToken);
    try {
      const targetId = accountId !== ALL_ACCOUNTS ? accountId : accounts[0]?.id;
      if (targetId) {
        await followUpApi.saveSettings(targetId, { aiConversationEnabled: next } as any);
      }
    } catch {
      // Rollback on failure
      setAuth({ ...authUser, aiConversationEnabled: !next }, authToken);
    }
  };

  return (
    <div
      className="lb-plan-switcher"
      style={{
        display: 'flex',
        gap: 6,
        background: 'var(--lb-surface)',
        border: '1px solid var(--lb-line)',
        borderRadius: 12,
        padding: 5,
        boxShadow: 'var(--lb-shadow-sm)',
        marginBottom: 12,
      }}
    >
      {PLANS.map(p => {
        const isActive = p.key === active;
        const isConvert = p.key === 'convert';
        const on = isConvert ? aiOn : false;
        return (
          <div
            key={p.key}
            className="lb-plan-segment"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 8,
              background: isActive ? 'var(--lb-accent-tint)' : 'transparent',
              flex: 1,
              minWidth: 0,
            }}
          >
            <button
              type="button"
              onClick={() => navigate(p.route)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                flex: 1,
                minWidth: 0,
                background: 'transparent',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 13,
                fontWeight: isActive ? 700 : 600,
                color: isActive ? 'var(--lb-accent)' : 'var(--lb-ink-3)',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  width: 7, height: 7, borderRadius: 999,
                  background: p.dot,
                  flexShrink: 0,
                }}
              />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.label}
              </span>
            </button>
            <MiniToggle
              on={!!on}
              disabled={!isConvert}
              onClick={isConvert ? onToggleAi : undefined}
              title={
                isConvert
                  ? `Turn ${aiOn ? 'off' : 'on'} AI Conversation`
                  : `Open ${p.label} to change its master toggle`
              }
            />
          </div>
        );
      })}
    </div>
  );
}
