/**
 * Shared wizard-style cards for the Automation pages.
 *
 * Extracted from `pages/onboarding/steps/AutomationLevelStep.tsx` so the
 * production Automation pages (Respond, Followups, Conversation) can
 * render the canonical FinalDesign chrome instead of the legacy
 * SettingCard variants. The wizard step itself imports these too — one
 * implementation, one source of truth.
 *
 * Components:
 *   - FirstReplyCard: master toggle card with biz-hours checkbox + children
 *   - FollowupCard:   master toggle card with picker dropdown
 *   - Toggle:         42×24 pill toggle
 *   - Checkbox:       18×18 accent-colored checkbox
 */
import { useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, ChevronRight, Clock } from 'lucide-react';
import { InfoDot, InfoTip } from '../InfoPopover';

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onChange(!on); }}
      aria-pressed={on}
      style={{
        width: 42, height: 24, borderRadius: 99,
        background: on ? 'var(--lb-accent)' : 'var(--lb-line)',
        position: 'relative', flexShrink: 0,
        border: 0, padding: 0, cursor: 'pointer',
        transition: 'background 140ms',
      }}
    >
      <span style={{
        position: 'absolute', top: 3, left: on ? 21 : 3,
        width: 18, height: 18, borderRadius: 99, background: '#fff',
        transition: 'left 140ms',
      }} />
    </button>
  );
}

export function Checkbox({ checked }: { checked: boolean }) {
  return (
    <span style={{
      width: 18, height: 18, borderRadius: 5,
      border: '1.5px solid ' + (checked ? 'var(--lb-accent)' : 'var(--lb-line)'),
      background: checked ? 'var(--lb-accent)' : '#fff',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      flexShrink: 0, transition: 'background 120ms, border-color 120ms',
    }}>
      {checked && <Check size={11} style={{ color: '#fff', strokeWidth: 3 }} />}
    </span>
  );
}

/**
 * First reply card chrome — 1.5px border, 14 radius, shadow, 40×40
 * colored icon tile, 15px/700 title. Header carries the master toggle;
 * when on, an inline body appears with an optional biz-hours checkbox
 * and children rendered below it.
 */
