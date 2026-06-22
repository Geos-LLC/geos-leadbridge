import { useState, useEffect, type CSSProperties, type ReactNode } from 'react';
import {
  Plus, Trash2, Loader2, ChevronDown, X,
  Table2, Repeat, PlusCircle, AlertCircle, BadgePercent,
} from 'lucide-react';
import { usersApi, serviceProfilesApi } from '../services/api';
import { DEFAULT_CLEANING_PRICING, hydratePricing } from '../data/defaultPricing';
import {
  CollapsibleSection,
  UNIFIED_ADD_ROW_STYLE,
  UnifiedSaveButton,
} from './playbook-controls';

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
  /**
   * Wizard ("compact") rendering — hides every section except the Price
   * Table + Save button. Used by the setup wizard's Services step where
   * the "Edit pricing →" slot wants a slim editor matching the
   * FinalDesign canonical (just the table, no Service Type dropdown,
   * Sqft adjust, Quote shape picker, Frequency discounts, Add-ons,
   * Surcharges, or Discounts). All hidden sections keep their default
   * pricingJson values — the user can still edit them from
   * Settings → AI Playbook after onboarding.
   */
  wizardMode?: boolean;
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

/**
 * Compact bed/bath price chip rendered per cleaning type in each
 * cleaning row. Mirrors the PriceChip primitive used by item_quantity
 * pricing — tinted pill background, uppercase mono tag, inline
 * editable amount. Kept local because the cleaning grid only stores
 * the type label without keys (allTypes is hydrated from the parsed
 * pricing), so the shared PriceChip's onChange signature would force
 * an awkward double-bind here.
 */
/**
 * Single price cell in the Price Table — matches the FinalDesign
 * "Pricing Table (standalone)" canonical: a 88px-wide bordered tile
 * with a faint $ prefix in mono grey + the value in mono dark right-
 * aligned. Editable inline — focus reveals the input border. Used in
 * a horizontal table layout where each cleaning-type column gets one
 * cell per row.
 */
function PriceCell({
  amount,
  onChange,
}: {
  amount: number;
  onChange: (next: number) => void;
}) {
  return (
    <div style={{ width: 88, flexShrink: 0, padding: '7px 10px' }}>
      <span
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'flex-end',
          gap: 4,
          padding: '7px 9px',
          border: '1px solid var(--lb-line, #e5e9f2)',
          borderRadius: 8,
          background: '#fff',
          boxShadow: '0 1px 1px rgba(10,21,48,0.02)',
        }}
      >
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--lb-ink-7, #b4bbcc)',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          $
        </span>
        <input
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(amount) ? amount : 0}
          onChange={(e) => onChange(parseInt(e.target.value) || 0)}
          style={{
            width: 48,
            padding: '0 2px',
            border: 0,
            background: 'transparent',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
            fontWeight: 700,
            color: 'var(--lb-ink-1, #0a1530)',
            textAlign: 'right',
            outline: 'none',
          }}
        />
      </span>
    </div>
  );
}

// Inline editable inputs for the cleaning row label area. Mirror the
// hover-only borders the line-items PriceRow uses so the row stays
// tidy but the operator can still click to edit.
const INLINE_BED_BATH_INPUT: CSSProperties = {
  width: 32,
  padding: '2px 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 700,
  color: 'var(--lb-ink-1, #0a1530)',
  textAlign: 'center',
};

const INLINE_SQFT_INPUT: CSSProperties = {
  width: 52,
  padding: '2px 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 11.5,
  color: 'var(--lb-ink-3, #334155)',
  textAlign: 'right',
};

const INLINE_UNIT_LABEL: CSSProperties = {
  fontSize: 10.5,
  fontWeight: 700,
  letterSpacing: '0.06em',
  color: 'var(--lb-ink-5, #64748b)',
  textTransform: 'uppercase',
};

const INLINE_DOT: CSSProperties = {
  color: 'var(--lb-ink-5, #64748b)',
  fontWeight: 400,
};

/**
 * Small right-aligned pill used by ServicePricingForm's CollapsibleSection
 * headers — matches the row-count badge style used by the item_quantity
 * Pricing card so cleaning and line items wear the same chrome.
 */
function UnifiedSectionBadge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--lb-ink-5)',
        background: 'var(--lb-ink-10, #f3f5fa)',
        padding: '3px 8px',
        borderRadius: 999,
        letterSpacing: '0.02em',
      }}
    >
      {children}
    </span>
  );
}

