import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  PhoneOff, Sparkles, RotateCcw, Plus, ChevronRight,
  RefreshCw, Clock, UserX, Brain, Info,
} from 'lucide-react';
import {
  SettingCard, SectionCard, FieldRow, OptionCard, InfoTile,
  Dropdown, ActionLink, IconTile, FooterBanner,
  type IconTone,
} from '../../components/automation/ui';
import type { LucideIcon } from 'lucide-react';

const DEFAULT_FOLLOWUP_PLAN: { val: number; unit: string }[] = [
  { val: 2,  unit: 'min' },
  { val: 10, unit: 'min' },
  { val: 1,  unit: 'hour' },
  { val: 1,  unit: 'day' },
  { val: 3,  unit: 'days' },
  { val: 7,  unit: 'days' },
  { val: 2,  unit: 'weeks' },
  { val: 1,  unit: 'month' },
  { val: 3,  unit: 'months' },
  { val: 6,  unit: 'months' },
  { val: 1,  unit: 'year' },
];

export function AutomationFollowups(_props: { accountId: string }) {
  const [quietOn, setQuietOn] = useState(true);
  const [deliveryMode, setDeliveryMode] = useState<'suggest' | 'active'>('active');
  const [messageMode, setMessageMode] = useState<'template' | 'ai'>('ai');
  const plan = DEFAULT_FOLLOWUP_PLAN;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Quiet hours */}
      <SettingCard
        icon={PhoneOff}
        iconTone="violet"
        title="Quiet hours"
        subtitle="Don't send follow-ups overnight."
        enabled={quietOn}
        onToggle={setQuietOn}
      >
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, paddingTop: 4,
        }}>
          <div style={{ flex: 1 }} />
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 13, color: 'var(--lb-ink-2)' }}>
              <span style={{ fontWeight: 500 }}>Quiet hours: </span>
              <span style={{ fontWeight: 700 }}>10:00 PM – 8:00 AM</span>
            </div>
            <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
              America/New_York (daily)
            </div>
          </div>
          <ActionLink external>Edit in Settings</ActionLink>
        </div>
      </SettingCard>

      {/* Follow-up mode */}
      <SectionCard padding="20px 24px 8px">
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Follow-up mode
          </div>
          <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', marginTop: 2 }}>
            Choose how follow-ups are delivered and composed.
          </div>
        </div>

        <FieldRow label="Delivery mode" sublabel="How follow-ups are sent." align="top">
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={deliveryMode === 'suggest'}
              onClick={() => setDeliveryMode('suggest')}
              title="Suggest"
              body="Draft follow-ups for you to review and approve."
            />
            <OptionCard
              selected={deliveryMode === 'active'}
              onClick={() => setDeliveryMode('active')}
              title="Active"
              body="Send follow-ups automatically without approval."
            />
          </div>
        </FieldRow>

        <FieldRow label="Message mode" sublabel="How follow-up messages are composed." align="top">
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={messageMode === 'template'}
              onClick={() => setMessageMode('template')}
              title="Use custom template"
              body="Use your saved template for all follow-up messages."
            />
            <OptionCard
              selected={messageMode === 'ai'}
              onClick={() => setMessageMode('ai')}
              title="AI (auto)"
              body="AI writes each message based on the conversation using your strategy."
            />
          </div>
        </FieldRow>

        <FieldRow label="AI Strategy" sublabel="Used when AI is composing messages." noBorder>
          <InfoTile
            icon={Brain}
            iconTone="violet"
            title="Auto"
            body="AI picks the best strategy based on conversation context."
            actionLabel="Edit AI Settings"
          />
        </FieldRow>
      </SectionCard>

      {/* Follow-up plan */}
      <SectionCard padding="20px 24px 24px">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
              Follow-up plan
            </div>
            <Sparkles size={14} style={{ color: 'var(--lb-accent)' }} />
          </div>
          <button
            type="button"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              background: 'transparent', border: 0, cursor: 'pointer',
              fontFamily: 'inherit', fontSize: 13, fontWeight: 600,
              color: 'var(--lb-accent)', padding: 0,
            }}
          >
            <RotateCcw size={13} /> Reset to defaults
          </button>
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', marginBottom: 18 }}>
          AI writes each step from the live conversation. You only set the timing.
        </div>

        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 6, flexWrap: 'nowrap',
          overflowX: 'auto', paddingBottom: 8,
        }}>
          {plan.map((step, i) => (
            <div key={i} style={{ display: 'contents' }}>
              <PlanStep n={i + 1} val={step.val} unit={step.unit} />
              {i < plan.length - 1 && (
                <div style={{ display: 'flex', alignItems: 'center', color: 'var(--lb-ink-6)', paddingTop: 22 }}>
                  <ChevronRight size={14} />
                </div>
              )}
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)' }}>
            Click any step to edit its timing.
          </div>
          <button
            type="button"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '7px 14px',
              background: 'white', color: 'var(--lb-accent)',
              border: '1px solid var(--lb-accent-line)', borderRadius: 999,
              cursor: 'pointer', fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
            }}
          >
            <Plus size={13} /> Add step
          </button>
        </div>
      </SectionCard>

      {/* Stacked rule cards */}
      <SectionCard padding="0">
        <RuleCardRow
          icon={RefreshCw}
          iconTone="green"
          title="Resume follow-ups after conversation"
          body="When a customer replies and then goes silent again, start a new follow-up sequence."
          fieldLabel="Wait before resuming"
          fieldValue="12 hours"
          fieldOptions={['1 hour', '6 hours', '12 hours', '24 hours', '48 hours']}
          tipIcon={Sparkles}
          tip="How long to wait after your last message before starting follow-ups again."
        />
        <RuleCardRow
          icon={Clock}
          iconTone="orange"
          title="Check in after customer deferral"
          body={"When customer says \"I'll get back to you\" / \"let me think\", silence the AI and schedule one nudge later. Cancels if they reply first."}
          fieldLabel="Send check-in after"
          fieldValue="3 days"
          fieldOptions={['1 day', '2 days', '3 days', '1 week']}
          tipIcon={Sparkles}
          tip="AI generates this check-in from the conversation using your auto strategy. Switch to Custom Template above to write a fixed message instead."
        />
        <RuleCardRow
          icon={UserX}
          iconTone="rose"
          title="Re-engage after customer hired competitor"
          body="When customer says they hired someone else, send one polite check-in later. Captures the dissatisfied ones."
          fieldLabel="Send re-engage after"
          fieldValue="3 weeks"
          fieldOptions={['1 week', '2 weeks', '3 weeks', '1 month']}
          tipIcon={Sparkles}
          tip="AI generates this re-engage from the conversation using your auto strategy. Switch to Custom Template above to write a fixed message instead."
          noBorder
        />
      </SectionCard>

      <FooterBanner
        icon={Info}
        body={<>Follow-ups respect quiet hours and business hours. You can edit those in <Link to="/settings" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Settings</Link>.</>}
      />
    </div>
  );
}

