import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Flame, Sun, Snowflake, DollarSign, Loader2, RefreshCw } from 'lucide-react';
import { partnerNetworkApi, type DashboardSummary } from '../../services/partnerNetwork';
import { Card, Kpi, Btn } from '../../components/ui';

export default function PartnerNetworkDashboard() {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await partnerNetworkApi.getDashboard());
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  if (loading && !data) {
    return (
      <div style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-ink-5)' }}>
        <Loader2 className="animate-spin" size={16} /> Loading dashboard…
      </div>
    );
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Partner Network Beta</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Lead exchange overview across your partner businesses.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Btn icon={<RefreshCw size={13} />} onClick={load}>Refresh</Btn>
          <Link to="/partner-network/businesses"><Btn variant="primary">Businesses</Btn></Link>
          <Link to="/partner-network/referral-codes"><Btn variant="accent">Referral codes</Btn></Link>
        </div>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      <Card padding={0}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }}>
          <Kpi label="Total Leads" value={data?.totals.total ?? 0} />
          <Kpi label={<><Flame size={11} style={{ display: 'inline', verticalAlign: -1, color: '#dc2626' }} /> Hot (this week)</>} value={data?.totals.hot ?? 0} />
          <Kpi label={<><Sun size={11} style={{ display: 'inline', verticalAlign: -1, color: '#f59e0b' }} /> Warm (this month)</>} value={data?.totals.warm ?? 0} />
          <Kpi label={<><Snowflake size={11} style={{ display: 'inline', verticalAlign: -1, color: '#3b82f6' }} /> Cold (not sure)</>} value={data?.totals.cold ?? 0} />
          <Kpi label={<><DollarSign size={11} style={{ display: 'inline', verticalAlign: -1 }} /> Est. Total Value</>} value={`$${data?.totals.estimatedTotalValue ?? 0}`} muted />
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Leads by source business">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6 }}>Source business</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Leads</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {data?.bySourceBusiness.length === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--lb-ink-5)', padding: '8px 0' }}>No leads yet.</td></tr>
              )}
              {data?.bySourceBusiness.map(row => (
                <tr key={row.businessId} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={{ padding: '6px 0' }}>{row.businessName}</td>
                  <td style={{ textAlign: 'right' }}>{row.count}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>${row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Leads by referral code / employee">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6 }}>Code</th>
                <th style={{ paddingBottom: 6 }}>Employee</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Leads</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {data?.byReferralCode.length === 0 && (
                <tr><td colSpan={4} style={{ color: 'var(--lb-ink-5)', padding: '8px 0' }}>No leads yet.</td></tr>
              )}
              {data?.byReferralCode.map(row => (
                <tr key={row.codeId} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={{ padding: '6px 0', fontFamily: 'var(--lb-font-mono)', fontSize: 12 }}>{row.code}</td>
                  <td style={{ color: 'var(--lb-ink-4)' }}>{row.employeeName || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{row.count}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>${row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="Top referral employees · conversion">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6 }}>Employee</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Opens</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Starts</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Subs</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byEmployee?.length ?? 0) === 0 && (
                <tr><td colSpan={5} style={{ color: 'var(--lb-ink-5)', padding: '8px 0' }}>No employee leads yet.</td></tr>
              )}
              {data?.byEmployee.slice(0, 10).map(row => (
                <tr key={row.employeeName} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={{ padding: '6px 0' }}>{row.employeeName}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>{row.pageViews}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>{row.formStarts}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>{row.submissions}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>${row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Top destination businesses">
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={{ paddingBottom: 6 }}>Destination</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Leads</th>
                <th style={{ paddingBottom: 6, textAlign: 'right' }}>Value</th>
              </tr>
            </thead>
            <tbody>
              {(data?.byDestinationBusiness?.length ?? 0) === 0 && (
                <tr><td colSpan={3} style={{ color: 'var(--lb-ink-5)', padding: '8px 0' }}>No leads yet.</td></tr>
              )}
              {data?.byDestinationBusiness.slice(0, 10).map(row => (
                <tr key={row.businessId} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={{ padding: '6px 0' }}>{row.businessName}</td>
                  <td style={{ textAlign: 'right' }}>{row.count}</td>
                  <td style={{ textAlign: 'right', fontFamily: 'var(--lb-font-mono)' }}>${row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card title="Referral funnel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
          <FunnelStep label="QR opens" value={data?.funnel.views ?? 0} />
          <Arrow />
          <FunnelStep label="Started" value={data?.funnel.started ?? 0} />
          <Arrow />
          <FunnelStep label="Submitted" value={data?.funnel.submitted ?? 0} />
          <Arrow />
          <FunnelStep label="Qualified" value={data?.funnel.qualified ?? 0} />
          <Arrow />
          <FunnelStep label="Booked" value={data?.funnel.booked ?? 0} />
        </div>
        <p style={{ color: 'var(--lb-ink-5)', fontSize: 12, marginTop: 10, marginBottom: 0 }}>
          QR opens and form starts are tracked for funnel only — they do not create leads.
          Qualified and Booked reflect manual status updates by the admin.
        </p>
      </Card>

      <Card title="Leads by status">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {Object.entries(data?.byStatus ?? {}).length === 0 && (
            <div style={{ color: 'var(--lb-ink-5)', fontSize: 13 }}>No leads yet.</div>
          )}
          {Object.entries(data?.byStatus ?? {}).map(([status, count]) => (
            <div key={status} style={{
              padding: '6px 12px',
              borderRadius: 999,
              background: 'var(--lb-ink-10)',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--lb-ink-2)',
            }}>
              {status}: <span style={{ fontFamily: 'var(--lb-font-mono)' }}>{count as number}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function FunnelStep({ label, value }: { label: string; value: number }) {
  return (
    <div style={{
      padding: '10px 16px',
      borderRadius: 8,
      background: 'var(--lb-ink-10)',
      minWidth: 120,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--lb-font-mono)' }}>{value}</div>
    </div>
  );
}

function Arrow() {
  return <span style={{ color: 'var(--lb-ink-5)', fontSize: 18 }}>→</span>;
}