/**
 * Quote shape picker — two-button segmented control matching the
 * sqft-toggle card chrome. Lets the operator decide whether AI quotes
 * a calculated range ($L–$H) or a single number for THIS pricing JSON.
 * Default 'range'. Replaces the picker that used to live under
 * Settings → Automation → Conversation when Goal=Price (2026-06-18).
 */
function QuoteShapePicker({
  mode,
  onChange,
}: {
  mode: 'range' | 'exact';
  onChange: (next: 'range' | 'exact') => void;
}) {
  const optStyle = (selected: boolean): CSSProperties => ({
    flex: 1,
    padding: '10px 14px',
    border: selected ? '1.5px solid var(--lb-accent)' : '1.5px solid var(--lb-line)',
    borderRadius: 12,
    background: selected ? 'var(--lb-accent-10, #eef2ff)' : 'var(--lb-surface)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontSize: 13,
    fontWeight: 600,
    color: selected ? 'var(--lb-accent)' : 'var(--lb-ink-2)',
    textAlign: 'left',
    transition: 'border-color 120ms, background 120ms',
  });
  return (
    <div
      style={{
        padding: '12px 14px',
        background: 'var(--lb-surface)',
        border: '1.5px solid var(--lb-line)',
        borderRadius: 14,
        boxShadow: 'var(--lb-shadow-sm)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          Quote shape
        </div>
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 3, lineHeight: 1.45 }}>
          How AI quotes the calculated price to the customer. Range uses the ±gap configured on this pricing JSON (default ±10%).
        </div>
      </div>
      <div style={{ display: 'flex', gap: 10 }}>
        <button type="button" style={optStyle(mode === 'range')} onClick={() => onChange('range')}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Range</div>
          <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', fontWeight: 500, marginTop: 2 }}>
            e.g. $270–$330
          </div>
        </button>
        <button type="button" style={optStyle(mode === 'exact')} onClick={() => onChange('exact')}>
          <div style={{ fontSize: 13.5, fontWeight: 700 }}>Exact</div>
          <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', fontWeight: 500, marginTop: 2 }}>
            single number from the table
          </div>
        </button>
      </div>
    </div>
  );
}