function PlanStep({ n, val, unit }: { n: number; val: number; unit: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 64 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--lb-ink-5)', fontFamily: 'var(--lb-font-mono)' }}>
        #{n}
      </div>
      <button
        type="button"
        style={{
          width: 64, padding: '10px 6px',
          background: 'white', border: '1px solid var(--lb-line)',
          borderRadius: 10,
          cursor: 'pointer', fontFamily: 'inherit',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
          transition: 'border-color 120ms',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--lb-ink-1)', lineHeight: 1, letterSpacing: '-0.02em' }}>{val}</div>
        <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', lineHeight: 1 }}>{unit}</div>
      </button>
    </div>
  );
}

function RuleCardRow({
  icon, iconTone, title, body, fieldLabel, fieldValue, fieldOptions, tipIcon: TipIcon, tip, noBorder,
}: {
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
  fieldLabel: string;
  fieldValue: string;
  fieldOptions: string[];
  tipIcon: LucideIcon;
  tip: string;
  noBorder?: boolean;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 24,
      padding: '20px 24px',
      borderBottom: noBorder ? 'none' : '1px solid var(--lb-line-soft)',
      alignItems: 'flex-start',
    }}>
      <div style={{ display: 'flex', gap: 12 }}>
        <IconTile icon={icon} tone={iconTone} size="md" />
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>{title}</div>
          <div style={{ fontSize: 12.5, color: 'var(--lb-ink-5)', marginTop: 4, lineHeight: 1.5 }}>{body}</div>
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-2)', marginBottom: 6 }}>{fieldLabel}</div>
        <Dropdown
          value={fieldValue}
          onChange={() => { /* TODO wire */ }}
          options={fieldOptions}
          width="100%"
        />
      </div>
      <div style={{
        display: 'flex', gap: 10,
        padding: '12px 14px',
        background: '#f8fafc',
        border: '1px solid var(--lb-line-soft)',
        borderRadius: 10,
        fontSize: 12.5, color: 'var(--lb-ink-4)',
        lineHeight: 1.5,
      }}>
        <TipIcon size={14} style={{ color: 'var(--lb-accent)', flexShrink: 0, marginTop: 1 }} />
        <div>{tip}</div>
      </div>
    </div>
  );
}
