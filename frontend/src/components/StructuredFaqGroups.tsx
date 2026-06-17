/**
 * Shared structured-FAQ chip groups used on every service tab — the
 * five generic questions a customer asks of any home-service business
 * (insured & bonded, supplies, pet policy, payment methods, customer
 * must be home).
 *
 * AccountFaqForm renders the cleaning-specific FAQ surface and used
 * to ship its own inline copies of these five groups; CustomQAForm
 * for non-cleaning services historically had none. Pulling them into
 * one component means both forms wear the same visuals and the
 * non-cleaning tabs answer the same baseline questions cleaning has
 * always had.
 *
 * Storage is per-shape — the parent owns `value` and decides where to
 * persist it. The backend prompt assembler (parseAccountFaq /
 * buildFaqBlock in src/ai/faq-context.ts) already accepts every key
 * this component edits, so writing them to ServiceProfile.faqJson
 * flows into the AI prompt automatically.
 */

export type StructuredFaqValue = {
  insuredAndBonded?: { value?: 'unset' | 'yes' | 'no'; details?: string };
  bringsSupplies?: { value?: 'unset' | 'yes' | 'no'; details?: string };
  petPolicy?: { value?: 'unset' | 'pet_friendly' | 'extra_charge' | 'no_pets'; details?: string };
  paymentMethods?: string[];
  customerMustBeHome?: { value?: 'unset' | 'no' | 'yes' | 'optional'; details?: string };
};

type ChipOption<V extends string> = { key: V; label: string };

const PAYMENT_OPTIONS = ['Cash', 'Card', 'Venmo', 'Zelle', 'Invoice'] as const;

export function StructuredFaqGroups({
  value,
  onChange,
}: {
  value: StructuredFaqValue;
  onChange: (next: StructuredFaqValue) => void;
}) {
  const set = <K extends keyof StructuredFaqValue>(key: K, next: StructuredFaqValue[K]) =>
    onChange({ ...value, [key]: next });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <FaqChipGroup
        label="Insured & bonded?"
        options={[
          { key: 'unset', label: 'Not set' },
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'No' },
        ]}
        active={value.insuredAndBonded?.value ?? 'unset'}
        onSelect={(k) => set('insuredAndBonded', { ...value.insuredAndBonded, value: k })}
        detail={
          value.insuredAndBonded?.value === 'yes'
            ? {
                placeholder: 'Optional details (e.g. carrier, coverage amount)',
                value: value.insuredAndBonded.details ?? '',
                onChange: (v) =>
                  set('insuredAndBonded', { ...value.insuredAndBonded, details: v }),
              }
            : undefined
        }
      />

      <FaqChipGroup
        label="Bring supplies & equipment?"
        options={[
          { key: 'unset', label: 'Not set' },
          { key: 'yes', label: 'Yes' },
          { key: 'no', label: 'Customer provides' },
        ]}
        active={value.bringsSupplies?.value ?? 'unset'}
        onSelect={(k) => set('bringsSupplies', { ...value.bringsSupplies, value: k })}
        detail={{
          placeholder: 'Optional notes (e.g. eco-friendly products, fragrance-free available)',
          value: value.bringsSupplies?.details ?? '',
          onChange: (v) =>
            set('bringsSupplies', { ...value.bringsSupplies, details: v }),
        }}
      />

      <FaqChipGroup
        label="Pet policy"
        options={[
          { key: 'unset', label: 'Not set' },
          { key: 'pet_friendly', label: 'Pet friendly' },
          { key: 'extra_charge', label: 'Extra charge' },
          { key: 'no_pets', label: 'No pets' },
        ]}
        active={value.petPolicy?.value ?? 'unset'}
        onSelect={(k) => set('petPolicy', { ...value.petPolicy, value: k })}
      />

      <FaqChipGroupMulti
        label="Accepted payment"
        options={PAYMENT_OPTIONS.map((o) => ({ key: o, label: o }))}
        active={value.paymentMethods ?? []}
        onChange={(next) => set('paymentMethods', next)}
      />

      <FaqChipGroup
        label="Does the customer need to be home?"
        options={[
          { key: 'unset', label: 'Not set' },
          { key: 'no', label: 'No' },
          { key: 'yes', label: 'Yes' },
          { key: 'optional', label: 'Optional' },
        ]}
        active={value.customerMustBeHome?.value ?? 'unset'}
        onSelect={(k) =>
          set('customerMustBeHome', { ...value.customerMustBeHome, value: k })
        }
      />
    </div>
  );
}

function FaqGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--lb-ink-5, #64748b)',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function chipStyle(active: boolean): React.CSSProperties {
  return {
    padding: '8px 14px',
    borderRadius: 8,
    border: '1px solid',
    borderColor: active ? '#93c5fd' : '#e2e8f0',
    background: active ? '#eff6ff' : 'white',
    color: active ? '#1d4ed8' : '#334155',
    fontSize: 12.5,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'all 120ms ease',
  };
}

function FaqChipGroup<V extends string>({
  label,
  options,
  active,
  onSelect,
  detail,
}: {
  label: string;
  options: ChipOption<V>[];
  active: V;
  onSelect: (next: V) => void;
  detail?: {
    placeholder: string;
    value: string;
    onChange: (next: string) => void;
  };
}) {
  return (
    <div>
      <FaqGroupLabel>{label}</FaqGroupLabel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => onSelect(o.key)}
            style={chipStyle(active === o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>
      {detail && (
        <input
          type="text"
          value={detail.value}
          onChange={(e) => detail.onChange(e.target.value)}
          placeholder={detail.placeholder}
          style={{
            width: '100%',
            marginTop: 8,
            padding: '9px 12px',
            border: '1px solid var(--lb-line, #e5e9f2)',
            borderRadius: 10,
            fontSize: 13,
            fontFamily: 'inherit',
            color: 'var(--lb-ink-1, #0a1530)',
            background: 'white',
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

function FaqChipGroupMulti({
  label,
  options,
  active,
  onChange,
}: {
  label: string;
  options: ChipOption<string>[];
  active: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (key: string) => {
    const set = new Set(active);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    onChange(Array.from(set));
  };
  return (
    <div>
      <FaqGroupLabel>{label}</FaqGroupLabel>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            onClick={() => toggle(o.key)}
            style={chipStyle(active.includes(o.key))}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