export default function ServicePricingForm({ accountId, accountName, saveToAll, serviceProfileId, wizardMode }: ServicePricingFormProps) {
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

  // Cleaning equivalent of the item_quantity "Add column": adds a new
  // cleaningType to the schema and seeds every existing priceTable row
  // at $0 for the new key. The operator names the column; we derive a
  // slug key the pricing engine can look up.
  const addCleaningType = () => {
    const name = window.prompt('Cleaning type (e.g. Move-out, Post-construction):');
    if (!name) return;
    const label = name.trim().slice(0, 40);
    if (!label) return;
    const key = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    if (!key) return;
    setPricing((p: any) => {
      const existing = (p.cleaningTypes || []) as Array<{ key: string }>;
      if (existing.some((t) => t.key === key)) return p; // dedupe by key
      return {
        ...p,
        cleaningTypes: [...existing, { key, label, enabled: true }],
        priceTable: (p.priceTable || []).map((row: any) => ({ ...row, [key]: 0 })),
      };
    });
  };

  const removeCleaningType = (key: string) => {
    const remaining = (pricing?.cleaningTypes || []).filter((t: any) => t.key !== key);
    if (remaining.length === 0) {
      alert('Keep at least one cleaning type — add another before removing this one.');
      return;
    }
    const target = (pricing?.cleaningTypes || []).find((t: any) => t.key === key);
    if (!window.confirm(`Remove the "${target?.label ?? key}" column? Prices in that column will be discarded.`)) return;
    setPricing((p: any) => ({
      ...p,
      cleaningTypes: remaining,
      priceTable: (p.priceTable || []).map((row: any) => {
        const { [key]: _drop, ...rest } = row;
        void _drop;
        return rest;
      }),
    }));
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
      {/* Service Type Header — hidden in wizardMode (slim editor) */}
      {!wizardMode && (
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
      )}

      {/* Service Types row removed (2026-06-13). Hiding columns by toggle led
          to legacy accounts missing Deep Cleaning entirely from both the form
          and the AI prompt. The new rule: every service is always a column;
          to "disable" a service, the user enters 0 for every row of that
          column. See frontend/src/data/defaultPricing.ts. */}

      {/* Square footage adjustment toggle — hidden in wizardMode */}
      {!wizardMode && (
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
      )}

      {/* Quote shape — Range (default) vs Exact. Moved here from
          Settings → Automation → Conversation (Goal=Price) 2026-06-18
          so the user adjusts it while reviewing prices, independent
          of the Conversation Goal. Backend reads pricing.priceQuoteMode
          via the hydrator (priceQuoteMode → defaultPricing.ts).
          Hidden in wizardMode — Range/Exact lives in the full editor
          (Settings → AI Playbook) after onboarding. */}
      {!wizardMode && (
        <QuoteShapePicker
          mode={pricing.priceQuoteMode === 'exact' ? 'exact' : 'range'}
          onChange={(mode) => setPricing((p: any) => ({ ...p, priceQuoteMode: mode }))}
        />
      )}

      {/* Price Table — two render paths:
              wizardMode = compact flex-based table rendered DIRECTLY
                (no CollapsibleSection wrapper) to avoid the
                table-in-card-in-card nesting the canonical
                explicitly avoids. Bordered card around the table
                only, `flex:1.5` row label, `flex:1` per column, no
                horizontal scroll, no `+ col` sentinel, no per-row
                delete sentinel. Matches FinalDesign "Service Setup
                (standalone)" — the table sits inline below the
                Pricing nav row.
              full editor = horizontal-scroll table from the
                "Pricing Table (standalone)" canonical wrapped in the
                shared CollapsibleSection chrome — fixed 88px
                columns, `+ col` sentinel, 50px delete sentinel,
                right-edge fade. Optimized for unbounded width in
                Settings → AI Playbook. */}
      {wizardMode ? (
        <>
              {/* Flush table — no outer bordered card. The only card
                  edge is the surrounding accordion's. Each row carries
                  its own bottom border for row separation; the header
                  row keeps a heavier bottom border to separate it
                  visually from the body. */}
              <div>
                {/* Header — column labels wrap to multiple lines if
                    needed so "Moving / Move-out" and "Airbnb / Turnover"
                    aren't truncated at the cramped wizard width. */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    borderBottom: '1px solid var(--lb-line, #e5e9f2)',
                  }}
                >
                  <div
                    style={{
                      flex: 2,
                      minWidth: 0,
                      padding: '9px 4px 9px 0',
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--lb-ink-6, #8b94ab)',
                    }}
                  >
                    Size band
                  </div>
                  {allTypes.map((t: any) => (
                    <div
                      key={t.key}
                      style={{
                        flex: 1,
                        minWidth: 0,
                        padding: '9px 6px',
                        textAlign: 'right',
                        fontSize: 9.5,
                        fontWeight: 700,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        textTransform: 'uppercase',
                        letterSpacing: '0.02em',
                        color: 'var(--lb-ink-6, #8b94ab)',
                        lineHeight: 1.2,
                        wordBreak: 'break-word',
                      }}
                      title={t.label}
                    >
                      {t.label}
                    </div>
                  ))}
                </div>

                {/* Body rows */}
                {pricing.priceTable?.map((row: any, i: number) => {
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        borderBottom: '1px solid var(--lb-line-soft, #f3f5fa)',
                      }}
                    >
                      <div
                        style={{
                          flex: 2,
                          minWidth: 0,
                          padding: '8px 4px 8px 0',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 3,
                            fontSize: 12.5,
                            fontWeight: 600,
                            color: 'var(--lb-ink-1, #0a1530)',
                          }}
                        >
                          <input
                            type="number"
                            value={row.bed}
                            min={1}
                            max={10}
                            onChange={(e) =>
                              updatePriceCell(i, 'bed', parseInt(e.target.value) || 1)
                            }
                            style={{ ...INLINE_BED_BATH_INPUT, width: 24, fontSize: 12.5 }}
                          />
                          <span style={{ ...INLINE_UNIT_LABEL, fontSize: 9.5 }}>bed</span>
                          <span style={INLINE_DOT}>·</span>
                          <input
                            type="number"
                            value={row.bath}
                            min={1}
                            max={10}
                            onChange={(e) =>
                              updatePriceCell(i, 'bath', parseInt(e.target.value) || 1)
                            }
                            style={{ ...INLINE_BED_BATH_INPUT, width: 24, fontSize: 12.5 }}
                          />
                          <span style={{ ...INLINE_UNIT_LABEL, fontSize: 9.5 }}>bath</span>
                          <button
                            type="button"
                            onClick={() => removePriceRow(i)}
                            title="Remove row"
                            style={{
                              marginLeft: 'auto',
                              background: 'transparent',
                              border: 0,
                              padding: '0 2px',
                              cursor: 'pointer',
                              color: 'var(--lb-ink-6, #8b94ab)',
                              fontFamily: 'inherit',
                              display: 'inline-flex',
                              alignItems: 'center',
                            }}
                          >
                            <Trash2 size={11} />
                          </button>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 2,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 10.5,
                            color: 'var(--lb-ink-6, #8b94ab)',
                          }}
                        >
                          <input
                            type="number"
                            value={row.sqftMin ?? ''}
                            min={0}
                            step={50}
                            onChange={(e) =>
                              updatePriceCell(i, 'sqftMin', parseInt(e.target.value) || 0)
                            }
                            style={{ ...INLINE_SQFT_INPUT, width: 40 }}
                          />
                          <span>–</span>
                          <input
                            type="number"
                            value={row.sqftMax ?? ''}
                            min={0}
                            step={50}
                            onChange={(e) =>
                              updatePriceCell(i, 'sqftMax', parseInt(e.target.value) || 0)
                            }
                            style={{ ...INLINE_SQFT_INPUT, width: 40 }}
                          />
                          <span style={{ marginLeft: 2 }}>sqft</span>
                        </div>
                      </div>
                      {allTypes.map((t: any) => (
                        <div key={t.key} style={{ flex: 1, minWidth: 0, padding: '6px 5px' }}>
                          <span style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'flex-end',
                            gap: 2,
                            padding: '7px 7px',
                            border: '1px solid var(--lb-line, #e5e9f2)',
                            borderRadius: 8,
                            background: '#fff',
                          }}>
                            <span style={{
                              fontSize: 10,
                              color: 'var(--lb-ink-7, #b4bbcc)',
                              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            }}>$</span>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              value={Number(row[t.key]) || 0}
                              onChange={(e) => updatePriceCell(i, t.key, parseInt(e.target.value) || 0)}
                              style={{
                                width: '100%',
                                minWidth: 0,
                                padding: 0,
                                border: 0,
                                background: 'transparent',
                                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                                fontSize: 12.5,
                                fontWeight: 700,
                                color: 'var(--lb-ink-1, #0a1530)',
                                textAlign: 'right',
                                outline: 'none',
                              }}
                            />
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>

              {/* Add row / Add column dashed pills below */}
              <div style={{ marginTop: 12, display: 'flex', gap: 9, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  onClick={addPriceRow}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 13px',
                    border: '1px dashed var(--lb-accent-line, #c3d4ff)',
                    borderRadius: 10,
                    background: 'var(--lb-accent-tint, #e7efff)',
                    color: 'var(--lb-accent, #2563eb)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <Plus size={13} /> Add row
                </button>
                <button
                  type="button"
                  onClick={addCleaningType}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '8px 13px',
                    border: '1px dashed var(--lb-accent-line, #c3d4ff)',
                    borderRadius: 10,
                    background: 'var(--lb-accent-tint, #e7efff)',
                    color: 'var(--lb-accent, #2563eb)',
                    fontSize: 12.5,
                    fontWeight: 600,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <Plus size={13} /> Add column
                </button>
              </div>
            </>
          ) : (
          <CollapsibleSection
            title="Price table"
            icon={<Table2 size={14} color="var(--lb-ink-5, #64748b)" />}
            rightBadge={<UnifiedSectionBadge>{`${pricing.priceTable?.length || 0} rows`}</UnifiedSectionBadge>}
            open={!!expandedSections.priceTable}
            onToggle={() => toggleSection('priceTable')}
          >
          <div>
          <div style={{ position: 'relative', borderTop: '1px solid var(--lb-line-soft, #eef1f7)' }}>
            <div className="pt-scroll" style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 'max-content' }}>
                {/* Header row — row-axis label + per-cleaning-type
                    column headers + + col sentinel. */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'stretch',
                    background: '#f8fafc',
                    borderBottom: '1px solid var(--lb-line, #e5e9f2)',
                  }}
                >
                  <div
                    style={{
                      flex: '1 1 220px',
                      minWidth: 220,
                      padding: '10px 14px',
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      textTransform: 'uppercase',
                      letterSpacing: '0.03em',
                      color: 'var(--lb-ink-6, #8b94ab)',
                    }}
                  >
                    Size band
                  </div>
                  {allTypes.map((t: any) => (
                    <div
                      key={t.key}
                      style={{
                        width: 88,
                        flexShrink: 0,
                        padding: '10px 12px',
                        textAlign: 'right',
                        fontSize: 10,
                        fontWeight: 700,
                        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                        textTransform: 'uppercase',
                        letterSpacing: '0.03em',
                        color: 'var(--lb-ink-6, #8b94ab)',
                        position: 'relative',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                        {t.label}
                        <button
                          type="button"
                          onClick={() => removeCleaningType(t.key)}
                          title={`Remove ${t.label} column`}
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 14,
                            height: 14,
                            borderRadius: 999,
                            border: 0,
                            background: 'transparent',
                            color: 'var(--lb-ink-6, #8b94ab)',
                            cursor: 'pointer',
                            padding: 0,
                          }}
                        >
                          <X size={10} />
                        </button>
                      </span>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={addCleaningType}
                    title="Add column"
                    style={{
                      width: 50,
                      flexShrink: 0,
                      padding: '10px 6px',
                      textAlign: 'center',
                      fontSize: 10,
                      fontWeight: 700,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      color: 'var(--lb-accent, #2563eb)',
                      border: 0,
                      borderLeft: '1px dashed #d7e0f5',
                      background: 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    + col
                  </button>
                </div>

                {/* Body rows */}
                {pricing.priceTable?.map((row: any, i: number) => {
                  const legacySqft = Number(row.sqft) || 0;
                  const sqftMin = Number(row.sqftMin) || legacySqft;
                  const sqftMax = Number(row.sqftMax) || legacySqft;
                  const midpoint =
                    sqftMin && sqftMax ? (sqftMin + sqftMax) / 2 : sqftMin || sqftMax;
                  return (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        borderBottom: '1px solid var(--lb-line-soft, #eef1f7)',
                      }}
                    >
                      <div
                        style={{
                          flex: '1 1 220px',
                          minWidth: 220,
                          padding: '10px 14px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            fontSize: 13.5,
                            fontWeight: 600,
                            color: 'var(--lb-ink-1, #0a1530)',
                          }}
                        >
                          <input
                            type="number"
                            value={row.bed}
                            min={1}
                            max={10}
                            onChange={(e) =>
                              updatePriceCell(i, 'bed', parseInt(e.target.value) || 1)
                            }
                            style={INLINE_BED_BATH_INPUT}
                          />
                          <span style={INLINE_UNIT_LABEL}>bed</span>
                          <span style={INLINE_DOT}>·</span>
                          <input
                            type="number"
                            value={row.bath}
                            min={1}
                            max={10}
                            onChange={(e) =>
                              updatePriceCell(i, 'bath', parseInt(e.target.value) || 1)
                            }
                            style={INLINE_BED_BATH_INPUT}
                          />
                          <span style={INLINE_UNIT_LABEL}>bath</span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 4,
                            rowGap: 4,
                            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                            fontSize: 11,
                            color: 'var(--lb-ink-6, #8b94ab)',
                            marginTop: 1,
                          }}
                        >
                          <input
                            type="number"
                            value={row.sqftMin ?? ''}
                            min={0}
                            step={50}
                            onChange={(e) =>
                              updatePriceCell(i, 'sqftMin', parseInt(e.target.value) || 0)
                            }
                            style={INLINE_SQFT_INPUT}
                          />
                          <span>–</span>
                          <input
                            type="number"
                            value={row.sqftMax ?? ''}
                            min={0}
                            step={50}
                            onChange={(e) =>
                              updatePriceCell(i, 'sqftMax', parseInt(e.target.value) || 0)
                            }
                            style={INLINE_SQFT_INPUT}
                          />
                          <span style={{ marginLeft: 2 }}>sqft</span>
                          {midpoint > 0 && (
                            <span style={{ marginLeft: 10, opacity: 0.7, flex: '1 1 100%' }}>
                              {allTypes
                                .map((t: any) => {
                                  const p = Number(row[t.key]) || 0;
                                  return p > 0
                                    ? `$${(p / midpoint).toFixed(2)}/sqft ${t.label.split(' ')[0].toLowerCase()}`
                                    : '';
                                })
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          )}
                        </div>
                      </div>
                      {allTypes.map((t: any) => (
                        <PriceCell
                          key={t.key}
                          amount={Number(row[t.key]) || 0}
                          onChange={(v) => updatePriceCell(i, t.key, v)}
                        />
                      ))}
                      <div
                        style={{
                          width: 50,
                          flexShrink: 0,
                          alignSelf: 'stretch',
                          borderLeft: '1px dashed var(--lb-line-soft, #f3f5fa)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => removePriceRow(i)}
                          title="Remove row"
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            width: 28,
                            height: 28,
                            borderRadius: 7,
                            border: '1px solid var(--lb-line, #e5e9f2)',
                            background: 'white',
                            color: 'var(--lb-ink-5, #64748b)',
                            cursor: 'pointer',
                          }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Right-edge gradient hint — appears when content overflows
                so the scroll affordance is visible at a glance. */}
            {allTypes.length > 2 && (
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  right: 0,
                  width: 26,
                  height: '100%',
                  background: 'linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.92))',
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>

          {/* Action row — dashed accent-tint pills per canonical. */}
          <div
            style={{
              display: 'flex',
              gap: 9,
              flexWrap: 'wrap',
              padding: '14px 14px 4px',
            }}
          >
            <button
              type="button"
              onClick={addPriceRow}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '9px 14px',
                border: '1px dashed var(--lb-accent-line, #c3d4ff)',
                borderRadius: 10,
                background: 'var(--lb-accent-tint, #e7efff)',
                color: 'var(--lb-accent, #2563eb)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Plus size={14} /> Add row
            </button>
            <button
              type="button"
              onClick={addCleaningType}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '9px 14px',
                border: '1px dashed var(--lb-accent-line, #c3d4ff)',
                borderRadius: 10,
                background: 'var(--lb-accent-tint, #e7efff)',
                color: 'var(--lb-accent, #2563eb)',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              <Plus size={14} /> Add column
            </button>
          </div>
          </div>
          </CollapsibleSection>
          )}

      {/* Frequency Discounts — hidden in wizardMode (lives in full
          editor at Settings → AI Playbook after onboarding) */}
      {!wizardMode && (
      <CollapsibleSection
        title="Frequency discounts"
        icon={<Repeat size={14} color="var(--lb-ink-5, #64748b)" />}
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
      </CollapsibleSection>
      )}

      {/* Add-ons / Extras — hidden in wizardMode */}
      {!wizardMode && (
      <CollapsibleSection
        title="Add-ons"
        icon={<PlusCircle size={14} color="var(--lb-ink-5, #64748b)" />}
        rightBadge={
          (pricing.extras?.length || 0) > 0 ? (
            <UnifiedSectionBadge>{pricing.extras.length}</UnifiedSectionBadge>
          ) : undefined
        }
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
      </CollapsibleSection>
      )}

      {/* Condition Surcharges + Pet Surcharge — hidden in wizardMode */}
      {!wizardMode && (
      <CollapsibleSection
        title="Surcharges"
        icon={<AlertCircle size={14} color="var(--lb-ink-5, #64748b)" />}
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
      </CollapsibleSection>
      )}

      {/* Discounts — hidden in wizardMode */}
      {!wizardMode && (
      <CollapsibleSection
        title="Discounts"
        icon={<BadgePercent size={14} color="var(--lb-ink-5, #64748b)" />}
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
      </CollapsibleSection>
      )}

      {/* Save Button — unified pill across all playbook forms. The
          cleaning grid used to ship a full-width hero button; that
          clashed with the right-aligned pill used by item / hourly /
          Q&A forms, so the tabs looked like different products. */}
      <UnifiedSaveButton
        label="Save Pricing"
        dirty
        saving={saving}
        savedAt={saved ? Date.now() : null}
        onClick={() => void handleSave()}
        fullWidth
      />
    </div>
  );
}

// ─── Local style helpers ────────────────────────────────────────────────

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


// Mirror the shared playbook-controls Add-row style so the cleaning
// grid's "Add row" buttons (Add cleaning type, Add discount tier, …)
// match Add Q&A and Add item in the other forms.
const addBtnInlineStyle: CSSProperties = {
  ...UNIFIED_ADD_ROW_STYLE,
  width: '100%',
  justifyContent: 'center',
};
