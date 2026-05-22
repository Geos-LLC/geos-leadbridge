import { useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MRow, MScopeBar, MSection, MShell, MToggleRow,
} from '../components';
import type { IconName } from '../components';
import { useMobileAccounts } from '../hooks';
import { MEmpty, MLoading } from '../states';

type Strategy = 'auto' | 'qualify' | 'price' | 'phone';

const STRATEGY_OPTS: Array<{ v: Strategy; label: string; sub: string; icon: IconName }> = [
  { v: 'auto', label: 'Auto', sub: 'AI picks based on lead intent', icon: 'sparkles' },
  { v: 'qualify', label: 'Qualify first', sub: 'Ask 2 questions before pricing', icon: 'help-circle' },
  { v: 'price', label: 'Lead with price', sub: 'Share ballpark in first reply', icon: 'dollar-sign' },
  { v: 'phone', label: 'Push to call', sub: 'Get them on a quick call', icon: 'phone' },
];

export default function MAutomationConvert() {
  const [strategy, setStrategy] = useState<Strategy>('auto');
  const [accountId, setAccountId] = useState('all');
  const [consult, setConsult] = useState(true);
  const [bigJobs, setBigJobs] = useState(true);
  const [tough, setTough] = useState(true);
  const accounts = useMobileAccounts();

  return (
    <MShell tab="auto" appBar={<MAppBar leading={<MBack label="" />} title="AI Conversation" subtitle="Convert" />}>
      {accounts.loading && <MLoading label="Loading your accounts…" />}
      {!accounts.loading && (
        <MScopeBar accountId={accountId} setAccountId={setAccountId} accounts={accounts.data || []} />
      )}

      {accountId === 'all' && (accounts.data?.length ?? 0) > 0 && (
        <MEmpty
          icon="info"
          title="Pick an account to edit"
          body="AI Conversation strategy is per-account. Use the picker above to choose one."
        />
      )}

      <MSection title="Strategy">
        <MCard>
          {STRATEGY_OPTS.map((o, i) => (
            <MRow
              key={o.v}
              onClick={() => setStrategy(o.v)}
              leading={<MIconBox icon={o.icon} color="var(--accent)" bg="var(--accent-tint)" />}
              title={o.label}
              subtitle={o.sub}
              trailing={
                <span style={{
                  width: 20, height: 20, borderRadius: 99,
                  border: '2px solid ' + (strategy === o.v ? 'var(--accent)' : 'var(--ink-8)'),
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  background: strategy === o.v ? 'var(--accent)' : 'transparent',
                }}>
                  {strategy === o.v && <Icon name="check" size={11} style={{ color: 'white' }} />}
                </span>
              }
              last={i === STRATEGY_OPTS.length - 1}
            />
          ))}
        </MCard>
      </MSection>

      <MSection title="Hand-off rules">
        <MCard>
          <MToggleRow
            leading={<MIconBox icon="user" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off on consult requests" sub="Big jobs route to you"
            on={consult} onChange={setConsult}
          />
          <MToggleRow
            leading={<MIconBox icon="dollar-sign" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off above $1,500" sub="High-ticket flagged for review"
            on={bigJobs} onChange={setBigJobs}
          />
          <MToggleRow
            leading={<MIconBox icon="alert-triangle" color="var(--warn)" bg="var(--warn-tint)" />}
            title="Hand off on tough questions" sub="Anything off-script"
            on={tough} onChange={setTough}
            last
          />
        </MCard>
      </MSection>

      <div style={{ height: 60 }} />
    </MShell>
  );
}
