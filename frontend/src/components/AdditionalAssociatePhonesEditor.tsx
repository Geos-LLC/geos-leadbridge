import { useEffect, useMemo, useState } from 'react';
import { Phone, Plus, Trash2, Loader2, Info } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { usersApi, authApi } from '../services/api';
import { notify } from '../store/notificationStore';

export interface AssociatePhoneEntry {
  id: string;
  phoneNumber: string;
  label?: string;
}

interface DraftEntry {
  id: string;
  phoneNumber: string;
  label: string;
}

function isValidPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1')) || digits.length > 10;
}

function genId(): string {
  return `aap_${Math.random().toString(36).slice(2, 10)}_${Date.now().toString(36)}`;
}

function readInitial(user: any): DraftEntry[] {
  const raw = user?.additionalAssociatePhonesJson;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e: any) => e && typeof e.phoneNumber === 'string')
    .map((e: any) => ({
      id: typeof e.id === 'string' && e.id ? e.id : genId(),
      phoneNumber: e.phoneNumber,
      label: typeof e.label === 'string' ? e.label : '',
    }));
}

/**
 * Editor for User.additionalAssociatePhonesJson. Lets the user add / edit /
 * remove extra team-member / callback numbers that should be registered as
 * Thumbtack associate phones on every connected TT business.
 *
 * Save behavior:
 *  - calls PATCH /v1/users/me with the full array (replace semantics)
 *  - backend fires ensureAssociatePhone on every TT business — idempotent
 *  - removing a row LOCALLY does NOT delete the entry from TT (per spec)
 */
export function AdditionalAssociatePhonesEditor() {
  const user = useAuthStore(s => s.user) as any;
  const token = useAuthStore(s => s.token);
  const setAuth = useAuthStore(s => s.setAuth);

  const [drafts, setDrafts] = useState<DraftEntry[]>(() => readInitial(user));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-hydrate when the user object updates from elsewhere (e.g. a Communication
  // save fires this same field via the shared auth store).
  useEffect(() => {
    setDrafts(readInitial(user));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, JSON.stringify(user?.additionalAssociatePhonesJson ?? null)]);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2200);
    return () => clearTimeout(t);
  }, [savedAt]);

  const initialJson = useMemo(() => JSON.stringify(readInitial(user)), [user]);
  const draftJson = useMemo(() => JSON.stringify(drafts), [drafts]);
  const dirty = initialJson !== draftJson;

  const handleAdd = () => {
    setDrafts(prev => [...prev, { id: genId(), phoneNumber: '', label: '' }]);
  };

  const handleRemove = (id: string) => {
    setDrafts(prev => prev.filter(d => d.id !== id));
  };

  const handleChange = (id: string, patch: Partial<DraftEntry>) => {
    setDrafts(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  };

  const handleSave = async () => {
    setError(null);
    // Validation
    const cleaned: DraftEntry[] = [];
    for (const d of drafts) {
      const phone = d.phoneNumber.trim();
      if (!phone) continue; // skip empty rows silently
      if (!isValidPhone(phone)) {
        setError(`"${phone}" is not a valid phone number`);
        return;
      }
      cleaned.push({ id: d.id, phoneNumber: phone, label: d.label.trim() });
    }
    setSaving(true);
    try {
      const payload = cleaned.map(d => ({
        id: d.id,
        phoneNumber: d.phoneNumber,
        ...(d.label ? { label: d.label } : {}),
      }));
      await usersApi.updateProfile({ additionalAssociatePhones: payload });
      // Refresh the cached user so the rest of the app sees the new list.
      if (token) {
        try {
          const fresh: any = await authApi.getProfile();
          const u = fresh?.user ?? fresh;
          if (u?.id) setAuth(u, token);
        } catch { /* silent */ }
      }
      setSavedAt(Date.now());
      notify.success('Saved', 'Additional associate phones updated');
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {drafts.length === 0 && (
        <div style={{
          padding: '14px 16px', borderRadius: 10,
          background: 'var(--lb-ink-tint, #f8fafc)',
          color: 'var(--lb-ink-5, #64748b)', fontSize: 13,
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Info size={14} />
          No additional associate numbers yet. Add team members or extra callback lines.
        </div>
      )}

      {drafts.map((d, idx) => (
        <div key={d.id} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '10px 12px',
          border: '1px solid var(--lb-line, #e5e7eb)', borderRadius: 10,
          background: 'white',
        }}>
          <Phone size={16} color="var(--lb-ink-5, #64748b)" />
          <input
            value={d.label}
            onChange={e => handleChange(d.id, { label: e.target.value })}
            placeholder={`Label (e.g. "John")`}
            style={{
              flex: '1 1 30%', minWidth: 0,
              padding: '8px 10px',
              border: '1px solid var(--lb-line, #e5e7eb)', borderRadius: 8,
              fontSize: 13, fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <input
            value={d.phoneNumber}
            onChange={e => handleChange(d.id, { phoneNumber: e.target.value })}
            placeholder="+1 (555) 010-1234"
            style={{
              flex: '1 1 50%', minWidth: 0,
              padding: '8px 10px',
              border: '1px solid var(--lb-line, #e5e7eb)', borderRadius: 8,
              fontSize: 13, fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => handleRemove(d.id)}
            aria-label={`Remove row ${idx + 1}`}
            style={{
              padding: 6, border: 'none', background: 'transparent',
              color: 'var(--lb-ink-5, #64748b)', cursor: 'pointer',
            }}
          >
            <Trash2 size={16} />
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <button
          type="button"
          onClick={handleAdd}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '8px 12px', borderRadius: 8,
            border: '1px dashed var(--lb-line, #cbd5e1)',
            background: 'white', color: 'var(--lb-ink-2, #334155)',
            fontSize: 13, fontWeight: 600, cursor: 'pointer',
          }}
        >
          <Plus size={14} /> Add another number
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {savedAt && !error && (
            <span style={{ color: 'var(--lb-success, #059669)', fontSize: 12, fontWeight: 600 }}>Saved</span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '8px 14px', borderRadius: 8,
              border: 'none',
              background: !dirty || saving ? 'var(--lb-ink-tint, #e2e8f0)' : '#2563eb',
              color: !dirty || saving ? 'var(--lb-ink-5, #64748b)' : 'white',
              fontSize: 13, fontWeight: 600,
              cursor: !dirty || saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{
          padding: '8px 12px', borderRadius: 8,
          background: 'var(--lb-danger-tint, #fee2e2)',
          color: 'var(--lb-danger, #dc2626)',
          fontSize: 12, fontWeight: 600,
        }}>
          {error}
        </div>
      )}

      <div style={{ color: 'var(--lb-ink-5, #64748b)', fontSize: 12 }}>
        Each saved number is registered as a Thumbtack associate phone on every connected business so it can call customers through the TT proxy. Removing a number here stops re-syncing; existing TT entries are left in place.
      </div>
    </div>
  );
}
