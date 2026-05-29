import { useEffect, useState } from 'react';
import { Workflow, CheckCircle2, AlertTriangle, AlertCircle, Loader2, Plug, Clock } from 'lucide-react';
import { SettingCard } from '../automation/ui';
import { sfConnectionApi, type SfConnectionStatus } from '../../services/api';
import { notify } from '../../store/notificationStore';

// ServiceFlow Connection — PR-C3.
//
// Renders one card on the Settings → Integrations page that shows the
// current SF orchestration connection state for the logged-in user and
// offers Connect / Disconnect actions.
//
// State surfaces (the seven the user asked for):
//   - Not connected     (no row, or revoked / disconnected — show Connect)
//   - Connecting        (status=pending; show spinner)
//   - Active            (status=active; show success badge + Disconnect)
//   - Active + rotation pending  (R1 signal — amber badge + grace countdown)
//   - Error             (status=error + lastErrorMessage; show Reconnect)
//   - Revoked           (status=revoked; show "SF revoked — Reconnect")
//   - Disconnected      (status=disconnected by user; show Connect)
//
// All secret material is excluded from this surface — the backend
// GET /v1/integrations/sf/connection only returns safe metadata.

function formatRelative(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const diffMs = d.getTime() - Date.now();
  const absSec = Math.abs(Math.round(diffMs / 1000));
  const sign = diffMs >= 0 ? 'in ' : '';
  const suffix = diffMs >= 0 ? '' : ' ago';
  if (absSec < 60) return `${sign}${absSec}s${suffix}`;
  const min = Math.round(absSec / 60);
  if (min < 60) return `${sign}${min} min${suffix}`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${sign}${hr} h${suffix}`;
  return d.toLocaleString();
}

function formatAbsolute(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

type Badge = { bg: string; fg: string; border: string; icon: any; label: string };

function badgeFor(s: SfConnectionStatus): Badge {
  if (s.rotationPending && s.connected) {
    return { bg: '#fef3c7', fg: '#92400e', border: '#fde68a', icon: Clock, label: 'Rotation pending' };
  }
  switch (s.status) {
    case 'active':
    case 'rotating':
      return { bg: '#dcfce7', fg: '#15803d', border: '#a7f3d0', icon: CheckCircle2, label: 'Connected' };
    case 'pending':
      return { bg: '#eff6ff', fg: '#1d4ed8', border: '#c3d4ff', icon: Loader2, label: 'Connecting…' };
    case 'error':
      return { bg: '#fef2f2', fg: '#b91c1c', border: '#fecaca', icon: AlertCircle, label: 'Error' };
    case 'revoked':
      return { bg: '#f3f4f6', fg: '#374151', border: '#e5e7eb', icon: AlertTriangle, label: 'Revoked by ServiceFlow' };
    case 'disconnected':
      return { bg: '#f3f4f6', fg: '#6b7280', border: '#e5e7eb', icon: Plug, label: 'Disconnected' };
    case 'none':
    default:
      return { bg: '#f9fafb', fg: '#6b7280', border: '#e5e7eb', icon: Plug, label: 'Not connected' };
  }
}

export function ServiceFlowConnectionCard() {
  const [status, setStatus] = useState<SfConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'connect' | 'disconnect' | null>(null);

  async function load() {
    try {
      setStatus(await sfConnectionApi.getStatus());
    } catch (e: any) {
      notify.error('ServiceFlow', e?.message ?? 'Failed to load connection status');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // If a handshake just completed, the user is redirected back to this page
    // with ?sf=connected or ?sf=error&code=... — refresh once on mount and
    // again 1.5s later to catch the post-callback persist.
    const t = window.setTimeout(load, 1500);
    return () => window.clearTimeout(t);
  }, []);

  async function onConnect() {
    setBusy('connect');
    try {
      const r = await sfConnectionApi.startConnect();
      if (r.success && r.redirectUrl) {
        // Send the user to SF authorize. SF will redirect them back to
        // /api/v1/integrations/sf/callback which finishes the exchange
        // and bounces to /settings/integrations?sf=connected.
        window.location.assign(r.redirectUrl);
        return;
      }
      notify.error('ServiceFlow', r.error ?? 'Could not start connection');
    } catch (e: any) {
      notify.error('ServiceFlow', e?.message ?? 'Connect failed');
    } finally {
      setBusy(null);
    }
  }

  async function onDisconnect() {
    if (!window.confirm('Disconnect ServiceFlow? This will stop orchestrated bookings.')) return;
    setBusy('disconnect');
    try {
      const r = await sfConnectionApi.disconnect('lb_user_settings_ui');
      if (r.success) {
        notify.success('ServiceFlow', 'Disconnected');
        await load();
        return;
      }
      notify.error('ServiceFlow', 'Disconnect did not complete');
    } catch (e: any) {
      notify.error('ServiceFlow', e?.message ?? 'Disconnect failed');
    } finally {
      setBusy(null);
    }
  }

  const showConnect =
    !loading && status &&
    (status.status === 'none' || status.status === 'disconnected' ||
     status.status === 'revoked' || status.status === 'error');
  const showDisconnect =
    !loading && status &&
    (status.status === 'active' || status.status === 'rotating' || status.status === 'pending');

  const badge = status ? badgeFor(status) : null;

  return (
    <SettingCard
      icon={Workflow}
      iconTone="violet"
      title="ServiceFlow Connection"
      subtitle="Orchestrated booking + lifecycle integration. Authoritative provisioning happens over OAuth; webhooks carry operational events only."
      headerRight={
        badge && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px', borderRadius: 999,
            background: badge.bg, color: badge.fg, border: `1px solid ${badge.border}`,
            fontSize: 11, fontWeight: 600,
          }}>
            <badge.icon size={11} style={status?.status === 'pending' ? { animation: 'spin 1s linear infinite' } : undefined} />
            {badge.label}
          </span>
        )
      }
      contentPad="16px 24px 20px"
    >
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-ink-5)', fontSize: 13 }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading status…
        </div>
      )}

      {!loading && status && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Rotation pending: explicit amber banner with grace countdown */}
          {status.rotationPending && status.connected && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 10,
              background: '#fffbeb', border: '1px solid #fde68a',
              fontSize: 13, color: '#92400e',
            }}>
              <Clock size={16} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600 }}>Credential rotation in progress</div>
                <div style={{ marginTop: 2, color: '#a16207' }}>
                  Current credential remains valid until {formatRelative(status.pendingRotationGraceExpiresAt)} ({formatAbsolute(status.pendingRotationGraceExpiresAt)}). Refresh is automatic and requires no action.
                </div>
              </div>
            </div>
          )}

          {/* Error: surface the SF-side reason if any */}
          {status.status === 'error' && status.lastErrorMessage && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 10,
              background: '#fef2f2', border: '1px solid #fecaca',
              fontSize: 13, color: '#7f1d1d',
            }}>
              <AlertCircle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600 }}>Connection error</div>
                <div style={{ marginTop: 2 }}>{status.lastErrorMessage}</div>
              </div>
            </div>
          )}

          {/* Revoked: clear reason + how to recover */}
          {status.status === 'revoked' && (
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10,
              padding: '12px 14px', borderRadius: 10,
              background: '#f9fafb', border: '1px solid #e5e7eb',
              fontSize: 13, color: '#374151',
            }}>
              <AlertTriangle size={16} style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600 }}>ServiceFlow revoked the connection</div>
                <div style={{ marginTop: 2, color: '#6b7280' }}>
                  {status.disconnectedAt ? `Revoked ${formatRelative(status.disconnectedAt)} (${formatAbsolute(status.disconnectedAt)}). ` : ''}
                  Click Connect to re-authorize.
                </div>
              </div>
            </div>
          )}

          {/* Metadata grid — shown whenever there's a connection row */}
          {status.status !== 'none' && (
            <div style={{
              display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px',
              fontSize: 12.5, color: 'var(--lb-ink-5)',
            }}>
              {status.sfTenantName && (<><Label>Tenant</Label><Value>{status.sfTenantName} <Mono>#{status.sfTenantId}</Mono></Value></>)}
              {!status.sfTenantName && status.sfTenantId && (<><Label>Tenant ID</Label><Value><Mono>{status.sfTenantId}</Mono></Value></>)}
              {status.sourceInstance && (<><Label>SF instance</Label><Value><Mono>{status.sourceInstance}</Mono></Value></>)}
              {status.signatureKeyId && (<><Label>Signing key</Label><Value><Mono>{status.signatureKeyId}</Mono></Value></>)}
              {status.tokenPrefix && (<><Label>Token prefix</Label><Value><Mono>{status.tokenPrefix}…</Mono></Value></>)}
              {status.connectedAt && (<><Label>Connected</Label><Value>{formatRelative(status.connectedAt)} · <span style={{ color: 'var(--lb-ink-5)' }}>{formatAbsolute(status.connectedAt)}</span></Value></>)}
              {status.tokenLastReceivedAt && (<><Label>Credential last received</Label><Value>{formatRelative(status.tokenLastReceivedAt)}</Value></>)}
              {status.tokenExpiresAt && (<><Label>Credential expires</Label><Value>{formatRelative(status.tokenExpiresAt)}</Value></>)}
              {status.disconnectedAt && status.status !== 'revoked' && (<><Label>Disconnected</Label><Value>{formatRelative(status.disconnectedAt)}{status.disconnectInitiator ? ` (${status.disconnectInitiator})` : ''}</Value></>)}
            </div>
          )}

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            {showConnect && (
              <button
                type="button"
                onClick={onConnect}
                disabled={busy !== null}
                style={{
                  padding: '8px 14px', fontSize: 13, fontWeight: 600,
                  background: 'var(--lb-accent)', color: 'white',
                  border: 0, borderRadius: 8, cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy === 'connect' && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
                {status.status === 'revoked' || status.status === 'error' ? 'Reconnect' : 'Connect ServiceFlow'}
              </button>
            )}
            {showDisconnect && (
              <button
                type="button"
                onClick={onDisconnect}
                disabled={busy !== null}
                style={{
                  padding: '8px 14px', fontSize: 13, fontWeight: 600,
                  background: 'white', color: 'var(--lb-ink-1)',
                  border: '1.5px solid var(--lb-line)', borderRadius: 8,
                  cursor: busy ? 'wait' : 'pointer', fontFamily: 'inherit',
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  opacity: busy ? 0.6 : 1,
                }}
              >
                {busy === 'disconnect' && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </SettingCard>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--lb-ink-5)', fontSize: 12 }}>{children}</span>;
}
function Value({ children }: { children: React.ReactNode }) {
  return <span style={{ color: 'var(--lb-ink-1)', fontSize: 12.5 }}>{children}</span>;
}
function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code style={{
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 11.5, color: 'var(--lb-ink-2)',
      background: 'var(--lb-line-soft)', padding: '1px 6px', borderRadius: 4,
    }}>{children}</code>
  );
}
