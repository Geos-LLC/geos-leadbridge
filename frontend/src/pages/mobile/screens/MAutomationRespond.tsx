import { useEffect, useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MRow, MScopeBar, MSection, MSegmented, MShell,
  MToggleRow,
} from '../components';
import { useMobileAccounts, useAccountSettings } from '../hooks';
import { MEmpty, MLoading } from '../states';

export default function MAutomationRespond() {
  const [mode, setMode] = useState<'template' | 'ai'>('ai');
  const [enabled, setEnabled] = useState(true);
  const [accountId, setAccountId] = useState('all');
  const accounts = useMobileAccounts();
  const settings = useAccountSettings(accountId === 'all' ? null : accountId);

  // Pull current settings into local state when scope changes.
  useEffect(() => {
    if (!settings.data) return;
    if (settings.data.followUpReplyType === 'template' || settings.data.followUpReplyType === 'ai') {
      setMode(settings.data.followUpReplyType);
    }
    setEnabled(settings.data.followUpMode !== 'off');
  }, [settings.data]);

  return (
    <MShell
      tab="auto"
      appBar={<MAppBar leading={<MBack label="" />} title="When a Lead Arrives" subtitle="Respond" />}
    >
      {accounts.loading && <MLoading label="Loading your accounts…" />}
      {!accounts.loading && (
        <MScopeBar accountId={accountId} setAccountId={setAccountId} accounts={accounts.data || []} />
      )}

      {accountId === 'all' && (accounts.data?.length ?? 0) > 0 && (
        <MEmpty
          icon="info"
          title="Pick an account to edit"
          body="Reply settings are per-account. Use the picker above to choose one."
        />
      )}

      {accountId !== 'all' && (
        <>
          <MSection title="Status">
            <MCard>
              <MToggleRow
                leading={<MIconBox icon="zap" color="var(--success)" bg="var(--success-tint)" />}
                title="Instant Reply"
                sub={enabled ? 'Active — replies as soon as a lead lands' : 'Paused — no auto reply'}
                on={enabled} onChange={setEnabled}
                last
              />
            </MCard>
          </MSection>

          <MSection title="Reply mode">
            <MSegmented<'template' | 'ai'>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'template', label: 'Template' },
                { value: 'ai', label: 'AI Draft' },
              ]}
            />
            {mode === 'ai' && (
              <MCard style={{ marginTop: 12, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.07em', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Icon name="sparkles" size={12} /> AI Prompt
                </div>
                <div style={{ fontSize: 13, color: 'var(--ink-5)', lineHeight: 1.55, padding: '10px 12px', background: 'var(--ink-10)', borderRadius: 10, border: '1px solid var(--line)' }}>
                  Edit the AI reply prompt in the desktop app's Settings → AI.
                </div>
              </MCard>
            )}
          </MSection>

          <MSection title="Active hours">
            <MCard>
              <MRow
                leading={<MIconBox icon="clock" color="var(--accent)" bg="var(--accent-tint)" />}
                title={settings.data?.followUpActiveHoursStart && settings.data?.followUpActiveHoursEnd
                  ? `${settings.data.followUpActiveHoursStart} – ${settings.data.followUpActiveHoursEnd}`
                  : 'Always on'}
                subtitle={settings.data?.followUpTimezone || 'Timezone follows your account default'}
                trailing={<Icon name="chevron-right" size={16} style={{ color: 'var(--ink-6)' }} />}
                last
              />
            </MCard>
          </MSection>
        </>
      )}

      <div style={{ height: 60 }} />
    </MShell>
  );
}
