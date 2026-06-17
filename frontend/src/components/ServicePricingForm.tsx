import { useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import {
  Plus, Trash2, Save, Loader2, ChevronDown, ChevronRight,
  Table2, Repeat, PlusCircle, AlertCircle, BadgePercent,
  type LucideIcon,
} from 'lucide-react';
import { usersApi, serviceProfilesApi } from '../services/api';
import { DEFAULT_CLEANING_PRICING, hydratePricing } from '../data/defaultPricing';
import { IconTile, type IconTone } from './automation/ui';

// Re-export for downstream imports (Services.tsx, PricingSetupStep.tsx).
// The canonical definition lives in `../data/defaultPricing` so the wizard
// preview and AI Playbook share one source of truth.
export { DEFAULT_CLEANING_PRICING };

interface ServicePricingFormProps {
  accountId: string;
  accountName: string;
  saveToAll?: string[]; // array of account IDs to save to (shared pricing mode)
  // When set, the form loads/saves against a per-Service pricing blob
  // (ServiceProfile.pricingJson) instead of the SavedAccount pricing.
  // accountId is still required for display fallback but ignored at the
  // load/save layer. saveToAll is ignored in this mode — service pricing
  // is scoped to one profile, not fanned out across accounts.
  serviceProfileId?: string;
}

const MONO: CSSProperties = { fontFamily: 'var(--lb-font-mono)' };

const numInputStyle: CSSProperties = {
  border: '1px solid var(--lb-line)',
  borderRadius: 8,
  padding: '6px 8px',
  fontSize: 12.5,
  fontFamily: 'var(--lb-font-mono)',
  color: 'var(--lb-ink-1)',
  background: 'var(--lb-surface)',
  outline: 'none',
  textAlign: 'center',
};

const textInputStyle: CSSProperties = {
  border: '1px solid var(--lb-line)',
  borderRadius: 8,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'var(--lb-font-sans)',
  color: 'var(--lb-ink-1)',
  background: 'var(--lb-surface)',
  outline: 'none',
};

function SectionPanel({
  icon, iconTone, title, count, open, onToggle, children,
}: {
  icon: LucideIcon;
  iconTone: IconTone;
  title: ReactNode;
  count?: number | string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--lb-surface)',
      border: '1.5px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      overflow: 'hidden',
    }}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '12px 14px',
          background: 'var(--lb-surface)',
          border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left',
        }}
      >
        <IconTile icon={icon} tone={iconTone} size="sm" />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>{title}</span>
          {count !== undefined && (
            <span style={{
              ...MONO,
              fontSize: 11, fontWeight: 600, color: 'var(--lb-ink-5)',
              background: 'var(--lb-ink-10)',
              padding: '2px 8px', borderRadius: 999,
              letterSpacing: 0.02,
            }}>{count}</span>
          )}
        </div>
        {open ? <ChevronDown size={16} color="var(--lb-ink-5)" /> : <ChevronRight size={16} color="var(--lb-ink-5)" />}
      </button>
      {open && (
        <div style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function ServicePricingForm({ accountId, accountName, saveToAll, serviceProfileId }: ServicePricingFormProps) {
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
    setLoading(true);
    if (serviceProfileId) {
      // Per-Service pricing — load from ServiceProfile.pricingJson (string
      // of serialized pricing blob). Falls back to DEFAULT_CLEANING_PRICING
      // when missing/unparseable.
      serviceProfilesApi
        .get(serviceProfileId)
        .then(profile => {
          let parsed: any = null;
          if (profile.pricingJson) {
            try { parsed = JSON.parse(profile.pricingJson); } catch { /* fall through */ }
          }
          setPricing(hydratePricing(parsed || DEFAULT_CLEANING_PRICING));
        })
        .catch(() => setPricing(hydratePricing(DEFAULT_CLEANING_PRICING)))
        .finally(() => setLoading(false));
      return;
    }
    if (!loadId) { setLoading(false); return; }
    usersApi.getServicePricing(loadId)
      .then(res => setPricing(hydratePricing(res.pricing || DEFAULT_CLEANING_PRICING)))
      .catch(() => setPricing(hydratePricing(DEFAULT_CLEANING_PRICING)))
      .finally(() => setLoading(false));
  }, [loadId, serviceProfileId]);

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
      if (serviceProfileId) {
        await serviceProfilesApi.update(serviceProfileId, { pricingJson: JSON.stringify(pricing) });
      } else if (saveToAll && saveToAll.length > 0) {
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

  if (loading) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '14px 4px',
        fontSize: 13, color: 'var(--lb-ink-5)',
      }}>
        <Loader2 size={14} className="animate-spin" /> Loading pricing…
      </div>
    );
  }
  if (!pricing) return null;

  // Every cleaningType from the (hydrated) pricing renders as a column.
  // Legacy `enabled: false` is preserved on the JSON for back-compat but
  // does NOT hide a column. The user "disables" a service by entering 0
  // in every row of that column — see DEFAULT_CLEANING_PRICING comments.
  const allTypes = pricing.cleaningTypes || [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* Service Type Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{
            ...MONO,
            fontSize: 10.5, fontWeight: 700, color: 'var(--lb-ink-5)',
            letterSpacing: 0.06, textTransform: 'uppercase',
          }}>
            Service Pricing
          </div>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-2)', marginTop: 2 }}>
            {accountName}
          </div>
        </div>
        <div style={{ position: 'relative' }}>
          <select
            value={pricing.serviceType}
            onChange={e => setPricing((p: any) => ({ ...p, serviceType: e.target.value }))}
            style={{
              padding: '8px 30px 8px 12px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 13, fontWeight: 500, fontFamily: 'inherit',
              background: 'var(--lb-surface)', color: 'var(--lb-ink-1)',
              appearance: 'none', cursor: 'pointer', outline: 'none',
            }}
          >
            <option value="cleaning">Cleaning Service</option>
            <option value="plumbing">Plumbing</option>
            <option value="landscaping">Landscaping</option>
            <option value="handyman">Handyman</option>
            <option value="other">Other Service</option>
          </select>
          <ChevronDown size={14} style={{
            position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
            color: 'var(--lb-ink-5)', pointerEvents: 'none',
          }} />
        </div>
      </div>

      {/* Service Types row removed (2026-06-13). Hiding columns by toggle led
          to legacy accounts missing Deep Cleaning entirely from both the form
          and the AI prompt. The new rule: every service is always a column;
          to "disable" a service, the user enters 0 for every row of that
          column. See frontend/src/data/defaultPricing.ts. */}

      {/* Square footage adjustment toggle */}
      <label style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '12px 14px',
        background: 'var(--lb-surface)',
        border: '1.5px solid var(--lb-line)',
        borderRadius: 14,
        boxShadow: 'var(--lb-shadow-sm)',
        cursor: 'pointer',
        userSelect: 'none',
      }}>
        <input
          type="checkbox"
          checked={pricing.sqftAdjustEnabled !== false}
          onChange={e => setPricing((p: any) => ({ ...p, sqftAdjustEnabled: e.target.checked }))}
          style={{ accentColor: 'var(--lb-accent)', width: 16, height: 16, marginTop: 2 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
            Adjust price by square footage
          </div>
          <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 3, lineHeight: 1.45 }}>
            When the lead's reported sqft exceeds the row's <span style={{ fontWeight: 600, color: 'var(--lb-ink-3)' }}>Sqft Max</span>, AI scales the price using the row's $/sqft (computed at the midpoint of the range). Properties within the min–max range use the table price as-is.
          </div>
        </div>
      </label>

      {/* Price Table */}
      <SectionPanel
        icon={Table2}
        iconTone="gray"
        title="Price Table"
        count={`${pricing.priceTable?.length || 0} rows`}
        open={!!expandedSections.priceTable}
        onToggle={() => toggleSection('priceTable')}
      >
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
            <thead>
              <tr style={{ background: 'var(--lb-ink-10)' }}>
                <th style={thStyle}>Bed</th>
                <th style={thStyle}>Bath</th>
                <th style={thStyle} title="Smallest property size this row's price applies to">Sqft Min</th>
                <th style={thStyle} title="Largest property size at the row's price — beyond this, AI scales by $/sqft">Sqft Max</th>
                {allTypes.map((t: any) => (
                  <th key={t.key} style={thStyle}>{t.label}</th>
                ))}
                {allTypes.map((t: any) => (
                  <th
                    key={`psf-${t.key}`}
                    style={{ ...thStyle, color: 'var(--lb-ink-6)' }}
                    title={`${t.label} price per square foot — derived from price ÷ midpoint of the sqft range`}
                  >
                    $/sqft {t.label.split(' ')[0]}
                  </th>
                ))}
                <th style={{ ...thStyle, width: 28 }}></th>
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
                  <tr key={i} style={{ borderTop: '1px solid var(--lb-line-soft)' }}>
                    <td style={tdStyle}>
                      <input
                        type="number" value={row.bed} min={1} max={10}
                        onChange={e => updatePriceCell(i, 'bed', parseInt(e.target.value) || 1)}
                        style={{ ...numInputStyle, width: 44 }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="number" value={row.bath} min={1} max={10}
                        onChange={e => updatePriceCell(i, 'bath', parseInt(e.target.value) || 1)}
                        style={{ ...numInputStyle, width: 44 }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="number" value={row.sqftMin ?? ''} min={0} step={50}
                        onChange={e => updatePriceCell(i, 'sqftMin', parseInt(e.target.value) || 0)}
                        style={{ ...numInputStyle, width: 68 }}
                      />
                    </td>
                    <td style={tdStyle}>
                      <input
                        type="number" value={row.sqftMax ?? ''} min={0} step={50}
                        onChange={e => updatePriceCell(i, 'sqftMax', parseInt(e.target.value) || 0)}
                        style={{ ...numInputStyle, width: 68 }}
                      />
                    </td>
                    {allTypes.map((t: any) => (
                      <td key={t.key} style={tdStyle}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <span style={{ fontSize: 10.5, color: 'var(--lb-ink-5)', ...MONO }}>$</span>
                          <input
                            type="number" value={row[t.key] || 0} min={0}
                            onChange={e => updatePriceCell(i, t.key, parseInt(e.target.value) || 0)}
                            style={{ ...numInputStyle, width: 60 }}
                          />
                        </div>
                      </td>
                    ))}
                    {allTypes.map((t: any) => {
                      const price = Number(row[t.key]) || 0;
                      const perSqft = midpoint > 0 ? price / midpoint : 0;
                      return (
                        <td key={`psf-${t.key}`} style={tdStyle}>
                          <span style={{ fontSize: 11, color: 'var(--lb-ink-6)', ...MONO }}>
                            {midpoint > 0 ? `$${perSqft.toFixed(3)}` : '—'}
                          </span>
                        </td>
                      );
                    })}
                    <td style={tdStyle}>
                      <button
                        type="button"
                        onClick={() => removePriceRow(i)}
                        style={iconBtnStyle}
                        aria-label="Remove row"
                      >
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            type="button"
            onClick={addPriceRow}
            style={addBtnStyle}
          >
            <Plus size={12} /> Add row
          </button>
        </div>
      </SectionPanel>

      {/* Frequency Discounts */}
      <SectionPanel
        icon={Repeat}
        iconTone="purple"
        title="Frequency Discounts"
        open={!!expandedSections.frequency}
        onToggle={() => toggleSection('frequency')}
      >
        <div style={{ padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pricing.frequencyDiscounts?.map((fd: any, i: number) => (
            <div key={fd.key} style={rowStyle}>
              <span style={rowLabelStyle}>{fd.label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number" value={fd.discount} min={0} max={50}
                  onChange={e => updateFreqDiscount(i, parseInt(e.target.value) || 0)}
                  style={{ ...numInputStyle, width: 52 }}
                />
                <span style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', ...MONO }}>%</span>
              </div>
            </div>
          ))}
        </div>
      </SectionPanel>

      {/* Add-ons / Extras */}
      <SectionPanel
        icon={PlusCircle}
        iconTone="blue"
        title="Add-ons"
        count={pricing.extras?.length || 0}
        open={!!expandedSections.extras}
        onToggle={() => toggleSection('extras')}
      >
        <div style={{ padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pricing.extras?.map((ex: any, i: number) => (
            <div key={ex.key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="text" value={ex.label} placeholder="Add-on name"
                onChange={e => updateExtra(i, 'label', e.target.value)}
                style={{ ...textInputStyle, flex: 1, minWidth: 0 }}
              />
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', ...MONO }}>$</span>
                <input
                  type="number" value={ex.price} min={0}
                  onChange={e => updateExtra(i, 'price', parseInt(e.target.value) || 0)}
                  style={{ ...numInputStyle, width: 60 }}
                />
              </div>
              <button
                type="button"
                onClick={() => removeExtra(i)}
                style={iconBtnStyle}
                aria-label="Remove add-on"
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          <button type="button" onClick={addExtra} style={addBtnInlineStyle}>
            <Plus size={12} /> Add extra
          </button>
        </div>
      </SectionPanel>

      {/* Condition Surcharges + Pet Surcharge */}
      <SectionPanel
        icon={AlertCircle}
        iconTone="orange"
        title="Surcharges"
        open={!!expandedSections.surcharges}
        onToggle={() => toggleSection('surcharges')}
      >
        <div style={{ padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={groupHeadingStyle}>Property Condition</div>
          {pricing.conditionSurcharges?.map((cs: any, i: number) => (
            <div key={cs.key} style={rowStyle}>
              <span style={rowLabelStyle}>{cs.label}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', ...MONO }}>+$</span>
                <input
                  type="number" value={cs.surcharge} min={0}
                  onChange={e => updateConditionSurcharge(i, parseInt(e.target.value) || 0)}
                  style={{ ...numInputStyle, width: 60 }}
                />
              </div>
            </div>
          ))}
          <div style={{ borderTop: '1px solid var(--lb-line-soft)', paddingTop: 10, ...rowStyle }}>
            <span style={rowLabelStyle}>Pet Surcharge</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', ...MONO }}>+$</span>
              <input
                type="number" value={pricing.petSurcharge || 0} min={0}
                onChange={e => setPricing((p: any) => ({ ...p, petSurcharge: parseInt(e.target.value) || 0 }))}
                style={{ ...numInputStyle, width: 60 }}
              />
            </div>
          </div>
        </div>
      </SectionPanel>

      {/* Discounts */}
      <SectionPanel
        icon={BadgePercent}
        iconTone="green"
        title="Discounts"
        open={!!expandedSections.discounts}
        onToggle={() => toggleSection('discounts')}
      >
        <div style={{ padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Recurring cleaning discount */}
          <div>
            <div style={groupHeadingStyle}>Recurring Cleaning Discount</div>
            <div style={{ ...rowStyle, marginTop: 8 }}>
              <span style={rowLabelStyle}>Discount for recurring customers</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <input
                  type="number" value={pricing.recurringDiscount || 0} min={0} max={50}
                  onChange={e => setPricing((p: any) => ({ ...p, recurringDiscount: parseInt(e.target.value) || 0 }))}
                  style={{ ...numInputStyle, width: 52 }}
                />
                <span style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', ...MONO }}>%</span>
              </div>
            </div>
          </div>

          {/* Order amount discounts */}
          <div style={{ borderTop: '1px solid var(--lb-line-soft)', paddingTop: 12 }}>
            <div style={groupHeadingStyle}>Order Amount Discounts</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
              {(pricing.orderDiscounts || []).map((od: any, i: number) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11.5, color: 'var(--lb-ink-5)' }}>Over</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', ...MONO }}>$</span>
                    <input
                      type="number" value={od.minAmount} min={0}
                      onChange={e => {
                        const ods = [...(pricing.orderDiscounts || [])];
                        ods[i] = { ...ods[i], minAmount: parseInt(e.target.value) || 0 };
                        setPricing((p: any) => ({ ...p, orderDiscounts: ods }));
                      }}
                      style={{ ...numInputStyle, width: 70 }}
                    />
                  </div>
                  <span style={{ fontSize: 11.5, color: 'var(--lb-ink-5)' }}>→</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input
                      type="number" value={od.discount} min={0} max={50}
                      onChange={e => {
                        const ods = [...(pricing.orderDiscounts || [])];
                        ods[i] = { ...ods[i], discount: parseInt(e.target.value) || 0 };
                        setPricing((p: any) => ({ ...p, orderDiscounts: ods }));
                      }}
                      style={{ ...numInputStyle, width: 52 }}
                    />
                    <span style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', ...MONO }}>% off</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPricing((p: any) => ({ ...p, orderDiscounts: (p.orderDiscounts || []).filter((_: any, j: number) => j !== i) }));
                    }}
                    style={iconBtnStyle}
                    aria-label="Remove discount tier"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                onClick={() => {
                  setPricing((p: any) => ({ ...p, orderDiscounts: [...(p.orderDiscounts || []), { minAmount: 0, discount: 0 }] }));
                }}
                style={addBtnInlineStyle}
              >
                <Plus size={12} /> Add discount tier
              </button>
            </div>
          </div>
        </div>
      </SectionPanel>

      {/* Save Button */}
      <button
        type="button"
        onClick={handleSave}
        disabled={saving}
        style={{
          width: '100%',
          padding: '12px 16px',
          background: saved ? 'var(--lb-success)' : 'var(--lb-accent)',
          color: 'var(--lb-accent-fg)',
          fontSize: 13.5, fontWeight: 600, fontFamily: 'inherit',
          border: 0, borderRadius: 10,
          cursor: saving ? 'not-allowed' : 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          opacity: saving ? 0.7 : 1,
          boxShadow: 'var(--lb-shadow-sm)',
          transition: 'background 160ms ease',
        }}
      >
        {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
        {saved ? 'Saved!' : 'Save Pricing'}
      </button>
    </div>
  );
}

// ─── Local style helpers ────────────────────────────────────────────────

const thStyle: CSSProperties = {
  padding: '8px 6px',
  textAlign: 'left',
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--lb-ink-5)',
  textTransform: 'uppercase',
  letterSpacing: 0.04,
  fontFamily: 'var(--lb-font-mono)',
  whiteSpace: 'nowrap',
};

const tdStyle: CSSProperties = {
  padding: '6px 6px',
  verticalAlign: 'middle',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const rowLabelStyle: CSSProperties = {
  fontSize: 13, color: 'var(--lb-ink-2)', fontWeight: 500,
};

const groupHeadingStyle: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  color: 'var(--lb-ink-5)',
  textTransform: 'uppercase',
  letterSpacing: 0.06,
  fontFamily: 'var(--lb-font-mono)',
};

const iconBtnStyle: CSSProperties = {
  width: 26, height: 26, borderRadius: 6,
  background: 'transparent',
  border: '1px solid transparent',
  color: 'var(--lb-ink-6)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  cursor: 'pointer',
  flexShrink: 0,
};

const addBtnStyle: CSSProperties = {
  width: '100%',
  padding: '10px 14px',
  borderTop: '1px solid var(--lb-line-soft)',
  background: 'var(--lb-surface)',
  border: 0,
  borderTopWidth: 1,
  borderTopStyle: 'solid',
  borderTopColor: 'var(--lb-line-soft)',
  color: 'var(--lb-accent)',
  fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};

const addBtnInlineStyle: CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  background: 'var(--lb-accent-tint)',
  border: '1px dashed var(--lb-accent-line)',
  borderRadius: 8,
  color: 'var(--lb-accent)',
  fontSize: 12, fontWeight: 600, fontFamily: 'inherit',
  cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
};
