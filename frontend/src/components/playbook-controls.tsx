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

import { ChevronDown, ChevronUp, Loader2, Plus, Save, Trash2 } from 'lucide-react';
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
  children,
}: {
  title: string;
  icon?: ReactNode;
  rightBadge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
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
        onClick={() => setOpen((v) => !v)}
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
 * Compact Q&A row used by every FAQ form. Two-line layout: question
 * input on top (bold, single line), answer textarea below. Hover-only
 * borders so the row stays clean by default but is fully inline-
 * editable. Trash button on the right.
 */
export function FaqRow({
  question,
  answer,
  index,
  onChangeQuestion,
  onChangeAnswer,
  onRemove,
}: {
  question: string;
  answer: string;
  index: number;
  onChangeQuestion: (next: string) => void;
  onChangeAnswer: (next: string) => void;
  onRemove?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '12px 14px',
        borderBottom: '1px solid var(--lb-line-soft, #eef1f7)',
      }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontWeight: 700,
          color: 'var(--lb-ink-5, #64748b)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          paddingTop: 6,
          width: 32,
          flexShrink: 0,
        }}
      >
        Q{index + 1}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <input
          type="text"
          value={question}
          onChange={(e) => onChangeQuestion(e.target.value)}
          placeholder="What question would a lead ask?"
          style={FAQ_INLINE_QUESTION_INPUT}
        />
        <textarea
          value={answer}
          onChange={(e) => onChangeAnswer(e.target.value)}
          placeholder="Answer the AI will give verbatim"
          rows={2}
          style={FAQ_INLINE_ANSWER_INPUT}
        />
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          title="Remove Q&A"
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
            marginTop: 4,
          }}
        >
          <Trash2 size={13} />
        </button>
      )}
    </div>
  );
}

const FAQ_INLINE_QUESTION_INPUT: CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13.5,
  fontWeight: 600,
  color: 'var(--lb-ink-1, #0a1530)',
  boxSizing: 'border-box',
};

const FAQ_INLINE_ANSWER_INPUT: CSSProperties = {
  width: '100%',
  padding: '4px 6px',
  border: '1px solid transparent',
  borderRadius: 6,
  background: 'transparent',
  fontFamily: 'inherit',
  fontSize: 13,
  color: 'var(--lb-ink-2, #1f2a44)',
  resize: 'vertical',
  boxSizing: 'border-box',
};

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
