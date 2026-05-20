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
