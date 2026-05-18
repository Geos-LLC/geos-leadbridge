import { useEffect, useState } from 'react';
import {
  MessageSquareText, MessageCircle, Phone, Clock,
  FileText, ArrowRightLeft, Volume2, Mic, Info,
  Clipboard, Sparkles, Brain, User, ArrowRight, PhoneCall, Loader2,
} from 'lucide-react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  SettingCard, FieldRow, OptionCard, InfoTile, Checkbox, ActionLink, FooterBanner,
} from '../../components/automation/ui';
import { automationApi, callConnectApi, notificationsApi, templatesApi } from '../../services/api';
import type { AutomationRule, CallConnectMode, CallConnectSettings, MessageTemplate, NotificationRule } from '../../types';

export function AutomationRespond({ accountId }: { accountId: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const fromState = { from: location.pathname + location.search, fromLabel: 'When a Lead Arrives' };

  // Visual + state
  const [instantReplyOn, setInstantReplyOn] = useState(true);
  const [instantTextOn,  setInstantTextOn]  = useState(true);
  const [instantCallOn,  setInstantCallOn]  = useState(true);
  const [replyType, setReplyType] = useState<'template' | 'ai'>('ai');
  const [textBizHours, setTextBizHours] = useState(true);
  const [callBizHours, setCallBizHours] = useState(true);
  const [connMode, setConnMode] = useState<'agent-first' | 'parallel'>('agent-first');

  // Loaded source-of-truth records (only when a specific account is picked)
  const [newLeadRule, setNewLeadRule] = useState<AutomationRule | null>(null);
  const [customerTextRule, setCustomerTextRule] = useState<NotificationRule | null>(null);
  const [callSettings, setCallSettings] = useState<CallConnectSettings | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isAll = accountId === 'all';

  // Load per-account data when scope changes
  useEffect(() => {
    if (isAll) {
      setNewLeadRule(null); setCustomerTextRule(null); setCallSettings(null);
      return;
    }
    let alive = true;
    setLoading(true); setError(null);
    Promise.all([
      automationApi.getRulesForAccount(accountId).catch(() => ({ rules: [] as AutomationRule[] })),
      notificationsApi.getRules(accountId).catch(() => ({ rules: [] as NotificationRule[] })),
      callConnectApi.getSettings(accountId).catch(() => ({ settings: null as CallConnectSettings | null })),
      templatesApi.getTemplates().catch(() => ({ templates: [] as MessageTemplate[], count: 0 })),
    ]).then(([autoRes, notifRes, ccRes, tplRes]) => {
      if (!alive) return;
      const nl = (autoRes.rules || []).find(r => r.triggerType === 'new_lead' && (!r.delayMinutes || r.delayMinutes === 0)) || null;
      const ct = (notifRes.rules || []).find(r => r.triggerType === 'new_lead' && r.sendToCustomer) || null;
      setNewLeadRule(nl);
      setCustomerTextRule(ct);
      setCallSettings(ccRes.settings);
      setTemplates(tplRes.templates || []);
      if (nl) {
        setInstantReplyOn(!!nl.enabled);
        setReplyType(nl.useAi ? 'ai' : 'template');
      }
      if (ct) setInstantTextOn(!!ct.enabled);
      if (ccRes.settings) {
        setInstantCallOn(!!ccRes.settings.enabled);
        setConnMode(ccRes.settings.mode === 'PARALLEL' ? 'parallel' : 'agent-first');
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [accountId, isAll]);

  const handleSave = async () => {
    if (isAll) {
      setError('Pick a specific account to save changes. "All accounts" is read-only in this view for now.');
      return;
    }
    setSaving(true); setError(null);
    try {
      const ops: Promise<unknown>[] = [];
      if (newLeadRule) {
        ops.push(automationApi.updateRule(newLeadRule.id, {
          enabled: instantReplyOn,
          useAi: replyType === 'ai',
        }));
      }
      if (customerTextRule) {
        ops.push(notificationsApi.updateRule(accountId, customerTextRule.id, {
          enabled: instantTextOn,
        }));
      }
      if (callSettings) {
        ops.push(callConnectApi.saveSettings(accountId, {
          enabled: instantCallOn,
          mode: (connMode === 'parallel' ? 'PARALLEL' : 'AGENT_FIRST') as CallConnectMode,
        }));
      }
      await Promise.all(ops);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e?.response?.data?.message || e?.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const goAiSettings = () => navigate('/automation/convert', { state: fromState });
  const goEditHours = () => navigate('/settings?tab=hours', { state: fromState });
  const goTemplates = () => navigate('/templates', { state: fromState });

  // Resolve template names for cards whose content is stored as raw strings on
  // CallConnectSettings (whisper/voicemail). Match by content first (exact
  // template currently in use), then fall back to the canonical template name.
  const findTplByContent = (content: string | null | undefined): MessageTemplate | undefined =>
    content ? templates.find(t => t.content === content) : undefined;
  const findTplByName = (name: string): MessageTemplate | undefined => templates.find(t => t.name === name);

  const whisperTpl = findTplByContent(callSettings?.agentWhisperMessage) || findTplByName('CC - Agent Whisper');
  const voicemailTpl = findTplByContent(callSettings?.leadVoicemailMessage) || findTplByName('CC - Voicemail TTS');
  const ctTpl = customerTextRule?.messageTemplate || findTplByContent(customerTextRule?.template || null) || findTplByName('CT - Auto Reply');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--lb-ink-5)', fontSize: 13 }}>
          <Loader2 size={14} className="animate-spin" /> Loading account settings…
        </div>
      )}
      {error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-danger-tint)', color: 'var(--lb-danger)',
          fontSize: 13, fontWeight: 600,
        }}>{error}</div>
      )}
      {savedAt && !error && (
        <div style={{
          padding: '10px 14px', borderRadius: 10,
          background: 'var(--lb-success-tint)', color: 'var(--lb-success)',
          fontSize: 13, fontWeight: 600,
        }}>Saved.</div>
      )}

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
            onAction={goAiSettings}
          />
        </FieldRow>

        <FieldRow label="First Reply Instructions" noBorder>
          <InfoTile
            icon={FileText}
            iconTone="violet"
            title={
              replyType === 'ai'
                ? (newLeadRule?.promptTemplate?.name || 'Default first-reply instructions')
                : (newLeadRule?.template?.name || 'Default first-reply template')
            }
            body={
              replyType === 'ai'
                ? (newLeadRule?.promptTemplate?.content || newLeadRule?.aiSystemPrompt || 'How AI should write the first reply.')
                : (newLeadRule?.template?.content || 'Pre-written reply sent when a new lead arrives.')
            }
            actionLabel="Edit Template"
            onAction={goTemplates}
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
              <ActionLink onClick={goEditHours}>Edit Hours</ActionLink>
            </div>
          </div>
        </FieldRow>

        <FieldRow icon={FileText} iconTone="green" label="SMS Template" noBorder>
          <InfoTile
            title={ctTpl?.name || customerTextRule?.name || 'CT - Auto Reply'}
            body={ctTpl?.content || customerTextRule?.template || 'Hi {{lead.name}}, this is {{account.name}}. We just received your request…'}
            actionLabel="Edit Template"
            onAction={goTemplates}
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
              <ActionLink onClick={goEditHours}>Edit Hours</ActionLink>
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
            title={whisperTpl?.name || 'CC - Agent Whisper'}
            body={callSettings?.agentWhisperMessage || whisperTpl?.content || 'You have a new lead for {category}. Customer name: {customerName}…'}
            actionLabel="Edit Template"
            onAction={goTemplates}
          />
        </FieldRow>

        <FieldRow icon={Mic} iconTone="violet" label="Voicemail Message" noBorder>
          <InfoTile
            title={voicemailTpl?.name || 'CC - Voicemail TTS'}
            body={callSettings?.leadVoicemailMessage || voicemailTpl?.content || 'Hi {customerName}, this is {accountName}. We tried to reach you…'}
            actionLabel="Edit Template"
            onAction={goTemplates}
          />
        </FieldRow>
      </SettingCard>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || isAll}
          style={{
            padding: '10px 18px', fontSize: 13.5, fontWeight: 600,
            background: 'var(--lb-accent)', color: 'white',
            border: 0, borderRadius: 10,
            cursor: (saving || isAll) ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            opacity: (saving || isAll) ? 0.6 : 1,
          }}
          title={isAll ? 'Pick a specific account to save changes' : undefined}
        >
          {saving ? 'Saving...' : 'Save changes'}
        </button>
      </div>

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
