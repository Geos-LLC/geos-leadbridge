import { useEffect, useState } from 'react';
import { Plus, Save, X, Loader2 } from 'lucide-react';
import {
  partnerNetworkApi,
  type PartnerBusiness,
  type PartnerRelationship,
} from '../../services/partnerNetwork';
import { Card, Btn } from '../../components/ui';

interface FormState {
  sourceBusinessId: string;
  destinationBusinessId: string;
  name: string;
  defaultOfferText: string;
  notes: string;
}
const EMPTY_FORM: FormState = {
  sourceBusinessId: '',
  destinationBusinessId: '',
  name: '',
  defaultOfferText: '',
  notes: '',
};

export default function PartnerNetworkRelationships() {
  const [relationships, setRelationships] = useState<PartnerRelationship[]>([]);
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [r, b] = await Promise.all([
        partnerNetworkApi.listRelationships(),
        partnerNetworkApi.listBusinesses(),
      ]);
      setRelationships(r);
      setBusinesses(b);
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const onSubmit = async () => {
    if (!form.sourceBusinessId || !form.destinationBusinessId) {
      setError('Pick a source and destination business');
      return;
    }
    if (form.sourceBusinessId === form.destinationBusinessId) {
      setError('Source and destination must be different');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      if (editingId) {
        await partnerNetworkApi.updateRelationship(editingId, {
          name: form.name.trim() || undefined,
          defaultOfferText: form.defaultOfferText.trim() || undefined,
          notes: form.notes.trim() || undefined,
        });
      } else {
        await partnerNetworkApi.createRelationship({
          sourceBusinessId: form.sourceBusinessId,
          destinationBusinessId: form.destinationBusinessId,
          name: form.name.trim() || undefined,
          defaultOfferText: form.defaultOfferText.trim() || undefined,
          notes: form.notes.trim() || undefined,
        });
      }
      setShowForm(false);
      setEditingId(null);
      setForm(EMPTY_FORM);
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Save failed');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (r: PartnerRelationship) => {
    try {
      await partnerNetworkApi.updateRelationship(r.id, { active: !r.active });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  const startEdit = (r: PartnerRelationship) => {
    setEditingId(r.id);
    setForm({
      sourceBusinessId: r.sourceBusinessId,
      destinationBusinessId: r.destinationBusinessId,
      name: r.name ?? '',
      defaultOfferText: r.defaultOfferText ?? '',
      notes: r.notes ?? '',
    });
    setShowForm(true);
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Partner relationships</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Configure which business sends leads to which.
          </p>
        </div>
        {!showForm && (
          <Btn variant="accent" icon={<Plus size={14} />} onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setShowForm(true); }}>
            New relationship
          </Btn>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {showForm && (
        <Card title={editingId ? 'Edit relationship' : 'New relationship'} action={
          <Btn icon={<X size={13} />} onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</Btn>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Source business *">
              <select
                value={form.sourceBusinessId}
                onChange={e => setForm({ ...form, sourceBusinessId: e.target.value })}
                style={inputStyle}
                disabled={!!editingId}
              >
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Destination business *">
              <select
                value={form.destinationBusinessId}
                onChange={e => setForm({ ...form, destinationBusinessId: e.target.value })}
                style={inputStyle}
                disabled={!!editingId}
              >
                <option value="">— Select —</option>
                {businesses.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Name (optional)" wide>
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Spotless → Premium Upholstery" />
            </Field>
            <Field label="Default offer text" wide>
              <textarea value={form.defaultOfferText} onChange={e => setForm({ ...form, defaultOfferText: e.target.value })} style={{ ...inputStyle, minHeight: 80 }} placeholder="Get $25 off your first upholstery cleaning" />
            </Field>
            <Field label="Notes" wide>
              <textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} style={{ ...inputStyle, minHeight: 60 }} />
            </Field>
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
        ) : relationships.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No relationships yet.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={th}>Source</th>
                <th style={th}>→</th>
                <th style={th}>Destination</th>
                <th style={th}>Offer</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {relationships.map(r => (
                <tr key={r.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={td}><strong>{r.sourceBusiness.name}</strong></td>
                  <td style={td}>→</td>
                  <td style={td}><strong>{r.destinationBusiness.name}</strong></td>
                  <td style={{ ...td, color: 'var(--lb-ink-4)', maxWidth: 280 }}>
                    {r.defaultOfferText ? r.defaultOfferText.slice(0, 80) + (r.defaultOfferText.length > 80 ? '…' : '') : '—'}
                  </td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: r.active ? 'var(--lb-success-tint)' : 'var(--lb-ink-10)',
                      color: r.active ? '#15803d' : 'var(--lb-ink-5)',
                    }}>{r.active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <Btn size="sm" onClick={() => startEdit(r)}>Edit</Btn>
                    <span style={{ marginLeft: 6 }} />
                    <Btn size="sm" onClick={() => toggleActive(r)}>{r.active ? 'Deactivate' : 'Activate'}</Btn>
                  </td>
                </tr>
              ))}
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

function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ gridColumn: wide ? 'span 2' : 'auto' }}>
      <label style={{ fontSize: 11, color: 'var(--lb-ink-5)', textTransform: 'uppercase', letterSpacing: 0.04, fontWeight: 500, display: 'block', marginBottom: 4 }}>
        {label}
      </label>
      {children}
    </div>
  );
}
