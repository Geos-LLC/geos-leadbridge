import { useState } from 'react';
import {
  Brain, Sparkles, Scale, CircleDollarSign, UserCheck, Calendar, Phone,
  Clock, Hand, UserX, CalendarCheck, HeartHandshake, CheckSquare,
  Users, PhoneCall, Smartphone, Ruler, BadgeCheck, Info, Bell, ArrowRight,
  MessageSquareText,
  type LucideIcon,
} from 'lucide-react';
import {
  SectionCard, SettingCard, FieldRow, OptionCard, ToggleRow,
  Radio, IconTile, ActionLink, AutoBadge,
  type IconTone,
} from '../../components/automation/ui';

type StrategyKey = 'auto' | 'hybrid' | 'price' | 'qualify' | 'convert' | 'phone';

const STRATEGIES: { k: StrategyKey; icon: LucideIcon; iconTone: IconTone; title: string; body: string }[] = [
  { k: 'auto',    icon: Sparkles,         iconTone: 'violet', title: 'Auto',    body: 'AI picks the best strategy based on conversation context.' },
  { k: 'hybrid',  icon: Scale,            iconTone: 'gray',   title: 'Hybrid',  body: 'Balance between qualifying, converting, and pricing.' },
  { k: 'price',   icon: CircleDollarSign, iconTone: 'green',  title: 'Price',   body: 'Prioritize giving price ranges proactively.' },
  { k: 'qualify', icon: UserCheck,        iconTone: 'orange', title: 'Qualify', body: 'Ask the right questions to qualify the lead.' },
  { k: 'convert', icon: Calendar,         iconTone: 'blue',   title: 'Convert', body: 'Focus on booking and moving the lead to action.' },
  { k: 'phone',   icon: Phone,            iconTone: 'rose',   title: 'Phone',   body: 'Encourage a phone call with your team.' },
];

