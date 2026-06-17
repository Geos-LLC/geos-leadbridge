import { useState, useEffect, useRef } from 'react';
import { Loader2, Upload } from 'lucide-react';
import { usersApi, serviceProfilesApi } from '../services/api';
import {
  CollapsibleSection,
  FaqRow,
  UnifiedAddRowButton,
  UnifiedSaveButton,
} from './playbook-controls';
import {
  StructuredFaqGroups,
  type StructuredFaqValue,
} from './StructuredFaqGroups';
import { MessageSquare } from 'lucide-react';

export interface AccountFaq {
  insuredAndBonded?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  bringsSupplies?: { value?: 'yes' | 'no' | 'unset'; details?: string };
  petPolicy?: { value?: 'pet_friendly' | 'extra_charge' | 'no_pets' | 'unset'; details?: string };
  paymentMethods?: string[];
  customerMustBeHome?: { value?: 'no' | 'yes' | 'optional' | 'unset'; details?: string };
  sameCleanerForRecurring?: { value?: 'try' | 'guaranteed' | 'no' | 'unset'; details?: string };
  standardScope?: string;
  deepScope?: string;
  laborRatePerCleanerHour?: number;
  crewSizeRule?: { hoursThreshold?: number; sizeUnder?: number; sizeOver?: number };
  customQA?: Array<{ question?: string; answer?: string }>;
}

const DEFAULT_FAQ: AccountFaq = {
  insuredAndBonded: { value: 'unset' },
  bringsSupplies: { value: 'unset' },
  petPolicy: { value: 'unset' },
  paymentMethods: [],
  customerMustBeHome: { value: 'unset' },
  sameCleanerForRecurring: { value: 'unset' },
  standardScope: '',
  deepScope: '',
  laborRatePerCleanerHour: 50,
  crewSizeRule: { hoursThreshold: 4, sizeUnder: 1, sizeOver: 2 },
  customQA: [],
};


interface AccountFaqFormProps {
  accountId: string;
  accountName: string;
  saveToAll?: string[];
  // When set, the form loads/saves against a per-Service FAQ
  // (ServiceProfile.faqJson) instead of the SavedAccount FAQ. accountId is
  // still required for the SavedAccount fallback shape but is ignored at
  // the load/save layer. saveToAll is ignored in this mode — a service's
  // FAQ is scoped to that one profile, not fanned out across accounts.
  serviceProfileId?: string;
}

