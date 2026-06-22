/**
 * Shared Save / Add-row controls for the AI Playbook pricing + FAQ
 * forms. The playbook surfaces three different pricing shapes
 * (cleaning bed/bath grid, item rows, hourly) and two FAQ shapes
 * (structured cleaning fields, generic Q&A pairs) — each historically
 * had its own button styling, which made the tabs look like different
 * products. This module is the single source of truth for those two
 * primitives so every form wears the same Save pill and the same
 * dashed Add-row button.
 *
 * Not a behavior change — the buttons forward their click handlers
 * verbatim. Per-form dirty / saving / saved state is still owned by
 * each form.
 */

import { ChevronDown, ChevronUp, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { useState, type CSSProperties, type ReactNode } from 'react';

export function UnifiedSaveButton({
  label,
  dirty,
  saving,
  savedAt,
  onClick,
  align = 'end',
  idleLabel = 'No changes',
  fullWidth = false,
}: {
  label: string;
  dirty: boolean;
  saving: boolean;
  savedAt: number | null;
  onClick: () => void;
  align?: 'start' | 'end';
  idleLabel?: string;
  fullWidth?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        justifyContent: fullWidth ? 'stretch' : align === 'end' ? 'flex-end' : 'flex-start',
      }}
    >
      {savedAt && !fullWidth && (
        <span
          style={{
            fontSize: 12,
            color: 'var(--lb-success, #16a34a)',
            fontWeight: 600,
          }}
        >
          Saved.
        </span>
      )}
      <button
        type="button"
        onClick={onClick}
        disabled={!dirty || saving}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
          padding: fullWidth ? '12px 16px' : '8px 14px',
          borderRadius: 10,
          background: dirty ? 'var(--lb-accent, #2563eb)' : '#cbd5e1',
          color: 'white',
          border: 0,
          fontSize: fullWidth ? 13.5 : 13,
          fontWeight: 600,
          cursor: dirty && !saving ? 'pointer' : 'not-allowed',
          fontFamily: 'inherit',
          opacity: saving ? 0.7 : 1,
          transition: 'background 160ms ease',
          width: fullWidth ? '100%' : undefined,
          boxShadow: fullWidth ? '0 1px 2px rgba(10,21,48,0.05)' : undefined,
        }}
      >
        {saving ? (
          <Loader2 size={fullWidth ? 14 : 13} className="animate-spin" />
        ) : (
          <Save size={fullWidth ? 14 : 13} />
        )}
        {saving
          ? 'Saving…'
          : !dirty && savedAt && fullWidth
            ? 'Saved!'
            : dirty
              ? label
              : idleLabel}
      </button>
    </div>
  );
}

/**
 * Tinted price chip — `$amount` rendered in mono, optionally tagged
 * (REGULAR / DEEP / per hour / flat). Used for the unified pricing
 * row layout across cleaning grid, item table, and hourly forms.
 */
export function PriceChip({
  amount,
  tag,
  editable,
  onChange,
  prefix = '$',
}: {
  amount: number;
  tag?: string;
  editable?: boolean;
  onChange?: (n: number) => void;
  prefix?: string;
}) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: editable ? '4px 8px' : '6px 12px',
        borderRadius: 999,
        background: 'var(--lb-ink-10, #f3f5fa)',
        color: 'var(--lb-ink-2, #1f2a44)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 12.5,
        fontWeight: 700,
        whiteSpace: 'nowrap',
      }}
    >
      {tag && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.05em',
            color: 'var(--lb-ink-5, #64748b)',
            textTransform: 'uppercase',
          }}
        >
          {tag}
        </span>
      )}
      <span style={{ color: 'var(--lb-ink-3, #334155)' }}>{prefix}</span>
      {editable && onChange ? (
        <input
          type="number"
          min={0}
          step={1}
          value={Number.isFinite(amount) ? amount : 0}
          onChange={(e) => onChange(Number(e.target.value) || 0)}
          style={{
            width: 56,
            padding: '2px 4px',
            border: '1px solid transparent',
            borderRadius: 6,
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: 12.5,
            fontWeight: 700,
            color: 'var(--lb-ink-1, #0a1530)',
            textAlign: 'right',
          }}
          onFocus={(e) => {
            e.currentTarget.style.background = 'white';
            e.currentTarget.style.borderColor = 'var(--lb-line, #e5e9f2)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.background = 'transparent';
            e.currentTarget.style.borderColor = 'transparent';
          }}
        />
      ) : (
        <span style={{ color: 'var(--lb-ink-1, #0a1530)' }}>{amount}</span>
      )}
    </div>
  );
}

/**
 * Collapsible section wrapper used by both Pricing (Price table /
 * Add-ons / Discounts) and FAQ (Custom Q&A / structured answers).
 * The header carries an icon tile, the title, an optional right-side
 * badge (row count, currency, etc), and a chevron. Closed by default
 * only when `defaultOpen=false`.
 *
 * Aliased as `PriceTableSection` for back-compat with the earlier
 * Pricing rollout.
 */