export function FirstReplyCard({
  icon: Icon, iconBg, iconColor, title, subtitle, info, enabled, onToggle,
  bizLabel, bizChecked, onBizToggle, bizNoBorder, children,
}: {
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  iconBg: string;
  iconColor: string;
  title: string;
  subtitle: string;
  info: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  /** Pass empty string + no-op handlers to hide the biz-hours row when
   *  the card doesn't gate by business hours. */
  bizLabel?: string;
  bizChecked?: boolean;
  onBizToggle?: (v: boolean) => void;
  bizNoBorder?: boolean;
  children?: ReactNode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  const showBizRow = !!bizLabel && typeof bizChecked === 'boolean' && !!onBizToggle;
  return (
    <div style={{
      background: '#fff',
      border: '1.5px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: 16 }}>
        <span style={{
          width: 40, height: 40, borderRadius: 11,
          background: iconBg, color: iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            {title}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.45,
          }}>
            <span style={{ flex: 1, minWidth: 0 }}>{subtitle}</span>
            <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
          </div>
          {infoOpen && <InfoTip>{info}</InfoTip>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingTop: 2 }}>
          <Toggle on={enabled} onChange={onToggle} />
        </div>
      </div>

      {/* Body (only when enabled) */}
      {enabled && (showBizRow || children) && (
        <div style={{ borderTop: '1px solid var(--lb-line-soft)', padding: '6px 16px 16px' }}>
          {showBizRow && (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
              padding: '13px 0',
              borderBottom: !bizNoBorder && children ? '1px solid var(--lb-line-soft)' : undefined,
            }}>
              <button
                type="button"
                onClick={() => onBizToggle!(!bizChecked)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  background: 'transparent', border: 0, cursor: 'pointer',
                  fontFamily: 'inherit', textAlign: 'left', padding: 0,
                  flex: 1, minWidth: 0,
                }}
              >
                <Checkbox checked={!!bizChecked} />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
                  {bizLabel}
                </span>
              </button>
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Follow-up rule card chrome — same outer shell as FirstReplyCard,
 * but the body carries a label + dropdown picker instead of a
 * biz-hours checkbox. Used by Resume / Check-in / Re-engage cards.
 */
export function FollowupCard({
  icon: Icon, iconBg, iconColor, title, subtitle, info,
  enabled, onToggle,
  pickerLabel, pickerValue, pickerOptions, onPickerChange,
  extra,
}: {
  icon: ComponentType<{ size?: number; style?: CSSProperties }>;
  iconBg: string;
  iconColor: string;
  title: string;
  /** Always-visible secondary text under the title. Omit to render only
   *  the title + (i) icon (info popover carries the description). */
  subtitle?: string;
  info: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  pickerLabel: string;
  pickerValue: string;
  pickerOptions: string[];
  onPickerChange: (v: string) => void;
  /** Optional extra UI rendered below the picker — e.g. the custom
   *  "1 day / 2 days / ..." editor when the operator picks "Custom…". */
  extra?: ReactNode;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div style={{
      background: '#fff',
      border: '1.5px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: 16 }}>
        <span style={{
          width: 40, height: 40, borderRadius: 11,
          background: iconBg, color: iconColor,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Icon size={18} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {subtitle ? (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
                {title}
              </div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2, lineHeight: 1.45,
              }}>
                <span style={{ flex: 1, minWidth: 0 }}>{subtitle}</span>
                <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
              </div>
            </>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
                {title}
              </div>
              <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
            </div>
          )}
          {infoOpen && <InfoTip>{info}</InfoTip>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, paddingTop: 2 }}>
          <Toggle on={enabled} onChange={onToggle} />
        </div>
      </div>

      {/* Body — label + dropdown when enabled */}
      {enabled && (
        <div style={{ borderTop: '1px solid var(--lb-line-soft)', padding: '14px 16px 16px' }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 12,
          }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>
              {pickerLabel}
            </span>
            <DelayPicker
              value={pickerValue}
              options={pickerOptions}
              onChange={onPickerChange}
            />
          </div>
          {extra}
        </div>
      )}
    </div>
  );
}

// Custom-delay parsing — keeps the same `${val} ${unit}` shape the backend's
// parseDelay() understands so values round-trip with the wizard.
type CustomUnit = 'min' | 'hour' | 'day' | 'week' | 'month';
const CUSTOM_UNIT_OPTIONS: { value: CustomUnit; label: string }[] = [
  { value: 'min',   label: 'minutes' },
  { value: 'hour',  label: 'hours' },
  { value: 'day',   label: 'days' },
  { value: 'week',  label: 'weeks' },
  { value: 'month', label: 'months' },
];

function parseCustomDelay(value: string): { val: number; unit: CustomUnit } {
  const d = (value || '').toLowerCase().trim();
  const val = Math.max(1, Math.round(parseFloat(d) || 1));
  if (d.includes('min')) return { val, unit: 'min' };
  if (d.includes('hour') || d.includes('hr')) return { val, unit: 'hour' };
  if (d.includes('day')) return { val, unit: 'day' };
  if (d.includes('week') || d.includes('wk')) return { val, unit: 'week' };
  if (d.includes('month') || d.includes('mo')) return { val, unit: 'month' };
  return { val: 1, unit: 'day' };
}

/**
 * Dropdown picker used by FollowupCard. Renders preset options + a
 * "Custom…" sentinel; picking Custom (or arriving with an off-preset
 * value) reveals an inline number + unit editor that serializes back
 * to "<val> <unit>". Matches the wizard's DropdownSelect so both
 * surfaces share the same UX.
 */
function DelayPicker({
  value, options, onChange,
}: { value: string; options: string[]; onChange: (v: string) => void }) {
  const isCustom = !options.includes(value);
  const custom = parseCustomDelay(isCustom ? value : '1 day');
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
      <span style={{ position: 'relative', display: 'inline-block' }}>
        <select
          value={isCustom ? '__custom__' : value}
          onChange={(e) => {
            if (e.target.value === '__custom__') {
              onChange(`${custom.val} ${custom.unit}`);
            } else {
              onChange(e.target.value);
            }
          }}
          style={{
            appearance: 'none',
            padding: '8px 36px 8px 14px',
            border: '1px solid var(--lb-line)',
            borderRadius: 9,
            background: '#fff',
            color: 'var(--lb-ink-1)',
            fontFamily: 'inherit',
            fontSize: 13, fontWeight: 600,
            cursor: 'pointer',
            outline: 'none',
          }}
        >
          {options.map(o => <option key={o} value={o}>{o}</option>)}
          <option value="__custom__">
            {isCustom
              ? `Custom: ${custom.val} ${CUSTOM_UNIT_OPTIONS.find(u => u.value === custom.unit)?.label}`
              : 'Custom…'}
          </option>
        </select>
        <span style={{
          position: 'absolute', right: 12, top: '50%',
          transform: 'translateY(-50%)',
          pointerEvents: 'none',
          color: 'var(--lb-ink-5)',
          fontSize: 10,
        }}>▾</span>
      </span>
      {isCustom && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input
            type="number"
            min={1}
            value={custom.val}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              const safe = Math.max(1, Number.isFinite(n) ? n : 1);
              onChange(`${safe} ${custom.unit}`);
            }}
            style={{
              width: 64, padding: '7px 10px',
              border: '1px solid var(--lb-line)', borderRadius: 8,
              fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
              background: '#fff', color: 'var(--lb-ink-1)',
              outline: 'none',
            }}
          />
          <span style={{ position: 'relative', display: 'inline-block' }}>
            <select
              value={custom.unit}
              onChange={(e) => onChange(`${custom.val} ${e.target.value as CustomUnit}`)}
              style={{
                appearance: 'none',
                padding: '7px 28px 7px 12px',
                border: '1px solid var(--lb-line)', borderRadius: 8,
                fontSize: 13, fontWeight: 600, fontFamily: 'inherit',
                background: '#fff', color: 'var(--lb-ink-1)',
                cursor: 'pointer', outline: 'none',
              }}
            >
              {CUSTOM_UNIT_OPTIONS.map(u => (
                <option key={u.value} value={u.value}>{u.label}</option>
              ))}
            </select>
            <span style={{
              position: 'absolute', right: 10, top: '50%',
              transform: 'translateY(-50%)',
              pointerEvents: 'none',
              color: 'var(--lb-ink-5)',
              fontSize: 9,
            }}>▾</span>
          </span>
        </span>
      )}
    </span>
  );
}

/**
 * Radio button row — circle + bold title + subtitle. Matches the
 * wizard's RadioButton used inside MessageGenerationExpander.
 */
export function RadioButton({
  selected, onClick, title, body,
}: { selected: boolean; onClick: () => void; title: string; body: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        background: 'transparent', border: 0, cursor: 'pointer',
        fontFamily: 'inherit', textAlign: 'left', padding: 0,
      }}
    >
      <span style={{
        width: 18, height: 18, borderRadius: 99,
        border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        background: selected ? 'var(--lb-accent)' : '#fff',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0, marginTop: 1,
        transition: 'background 120ms, border-color 120ms',
      }}>
        {selected && <span style={{ width: 6, height: 6, borderRadius: 99, background: '#fff' }} />}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          {title}
        </span>
        <span style={{ display: 'block', fontSize: 12, color: 'var(--lb-ink-5)', lineHeight: 1.5, marginTop: 3 }}>
          {body}
        </span>
      </span>
    </button>
  );
}

