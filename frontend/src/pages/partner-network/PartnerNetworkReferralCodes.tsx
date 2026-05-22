import { useEffect, useMemo, useState } from 'react';
import { Plus, Save, X, Loader2, Copy, Check } from 'lucide-react';
import {
  partnerNetworkApi,
  type PartnerBusiness,
  type PartnerReferralCode,
  type PartnerRelationship,
} from '../../services/partnerNetwork';
import { Card, Btn } from '../../components/ui';

interface FormState {
  code: string;
  sourceBusinessId: string;
  destinationBusinessId: string;
  partnerRelationshipId: string;
  employeeName: string;
}
const EMPTY_FORM: FormState = {
  code: '',
  sourceBusinessId: '',
  destinationBusinessId: '',
  partnerRelationshipId: '',
  employeeName: '',
};

export default function PartnerNetworkReferralCodes() {
  const [codes, setCodes] = useState<PartnerReferralCode[]>([]);
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [relationships, setRelationships] = useState<PartnerRelationship[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  const load = async () => {
    setLoading(true);
    try {
      const [c, b, r] = await Promise.all([
        partnerNetworkApi.listReferralCodes(),
        partnerNetworkApi.listBusinesses(),
        partnerNetworkApi.listRelationships(),
      ]);
      setCodes(c);
      setBusinesses(b);
      setRelationships(r);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  // When source+destination are picked, auto-suggest a matching relationship.
  const matchingRel = useMemo(() => {
    return relationships.find(r =>
      r.sourceBusinessId === form.sourceBusinessId &&
      r.destinationBusinessId === form.destinationBusinessId);
  }, [form.sourceBusinessId, form.destinationBusinessId, relationships]);

  const onSubmit = async () => {
    if (!form.code.trim() || !form.sourceBusinessId || !form.destinationBusinessId) {
      setError('Code, source, and destination are required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await partnerNetworkApi.createReferralCode({
        code: form.code.trim(),
        sourceBusinessId: form.sourceBusinessId,
        destinationBusinessId: form.destinationBusinessId,
        partnerRelationshipId: form.partnerRelationshipId || matchingRel?.id || undefined,
        employeeName: form.employeeName.trim() || undefined,
      });
      setShowForm(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (c: PartnerReferralCode) => {
    try {
      await partnerNetworkApi.updateReferralCode(c.id, { active: !c.active });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  const copyLink = async (c: PartnerReferralCode) => {
    const url = `${origin}${c.publicUrl}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(c.id);
      setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // Clipboard API can be blocked in non-https iframes — fall back to
      // selecting the URL via a hidden textarea so the user can copy manually.
      window.prompt('Copy this link', url);
    }
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Referral codes</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            One code per employee/source. Customers reach the form via the public link.
          </p>
        </div>
        {!showForm && (
          <Btn variant="accent" icon={<Plus size={14} />} onClick={() => { setForm(EMPTY_FORM); setShowForm(true); }}>
            New code
          </Btn>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {showForm && (
        <Card title="New referral code" action={
          <Btn icon={<X size={13} />} onClick={() => { setShowForm(false); setForm(EMPTY_FORM); }}>Cancel</Btn>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Code * (letters, digits, hyphens)">
              <input value={form.code} onChange={e => setForm({ ...form, code: e.target.value.toUpperCase() })} style={{ ...inputStyle, fontFamily: 'var(--lb-font-mono)', textTransform: 'uppercase' }} placeholder="SPOTLESS-MARIA" />
            </Field>
            <Field label="Employee name">
              <input value={form.employeeName} onChange={e => setForm({ ...form, employeeName: e.target.value })} style={inputStyle} placeholder="Maria" />
            </Field>
            <Field label="Source business *">
              <select value={form.sourceBusinessId} onChange={e => setForm({ ...form, sourceBusinessId: e.target.value })} style={inputStyle}>
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Destination business *">
              <select value={form.destinationBusinessId} onChange={e => setForm({ ...form, destinationBusinessId: e.target.value })} style={inputStyle}>
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            {matchingRel && (
              <div style={{ gridColumn: 'span 2', fontSize: 12, color: 'var(--lb-ink-5)' }}>
                Will link to relationship: <strong>{matchingRel.name || `${matchingRel.sourceBusiness.name} → ${matchingRel.destinationBusiness.name}`}</strong>
              </div>
            )}
          </div>
          <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
            <Btn variant="accent" icon={<Save size={14} />} onClick={onSubmit} disabled={submitting}>
              {submitting ? 'Saving…' : 'Save'}
            </Btn>
          </div>
        </Card>
      )}

      <Card padding={0}>
        {loading ? (
          <div style={{ padding: 16, color: 'var(--lb-ink-5)', display: 'flex', gap: 8 }}>
            <Loader2 className="animate-spin" size={16} /> Loading…
          </div>
        ) : codes.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No referral codes yet.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={th}>Code</th>
                <th style={th}>Employee</th>
                <th style={th}>Source</th>
                <th style={th}>Destination</th>
                <th style={th}>Public link</th>
                <th style={th}>QR</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {codes.map(c => {
                const fullUrl = `${origin}${c.publicUrl}`;
                // Prefer the QR URL the server persisted at create-time so
                // changing the QR provider is a single-place swap.
                const qrUrl = c.qrUrl
                  ?? `https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=${encodeURIComponent(fullUrl)}`;
                return (
                  <tr key={c.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                    <td style={{ ...td, fontFamily: 'var(--lb-font-mono)', fontWeight: 600 }}>{c.code}</td>
                    <td style={td}>{c.employeeName || '—'}</td>
                    <td style={td}>{c.sourceBusiness.name}</td>
                    <td style={td}>{c.destinationBusiness.name}</td>
                    <td style={{ ...td, color: 'var(--lb-ink-4)', fontFamily: 'var(--lb-font-mono)', fontSize: 11 }}>
                      <a href={c.publicUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--lb-accent)' }}>
                        {c.publicUrl}
                      </a>
                    </td>
                    <td style={td}>
                      <a href={qrUrl} target="_blank" rel="noopener noreferrer">
                        <img src={qrUrl} alt={`QR for ${c.code}`} width={48} height={48} style={{ display: 'block', border: '1px solid var(--lb-line)', borderRadius: 4 }} />
                      </a>
                    </td>
                    <td style={td}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                        background: c.active ? 'var(--lb-success-tint)' : 'var(--lb-ink-10)',
                        color: c.active ? '#15803d' : 'var(--lb-ink-5)',
                      }}>{c.active ? 'Active' : 'Inactive'}</span>
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <Btn size="sm" icon={copiedId === c.id ? <Check size={12} /> : <Copy size={12} />} onClick={() => copyLink(c)}>
                        {copiedId === c.id ? 'Copied' : 'Copy link'}
                      </Btn>
                      <span style={{ marginLeft: 6 }} />
                      <Btn size="sm" onClick={() => toggleActive(c)}>{c.active ? 'Deactivate' : 'Activate'}</Btn>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '8px 10px', fontSize: 13,
  border: '1px solid var(--lb-line)', borderRadius: 8, background: 'var(--lb-surface)',
  fontFamily: 'inherit',
};
const th: React.CSSProperties = { padding: '10px 14px', fontWeight: 500 };
const td: React.CSSProperties = { padding: '10px 14px', verticalAlign: 'middle' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.04, fontWeight: 500, display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
