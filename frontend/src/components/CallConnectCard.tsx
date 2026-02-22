import { useEffect, useState } from 'react';
import { Phone, PhoneCall, PhoneOff, PhoneMissed, Loader2, RotateCcw, Circle, ChevronDown, ChevronUp } from 'lucide-react';
import { callConnectApi } from '../services/api';
import type { LeadCallConnect, CallConnectStatus } from '../types';

interface CallConnectCardProps {
  leadId: string;
}

const STATUS_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; Icon: typeof Phone }
> = {
  CREATED:         { label: 'Connecting…',     color: 'text-blue-600',   bgColor: 'bg-blue-50',   Icon: Phone },
  CALLING_AGENT:   { label: 'Connecting…',     color: 'text-blue-600',   bgColor: 'bg-blue-50',   Icon: PhoneCall },
  AGENT_ANSWERED:  { label: 'Agent connected', color: 'text-blue-600',   bgColor: 'bg-blue-50',   Icon: PhoneCall },
  AGENT_ACCEPTED:  { label: 'Agent connected', color: 'text-blue-600',   bgColor: 'bg-blue-50',   Icon: PhoneCall },
  CALLING_LEAD:    { label: 'Ringing lead…',   color: 'text-blue-600',   bgColor: 'bg-blue-50',   Icon: PhoneCall },
  BRIDGED:         { label: 'Connected',       color: 'text-green-700',  bgColor: 'bg-green-50',  Icon: PhoneCall },
  VOICEMAIL_DROP:  { label: 'Voicemail left',  color: 'text-yellow-700', bgColor: 'bg-yellow-50', Icon: PhoneOff },
  ENDED:           { label: 'Ended',           color: 'text-gray-600',   bgColor: 'bg-gray-50',   Icon: PhoneOff },
  FAILED:          { label: 'Missed',          color: 'text-red-600',    bgColor: 'bg-red-50',    Icon: PhoneMissed },
  CANCELED:        { label: 'Canceled',        color: 'text-gray-500',   bgColor: 'bg-gray-50',   Icon: PhoneOff },
  // legacy
  RINGING_AGENT:   { label: 'Ringing agent…',  color: 'text-yellow-600', bgColor: 'bg-yellow-50', Icon: PhoneCall },
  RINGING_LEAD:    { label: 'Connecting lead…',color: 'text-yellow-600', bgColor: 'bg-yellow-50', Icon: PhoneCall },
  CANCELLED:       { label: 'Cancelled',       color: 'text-gray-500',   bgColor: 'bg-gray-50',   Icon: PhoneOff },
};

const EVENT_LABELS: Record<string, string> = {
  'call_connect.session.created':  'Session created',
  'call_connect.session_created':  'Session created',
  'call_connect.agent.ringing':    'Agent ringing',
  'call_connect.agent_ringing':    'Agent ringing',
  'call_connect.agent.accepted':   'Agent accepted',
  'call_connect.agent_accepted':   'Agent accepted',
  'call_connect.lead.ringing':     'Lead ringing',
  'call_connect.lead_ringing':     'Lead ringing',
  'call_connect.bridged':          'Bridged ✓',
  'call_connect.voicemail_drop':   'Voicemail dropped',
  'call_connect.ended':            'Ended',
  'call_connect.failed':           'Failed',
};

function formatTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function formatDate(iso: string) {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return 'Today';
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: CallConnectStatus | string }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.CREATED;
  const { Icon } = cfg;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${cfg.bgColor} ${cfg.color}`}>
      <Icon size={11} />
      {cfg.label}
    </span>
  );
}

function SessionCard({ session, index, total }: { session: LeadCallConnect; index: number; total: number }) {
  const [showTimeline, setShowTimeline] = useState(false);
  const cfg = STATUS_CONFIG[session.status] || STATUS_CONFIG.CREATED;
  const timeline = Array.isArray(session.timeline) ? session.timeline : [];

  return (
    <div className={`rounded-lg border px-3 py-2.5 ${cfg.bgColor} border-transparent`}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 font-medium">#{total - index}</span>
          <StatusBadge status={session.status} />
          {session.attempt > 0 && (
            <span className="text-xs text-gray-500">attempt {session.attempt}</span>
          )}
        </div>
        <span className="text-xs text-gray-400 shrink-0">
          {formatDate(session.createdAt)} {formatTime(session.createdAt)}
        </span>
      </div>

      {session.failureReason && (
        <p className="text-xs text-red-600 mt-1">{session.failureReason}</p>
      )}

      {session.recordingUrl && (
        <a
          href={session.recordingUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline mt-1"
        >
          <PhoneCall size={11} />
          Listen to recording
        </a>
      )}

      {/* Timeline toggle */}
      {timeline.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowTimeline(!showTimeline)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 transition-colors"
          >
            {showTimeline ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Timeline ({timeline.length} events)
          </button>

          {showTimeline && (
            <div className="mt-2 space-y-1 pl-2 border-l-2 border-gray-200">
              {timeline.map((entry, i) => (
                <div key={i} className="flex items-start gap-2">
                  <span className="text-xs text-gray-400 shrink-0 mt-0.5">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className="text-xs text-gray-700">
                    {EVENT_LABELS[entry.event] || entry.event}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {timeline.length === 0 && (
        <div className="text-xs text-gray-400 mt-1">
          Last update: {formatTime(session.lastEventAt)}
        </div>
      )}
    </div>
  );
}

export function CallConnectCard({ leadId }: CallConnectCardProps) {
  const [sessions, setSessions] = useState<LeadCallConnect[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await callConnectApi.getLeadSessions(leadId);
      setSessions(res.sessions);
    } catch (e: any) {
      setError(e?.response?.data?.message || 'Failed to load call connect sessions');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [leadId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-400 py-2">
        <Loader2 size={14} className="animate-spin" />
        Loading call connect…
      </div>
    );
  }

  if (error) {
    return <div className="text-xs text-red-500 py-1">{error}</div>;
  }

  if (sessions.length === 0) {
    return (
      <div className="text-xs text-gray-400 py-1 flex items-center gap-1.5">
        <Circle size={8} className="text-gray-300" />
        No call connect sessions for this lead
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium text-gray-700">
          <Phone size={14} className="text-blue-500" />
          Call Connect
          <span className="text-xs text-gray-400 font-normal">({sessions.length} session{sessions.length !== 1 ? 's' : ''})</span>
        </div>
        <button onClick={load} className="p-1 hover:bg-gray-100 rounded transition-colors" title="Refresh">
          <RotateCcw size={13} className="text-gray-400" />
        </button>
      </div>

      <div className="space-y-2">
        {sessions.map((session, idx) => (
          <SessionCard key={session.id} session={session} index={idx} total={sessions.length} />
        ))}
      </div>
    </div>
  );
}
