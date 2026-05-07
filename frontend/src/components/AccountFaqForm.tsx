import { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

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

const PAYMENT_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'cash', label: 'Cash' },
  { key: 'check', label: 'Check' },
  { key: 'venmo', label: 'Venmo' },
  { key: 'zelle', label: 'Zelle' },
  { key: 'credit_card', label: 'Credit card' },
  { key: 'debit_card', label: 'Debit card' },
  { key: 'invoice', label: 'Invoice' },
  { key: 'paypal', label: 'PayPal' },
];

interface AccountFaqFormProps {
  accountId: string;
  accountName: string;
  saveToAll?: string[];
}

export default function AccountFaqForm({ accountId, accountName, saveToAll }: AccountFaqFormProps) {
  const [faq, setFaq] = useState<AccountFaq | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [inherited, setInherited] = useState(false);

  const loadId = saveToAll && saveToAll.length > 0 ? saveToAll[0] : accountId;
  useEffect(() => {
    if (!loadId) return;
    setLoading(true);
    usersApi.getAccountFaq(loadId)
      .then(res => {
        setFaq({ ...DEFAULT_FAQ, ...(res.faq || {}) });
        setInherited(!!res.inherited);
      })
      .catch(() => setFaq(DEFAULT_FAQ))
      .finally(() => setLoading(false));
  }, [loadId]);

  const update = <K extends keyof AccountFaq>(key: K, value: AccountFaq[K]) => {
    setFaq(prev => ({ ...(prev || DEFAULT_FAQ), [key]: value }));
  };

  const togglePayment = (key: string) => {
    setFaq(prev => {
      const current = prev?.paymentMethods || [];
      const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      return { ...(prev || DEFAULT_FAQ), paymentMethods: next };
    });
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
      if (saveToAll && saveToAll.length > 0) {
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
  const labelCls = 'block text-[11px] font-bold text-slate-400 uppercase tracking-widest mb-2';

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

      {/* Insurance / bonded */}
      <div>
        <label className={labelCls}>Are you insured & bonded?</label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: 'unset', label: 'Not set' },
            { key: 'yes', label: 'Yes' },
            { key: 'no', label: 'No' },
          ].map(o => {
            const active = (faq.insuredAndBonded?.value || 'unset') === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => update('insuredAndBonded', { ...faq.insuredAndBonded, value: o.key as any })}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {faq.insuredAndBonded?.value === 'yes' && (
          <input
            type="text"
            value={faq.insuredAndBonded?.details || ''}
            onChange={e => update('insuredAndBonded', { ...faq.insuredAndBonded, details: e.target.value })}
            placeholder="Optional details (e.g. carrier, coverage amount)"
            className={`${inputCls} mt-2`}
          />
        )}
      </div>

      {/* Supplies */}
      <div>
        <label className={labelCls}>Do you bring supplies & equipment?</label>
        <div className="grid grid-cols-3 gap-2">
          {[
            { key: 'unset', label: 'Not set' },
            { key: 'yes', label: 'Yes, we bring everything' },
            { key: 'no', label: 'No, customer provides' },
          ].map(o => {
            const active = (faq.bringsSupplies?.value || 'unset') === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => update('bringsSupplies', { ...faq.bringsSupplies, value: o.key as any })}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        <input
          type="text"
          value={faq.bringsSupplies?.details || ''}
          onChange={e => update('bringsSupplies', { ...faq.bringsSupplies, details: e.target.value })}
          placeholder="Optional notes (e.g. eco-friendly products, fragrance-free available on request)"
          className={`${inputCls} mt-2`}
        />
      </div>

      {/* Pet policy */}
      <div>
        <label className={labelCls}>Pet policy</label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: 'unset', label: 'Not set' },
            { key: 'pet_friendly', label: 'Pet-friendly, no charge' },
            { key: 'extra_charge', label: 'Extra charge for pets' },
            { key: 'no_pets', label: "We don't service homes with pets" },
          ].map(o => {
            const active = (faq.petPolicy?.value || 'unset') === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => update('petPolicy', { ...faq.petPolicy, value: o.key as any })}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all text-left ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {faq.petPolicy?.value === 'extra_charge' && (
          <input
            type="text"
            value={faq.petPolicy?.details || ''}
            onChange={e => update('petPolicy', { ...faq.petPolicy, details: e.target.value })}
            placeholder="Pet surcharge details (e.g. $20 per visit)"
            className={`${inputCls} mt-2`}
          />
        )}
      </div>

      {/* Payment methods */}
      <div>
        <label className={labelCls}>Accepted payment methods</label>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {PAYMENT_OPTIONS.map(opt => {
            const active = (faq.paymentMethods || []).includes(opt.key);
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => togglePayment(opt.key)}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Must be home */}
      <div>
        <label className={labelCls}>Does the customer need to be home?</label>
        <div className="grid grid-cols-2 gap-2">
          {[
            { key: 'unset', label: 'Not set' },
            { key: 'no', label: 'No, just need access' },
            { key: 'yes', label: 'Yes, they should be home' },
            { key: 'optional', label: 'Either way works' },
          ].map(o => {
            const active = (faq.customerMustBeHome?.value || 'unset') === o.key;
            return (
              <button
                key={o.key}
                type="button"
                onClick={() => update('customerMustBeHome', { ...faq.customerMustBeHome, value: o.key as any })}
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all text-left ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
        {faq.customerMustBeHome?.value === 'no' && (
          <input
            type="text"
            value={faq.customerMustBeHome?.details || ''}
            onChange={e => update('customerMustBeHome', { ...faq.customerMustBeHome, details: e.target.value })}
            placeholder="How we get in (e.g. lockbox code, key under mat, doorman)"
            className={`${inputCls} mt-2`}
          />
        )}
      </div>

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
                className={`py-2 px-3 rounded-xl text-xs font-semibold border-2 transition-all text-left ${active ? 'bg-blue-600 text-white border-blue-600' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Scope */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Standard cleaning includes</label>
          <textarea
            value={faq.standardScope || ''}
            onChange={e => update('standardScope', e.target.value)}
            placeholder="e.g. Kitchen surfaces & appliances exterior, all bathrooms, dusting, vacuuming, mopping"
            rows={3}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>Deep cleaning includes</label>
          <textarea
            value={faq.deepScope || ''}
            onChange={e => update('deepScope', e.target.value)}
            placeholder="e.g. Everything in standard + baseboards, inside cabinets, doors & frames, detailed scrubbing"
            rows={3}
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
            <input
              type="number"
              min={1}
              value={faq.crewSizeRule?.hoursThreshold ?? ''}
              onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, hoursThreshold: Number(e.target.value) })}
              placeholder="Hours"
              className={inputCls}
            />
            <input
              type="number"
              min={1}
              value={faq.crewSizeRule?.sizeUnder ?? ''}
              onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, sizeUnder: Number(e.target.value) })}
              placeholder="Cleaners ≤"
              className={inputCls}
            />
            <input
              type="number"
              min={1}
              value={faq.crewSizeRule?.sizeOver ?? ''}
              onChange={e => update('crewSizeRule', { ...faq.crewSizeRule, sizeOver: Number(e.target.value) })}
              placeholder="Cleaners >"
              className={inputCls}
            />
          </div>
          <p className="text-[10px] text-slate-400 mt-1">Default: 1 cleaner if ≤4 hours, 2 if &gt;4 hours. Same total price either way.</p>
        </div>
      </div>

      {/* Custom Q&A */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className={`${labelCls} mb-0`}>Custom Q&amp;A</label>
          <button
            type="button"
            onClick={addCustomQA}
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg text-[11px] font-semibold transition-colors"
          >
            <Plus className="w-3 h-3" /> Add Q&amp;A
          </button>
        </div>
        <p className="text-[10px] text-slate-400 mb-2">Add anything the AI should know how to answer. Examples: weekend availability, eco product brands, parking instructions.</p>
        {(faq.customQA || []).length === 0 && (
          <div className="text-[11px] text-slate-400 italic px-3 py-3 bg-slate-50 border border-dashed border-slate-200 rounded-xl">No custom entries yet.</div>
        )}
        <div className="space-y-2">
          {(faq.customQA || []).map((qa, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2 items-start">
              <input
                type="text"
                value={qa.question || ''}
                onChange={e => updateCustomQA(idx, 'question', e.target.value)}
                placeholder="Question"
                className={inputCls}
              />
              <input
                type="text"
                value={qa.answer || ''}
                onChange={e => updateCustomQA(idx, 'answer', e.target.value)}
                placeholder="Answer (the AI will use this verbatim)"
                className={inputCls}
              />
              <button
                type="button"
                onClick={() => removeCustomQA(idx)}
                className="p-2 text-slate-400 hover:text-red-600 transition-colors"
                title="Remove"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center gap-3 pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'Saving...' : 'Save FAQ'}
        </button>
        {saved && <span className="text-xs text-green-700 font-semibold">Saved.</span>}
      </div>
    </div>
  );
}
