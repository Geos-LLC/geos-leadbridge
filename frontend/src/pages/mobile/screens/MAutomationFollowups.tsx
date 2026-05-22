import { useEffect, useState } from 'react';
import {
  Icon, MAppBar, MBack, MCard, MIconBox, MScopeBar, MSection, MShell, MToggleRow,
} from '../components';
import { useMobileAccounts, useAccountSettings } from '../hooks';
import { MEmpty, MLoading } from '../states';

export default function MAutomationFollowups() {
  const [enabled, setEnabled] = useState(true);
  const [accountId, setAccountId] = useState('all');
  const accounts = useMobileAccounts();
  const settings = useAccountSettings(accountId === 'all' ? null : accountId);

  useEffect(() => {
    if (!settings.data) return;
    setEnabled(settings.data.followUpMode !== 'off' && settings.data.followUpMode != null);
  }, [settings.data]);

  return (
    <MShell tab="auto" appBar={<MAppBar leading={<MBack label="" />} title="Follow-ups" subtitle="Engage" />}>
      {accounts.loading && <MLoading label="Loading your accounts…" />}
      {!accounts.loading && (
        <MScopeBar accountId={accountId} setAccountId={setAccountId} accounts={accounts.data || []} />
      )}

      {accountId === 'all' && (accounts.data?.length ?? 0) > 0 && (
        <MEmpty
          icon="info"
          title="Pick an account to edit"
          body="Follow-up schedules and modes are per-account. Use the picker above to choose one."
        />
      )}

      {accountId !== 'all' && (
        <>
          <MSection title="Status">
            <MCard>
              <MToggleRow
                leading={<MIconBox icon="repeat" color="#6d28d9" bg="#ede9fe" />}
                title="Auto follow-up"
                sub={settings.data?.followUpMode === 'auto_send' ? 'Auto-send · stops when the lead replies'
                  : settings.data?.followUpMode === 'suggest' ? 'Suggest only · approve before sending'
                  : 'Off'}
                on={enabled} onChange={setEnabled}
                last
              />
            </MCard>
          </MSection>

          <MSection title="Mode" action={<a style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>Edit on desktop</a>}>
            <MCard>
              <div style={{ padding: '14px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                Follow-up mode: <strong style={{ color: 'var(--ink-1)' }}>{settings.data?.followUpMode ?? '—'}</strong><br />
                Reply type: <strong style={{ color: 'var(--ink-1)' }}>{settings.data?.followUpReplyType ?? '—'}</strong>
              </div>
            </MCard>
          </MSection>

          <MSection title="Active hours">
            <MCard>
              <div style={{ padding: '14px', fontSize: 13, color: 'var(--ink-3)', lineHeight: 1.5 }}>
                {settings.data?.followUpActiveHoursStart && settings.data?.followUpActiveHoursEnd
                  ? <>From <strong style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-mono)' }}>{settings.data.followUpActiveHoursStart}</strong> to <strong style={{ color: 'var(--ink-1)', fontFamily: 'var(--font-mono)' }}>{settings.data.followUpActiveHoursEnd}</strong></>
                  : 'Always on'}
                {settings.data?.followUpTimezone && (
                  <>{' · '}<span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ink-5)' }}>{settings.data.followUpTimezone}</span></>
                )}
              </div>
            </MCard>
          </MSection>

          <MSection title="Detailed schedule">
            <MCard>
              <div style={{
                padding: '14px', fontSize: 12.5, color: 'var(--ink-5)', lineHeight: 1.5,
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <Icon name="info" size={13} />
                Step-by-step schedule editing lives in the desktop app for now. Mobile editing coming soon.
              </div>
            </MCard>
          </MSection>
        </>
      )}

      <div style={{ height: 60 }} />
    </MShell>
  );
}
