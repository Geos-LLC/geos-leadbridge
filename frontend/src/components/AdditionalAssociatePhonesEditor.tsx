import { useEffect, useMemo, useState } from 'react';
import { Phone, Plus, Trash2, Loader2, Info } from 'lucide-react';
import { thumbtackApi } from '../services/api';
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

function readInitial(value: AssociatePhoneEntry[] | null | undefined): DraftEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e) => e && typeof e.phoneNumber === 'string')
    .map((e) => ({
      id: typeof e.id === 'string' && e.id ? e.id : genId(),
      phoneNumber: e.phoneNumber,
      label: typeof e.label === 'string' ? e.label : '',
    }));
}

interface Props {
  /** SavedAccount id this list belongs to. */
  savedAccountId: string;
  /** Initial value pulled from SavedAccount.followUpSettingsJson.additionalAssociatePhones. */
  initialValue: AssociatePhoneEntry[] | null | undefined;
  /** Called after a successful save so the parent can refresh its accounts cache. */
  onSaved?: (next: AssociatePhoneEntry[]) => void;
}

/**
 * Per-business additional-associate-phones editor.
 *
 * Storage: SavedAccount.followUpSettingsJson.additionalAssociatePhones —
 * adding a number here registers ONLY on this business's Thumbtack profile.
 * Removing a row locally stops re-syncing; existing TT entries are kept.
 */
export function AdditionalAssociatePhonesEditor({ savedAccountId, initialValue, onSaved }: Props) {
  const [drafts, setDrafts] = useState<DraftEntry[]>(() => readInitial(initialValue));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-hydrate when the parent passes a different initialValue (e.g. after
  // a refresh of the saved-accounts cache).
  useEffect(() => {
    setDrafts(readInitial(initialValue));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedAccountId, JSON.stringify(initialValue ?? null)]);

  useEffect(() => {
    if (!savedAt) return;
    const t = setTimeout(() => setSavedAt(null), 2200);
    return () => clearTimeout(t);
  }, [savedAt]);

  const initialJson = useMemo(() => JSON.stringify(readInitial(initialValue)), [initialValue]);
  const draftJson = useMemo(() => JSON.stringify(drafts), [drafts]);
  const dirty = initialJson !== draftJson;

  const handleAdd = () => {
    setDrafts((prev) => [...prev, { id: genId(), phoneNumber: '', label: '' }]);
  };

  const handleRemove = (id: string) => {
    setDrafts((prev) => prev.filter((d) => d.id !== id));
  };

  const handleChange = (id: string, patch: Partial<DraftEntry>) => {
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const handleSave = async () => {
    setError(null);
    const cleaned: DraftEntry[] = [];
    for (const d of drafts) {
      const phone = d.phoneNumber.trim();
      if (!phone) continue;
      if (!isValidPhone(phone)) {
        setError(`"${phone}" is not a valid phone number`);
        return;
      }
      cleaned.push({ id: d.id, phoneNumber: phone, label: d.label.trim() });
    }
    setSaving(true);
    try {
      const payload = cleaned.map((d) => ({
        id: d.id,
        phoneNumber: d.phoneNumber,
        ...(d.label ? { label: d.label } : {}),
      }));
      await thumbtackApi.updateSavedAccount(savedAccountId, { additionalAssociatePhones: payload });
      setSavedAt(Date.now());
      notify.success('Saved', 'Additional associate numbers updated');
      onSaved?.(
        cleaned.map((d) => ({
          id: d.id,
          phoneNumber: d.phoneNumber,
          ...(d.label ? { label: d.label } : {}),
        })),
      );
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {drafts.length === 0 && (
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 8,
            background: 'var(--lb-ink-tint, #f8fafc)',
            color: 'var(--lb-ink-5, #64748b)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Info size={13} />
          No additional associate numbers for this business yet.
        </div>
      )}

      {drafts.map((d, idx) => (
        <div
          key={d.id}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 10px',
            border: '1px solid var(--lb-line, #e5e7eb)',
            borderRadius: 8,
            background: 'white',
          }}
        >
          <Phone size={14} color="var(--lb-ink-5, #64748b)" />
          <input
            value={d.label}
            onChange={(e) => handleChange(d.id, { label: e.target.value })}
            placeholder='Label (e.g. "Manager")'
            style={{
              flex: '1 1 30%',
              minWidth: 0,
              padding: '6px 9px',
              border: '1px solid var(--lb-line, #e5e7eb)',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <input
            value={d.phoneNumber}
            onChange={(e) => handleChange(d.id, { phoneNumber: e.target.value })}
            placeholder="+1 (555) 010-1234"
            style={{
              flex: '1 1 50%',
              minWidth: 0,
              padding: '6px 9px',
              border: '1px solid var(--lb-line, #e5e7eb)',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'inherit',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => handleRemove(d.id)}
            aria-label={`Remove row ${idx + 1}`}
            style={{
              padding: 4,
              border: 'none',
              background: 'transparent',
              color: 'var(--lb-ink-5, #64748b)',
              cursor: 'pointer',
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
        <button
          type="button"
          onClick={handleAdd}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 10px',
            borderRadius: 6,
            border: '1px dashed var(--lb-line, #cbd5e1)',
            background: 'white',
            color: 'var(--lb-ink-2, #334155)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          <Plus size={12} /> Add another
        </button>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {savedAt && !error && (
            <span style={{ color: 'var(--lb-success, #059669)', fontSize: 11, fontWeight: 600 }}>Saved</span>
          )}
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '6px 12px',
              borderRadius: 6,
              border: 'none',
              background: !dirty || saving ? 'var(--lb-ink-tint, #e2e8f0)' : '#2563eb',
              color: !dirty || saving ? 'var(--lb-ink-5, #64748b)' : 'white',
              fontSize: 12,
              fontWeight: 600,
              cursor: !dirty || saving ? 'not-allowed' : 'pointer',
            }}
          >
            {saving && <Loader2 size={12} className="animate-spin" />}
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {error && (
        <div
          style={{
            padding: '6px 10px',
            borderRadius: 6,
            background: 'var(--lb-danger-tint, #fee2e2)',
            color: 'var(--lb-danger, #dc2626)',
            fontSize: 11,
            fontWeight: 600,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
