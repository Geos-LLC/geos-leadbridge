import { useEffect, useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

type Feature = 'call' | 'firstMsg' | 'ai' | 'followups';

interface Props {
  accountId: string;
  feature: Feature;
  /** Compact mode hides the master-status hint line. */
  compact?: boolean;
}

const AI_MODE_LABELS: Record<string, { title: string; hint: string }> = {
  always: { title: 'Always on', hint: 'AI replies 24/7' },
  when_dispatcher_unavailable: { title: 'When you\'re unavailable', hint: 'AI replies only outside business hours (you handle them during)' },
  business_hours_only: { title: 'During business hours only', hint: 'AI replies only inside business hours' },
};

/**
 * Per-account control bound to a single Business Hours feature. Renders:
 *  - 'call' / 'firstMsg' / 'followups' → a single labeled toggle
 *  - 'ai'                              → a 3-option radio group
 *
 * Reads the master `businessHoursEnabled` to show a hint when the master
 * is off (the per-account toggle has no effect until master is on).
 */
export function AccountHoursControl({ accountId, feature, compact = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [masterLabel, setMasterLabel] = useState('');
  const [callOn, setCallOn] = useState(true);
  const [firstMsgOn, setFirstMsgOn] = useState(true);
  const [followUpsOn, setFollowUpsOn] = useState(false);
  const [aiMode, setAiMode] = useState<'always' | 'when_dispatcher_unavailable' | 'business_hours_only'>('when_dispatcher_unavailable');

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    (async () => {
      try {
        const [acct, master] = await Promise.all([
          usersApi.getAccountHours(accountId),
          usersApi.getBusinessHours(),
        ]);
        if (!alive) return;
        setCallOn(acct.callDuringBusinessHours);
        setFirstMsgOn(acct.firstMsgDuringBusinessHours);
        setFollowUpsOn(acct.followUpsUseBusinessHours);
        setAiMode(acct.aiConversationMode);
        setMasterEnabled(master.enabled);
        setMasterLabel(`${master.start}–${master.end} ${master.timezone.split('/')[1]?.replace('_', ' ') || master.timezone}, ${master.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(' ')}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [accountId]);

  const save = async (patch: Parameters<typeof usersApi.updateAccountHours>[1]) => {
    setSaving(true);
    try {
      await usersApi.updateAccountHours(accountId, patch);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <Loader2 size={12} className="animate-spin" /> Loading hours…
      </div>
    );
  }

  const masterHint = !compact && (
    <p className="text-[11px] text-slate-400 mt-1">
      <Clock size={10} className="inline -mt-px mr-1" />
      {masterEnabled ? `Business hours: ${masterLabel}` : 'Business hours master is OFF — toggles have no effect until enabled in Settings → General.'}
    </p>
  );

  if (feature === 'ai') {
    return (
      <div className="space-y-2 bg-slate-50/50 border border-slate-100 rounded-xl p-3">
        <div className="flex items-center justify-between">
          <p className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">When AI replies</p>
          {saving && <Loader2 size={12} className="animate-spin text-slate-400" />}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {(Object.keys(AI_MODE_LABELS) as Array<keyof typeof AI_MODE_LABELS>).map((k) => {
            const on = aiMode === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => { setAiMode(k as any); save({ aiConversationMode: k as any }); }}
                className={`text-left p-2 rounded-lg border transition-colors ${
                  on ? 'bg-blue-50 border-blue-300 text-blue-900' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'
                }`}
              >
                <div className="text-xs font-bold">{AI_MODE_LABELS[k].title}</div>
                <div className="text-[10px] text-slate-500 leading-tight mt-0.5">{AI_MODE_LABELS[k].hint}</div>
              </button>
            );
          })}
        </div>
        {masterHint}
      </div>
    );
  }

  const toggleConfig = {
    call: { label: 'Only call during business hours', on: callOn, set: (v: boolean) => { setCallOn(v); save({ callDuringBusinessHours: v }); } },
    firstMsg: { label: 'Only send first SMS during business hours', on: firstMsgOn, set: (v: boolean) => { setFirstMsgOn(v); save({ firstMsgDuringBusinessHours: v }); } },
    followups: { label: 'Use business hours for follow-ups (overrides quiet hours)', on: followUpsOn, set: (v: boolean) => { setFollowUpsOn(v); save({ followUpsUseBusinessHours: v }); } },
  }[feature];

  return (
    <div className="space-y-1.5 bg-slate-50/50 border border-slate-100 rounded-xl p-3">
      <label className="flex items-center justify-between cursor-pointer">
        <span className="text-xs font-semibold text-slate-700">{toggleConfig.label}</span>
        <div className="flex items-center gap-2">
          {saving && <Loader2 size={12} className="animate-spin text-slate-400" />}
          <input
            type="checkbox"
            className="sr-only peer"
            checked={toggleConfig.on}
            onChange={(e) => toggleConfig.set(e.target.checked)}
          />
          <span className="w-9 h-5 bg-slate-200 rounded-full peer peer-checked:bg-blue-600 relative transition-colors after:content-[''] after:absolute after:top-0.5 after:left-0.5 after:bg-white after:w-4 after:h-4 after:rounded-full after:transition-transform peer-checked:after:translate-x-4" />
        </div>
      </label>
      {masterHint}
    </div>
  );
}
