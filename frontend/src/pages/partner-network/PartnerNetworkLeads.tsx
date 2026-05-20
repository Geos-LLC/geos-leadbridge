import { useEffect, useState } from 'react';
import { Loader2, Download, AlertTriangle } from 'lucide-react';
import {
  partnerNetworkApi,
  type PartnerBusiness,
  type PartnerLead,
  type PartnerLeadIntent,
  type PartnerLeadStatus,
  type PartnerReferralCode,
} from '../../services/partnerNetwork';
import { Card, Btn } from '../../components/ui';

const STATUSES: PartnerLeadStatus[] = ['new', 'contacted', 'qualified', 'rejected', 'booked', 'paid_manually'];
const INTENTS: PartnerLeadIntent[] = ['this_week', 'this_month', 'not_sure'];

export default function PartnerNetworkLeads() {
  const [leads, setLeads] = useState<PartnerLead[]>([]);
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [codes, setCodes] = useState<PartnerReferralCode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState({
    sourceBusinessId: '',
    destinationBusinessId: '',
    referralCodeId: '',
    status: '' as PartnerLeadStatus | '',
    intentTiming: '' as PartnerLeadIntent | '',
  });

  const load = async () => {
    setLoading(true);
    try {
      const [l, b, c] = await Promise.all([
        partnerNetworkApi.listLeads({
          sourceBusinessId: filters.sourceBusinessId || undefined,
          destinationBusinessId: filters.destinationBusinessId || undefined,
          referralCodeId: filters.referralCodeId || undefined,
          status: (filters.status || undefined) as any,
          intentTiming: (filters.intentTiming || undefined) as any,
        }),
        partnerNetworkApi.listBusinesses(),
        partnerNetworkApi.listReferralCodes(),
      ]);
      setLeads(l);
      setBusinesses(b);
      setCodes(c);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [filters]);

  const updateStatus = async (lead: PartnerLead, status: PartnerLeadStatus) => {
    try {
      await partnerNetworkApi.updateLead(lead.id, { status });
      setLeads(leads.map(l => l.id === lead.id ? { ...l, status } : l));
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Partner leads</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Leads submitted via public referral forms.
          </p>
        </div>
        <a href={partnerNetworkApi.csvUrl()} download>
          <Btn icon={<Download size={13} />}>Export CSV</Btn>
        </a>
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      <Card>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          <select value={filters.sourceBusinessId} onChange={e => setFilters({ ...filters, sourceBusinessId: e.target.value })} style={inputStyle}>
            <option value="">All sources</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={filters.destinationBusinessId} onChange={e => setFilters({ ...filters, destinationBusinessId: e.target.value })} style={inputStyle}>
            <option value="">All destinations</option>
            {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select value={filters.referralCodeId} onChange={e => setFilters({ ...filters, referralCodeId: e.target.value })} style={inputStyle}>
            <option value="">All codes</option>
            {codes.map(c => <option key={c.id} value={c.id}>{c.code}</option>)}
          </select>
          <select value={filters.status} onChange={e => setFilters({ ...filters, status: e.target.value as any })} style={inputStyle}>
            <option value="">All statuses</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <select value={filters.intentTiming} onChange={e => setFilters({ ...filters, intentTiming: e.target.value as any })} style={inputStyle}>
            <option value="">All intents</option>
            {INTENTS.map(i => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
      </Card>

      <Card padding={0}>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--lb-ink-5)', display: 'flex', gap: 8 }}>
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : leads.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No leads match the current filters.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12.5 }}>
              <thead>
                <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                  <th style={th}>Created</th>
                  <th style={th}>Customer</th>
                  <th style={th}>Phone</th>
                  <th style={th}>Source → Destination</th>
                  <th style={th}>Code</th>
                  <th style={th}>Intent</th>
                  <th style={th}>Value</th>
                  <th style={th}>Status</th>
                  <th style={th}>Flags</th>
                </tr>
              </thead>
              <tbody>
                {leads.map(l => (
                  <tr key={l.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                    <td style={{ ...td, color: 'var(--lb-ink-5)' }}>{new Date(l.createdAt).toLocaleString()}</td>
                    <td style={td}>
                      <strong>{l.customerName}</strong>
                      {l.notes && (
                        <div style={{ color: 'var(--lb-ink-5)', fontSize: 11, marginTop: 2 }}>{l.notes.slice(0, 80)}{l.notes.length > 80 ? '…' : ''}</div>
                      )}
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--lb-font-mono)' }}>
                      <a href={`tel:${l.customerPhone}`} style={{ color: 'var(--lb-accent)' }}>{l.customerPhone}</a>
                    </td>
                    <td style={td}>{l.sourceBusiness.name} → {l.destinationBusiness.name}</td>
                    <td style={{ ...td, fontFamily: 'var(--lb-font-mono)', fontSize: 11 }}>
                      {l.referralCode.code}
                      {l.referralCode.employeeName && (
                        <div style={{ color: 'var(--lb-ink-5)' }}>{l.referralCode.employeeName}</div>
                      )}
                    </td>
                    <td style={td}>
                      <IntentBadge intent={l.intentTiming} />
                    </td>
                    <td style={{ ...td, fontFamily: 'var(--lb-font-mono)' }}>${l.estimatedValue}</td>
                    <td style={td}>
                      <select value={l.status} onChange={e => updateStatus(l, e.target.value as PartnerLeadStatus)} style={inputStyle}>
                        {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                      </select>
                    </td>
                    <td style={td}>
                      {l.possibleDuplicate && (
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                          background: 'var(--lb-warn-tint)', color: '#92400e',
                        }}>
                          <AlertTriangle size={10} /> dup?
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function IntentBadge({ intent }: { intent: PartnerLeadIntent }) {
  const map: Record<PartnerLeadIntent, { label: string; bg: string; fg: string }> = {
    this_week: { label: 'Hot · this week', bg: '#fee2e2', fg: '#991b1b' },
    this_month: { label: 'Warm · this month', bg: '#fef3c7', fg: '#92400e' },
    not_sure: { label: 'Cold · not sure', bg: '#dbeafe', fg: '#1e3a8a' },
  };
  const m = map[intent];
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
      background: m.bg, color: m.fg, whiteSpace: 'nowrap',
    }}>{m.label}</span>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', fontSize: 12,
  border: '1px solid var(--lb-line)', borderRadius: 6, background: 'var(--lb-surface)',
  fontFamily: 'inherit',
};
const th: React.CSSProperties = { padding: '10px 14px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'top' };
