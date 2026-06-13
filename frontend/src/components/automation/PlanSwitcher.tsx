import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/authStore';
import { automationApi, followUpApi } from '../../services/api';
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

// 32x18 mini toggle (track 32, thumb 13) per spec 2a.
function MiniToggle({
  on, onClick, disabled, title, loading,
}: {
  on: boolean;
  onClick?: (e: React.MouseEvent) => void;
  disabled?: boolean;
  title?: string;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={onClick}
      disabled={disabled || loading}
      title={title}
      style={{
        width: 32, height: 18, borderRadius: 999,
        background: on ? 'var(--lb-accent)' : '#cbd5e1',
        border: 0, padding: 0,
        cursor: (disabled || loading) ? 'not-allowed' : 'pointer',
        position: 'relative', flexShrink: 0,
        transition: 'background 160ms ease',
        opacity: (disabled || loading) ? 0.6 : 1,
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

interface RespondRuleRef {
  accountId: string;
  ruleId: string;
  enabled: boolean;
}

export function PlanSwitcher({ active, accountId }: { active: PlanKey; accountId: string }) {
  const navigate = useNavigate();
  const authUser = useAuthStore(s => s.user);
  const authToken = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);
  const accounts = useAppStore(s => s.savedAccounts);

  // AI Conversation master — single source of truth on User. Live-wired.
  const aiOn = !!authUser?.aiConversationEnabled;

  // First Reply master = enabled flag on the new-lead AutomationRule per
  // account. Per spec 2a the shell toggle controls the whole plan; ALL
  // scope writes to every account.
  const [respondRules, setRespondRules] = useState<RespondRuleRef[] | null>(null);

  // Follow-ups master = followUpMode != 'off' per account.
  const [engageStateByAcct, setEngageStateByAcct] = useState<Map<string, boolean> | null>(null);

  // Independent saving flags so failures on one plan don't blank the others.
  const [savingRespond, setSavingRespond] = useState(false);
  const [savingEngage, setSavingEngage] = useState(false);

  // Targets the toggles will write to — ALL scope = every saved account,
  // single account = just that one.
  const isAll = accountId === ALL_ACCOUNTS;
  const targetAccounts = isAll ? accounts : accounts.filter(a => a.id === accountId);

  // Load master state for both account-scoped plans whenever scope changes.
  useEffect(() => {
    if (targetAccounts.length === 0) {
      setRespondRules([]);
      setEngageStateByAcct(new Map());
      return;
    }
    let cancelled = false;

    // First Reply — load new-lead AutomationRule per target account. Use
    // the bulk endpoint when in ALL scope (one round-trip), per-account
    // otherwise.
    (async () => {
      try {
        const rules: RespondRuleRef[] = [];
        if (isAll) {
          const all = await automationApi.getRules();
          for (const a of targetAccounts) {
            const nl = (all.rules || []).find(
              r => r.savedAccountId === a.id && r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0),
            );
            if (nl) rules.push({ accountId: a.id, ruleId: nl.id, enabled: !!nl.enabled });
          }
        } else {
          const res = await automationApi.getRulesForAccount(targetAccounts[0].id);
          const nl = (res.rules || []).find(
            r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0),
          );
          if (nl) rules.push({ accountId: targetAccounts[0].id, ruleId: nl.id, enabled: !!nl.enabled });
        }
        if (!cancelled) setRespondRules(rules);
      } catch {
        if (!cancelled) setRespondRules([]);
      }
    })();

    // Follow-ups — load followUp settings per target account.
    (async () => {
      try {
        const entries = await Promise.all(
          targetAccounts.map(async a => {
            try {
              const res = await followUpApi.getSettings(a.id);
              const mode = res?.settings?.followUpMode ?? null;
              return [a.id, mode != null && mode !== 'off'] as const;
            } catch {
              return [a.id, false] as const;
            }
          }),
        );
        if (!cancelled) setEngageStateByAcct(new Map(entries));
      } catch {
        if (!cancelled) setEngageStateByAcct(new Map());
      }
    })();

    return () => { cancelled = true; };
  }, [accountId, accounts.length, isAll]);

  // Derived display state — true when ANY target account has the plan on.
  // The Followups page uses the same heuristic on its master card so we stay
  // consistent. For ALL-scope mixed accounts, flipping the toggle commits
  // the new value to every account, which is the documented behavior.
  const respondOn = (respondRules ?? []).some(r => r.enabled);
  const engageOn = engageStateByAcct
    ? Array.from(engageStateByAcct.values()).some(Boolean)
    : false;

  const onToggleRespond = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!respondRules || respondRules.length === 0 || savingRespond) return;
    const next = !respondOn;

    // Optimistic UI
    const prev = respondRules;
    setRespondRules(prev.map(r => ({ ...r, enabled: next })));
    setSavingRespond(true);
    try {
      await Promise.all(
        prev.map(r => automationApi.updateRule(r.ruleId, { enabled: next })),
      );
    } catch {
      setRespondRules(prev); // rollback
    } finally {
      setSavingRespond(false);
    }
  };

  const onToggleEngage = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!engageStateByAcct || engageStateByAcct.size === 0 || savingEngage) return;
    const next = !engageOn;

    // Optimistic UI
    const prev = engageStateByAcct;
    const optimistic = new Map(prev);
    targetAccounts.forEach(a => optimistic.set(a.id, next));
    setEngageStateByAcct(optimistic);
    setSavingEngage(true);
    try {
      // Mirror what Followups.tsx writes when its in-page master flips —
      // followUpMode='auto_send' on ON (+ replyType='ai' when AI is allowed,
      // which is the live default), followUpMode='off' on OFF.
      await Promise.all(
        targetAccounts.map(a => {
          const payload: Record<string, unknown> = next
            ? { mode: 'auto_send', replyType: 'ai', platform: a.platform }
            : { mode: 'off' };
          return followUpApi.saveWizardSettings(a.id, payload);
        }),
      );
    } catch {
      setEngageStateByAcct(prev); // rollback
    } finally {
      setSavingEngage(false);
    }
  };

  const onToggleAi = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!authUser || !authToken) return;
    const next = !aiOn;
    setAuth({ ...authUser, aiConversationEnabled: next }, authToken);
    try {
      const targetId = !isAll ? accountId : accounts[0]?.id;
      if (targetId) {
        await followUpApi.saveSettings(targetId, { aiConversationEnabled: next } as any);
      }
    } catch {
      setAuth({ ...authUser, aiConversationEnabled: !next }, authToken);
    }
  };

  const togglesByPlan: Record<PlanKey, { on: boolean; handler: (e: React.MouseEvent) => void; loading: boolean; loaded: boolean }> = {
    respond: {
      on: respondOn,
      handler: onToggleRespond,
      loading: savingRespond,
      loaded: respondRules !== null,
    },
    engage: {
      on: engageOn,
      handler: onToggleEngage,
      loading: savingEngage,
      loaded: engageStateByAcct !== null,
    },
    convert: {
      on: aiOn,
      handler: onToggleAi,
      loading: false,
      loaded: true,
    },
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
        const { on, handler, loading, loaded } = togglesByPlan[p.key];
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
              on={on}
              loading={loading}
              disabled={!loaded || (p.key !== 'convert' && targetAccounts.length === 0)}
              onClick={handler}
              title={
                !loaded
                  ? 'Loading…'
                  : loading
                    ? 'Saving…'
                    : on
                      ? `Turn off ${p.label}`
                      : `Turn on ${p.label}`
              }
            />
          </div>
        );
      })}
    </div>
  );
}