/**
 * Wizard-style Message generation expander — chevron-toggle header
 * ("Message generation / How messages are composed.") that reveals
 * two RadioButtons (AI-generated vs Custom template). Used inside
 * FirstReplyCard children on the Automation Respond page and the
 * wizard step.
 */
export function MessageGenerationExpander({
  useAi, onChangeUseAi,
  aiBody = 'AI writes each message from your Business Info, FAQ, Pricing and AI Playbook.',
  templateBody = 'Use your own pre-written messages instead of AI.',
  defaultOpen = false,
  templateName,
}: {
  useAi: boolean;
  onChangeUseAi: (next: boolean) => void;
  aiBody?: string;
  templateBody?: string;
  defaultOpen?: boolean;
  /**
   * Section's primary MessageTemplate name (e.g. "Instant Reply",
   * "Follow Up"). When provided AND Custom template is selected,
   * surfaces an "Edit this template →" deep-link that opens the named
   * template in the editor on the /templates page.
   */
  templateName?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, padding: '13px 0 0' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 9, width: '100%',
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left', padding: 0,
        }}
      >
        {open
          ? <ChevronDown size={15} style={{ color: 'var(--lb-ink-5)', marginTop: 2, flexShrink: 0 }} />
          : <ChevronRight size={15} style={{ color: 'var(--lb-ink-5)', marginTop: 2, flexShrink: 0 }} />}
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--lb-ink-2)' }}>
            Message generation
          </span>
          <span style={{ display: 'block', fontSize: 12, color: 'var(--lb-ink-5)', marginTop: 2 }}>
            How messages are composed.
          </span>
        </span>
      </button>
      {open && (
        <div style={{ marginTop: 13, paddingLeft: 24, display: 'flex', flexDirection: 'column', gap: 13 }}>
          <RadioButton
            selected={useAi}
            onClick={() => onChangeUseAi(true)}
            title="AI-generated"
            body={aiBody}
          />
          <RadioButton
            selected={!useAi}
            onClick={() => onChangeUseAi(false)}
            title="Custom template"
            body={templateBody}
          />
          {!useAi && templateName && (
            <Link
              to={`/templates?name=${encodeURIComponent(templateName)}&edit=1`}
              style={{
                alignSelf: 'flex-start',
                marginLeft: 28,
                fontSize: 12.5,
                fontWeight: 600,
                color: 'var(--lb-accent)',
                textDecoration: 'none',
              }}
            >
              Edit “{templateName}” template →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * AI Response Mode card — single checkbox "Only assist outside of
 * business hours" with an (i) toggle for the longer explanation.
 * Checked = 'assist' (auto-send only after hours), unchecked =
 * 'autopilot' (auto-send any time). The 'suggest' (review-only)
 * delivery mode is intentionally not surfaced here — it's opt-in
 * via Settings → AI Playbook → Delivery mode (advanced).
 */
export function AiResponseModeCard({
  respHoursOnly, onChange,
}: {
  respHoursOnly: boolean;
  onChange: (v: boolean) => void;
}) {
  const [infoOpen, setInfoOpen] = useState(false);
  return (
    <div style={{
      background: '#fff',
      border: '1px solid var(--lb-line)',
      borderRadius: 14,
      boxShadow: 'var(--lb-shadow-sm)',
      padding: 16,
    }}>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 6 }}>
        <span style={{
          width: 40, height: 40, borderRadius: 11,
          background: '#e0e7ff', color: '#6366f1',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexShrink: 0,
        }}>
          <Clock size={19} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            AI Response Mode
          </div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', lineHeight: 1.5, marginTop: 3 }}>
            When AI is allowed to respond automatically to customer messages.
          </div>
          {infoOpen && (
            <InfoTip>
              When the checkbox is on, AI only replies after your business hours close — during the day, your team handles conversations live. When off, AI replies any time of day. Either way, AI follow-ups and detection still run on their own schedule.
            </InfoTip>
          )}
        </div>
        <div style={{ marginTop: 4 }}>
          <InfoDot open={infoOpen} onClick={() => setInfoOpen(o => !o)} />
        </div>
      </div>
      <button
        type="button"
        onClick={() => onChange(!respHoursOnly)}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: 'transparent', border: 0, cursor: 'pointer',
          fontFamily: 'inherit', textAlign: 'left',
          padding: '8px 0 2px', width: '100%',
        }}
      >
        <Checkbox checked={respHoursOnly} />
        <span style={{ fontSize: 13.5, fontWeight: 600, color: 'var(--lb-ink-1)' }}>
          Only assist outside of business hours
        </span>
      </button>
    </div>
  );
}
