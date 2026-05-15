import { useEffect, useState } from 'react';
import { Clock, Loader2 } from 'lucide-react';
import { usersApi } from '../services/api';

type Feature = 'call' | 'firstMsg' | 'applyQuietHours';

interface Props {
  accountId: string;
  feature: Feature;
  /** Compact mode hides the master-status hint line. */
  compact?: boolean;
}

/**
 * Per-account control bound to a single feature toggle:
 *  - 'call' / 'firstMsg'    → opts in to the User's Business Hours window
 *  - 'applyQuietHours'      → opts in to the User's Quiet Hours window (follow-ups)
 *
 * Each renders a single labeled toggle plus a hint showing the master window state.
 */
export function AccountHoursControl({ accountId, feature, compact = false }: Props) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [masterEnabled, setMasterEnabled] = useState(false);
  const [masterLabel, setMasterLabel] = useState('');
  const [callOn, setCallOn] = useState(true);
  const [firstMsgOn, setFirstMsgOn] = useState(true);
  const [applyQuietOn, setApplyQuietOn] = useState(true);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    (async () => {
      try {
        if (feature === 'applyQuietHours') {
          const [acct, master] = await Promise.all([
            usersApi.getAccountHours(accountId),
            usersApi.getQuietHours(),
          ]);
          if (!alive) return;
          setApplyQuietOn(acct.followUpsApplyQuietHours);
          setMasterEnabled(master.enabled);
          setMasterLabel(`${master.start}–${master.end} ${master.timezone.split('/')[1]?.replace('_', ' ') || master.timezone} (daily)`);
        } else {
          const [acct, master] = await Promise.all([
            usersApi.getAccountHours(accountId),
            usersApi.getBusinessHours(),
          ]);
          if (!alive) return;
          setCallOn(acct.callDuringBusinessHours);
          setFirstMsgOn(acct.firstMsgDuringBusinessHours);
          setMasterEnabled(master.enabled);
          setMasterLabel(`${master.start}–${master.end} ${master.timezone.split('/')[1]?.replace('_', ' ') || master.timezone}, ${master.days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(' ')}`);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [accountId, feature]);

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

  const masterKind = feature === 'applyQuietHours' ? 'Quiet hours' : 'Business hours';
  const masterHint = !compact && (
    <p className="text-[11px] text-slate-400 mt-1">
      <Clock size={10} className="inline -mt-px mr-1" />
      {masterEnabled
        ? `${masterKind}: ${masterLabel}`
        : `${masterKind} master is OFF — toggle has no effect until enabled in Settings → General.`}
    </p>
  );

  const toggleConfig = {
    call: { label: 'Only call during business hours', on: callOn, set: (v: boolean) => { setCallOn(v); save({ callDuringBusinessHours: v }); } },
    firstMsg: { label: 'Only send first SMS during business hours', on: firstMsgOn, set: (v: boolean) => { setFirstMsgOn(v); save({ firstMsgDuringBusinessHours: v }); } },
    applyQuietHours: { label: 'Apply quiet hours (don\'t send follow-ups overnight)', on: applyQuietOn, set: (v: boolean) => { setApplyQuietOn(v); save({ followUpsApplyQuietHours: v }); } },
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
