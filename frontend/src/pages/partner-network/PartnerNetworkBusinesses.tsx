import { useEffect, useState } from 'react';
import { Plus, Loader2, Save, Pencil, X } from 'lucide-react';
import { partnerNetworkApi, type PartnerBusiness } from '../../services/partnerNetwork';
import { Card, Btn } from '../../components/ui';

interface BusinessFormState {
  name: string;
  category: string;
  phone: string;
  website: string;
  serviceArea: string;
}

const EMPTY_FORM: BusinessFormState = {
  name: '',
  category: '',
  phone: '',
  website: '',
  serviceArea: '',
};

export default function PartnerNetworkBusinesses() {
  const [businesses, setBusinesses] = useState<PartnerBusiness[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<BusinessFormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setBusinesses(await partnerNetworkApi.listBusinesses());
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Failed to load businesses');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const onSubmit = async () => {
    if (!form.name.trim()) {
      setError('Name is required');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload = {
        name: form.name.trim(),
        category: form.category.trim() || undefined,
        phone: form.phone.trim() || undefined,
        website: form.website.trim() || undefined,
        serviceArea: form.serviceArea.trim() || undefined,
      };
      if (editingId) {
        await partnerNetworkApi.updateBusiness(editingId, payload);
      } else {
        await partnerNetworkApi.createBusiness(payload);
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

  const startEdit = (b: PartnerBusiness) => {
    setEditingId(b.id);
    setForm({
      name: b.name,
      category: b.category ?? '',
      phone: b.phone ?? '',
      website: b.website ?? '',
      serviceArea: b.serviceArea ?? '',
    });
    setShowForm(true);
  };

  const toggleActive = async (b: PartnerBusiness) => {
    try {
      await partnerNetworkApi.updateBusiness(b.id, { active: !b.active });
      await load();
    } catch (err: any) {
      setError(err?.response?.data?.message || 'Update failed');
    }
  };

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', margin: 0 }}>Businesses</h2>
          <p style={{ fontSize: 13, color: 'var(--lb-ink-5)', margin: '4px 0 0' }}>
            Partner-network businesses you operate or partner with.
          </p>
        </div>
        {!showForm && (
          <Btn variant="accent" icon={<Plus size={14} />} onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setShowForm(true); }}>
            New business
          </Btn>
        )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--lb-danger-tint)', color: '#991b1b', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {showForm && (
        <Card title={editingId ? 'Edit business' : 'New business'} action={
          <Btn icon={<X size={13} />} onClick={() => { setShowForm(false); setEditingId(null); setForm(EMPTY_FORM); }}>Cancel</Btn>
        }>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <Field label="Name *">
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={inputStyle} placeholder="Spotless Homes" />
            </Field>
            <Field label="Category">
              <input value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} style={inputStyle} placeholder="House cleaning" />
            </Field>
            <Field label="Phone">
              <input value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} style={inputStyle} placeholder="(555) 555-1234" />
            </Field>
            <Field label="Website">
              <input value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} style={inputStyle} placeholder="https://example.com" />
            </Field>
            <Field label="Service area" wide>
              <input value={form.serviceArea} onChange={e => setForm({ ...form, serviceArea: e.target.value })} style={inputStyle} placeholder="Boston, MA" />
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
        ) : businesses.length === 0 ? (
          <div style={{ padding: 24, color: 'var(--lb-ink-5)', textAlign: 'center', fontSize: 13 }}>
            No businesses yet. Create your first one to begin.
          </div>
        ) : (
          <table style={{ width: '100%', fontSize: 13 }}>
            <thead>
              <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
                <th style={th}>Name</th>
                <th style={th}>Category</th>
                <th style={th}>Phone</th>
                <th style={th}>Service area</th>
                <th style={th}>Status</th>
                <th style={th} />
              </tr>
            </thead>
            <tbody>
              {businesses.map(b => (
                <tr key={b.id} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                  <td style={td}><strong>{b.name}</strong></td>
                  <td style={td}>{b.category || '—'}</td>
                  <td style={td}>{b.phone || '—'}</td>
                  <td style={td}>{b.serviceArea || '—'}</td>
                  <td style={td}>
                    <span style={{
                      padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600,
                      background: b.active ? 'var(--lb-success-tint)' : 'var(--lb-ink-10)',
                      color: b.active ? '#15803d' : 'var(--lb-ink-5)',
                    }}>{b.active ? 'Active' : 'Inactive'}</span>
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <Btn size="sm" icon={<Pencil size={12} />} onClick={() => startEdit(b)}>Edit</Btn>
                    <span style={{ marginLeft: 6 }} />
                    <Btn size="sm" onClick={() => toggleActive(b)}>{b.active ? 'Deactivate' : 'Activate'}</Btn>
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