export function CollapsibleSection({
  title,
  icon,
  rightBadge,
  defaultOpen = true,
  open: openProp,
  onToggle,
  children,
}: {
  title: string;
  icon?: ReactNode;
  rightBadge?: ReactNode;
  defaultOpen?: boolean;
  /** Optional controlled-mode props. When both are supplied the parent
   *  owns the open state (used by ServicePricingForm so a re-render
   *  doesn't collapse the cleaning grid). When unset, the section is
   *  uncontrolled and defaults to `defaultOpen`. */
  open?: boolean;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const controlled = openProp !== undefined && onToggle !== undefined;
  const open = controlled ? !!openProp : innerOpen;
  const toggle = controlled ? onToggle! : () => setInnerOpen((v) => !v);
  return (
    <div
      style={{
        border: '1px solid var(--lb-line, #e5e9f2)',
        borderRadius: 12,
        overflow: 'hidden',
        background: 'white',
      }}
    >
      <button
        type="button"
        onClick={toggle}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          background: 'transparent',
          border: 0,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
        }}
      >
        {icon}
        <span
          style={{
            flex: 1,
            fontSize: 13.5,
            fontWeight: 700,
            color: 'var(--lb-ink-1, #0a1530)',
          }}
        >
          {title}
        </span>
        {rightBadge}
        {open ? (
          <ChevronUp size={16} color="var(--lb-ink-5, #64748b)" />
        ) : (
          <ChevronDown size={16} color="var(--lb-ink-5, #64748b)" />
        )}
      </button>
      {open && (
        <div
          style={{
            borderTop: '1px solid var(--lb-line-soft, #eef1f7)',
            padding: '4px 0 12px',
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Compact single-line price row — label (+ optional editable),
 * mono sub-line, one or two PriceChips on the right, trash icon to
 * remove. The label / sub editing affordances are inline-on-hover so
 * the row keeps a tidy default look but stays fully editable.
 */
export function PriceRow({
  label,
  sub,
  chips,
  onChangeLabel,
  onChangeSub,
  onRemove,
}: {
  label: string;
  sub?: string;
  chips: ReactNode;
  onChangeLabel?: (next: string) => void;
  onChangeSub?: (next: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderBottom: '1px solid var(--lb-line-soft, #eef1f7)',
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {onChangeLabel ? (
          <input
            type="text"
            value={label}
            onChange={(e) => onChangeLabel(e.target.value)}
            style={INLINE_LABEL_INPUT}
            placeholder="Item name"
          />
        ) : (
          <span
            style={{
              fontSize: 13.5,
              fontWeight: 600,
              color: 'var(--lb-ink-1, #0a1530)',
            }}
          >
            {label}
          </span>
        )}
        {(sub !== undefined || onChangeSub) && (
          onChangeSub ? (
            <input
              type="text"
              value={sub ?? ''}
              onChange={(e) => onChangeSub(e.target.value)}
              placeholder="per piece"
              style={INLINE_SUB_INPUT}
            />
          ) : (
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 11.5,
                color: 'var(--lb-ink-5, #64748b)',
              }}
            >
              {sub}
            </span>
          )
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>{chips}</div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
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
            flexShrink: 0,
          }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

/** Back-compat alias — earlier Pricing rollout imported PriceTableSection. */
export const PriceTableSection = CollapsibleSection;

/**
 * Custom-Q&A row rendered as a chip-style FAQ entry — matches the
 * structured FAQ chip groups above (uppercase grey question label,
 * answer as a row of multi-select chips with inline + Add chip).
 *
 * Storage stays as a single `customQA[].answer` string for backend
 * compat: the chips are persisted comma-separated, then split on read.
 * Sentence-style answers ("Yes, …") stay as one chip — operators add
 * commas only when they want multiple chips.
 */
export function FaqRow({
  question,
  answer,
  onChangeQuestion,
  onChangeAnswer,
  onRemove,
}: {
  question: string;
  answer: string;
  index?: number;
  onChangeQuestion: (next: string) => void;
  onChangeAnswer: (next: string) => void;
  onRemove?: () => void;
}) {
  // Split for display only; storage stays a single string. We DON'T
  // split on every comma — the simplest heuristic is to look for the
  // `,` separator the operator types when they intend multiple chips
  // and trim each segment. A single comma in a sentence answer (Q4-
  // style "Yes, standard …") collapses to one chip after the user
  // re-edits if it bothers them; we don't auto-fix that.
  const chips = answer
    .split(/,(?![^\(]*\))/g) // split on `,` but not inside parens
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const writeChips = (nextChips: string[]) =>
    onChangeAnswer(nextChips.join(', '));
  const updateChip = (idx: number, next: string) => {
    const out = [...chips];
    out[idx] = next;
    writeChips(out);
  };
  const removeChip = (idx: number) => writeChips(chips.filter((_, i) => i !== idx));
  const addChip = () => writeChips([...chips, '']);

  return (
    // Canonical FAQ-standalone card chrome — bordered rounded card per
    // Q&A entry with a violet "Q" badge above the question text and a
    // green "A" badge above the answer chips.
    <div
      style={{
        border: '1px solid var(--lb-line, #e5e9f2)',
        borderRadius: 11,
        overflow: 'hidden',
        background: '#fff',
        margin: '0 14px 10px',
      }}
    >
      {/* Q row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '12px 13px 10px' }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: '#ede9fe',
            color: '#7c3aed',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            fontSize: 11,
            fontWeight: 800,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          Q
        </span>
        <input
          type="text"
          value={question}
          onChange={(e) => onChangeQuestion(e.target.value)}
          placeholder="What question would a lead ask?"
          style={{
            flex: 1,
            minWidth: 0,
            padding: '0 2px',
            border: '1px solid transparent',
            borderRadius: 6,
            background: 'transparent',
            fontFamily: 'inherit',
            fontSize: 13.5,
            fontWeight: 600,
            lineHeight: 1.4,
            color: 'var(--lb-ink-1, #0a1530)',
            outline: 'none',
            boxSizing: 'border-box',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--lb-line, #e5e9f2)';
            e.currentTarget.style.background = '#fff';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'transparent';
            e.currentTarget.style.background = 'transparent';
          }}
        />
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            title="Remove Q&A"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 6,
              border: '1px solid var(--lb-line, #e5e9f2)',
              background: '#fff',
              color: 'var(--lb-ink-6, #8b94ab)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      {/* A row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 9, padding: '0 13px 12px' }}>
        <span
          style={{
            width: 20,
            height: 20,
            borderRadius: 6,
            background: '#dcfce7',
            color: '#16a34a',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            marginTop: 2,
            fontSize: 11,
            fontWeight: 800,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          }}
        >
          A
        </span>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {chips.map((chip, i) => (
            <FaqAnswerChip
              key={i}
              value={chip}
              onChange={(v) => updateChip(i, v)}
              onRemove={() => removeChip(i)}
            />
          ))}
          <button
            type="button"
            onClick={addChip}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '6px 10px',
              borderRadius: 8,
              border: '1px dashed var(--lb-accent-line, #c3d4ff)',
              background: 'var(--lb-accent-tint, #e7efff)',
              color: 'var(--lb-accent, #2563eb)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <Plus size={11} /> Add answer
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One answer chip — outline-blue pill with an inline-editable text
 * field that auto-sizes to its content, plus a small X to remove. The
 * X collapses the chip from the parent row's answer string. Same
 * outline-blue selected style as the structured FAQ chip groups so
 * Custom Q&A reads as a continuation of them.
 */
function FaqAnswerChip({
  value,
  onChange,
  onRemove,
}: {
  value: string;
  onChange: (next: string) => void;
  onRemove: () => void;
}) {
  const width = Math.max(60, Math.min(360, (value.length || 8) * 7.5));
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '6px 8px 6px 12px',
        borderRadius: 999,
        border: '1px solid #93c5fd',
        background: '#eff6ff',
        color: '#1d4ed8',
        fontSize: 12.5,
        fontWeight: 600,
      }}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Type an answer"
        style={{
          width,
          padding: '2px 4px',
          border: '1px solid transparent',
          borderRadius: 6,
          background: 'transparent',
          fontFamily: 'inherit',
          fontSize: 12.5,
          fontWeight: 600,
          color: '#1d4ed8',
          boxSizing: 'border-box',
          outline: 'none',
        }}
      />
      <button
        type="button"
        onClick={onRemove}
        title="Remove answer chip"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 18,
          height: 18,
          borderRadius: 999,
          border: 0,
          background: 'transparent',
          color: '#1d4ed8',
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <X size={11} />
      </button>
    </span>
  );
}

const INLINE_LABEL_INPUT: CSSProperties = {
  width: '100%',
  padding: '2px 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--lb-ink-1, #0a1530)',
};

const INLINE_SUB_INPUT: CSSProperties = {
  width: '100%',
  padding: '2px 4px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11.5,
  color: 'var(--lb-ink-5, #64748b)',
};

export const UNIFIED_ADD_ROW_STYLE: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 14px',
  borderRadius: 8,
  border: '1px dashed var(--lb-accent-line, #c3d4ff)',
  background: 'var(--lb-accent-tint, #e7efff)',
  color: 'var(--lb-accent, #2563eb)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export function UnifiedAddRowButton({
  label,
  onClick,
  fullWidth = false,
}: {
  label: string;
  onClick: () => void;
  fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...UNIFIED_ADD_ROW_STYLE,
        width: fullWidth ? '100%' : undefined,
        justifyContent: fullWidth ? 'center' : undefined,
      }}
    >
      <Plus size={13} /> {label}
    </button>
  );
}
