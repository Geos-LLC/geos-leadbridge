import { useState } from 'react';
import {
  MessageSquareText, MessageCircle, Phone, Clock,
  FileText, ArrowRightLeft, Volume2, Mic, Info,
  Clipboard, Sparkles, Brain, User, ArrowRight, PhoneCall,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  SettingCard, FieldRow, OptionCard, InfoTile, Checkbox, ActionLink, FooterBanner,
} from '../../components/automation/ui';

export function AutomationRespond(_props: { accountId: string }) {
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [instantTextOn,  setInstantTextOn]  = useState(true);
  const [instantCallOn,  setInstantCallOn]  = useState(true);
  const [replyType, setReplyType] = useState<'template' | 'ai'>('ai');
  const [textBizHours, setTextBizHours] = useState(true);
  const [callBizHours, setCallBizHours] = useState(true);
  const [connMode, setConnMode] = useState<'agent-first' | 'parallel'>('agent-first');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Instant Reply */}
      <SettingCard
        icon={MessageSquareText}
        iconTone="blue"
        title="Instant Reply"
        subtitle="Send the first message automatically when a new lead arrives."
        enabled={instantReplyOn}
        onToggle={setInstantReplyOn}
        contentPad="8px 24px 24px"
      >
        <FieldRow label="Reply type" align="top">
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={replyType === 'template'}
              onClick={() => setReplyType('template')}
              title="Use template"
              body="Send a pre-written reply."
              icon={Clipboard}
            />
            <OptionCard
              selected={replyType === 'ai'}
              onClick={() => setReplyType('ai')}
              title="Let AI write it"
              body="AI will write a personalized first reply."
              icon={Sparkles}
            />
          </div>
        </FieldRow>

        <FieldRow label="AI Strategy">
          <InfoTile
            icon={Brain}
            iconTone="violet"
            title="Auto"
            body="AI picks the best strategy based on conversation context."
            actionLabel="Edit AI Settings"
          />
        </FieldRow>

        <FieldRow label="First Reply Instructions" noBorder>
          <InfoTile
            icon={FileText}
            iconTone="violet"
            title="Default first-reply instructions"
            body="How AI should write the first reply."
            actionLabel="Edit Template"
          />
        </FieldRow>
      </SettingCard>

      {/* Instant Text */}
      <SettingCard
        icon={MessageCircle}
        iconTone="green"
        title="Instant Text"
        subtitle="Automatically text the lead when a new lead arrives."
        enabled={instantTextOn}
        onToggle={setInstantTextOn}
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Clock} iconTone="gray" label="Timing" align="top">
          <div>
            <Checkbox
              checked={textBizHours}
              onChange={setTextBizHours}
              label="Only send during business hours"
              sublabel="Mon–Fri, 9:00 AM – 6:00 PM (America/New_York)"
            />
            <div style={{ marginTop: 10 }}>
              <ActionLink>Edit Hours</ActionLink>
            </div>
          </div>
        </FieldRow>

        <FieldRow icon={FileText} iconTone="green" label="SMS Template" noBorder>
          <InfoTile
            title="CT - Auto Reply"
            body="Hi {{lead.name}}, this is {{account.name}}. We just received your request…"
            actionLabel="Edit Template"
          />
        </FieldRow>
      </SettingCard>

      {/* Instant Call */}
      <SettingCard
        icon={Phone}
        iconTone="violet"
        title="Instant Call"
        subtitle="Call your team and connect to the lead right away."
        enabled={instantCallOn}
        onToggle={setInstantCallOn}
        contentPad="8px 24px 24px"
      >
        <FieldRow icon={Clock} iconTone="gray" label="Timing" align="top">
          <div>
            <Checkbox
              checked={callBizHours}
              onChange={setCallBizHours}
              label="Only call during business hours"
              sublabel="Mon–Fri, 9:00 AM – 6:00 PM (America/New_York)"
            />
            <div style={{ marginTop: 10 }}>
              <ActionLink>Edit Hours</ActionLink>
            </div>
          </div>
        </FieldRow>

        <FieldRow icon={ArrowRightLeft} iconTone="gray" label="Connection Mode" align="top">
          <div style={{ display: 'flex', gap: 12 }}>
            <OptionCard
              selected={connMode === 'agent-first'}
              onClick={() => setConnMode('agent-first')}
              title="Agent First"
              body="We call you first, then bridge the lead."
              illustration={<ConnDiagram kind="serial" />}
            />
            <OptionCard
              selected={connMode === 'parallel'}
              onClick={() => setConnMode('parallel')}
              title="Parallel"
              body="We call you and the lead at the same time."
              illustration={<ConnDiagram kind="parallel" />}
            />
          </div>
        </FieldRow>

        <FieldRow icon={Volume2} iconTone="violet" label="Agent Whisper Message">
          <InfoTile
            title="CC - Agent Whisper"
            body="You have a new lead for {category}. Customer name: {customerName}…"
            actionLabel="Edit Template"
          />
        </FieldRow>

        <FieldRow icon={Mic} iconTone="violet" label="Voicemail Message" noBorder>
          <InfoTile
            title="CC - Voicemail TTS"
            body="Hi {customerName}, this is {accountName}. We tried to reach you…"
            actionLabel="Edit Template"
          />
        </FieldRow>
      </SettingCard>

      <FooterBanner
        icon={Info}
        body={<>Templates can be managed in <Link to="/templates" style={{ color: 'var(--lb-accent)', fontWeight: 600 }}>Templates</Link>.</>}
      />
    </div>
  );
}

function ConnDiagram({ kind }: { kind: 'serial' | 'parallel' }) {
  if (kind === 'serial') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-4)' }}>
        <User size={14} />
        <ArrowRight size={12} style={{ color: 'var(--lb-ink-6)' }} />
        <PhoneCall size={14} />
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lb-ink-4)' }}>
      <User size={14} />
      <ArrowRight size={12} style={{ color: 'var(--lb-ink-6)' }} />
      <User size={14} />
    </div>
  );
}
