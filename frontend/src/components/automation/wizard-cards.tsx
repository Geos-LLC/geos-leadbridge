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
import { Check, ChevronDown, ChevronRight } from 'lucide-react';
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
  const options = pickerOptions.includes(pickerValue) ? pickerOptions : [pickerValue, ...pickerOptions];
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
            <span style={{ position: 'relative', display: 'inline-block' }}>
              <select
                value={pickerValue}
                onChange={(e) => onPickerChange(e.target.value)}
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
              </select>
              <span style={{
                position: 'absolute', right: 12, top: '50%',
                transform: 'translateY(-50%)',
                pointerEvents: 'none',
                color: 'var(--lb-ink-5)',
                fontSize: 10,
              }}>▾</span>
            </span>
          </div>
          {extra}
        </div>
      )}
    </div>
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
}: {
  useAi: boolean;
  onChangeUseAi: (next: boolean) => void;
  aiBody?: string;
  templateBody?: string;
  defaultOpen?: boolean;
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
        </div>
      )}
    </div>
  );
}