export function AutomationConversation(_props: { accountId: string }) {
  const [strategy, setStrategy] = useState<StrategyKey>('auto');
  const [priceMode, setPriceMode] = useState<'range' | 'exact'>('range');
  const [availability, setAvailability] = useState<'always' | 'hours'>('always');
  const [stopRules, setStopRules] = useState({
    not_contacted: true, booked: true, price_agreed: true, done: true,
  });
  const [takeover, setTakeover] = useState({
    ready: true, live: true, phone: true, sqft: true, qualified: true,
  });

  const toggleStop = (k: keyof typeof stopRules) => setStopRules(r => ({ ...r, [k]: !r[k] }));
  const toggleTakeover = (k: keyof typeof takeover) => setTakeover(r => ({ ...r, [k]: !r[k] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* AI Strategy */}
      <SectionCard padding="22px 24px 24px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', marginBottom: 16 }}>
          <IconTile icon={Brain} tone="violet" size="lg" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>AI Strategy</div>
              <AutoBadge tone="green">Applies everywhere</AutoBadge>
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Single source of truth for how AI-generated messages are written.<br />
              Used by Instant Reply (AI mode), Follow-ups (AI mode), and AI Conversation.<br /><br />
              Pick the goal for each reply. Only Price volunteers a price proactively — the other strategies stay focused on their own goal and only quote when the customer asks.
            </div>
          </div>
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10,
            flex: '0 0 720px',
          }}>
            {STRATEGIES.map(s => (
              <StrategyCard
                key={s.k}
                selected={strategy === s.k}
                onClick={() => setStrategy(s.k)}
                icon={s.icon}
                iconTone={s.iconTone}
                title={s.title}
                body={s.body}
              />
            ))}
          </div>
        </div>

        <div style={{ borderTop: '1px solid var(--lb-line-soft)', paddingTop: 16, marginTop: 4 }}>
          <FieldRow
            label={
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                How AI quotes price <Info size={12} style={{ color: 'var(--lb-ink-6)' }} />
              </span>
            }
            sublabel="Choose how AI presents pricing when it volunteers a price."
            align="top"
            noBorder
          >
            <div style={{ display: 'flex', gap: 12 }}>
              <OptionCard
                selected={priceMode === 'range'}
                onClick={() => setPriceMode('range')}
                title="Range"
                body="AI gives a price range and tells the customer the dispatcher will confirm the exact number."
              />
              <OptionCard
                selected={priceMode === 'exact'}
                onClick={() => setPriceMode('exact')}
                title="Exact"
                body="AI gives an exact price when it has enough information."
              />
            </div>
          </FieldRow>
        </div>
      </SectionCard>

      {/* Auto Reply Availability */}
      <SettingCard
        icon={Clock}
        iconTone="violet"
        title="Auto Reply Availability"
        subtitle="Choose when AI can reply automatically."
        headerRight={
          <div style={{ display: 'flex', gap: 12, flex: 1, marginLeft: 24, marginTop: -4 }}>
            <OptionCard
              compact
              selected={availability === 'always'}
              onClick={() => setAvailability('always')}
              title="Always (24/7)"
              body="AI replies to leads at any time, day or night."
            />
            <OptionCard
              compact
              selected={availability === 'hours'}
              onClick={() => setAvailability('hours')}
              title="Outside of business hours"
              body={<>AI replies only outside your business hours window.<br /><span style={{ color: 'var(--lb-ink-3)' }}>Business Hours: Mon–Fri, 9:00 AM – 6:00 PM (New York)</span></>}
            />
          </div>
        }
      />

      {/* Stop Rules */}
      <SectionCard padding="22px 24px 8px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <IconTile icon={Hand} tone="rose" size="lg" />
          <div style={{ flex: '0 0 280px', minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              AI Conversation Stop Rules
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Rules that tell AI when to stop replying.
              <br /><br />
              When any of these happen, AI stops and the conversation is handed off.
            </div>
            <div style={{ marginTop: 14 }}>
              <ActionLink external>Learn more</ActionLink>
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <ToggleRow icon={UserX}         iconTone="gray"   label="Customer asks not to be contacted"           on={stopRules.not_contacted} onChange={() => toggleStop('not_contacted')} />
            <ToggleRow icon={CalendarCheck} iconTone="green"  label="Job is booked or confirmed"                  on={stopRules.booked}        onChange={() => toggleStop('booked')} />
            <ToggleRow icon={HeartHandshake}iconTone="purple" label="Customer agrees on price — hand off to manager" on={stopRules.price_agreed} onChange={() => toggleStop('price_agreed')} />
            <ToggleRow icon={CheckSquare}   iconTone="cyan"   label="Lead is done, scheduled, or archived"         on={stopRules.done}          onChange={() => toggleStop('done')} />
          </div>
        </div>

        <div style={{
          marginTop: 14,
          padding: '10px 14px',
          background: '#eff6ff',
          border: '1px solid #c3d4ff',
          borderRadius: 10,
          fontSize: 12.5, color: 'var(--lb-accent)',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <Info size={14} />
          Some stop rules may also trigger follow-up flows. Manage in
          <a href="#" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Follow-ups settings.</a>
        </div>
      </SectionCard>

      {/* Human Takeover */}
      <SectionCard padding="22px 24px 8px">
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <IconTile icon={Users} tone="orange" size="lg" />
          <div style={{ flex: '0 0 280px', minWidth: 0 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
              Human Takeover (Notify Your Team)
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--lb-ink-5)', lineHeight: 1.55 }}>
              Notify your team when AI detects the customer needs a human.
              <br /><br />
              These rules trigger alerts. AI may continue the conversation unless a Stop Rule above is also matched.
            </div>
            <div style={{ marginTop: 14, fontSize: 13, color: 'var(--lb-accent)', fontWeight: 600 }}>
              Manage alert templates in<br />
              Settings → Communication
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
            <ToggleRow icon={CalendarCheck} iconTone="green"  label="Ready to book"            on={takeover.ready}     onChange={() => toggleTakeover('ready')} />
            <ToggleRow icon={PhoneCall}     iconTone="purple" label="Wants live contact"       on={takeover.live}      onChange={() => toggleTakeover('live')} />
            <ToggleRow icon={Smartphone}    iconTone="blue"   label="Provided phone number"    on={takeover.phone}     onChange={() => toggleTakeover('phone')} />
            <ToggleRow icon={Ruler}         iconTone="orange" label="Provided square footage"  on={takeover.sqft}      onChange={() => toggleTakeover('sqft')} />
            <ToggleRow icon={BadgeCheck}    iconTone="cyan"   label="Qualification complete"   on={takeover.qualified} onChange={() => toggleTakeover('qualified')} />
          </div>
        </div>

        <div style={{
          marginTop: 14,
          padding: '12px 14px',
          background: '#fffbeb',
          border: '1px solid #fde68a',
          borderRadius: 10,
          fontSize: 12.5, color: '#92400e',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <Bell size={14} style={{ color: '#d97706' }} />
          <div style={{ flex: 1 }}>
            Alerts are sent based on templates in <strong>Settings → Communication → AI Human Takeover Alerts</strong>.
          </div>
          <ActionLink external>Go to Alerts &amp; Notifications</ActionLink>
        </div>
      </SectionCard>

      {/* How it works */}
      <SectionCard padding="20px 24px">
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em', marginBottom: 4 }}>
          How it works
        </div>
        <div style={{ fontSize: 13, color: 'var(--lb-ink-5)', marginBottom: 18 }}>
          AI continues the conversation until a Stop Rule is matched. Human Takeover rules send alerts so your team can jump in.
        </div>

        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 12,
          background: '#f8fafc', border: '1px solid var(--lb-line-soft)',
          borderRadius: 12, padding: '14px 16px',
        }}>
          <FlowStep icon={MessageSquareText} iconTone="blue"   title="AI is chatting"          subtitle="with the lead" />
          <FlowArrow />
          <FlowStep icon={Users}              iconTone="orange" title="Takeover rule matched"   subtitle="(alert sent to your team)" />
          <FlowArrow />
          <FlowStep icon={Bell}               iconTone="green"  title="Team is notified and"    subtitle="can take over" />
          <FlowArrow />
          <FlowStep icon={Hand}               iconTone="rose"   title="If a Stop Rule matches," subtitle="AI stops replying" />
        </div>
      </SectionCard>
    </div>
  );
}

function StrategyCard({
  selected, onClick, icon, iconTone, title, body,
}: {
  selected: boolean;
  onClick: () => void;
  icon: LucideIcon;
  iconTone: IconTone;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        position: 'relative',
        textAlign: 'left', padding: '14px 12px 14px',
        background: selected ? '#eff6ff' : 'white',
        border: '1.5px solid ' + (selected ? 'var(--lb-accent)' : 'var(--lb-line)'),
        borderRadius: 10,
        cursor: 'pointer', fontFamily: 'inherit',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
        transition: 'border-color 120ms, background 120ms',
      }}
    >
      <div style={{ position: 'absolute', top: 8, left: 8 }}>
        <Radio selected={selected} />
      </div>
      <div style={{ height: 6 }} />
      <IconTile icon={icon} tone={iconTone} size="md" />
      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--lb-ink-1)' }}>{title}</div>
      <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', textAlign: 'center', lineHeight: 1.4 }}>{body}</div>
    </button>
  );
}

function FlowStep({ icon, iconTone, title, subtitle }: { icon: LucideIcon; iconTone: IconTone; title: string; subtitle: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 10, padding: '0 8px' }}>
      <IconTile icon={icon} tone={iconTone} size="md" />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--lb-ink-1)', lineHeight: 1.3 }}>{title}</div>
        <div style={{ fontSize: 11.5, color: 'var(--lb-ink-5)', lineHeight: 1.3 }}>{subtitle}</div>
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', color: 'var(--lb-ink-6)' }}>
      <ArrowRight size={16} />
    </div>
  );
}
