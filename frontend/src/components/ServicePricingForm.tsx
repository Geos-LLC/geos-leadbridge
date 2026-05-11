import { useState, useEffect } from 'react';
import { Plus, Trash2, Save, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { usersApi } from '../services/api';

// Default cleaning pricing based on Spotless Homes structure
export const DEFAULT_CLEANING_PRICING = {
  serviceType: 'cleaning',
  cleaningTypes: [
    { key: 'regular', label: 'Regular Cleaning', enabled: true },
    { key: 'deep', label: 'Moving / Deep Cleaning', enabled: true },
    { key: 'airbnb', label: 'Airbnb Turnaround', enabled: true },
  ],
  priceTable: [
    { bed: 1, bath: 1, sqftMin: 600,  sqftMax: 800,  regular: 129, deep: 179, airbnb: 139 },
    { bed: 1, bath: 2, sqftMin: 700,  sqftMax: 900,  regular: 129, deep: 179, airbnb: 139 },
    { bed: 2, bath: 1, sqftMin: 800,  sqftMax: 1000, regular: 139, deep: 179, airbnb: 149 },
    { bed: 2, bath: 2, sqftMin: 1000, sqftMax: 1200, regular: 139, deep: 189, airbnb: 159 },
    { bed: 2, bath: 3, sqftMin: 1100, sqftMax: 1300, regular: 149, deep: 199, airbnb: 169 },
    { bed: 3, bath: 1, sqftMin: 1000, sqftMax: 1200, regular: 149, deep: 209, airbnb: 169 },
    { bed: 3, bath: 2, sqftMin: 1300, sqftMax: 1600, regular: 159, deep: 219, airbnb: 179 },
    { bed: 3, bath: 3, sqftMin: 1500, sqftMax: 1800, regular: 169, deep: 229, airbnb: 189 },
    { bed: 3, bath: 4, sqftMin: 1800, sqftMax: 2200, regular: 179, deep: 239, airbnb: 199 },
    { bed: 4, bath: 2, sqftMin: 1800, sqftMax: 2200, regular: 189, deep: 259, airbnb: 209 },
    { bed: 4, bath: 3, sqftMin: 2200, sqftMax: 2600, regular: 209, deep: 279, airbnb: 229 },
    { bed: 4, bath: 4, sqftMin: 2600, sqftMax: 3000, regular: 229, deep: 309, airbnb: 249 },
    { bed: 4, bath: 5, sqftMin: 3000, sqftMax: 3600, regular: 249, deep: 339, airbnb: 269 },
    { bed: 5, bath: 2, sqftMin: 2400, sqftMax: 2800, regular: 239, deep: 319, airbnb: 259 },
    { bed: 5, bath: 3, sqftMin: 2800, sqftMax: 3400, regular: 249, deep: 329, airbnb: 279 },
    { bed: 5, bath: 4, sqftMin: 3200, sqftMax: 3800, regular: 269, deep: 349, airbnb: 299 },
    { bed: 5, bath: 5, sqftMin: 3600, sqftMax: 4200, regular: 289, deep: 369, airbnb: 319 },
    { bed: 6, bath: 3, sqftMin: 3000, sqftMax: 3600, regular: 289, deep: 379, airbnb: 329 },
    { bed: 6, bath: 4, sqftMin: 3600, sqftMax: 4200, regular: 309, deep: 389, airbnb: 349 },
    { bed: 6, bath: 5, sqftMin: 4000, sqftMax: 4800, regular: 329, deep: 409, airbnb: 369 },
  ],
  sqftAdjustEnabled: true,
  frequencyDiscounts: [
    { key: 'weekly', label: 'Weekly', discount: 15 },
    { key: 'biweekly', label: 'Every 2 Weeks', discount: 10 },
    { key: 'monthly', label: 'Monthly', discount: 10 },
    { key: 'once', label: 'One Time', discount: 0 },
  ],
  extras: [
    { key: 'oven', label: 'Inside Oven', price: 40 },
    { key: 'fridge', label: 'Inside Fridge', price: 40 },
    { key: 'cabinet', label: 'Inside Kitchen Cabinets', price: 30 },
    { key: 'laundry', label: 'Laundry (per load)', price: 20 },
    { key: 'dishes', label: 'Dishes (1 load included)', price: 20 },
    { key: 'windows', label: 'Inside Windows (per window)', price: 20 },
    { key: 'blinds', label: 'Blinds (per window)', price: 10 },
    { key: 'baseboard', label: 'Baseboard Cleaning (per room)', price: 15 },
    { key: 'patio_door', label: 'Patio Door', price: 50 },
    { key: 'patio_garage', label: 'Patio / Garage', price: 50 },
  ],
  conditionSurcharges: [
    { key: 'well_maintained', label: 'Well Maintained', surcharge: 0 },
    { key: 'fair', label: 'Fair Condition', surcharge: 50 },
    { key: 'needs_attention', label: 'Needs Attention', surcharge: 100 },
  ],
  petSurcharge: 20,
  orderDiscounts: [
    { minAmount: 200, discount: 10 },
    { minAmount: 300, discount: 15 },
  ],
  recurringDiscount: 10,
  priceRange: {
    minus: { type: '%', value: 10 },
    plus: { type: '%', value: 10 },
  },
};

interface ServicePricingFormProps {
  accountId: string;
  accountName: string;
  saveToAll?: string[]; // array of account IDs to save to (shared pricing mode)
}

export default function ServicePricingForm({ accountId, accountName, saveToAll }: ServicePricingFormProps) {
  const [pricing, setPricing] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ priceTable: true });

  // In shared mode, load from the first account; otherwise from the selected one.
  // Depend on the primitive id, not the saveToAll array — callers frequently build
  // that array inline (accounts.map(...)), which would otherwise retrigger the load
  // on every parent render and loop the "Loading pricing..." spinner.
  const loadId = saveToAll && saveToAll.length > 0 ? saveToAll[0] : accountId;
  useEffect(() => {
    if (!loadId) return;
    setLoading(true);
    usersApi.getServicePricing(loadId)
      .then(res => setPricing(res.pricing || DEFAULT_CLEANING_PRICING))
      .catch(() => setPricing(DEFAULT_CLEANING_PRICING))
      .finally(() => setLoading(false));
  }, [loadId]);

  const toggleSection = (key: string) => setExpandedSections(p => ({ ...p, [key]: !p[key] }));

  const updatePriceCell = (rowIdx: number, col: string, value: number) => {
    setPricing((p: any) => {
      const table = [...p.priceTable];
      table[rowIdx] = { ...table[rowIdx], [col]: value };
      return { ...p, priceTable: table };
    });
  };

  const updateExtra = (idx: number, field: string, value: any) => {
    setPricing((p: any) => {
      const extras = [...p.extras];
      extras[idx] = { ...extras[idx], [field]: value };
      return { ...p, extras };
    });
  };

  const addExtra = () => {
    setPricing((p: any) => ({
      ...p,
      extras: [...p.extras, { key: `extra_${Date.now()}`, label: '', price: 0 }],
    }));
  };

  const removeExtra = (idx: number) => {
    setPricing((p: any) => ({ ...p, extras: p.extras.filter((_: any, i: number) => i !== idx) }));
  };

  const updateFreqDiscount = (idx: number, discount: number) => {
    setPricing((p: any) => {
      const fd = [...p.frequencyDiscounts];
      fd[idx] = { ...fd[idx], discount };
      return { ...p, frequencyDiscounts: fd };
    });
  };

  const updateConditionSurcharge = (idx: number, surcharge: number) => {
    setPricing((p: any) => {
      const cs = [...p.conditionSurcharges];
      cs[idx] = { ...cs[idx], surcharge };
      return { ...p, conditionSurcharges: cs };
    });
  };

  const addPriceRow = () => {
    setPricing((p: any) => ({
      ...p,
      priceTable: [...p.priceTable, { bed: 1, bath: 1, sqftMin: 600, sqftMax: 800, regular: 0, deep: 0, move: 0, airbnb: 0 }],
    }));
  };

  const removePriceRow = (idx: number) => {
    setPricing((p: any) => ({ ...p, priceTable: p.priceTable.filter((_: any, i: number) => i !== idx) }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (saveToAll && saveToAll.length > 0) {
        // Save to all accounts in parallel
        await Promise.all(saveToAll.map(id => usersApi.updateServicePricing(id, pricing)));
      } else {
        await usersApi.updateServicePricing(accountId, pricing);
      }
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      alert('Failed to save pricing');
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex items-center gap-2 text-sm text-slate-400 py-4"><Loader2 size={16} className="animate-spin" /> Loading pricing...</div>;
  if (!pricing) return null;

  const enabledTypes = pricing.cleaningTypes?.filter((t: any) => t.enabled) || [];

  return (
    <div className="space-y-4">
      {/* Service Type Header */}
      <div className="flex items-center justify-between">
        <div>
          <h4 className="text-xs font-bold text-slate-400 uppercase tracking-wider">Service Pricing</h4>
          <p className="text-[11px] text-slate-400 mt-0.5">{accountName}</p>
        </div>
        <select
          value={pricing.serviceType}
          onChange={e => setPricing((p: any) => ({ ...p, serviceType: e.target.value }))}
          className="text-xs px-2 py-1 border border-slate-200 rounded-lg bg-white"
        >
          <option value="cleaning">Cleaning Service</option>
          <option value="plumbing">Plumbing</option>
          <option value="landscaping">Landscaping</option>
          <option value="handyman">Handyman</option>
          <option value="other">Other Service</option>
        </select>
      </div>

      {/* Cleaning Types Toggle */}
      <div>
        <div className="text-[11px] font-semibold text-slate-600 mb-1.5">Service Types</div>
        <div className="flex flex-wrap gap-1.5">
          {pricing.cleaningTypes?.map((ct: any, i: number) => (
            <button
              key={ct.key}
              onClick={() => {
                const types = [...pricing.cleaningTypes];
                types[i] = { ...types[i], enabled: !types[i].enabled };
                setPricing((p: any) => ({ ...p, cleaningTypes: types }));
              }}
              className={`text-[10px] px-2 py-1 rounded-lg font-semibold transition-colors ${
                ct.enabled ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'
              }`}
            >
              {ct.label}
            </button>
          ))}
        </div>
      </div>

      {/* Square footage adjustment toggle */}
      <label className="flex items-start gap-2 px-3 py-2 border border-slate-200 rounded-xl cursor-pointer select-none">
        <input
          type="checkbox"
          checked={pricing.sqftAdjustEnabled !== false}
          onChange={e => setPricing((p: any) => ({ ...p, sqftAdjustEnabled: e.target.checked }))}
          className="accent-blue-600 w-4 h-4 rounded mt-0.5"
        />
        <div className="flex-1">
          <div className="text-[12px] font-semibold text-slate-700">Adjust price by square footage</div>
          <div className="text-[10px] text-slate-400 mt-0.5">
            When the lead's reported sqft exceeds the row's <span className="font-semibold">Sqft Max</span>, AI scales the price using the row's $/sqft (computed at the midpoint of the range). Properties within the min–max range use the table price as-is.
          </div>
        </div>
      </label>

      {/* Price Table */}
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('priceTable')}
          className="w-full px-3 py-2 flex items-center justify-between bg-slate-50 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
        >
          <span>Price Table ({pricing.priceTable?.length || 0} rows)</span>
          {expandedSections.priceTable ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expandedSections.priceTable && (
          <div className="overflow-x-auto">
            <table className="w-full text-[10px]">
              <thead>
                <tr className="bg-slate-50 text-slate-500">
                  <th className="px-2 py-1.5 text-left font-semibold">Bed</th>
                  <th className="px-2 py-1.5 text-left font-semibold">Bath</th>
                  <th className="px-2 py-1.5 text-left font-semibold" title="Smallest property size this row's price applies to">Sqft Min</th>
                  <th className="px-2 py-1.5 text-left font-semibold" title="Largest property size at the row's price — beyond this, AI scales by $/sqft">Sqft Max</th>
                  {enabledTypes.map((t: any) => (
                    <th key={t.key} className="px-2 py-1.5 text-left font-semibold">{t.label}</th>
                  ))}
                  {enabledTypes.map((t: any) => (
                    <th key={`psf-${t.key}`} className="px-2 py-1.5 text-left font-semibold text-slate-400" title={`${t.label} price per square foot — derived from price ÷ midpoint of the sqft range`}>
                      $/sqft {t.label.split(' ')[0]}
                    </th>
                  ))}
                  <th className="px-2 py-1.5 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {pricing.priceTable?.map((row: any, i: number) => {
                  // Back-compat: rows saved before the min/max split carried a single `sqft` field.
                  const legacySqft = Number(row.sqft) || 0;
                  const sqftMin = Number(row.sqftMin) || legacySqft;
                  const sqftMax = Number(row.sqftMax) || legacySqft;
                  const midpoint = sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : (sqftMin || sqftMax);
                  return (
                  <tr key={i} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-1 py-1">
                      <input type="number" value={row.bed} min={1} max={10}
                        onChange={e => updatePriceCell(i, 'bed', parseInt(e.target.value) || 1)}
                        className="w-10 px-1 py-0.5 border border-slate-200 rounded text-center text-[10px]" />
                    </td>
                    <td className="px-1 py-1">
                      <input type="number" value={row.bath} min={1} max={10}
                        onChange={e => updatePriceCell(i, 'bath', parseInt(e.target.value) || 1)}
                        className="w-10 px-1 py-0.5 border border-slate-200 rounded text-center text-[10px]" />
                    </td>
                    <td className="px-1 py-1">
                      <input type="number" value={row.sqftMin ?? ''} min={0} step={50}
                        onChange={e => updatePriceCell(i, 'sqftMin', parseInt(e.target.value) || 0)}
                        className="w-16 px-1 py-0.5 border border-slate-200 rounded text-center text-[10px]" />
                    </td>
                    <td className="px-1 py-1">
                      <input type="number" value={row.sqftMax ?? ''} min={0} step={50}
                        onChange={e => updatePriceCell(i, 'sqftMax', parseInt(e.target.value) || 0)}
                        className="w-16 px-1 py-0.5 border border-slate-200 rounded text-center text-[10px]" />
                    </td>
                    {enabledTypes.map((t: any) => (
                      <td key={t.key} className="px-1 py-1">
                        <div className="flex items-center">
                          <span className="text-slate-400 text-[9px] mr-0.5">$</span>
                          <input type="number" value={row[t.key] || 0} min={0}
                            onChange={e => updatePriceCell(i, t.key, parseInt(e.target.value) || 0)}
                            className="w-14 px-1 py-0.5 border border-slate-200 rounded text-[10px]" />
                        </div>
                      </td>
                    ))}
                    {enabledTypes.map((t: any) => {
                      const price = Number(row[t.key]) || 0;
                      const perSqft = midpoint > 0 ? price / midpoint : 0;
                      return (
                        <td key={`psf-${t.key}`} className="px-1 py-1">
                          <span className="text-slate-400 text-[10px]">
                            {midpoint > 0 ? `$${perSqft.toFixed(3)}` : '—'}
                          </span>
                        </td>
                      );
                    })}
                    <td className="px-1 py-1">
                      <button onClick={() => removePriceRow(i)} className="text-slate-300 hover:text-red-500">
                        <Trash2 size={10} />
                      </button>
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
            <button onClick={addPriceRow}
              className="w-full px-3 py-1.5 text-[10px] text-blue-600 hover:bg-blue-50 flex items-center justify-center gap-1 border-t border-slate-100">
              <Plus size={10} /> Add row
            </button>
          </div>
        )}
      </div>

      {/* Frequency Discounts */}
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('frequency')}
          className="w-full px-3 py-2 flex items-center justify-between bg-slate-50 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
        >
          <span>Frequency Discounts</span>
          {expandedSections.frequency ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expandedSections.frequency && (
          <div className="px-3 py-2 space-y-1.5">
            {pricing.frequencyDiscounts?.map((fd: any, i: number) => (
              <div key={fd.key} className="flex items-center justify-between">
                <span className="text-[11px] text-slate-600">{fd.label}</span>
                <div className="flex items-center gap-1">
                  <input type="number" value={fd.discount} min={0} max={50}
                    onChange={e => updateFreqDiscount(i, parseInt(e.target.value) || 0)}
                    className="w-12 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
                  <span className="text-[10px] text-slate-400">%</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add-ons / Extras */}
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('extras')}
          className="w-full px-3 py-2 flex items-center justify-between bg-slate-50 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
        >
          <span>Add-ons ({pricing.extras?.length || 0})</span>
          {expandedSections.extras ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expandedSections.extras && (
          <div className="px-3 py-2 space-y-1.5">
            {pricing.extras?.map((ex: any, i: number) => (
              <div key={ex.key} className="flex items-center gap-2">
                <input type="text" value={ex.label} placeholder="Add-on name"
                  onChange={e => updateExtra(i, 'label', e.target.value)}
                  className="flex-1 px-2 py-1 border border-slate-200 rounded text-[10px]" />
                <div className="flex items-center gap-0.5 shrink-0">
                  <span className="text-slate-400 text-[9px]">$</span>
                  <input type="number" value={ex.price} min={0}
                    onChange={e => updateExtra(i, 'price', parseInt(e.target.value) || 0)}
                    className="w-12 px-1 py-1 border border-slate-200 rounded text-[10px] text-center" />
                </div>
                <button onClick={() => removeExtra(i)} className="text-slate-300 hover:text-red-500 shrink-0">
                  <Trash2 size={10} />
                </button>
              </div>
            ))}
            <button onClick={addExtra}
              className="w-full py-1 text-[10px] text-blue-600 hover:bg-blue-50 flex items-center justify-center gap-1 rounded">
              <Plus size={10} /> Add extra
            </button>
          </div>
        )}
      </div>

      {/* Condition Surcharges + Pet Surcharge */}
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('surcharges')}
          className="w-full px-3 py-2 flex items-center justify-between bg-slate-50 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
        >
          <span>Surcharges</span>
          {expandedSections.surcharges ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expandedSections.surcharges && (
          <div className="px-3 py-2 space-y-2">
            <div className="text-[10px] font-semibold text-slate-500">Property Condition</div>
            {pricing.conditionSurcharges?.map((cs: any, i: number) => (
              <div key={cs.key} className="flex items-center justify-between">
                <span className="text-[11px] text-slate-600">{cs.label}</span>
                <div className="flex items-center gap-1">
                  <span className="text-[10px] text-slate-400">+$</span>
                  <input type="number" value={cs.surcharge} min={0}
                    onChange={e => updateConditionSurcharge(i, parseInt(e.target.value) || 0)}
                    className="w-14 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
                </div>
              </div>
            ))}
            <div className="border-t border-slate-100 pt-2 flex items-center justify-between">
              <span className="text-[11px] text-slate-600">Pet Surcharge</span>
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-slate-400">+$</span>
                <input type="number" value={pricing.petSurcharge || 0} min={0}
                  onChange={e => setPricing((p: any) => ({ ...p, petSurcharge: parseInt(e.target.value) || 0 }))}
                  className="w-14 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Discounts */}
      <div className="border border-slate-200 rounded-xl overflow-hidden">
        <button
          onClick={() => toggleSection('discounts')}
          className="w-full px-3 py-2 flex items-center justify-between bg-slate-50 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
        >
          <span>Discounts</span>
          {expandedSections.discounts ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {expandedSections.discounts && (
          <div className="px-3 py-2 space-y-3">
            {/* Recurring cleaning discount */}
            <div>
              <div className="text-[10px] font-semibold text-slate-500 mb-1">Recurring Cleaning Discount</div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-600">Discount for recurring customers</span>
                <div className="flex items-center gap-1">
                  <input type="number" value={pricing.recurringDiscount || 0} min={0} max={50}
                    onChange={e => setPricing((p: any) => ({ ...p, recurringDiscount: parseInt(e.target.value) || 0 }))}
                    className="w-12 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
                  <span className="text-[10px] text-slate-400">%</span>
                </div>
              </div>
            </div>

            {/* Order amount discounts */}
            <div className="border-t border-slate-100 pt-2">
              <div className="text-[10px] font-semibold text-slate-500 mb-1.5">Order Amount Discounts</div>
              <div className="space-y-1.5">
                {(pricing.orderDiscounts || []).map((od: any, i: number) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">Over</span>
                    <div className="flex items-center gap-0.5">
                      <span className="text-[9px] text-slate-400">$</span>
                      <input type="number" value={od.minAmount} min={0}
                        onChange={e => {
                          const ods = [...(pricing.orderDiscounts || [])];
                          ods[i] = { ...ods[i], minAmount: parseInt(e.target.value) || 0 };
                          setPricing((p: any) => ({ ...p, orderDiscounts: ods }));
                        }}
                        className="w-16 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
                    </div>
                    <span className="text-[10px] text-slate-500">→</span>
                    <div className="flex items-center gap-0.5">
                      <input type="number" value={od.discount} min={0} max={50}
                        onChange={e => {
                          const ods = [...(pricing.orderDiscounts || [])];
                          ods[i] = { ...ods[i], discount: parseInt(e.target.value) || 0 };
                          setPricing((p: any) => ({ ...p, orderDiscounts: ods }));
                        }}
                        className="w-12 px-1 py-0.5 border border-slate-200 rounded text-[10px] text-center" />
                      <span className="text-[10px] text-slate-400">% off</span>
                    </div>
                    <button onClick={() => {
                      setPricing((p: any) => ({ ...p, orderDiscounts: (p.orderDiscounts || []).filter((_: any, j: number) => j !== i) }));
                    }} className="text-slate-300 hover:text-red-500">
                      <Trash2 size={10} />
                    </button>
                  </div>
                ))}
                <button onClick={() => {
                  setPricing((p: any) => ({ ...p, orderDiscounts: [...(p.orderDiscounts || []), { minAmount: 0, discount: 0 }] }));
                }}
                  className="w-full py-1 text-[10px] text-blue-600 hover:bg-blue-50 flex items-center justify-center gap-1 rounded">
                  <Plus size={10} /> Add discount tier
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Save Button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full px-4 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saved ? 'Saved!' : 'Save Pricing'}
      </button>
    </div>
  );
}