export default function AccountFaqForm({ accountId, accountName, saveToAll, serviceProfileId }: AccountFaqFormProps) {
  const [faq, setFaq] = useState<AccountFaq | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [inherited, setInherited] = useState(false);
  const [uploading, setUploading] = useState<'standard' | 'deep' | null>(null);
  const standardFileRef = useRef<HTMLInputElement | null>(null);
  const deepFileRef = useRef<HTMLInputElement | null>(null);

  const loadId = saveToAll && saveToAll.length > 0 ? saveToAll[0] : accountId;
  useEffect(() => {
    setLoading(true);
    if (serviceProfileId) {
      // Per-Service FAQ — load from ServiceProfile.faqJson (string of
      // serialized AccountFaq shape). Falls back to DEFAULT_FAQ when the
      // JSON is missing or unparseable so the editor still renders.
      serviceProfilesApi
        .get(serviceProfileId)
        .then(profile => {
          let parsed: AccountFaq | null = null;
          if (profile.faqJson) {
            try { parsed = JSON.parse(profile.faqJson) as AccountFaq; } catch { /* fall through */ }
          }
          setFaq({ ...DEFAULT_FAQ, ...(parsed || {}) });
          setInherited(false);
        })
        .catch(() => setFaq(DEFAULT_FAQ))
        .finally(() => setLoading(false));
      return;
    }
    if (!loadId) { setLoading(false); return; }
    usersApi.getAccountFaq(loadId)
      .then(res => {
        setFaq({ ...DEFAULT_FAQ, ...(res.faq || {}) });
        setInherited(!!res.inherited);
      })
      .catch(() => setFaq(DEFAULT_FAQ))
      .finally(() => setLoading(false));
  }, [loadId, serviceProfileId]);

  const update = <K extends keyof AccountFaq>(key: K, value: AccountFaq[K]) => {
    setFaq(prev => ({ ...(prev || DEFAULT_FAQ), [key]: value }));
  };

  const updateCustomQA = (idx: number, field: 'question' | 'answer', value: string) => {
    setFaq(prev => {
      const list = [...(prev?.customQA || [])];
      list[idx] = { ...list[idx], [field]: value };
      return { ...(prev || DEFAULT_FAQ), customQA: list };
    });
  };

  const addCustomQA = () => {
    setFaq(prev => ({
      ...(prev || DEFAULT_FAQ),
      customQA: [...(prev?.customQA || []), { question: '', answer: '' }],
    }));
  };

  const handleChecklistUpload = async (target: 'standard' | 'deep', e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const existing = (target === 'standard' ? faq?.standardScope : faq?.deepScope) || '';
    if (existing.trim() && !confirm(`This will replace the current ${target} cleaning scope. Continue?`)) return;

    setUploading(target);
    try {
      const res = await usersApi.parseChecklistFile(file);
      const key: keyof AccountFaq = target === 'standard' ? 'standardScope' : 'deepScope';
      update(key, res.text);
      if (res.truncated) {
        alert(`Imported ~${Math.round(res.text.length / 1000)}KB of text. The file was longer than 20KB and was truncated to keep the AI prompt small.`);
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message || err?.message || 'Failed to parse file';
      alert(`Upload failed: ${msg}`);
    } finally {
      setUploading(null);
    }
  };

  const removeCustomQA = (idx: number) => {
    setFaq(prev => ({
      ...(prev || DEFAULT_FAQ),
      customQA: (prev?.customQA || []).filter((_, i) => i !== idx),
    }));
  };

  const handleSave = async () => {
    if (!faq) return;
    setSaving(true);
    try {
      const cleaned: AccountFaq = {
        ...faq,
        customQA: (faq.customQA || []).filter(qa => (qa.question || '').trim() && (qa.answer || '').trim()),
      };
      if (serviceProfileId) {
        await serviceProfilesApi.update(serviceProfileId, { faqJson: JSON.stringify(cleaned) });
      } else if (saveToAll && saveToAll.length > 0) {
        await Promise.all(saveToAll.map(id => usersApi.updateAccountFaq(id, cleaned)));
      } else {
        await usersApi.updateAccountFaq(accountId, cleaned);
      }
      setSaved(true);
      setInherited(false);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      alert('Failed to save FAQ');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 size={16} className="animate-spin" /> Loading FAQ...</div>;
  }
  if (!faq) return null;

  const inputCls = 'w-full bg-white border border-slate-200 rounded-xl p-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all';
  // Section label — uppercase grey, matches the structured FAQ language used in the design handoff.
  const labelCls = 'block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2';
  // Unified outline-style chip selector. Selected = soft accent tint with
  // accent border and accent text; unselected = white with grey border.
  // Same class strings replace the older heavy-blue-fill chips across
  // every structured FAQ group so the form feels consistent with the
  // newer custom Q&A and pricing chrome.
  const chipBaseCls =
    'py-2 px-3 rounded-lg text-xs font-semibold border transition-colors';
  const chipActiveCls =
    'bg-blue-50 text-blue-700 border-blue-300';
  const chipInactiveCls =
    'bg-white text-slate-700 border-slate-200 hover:border-slate-300';

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Account FAQ</h4>
          <p className="text-[11px] text-slate-400 mt-0.5">{accountName}</p>
        </div>
        {inherited && (
          <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-100 px-2 py-1 rounded-lg">
            Inherited — save to make it specific to this account
          </span>
        )}
      </div>

      <p className="text-xs text-slate-500 leading-relaxed bg-blue-50/60 border border-blue-100 rounded-xl p-3">
        These answers are injected into the AI prompt so it can respond accurately to common customer questions. Anything left blank, the AI defers to the team ("we'll confirm shortly") rather than guess.
      </p>

      {/* Five baseline chip groups — shared with every non-cleaning
          service so the FAQ chrome is identical across verticals. The
          remaining cleaning-specific groups (same cleaner, scope text,
          labor rate, crew sizing) keep rendering inline below. */}
      <StructuredFaqGroups
        value={{
          insuredAndBonded: faq.insuredAndBonded as StructuredFaqValue['insuredAndBonded'],
          bringsSupplies: faq.bringsSupplies as StructuredFaqValue['bringsSupplies'],
          petPolicy: faq.petPolicy as StructuredFaqValue['petPolicy'],
          paymentMethods: faq.paymentMethods,
          customerMustBeHome: faq.customerMustBeHome as StructuredFaqValue['customerMustBeHome'],
        }}
        onChange={(next) => {
          if (next.insuredAndBonded !== undefined) update('insuredAndBonded', next.insuredAndBonded as AccountFaq['insuredAndBonded']);
          if (next.bringsSupplies !== undefined) update('bringsSupplies', next.bringsSupplies as AccountFaq['bringsSupplies']);
          if (next.petPolicy !== undefined) update('petPolicy', next.petPolicy as AccountFaq['petPolicy']);
          if (next.paymentMethods !== undefined) update('paymentMethods', next.paymentMethods);
          if (next.customerMustBeHome !== undefined) update('customerMustBeHome', next.customerMustBeHome as AccountFaq['customerMustBeHome']);
        }}
      />

      {/* Same cleaner */}
      <div>
        <label className={labelCls}>Same cleaner for recurring visits?</label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: 'unset', label: 'Not set' },
            { key: 'try', label: 'We try, not guaranteed' },
            { key: 'guaranteed', label: 'Yes, guaranteed' },
            { key: 'no', label: 'No, varies each visit' },
          ].map(o => {
            const active = (faq.sameCleanerForRecurring?.value || 'unset') === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => update('sameCleanerForRecurring', { ...faq.sameCleanerForRecurring, value: o.key as any })}
                className={`${chipBaseCls} text-left ${active ? chipActiveCls : chipInactiveCls}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scope — with upload-checklist buttons */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className={`${labelCls} mb-0`}>Standard cleaning includes</label>
            <button
              type="button"
              onClick={() => standardFileRef.current?.click()}
              disabled={uploading === 'standard'}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 rounded-lg text-[11px] font-semibold transition-colors"
              title="Upload a checklist file (PDF, Word, Excel, image, TXT, CSV, MD)"
            >
              {uploading === 'standard' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Upload checklist
            </button>
            <input
              ref={standardFileRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ods,.txt,.md,.markdown,.csv,.tsv,.rtf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.heic,.heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet,text/plain,text/markdown,text/csv,text/tab-separated-values,text/rtf,image/*"
              onChange={e => handleChecklistUpload('standard', e)}
              className="hidden"
            />
          </div>
          <textarea
            value={faq.standardScope || ''}
            onChange={e => update('standardScope', e.target.value)}
            placeholder="e.g. Kitchen surfaces & appliances exterior, all bathrooms, dusting, vacuuming, mopping. Or upload a checklist file above."
            rows={5}
            className={inputCls}
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className={`${labelCls} mb-0`}>Deep cleaning includes</label>
            <button
              type="button"
              onClick={() => deepFileRef.current?.click()}
              disabled={uploading === 'deep'}
              className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 rounded-lg text-[11px] font-semibold transition-colors"
              title="Upload a checklist file (PDF, Word, Excel, image, TXT, CSV, MD)"
            >
              {uploading === 'deep' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />}
              Upload checklist
            </button>
            <input
              ref={deepFileRef}
              type="file"
              accept=".pdf,.doc,.docx,.xls,.xlsx,.xlsm,.ods,.txt,.md,.markdown,.csv,.tsv,.rtf,.png,.jpg,.jpeg,.webp,.gif,.bmp,.heic,.heif,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.oasis.opendocument.spreadsheet,text/plain,text/markdown,text/csv,text/tab-separated-values,text/rtf,image/*"
              onChange={e => handleChecklistUpload('deep', e)}
              className="hidden"
            />
          </div>
          <textarea
            value={faq.deepScope || ''}
            onChange={e => update('deepScope', e.target.value)}
            placeholder="e.g. Everything in standard + baseboards, inside cabinets, doors & frames, detailed scrubbing. Or upload a checklist file above."
            rows={5}
            className={inputCls}
          />
        </div>
      </div>

      {/* Labor rate + crew sizing */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Labor rate per cleaner-hour ($)</label>
          <input
            type="number"
            min={0}
            step={1}
            value={faq.laborRatePerCleanerHour ?? ''}
            onChange={e => update('laborRatePerCleanerHour', e.target.value === '' ? undefined : Number(e.target.value))}
            placeholder="50"
            className={inputCls}
          />
          <p className="text-[10px] text-slate-400 mt-1">Used by the AI for labor-hour math (cleaners × hours × rate). Leave blank to use the global default of $50.</p>
        </div>
        <div>
          <label className={labelCls}>Crew sizing rule</label>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <input
                type="number"
                min={1}
                value={faq.crewSizeRule?.hoursThreshold ?? ''}
                onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, hoursThreshold: Number(e.target.value) })}
                placeholder="4"
                className={inputCls}
              />
              <p className="text-[10px] text-slate-500 mt-1 leading-tight">Hours threshold (job length)</p>
            </div>
            <div>
              <input
                type="number"
                min={1}
                value={faq.crewSizeRule?.sizeUnder ?? ''}
                onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, sizeUnder: Number(e.target.value) })}
                placeholder="1"
                className={inputCls}
              />
              <p className="text-[10px] text-slate-500 mt-1 leading-tight">Cleaners if job ≤ threshold</p>
            </div>
            <div>
              <input
                type="number"
                min={1}
                value={faq.crewSizeRule?.sizeOver ?? ''}
                onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, sizeOver: Number(e.target.value) })}
                placeholder="2"
                className={inputCls}
              />
              <p className="text-[10px] text-slate-500 mt-1 leading-tight">Cleaners if job &gt; threshold</p>
            </div>
          </div>
          {(() => {
            const t = faq.crewSizeRule?.hoursThreshold;
            const u = faq.crewSizeRule?.sizeUnder;
            const o = faq.crewSizeRule?.sizeOver;
            const ready = Number(t) > 0 && Number(u) > 0 && Number(o) > 0;
            return (
              <p className="text-[11px] text-slate-600 mt-2 bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                {ready ? (
                  <>Plain English: <span className="font-semibold">send {u} cleaner{u === 1 ? '' : 's'} for jobs up to {t} hour{t === 1 ? '' : 's'}, {o} cleaners for jobs over {t} hour{t === 1 ? '' : 's'}.</span> Same total price either way — 2 cleaners just cut on-site time roughly in half.</>
                ) : (
                  <>Default: 1 cleaner for jobs up to 4 hours, 2 cleaners for jobs over 4 hours. Same total price either way.</>
                )}
              </p>
            );
          })()}
        </div>
      </div>

      {/* Custom Q&A — unified collapsible section with FaqRow per pair,
          matching the Custom service FAQ tab and the pricing tables. */}
      <CollapsibleSection
        title="Custom Q&A"
        icon={<MessageSquare size={14} color="var(--lb-ink-5, #64748b)" />}
        rightBadge={
          (faq.customQA || []).length > 0 && (
            <span
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--lb-ink-5, #64748b)',
                background: 'var(--lb-ink-10, #f3f5fa)',
                padding: '3px 8px',
                borderRadius: 999,
                letterSpacing: '0.02em',
              }}
            >
              {(faq.customQA || []).length}{' '}
              {(faq.customQA || []).length === 1 ? 'row' : 'rows'}
            </span>
          )
        }
      >
        {(faq.customQA || []).length === 0 ? (
          <div
            style={{
              padding: 18,
              margin: '0 14px 8px',
              border: '1px dashed var(--lb-line, #e5e9f2)',
              borderRadius: 10,
              background: 'var(--lb-bg, #f4f6fa)',
              textAlign: 'center',
            }}
          >
            <div style={{ fontSize: 13, color: 'var(--lb-ink-5, #64748b)', marginBottom: 10 }}>
              Add anything the AI should know how to answer. Examples: weekend availability,
              eco product brands, parking instructions.
            </div>
            <UnifiedAddRowButton label="Add Q&A" onClick={addCustomQA} />
          </div>
        ) : (
          <>
            {(faq.customQA || []).map((qa, idx) => (
              <FaqRow
                key={idx}
                index={idx}
                question={qa.question || ''}
                answer={qa.answer || ''}
                onChangeQuestion={(v) => updateCustomQA(idx, 'question', v)}
                onChangeAnswer={(v) => updateCustomQA(idx, 'answer', v)}
                onRemove={() => removeCustomQA(idx)}
              />
            ))}
            <div style={{ padding: '12px 14px 4px' }}>
              <UnifiedAddRowButton label="Add row" onClick={addCustomQA} />
            </div>
          </>
        )}
      </CollapsibleSection>

      {/* Save — full-width footer pill, same as Save Pricing across the playbook. */}
      <div className="pt-2 border-t border-slate-100">
        <UnifiedSaveButton
          label="Save FAQ"
          dirty
          saving={saving}
          savedAt={saved ? Date.now() : null}
          onClick={() => void handleSave()}
          fullWidth
        />
      </div>
    </div>
  );
}
