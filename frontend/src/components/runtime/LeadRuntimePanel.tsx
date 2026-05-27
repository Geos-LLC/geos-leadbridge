/**
 * Per-lead runtime-state panel.
 *
 * Pulls /v1/leads/:id/runtime-state and renders the new conversation
 * runtime fields as chips alongside the legacy Lead.status pill. Designed
 * to live ABOVE / next to the existing lead-detail header so operators can
 * compare both vocabularies side-by-side during the Phase 3 transition.
 *
 * Self-contained: no parent props beyond `leadId`. Refreshes on demand
 * via an optional refresh button. Renders nothing if the lead doesn't
 * belong to the caller (backend returns success:false).
 */

import { useCallback, useEffect, useState } from 'react';
import { conversationRuntimeApi, type RuntimeStateResponse } from '../../services/api';
import { RuntimeChip, toneForRuntime } from './RuntimeChip';

interface LeadRuntimePanelProps {
  leadId: string;
  /** When true, hides the header bar (useful when embedding in another card). */
  compact?: boolean;
}

export function LeadRuntimePanel({ leadId, compact }: LeadRuntimePanelProps) {
  const [data, setData] = useState<RuntimeStateResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!leadId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await conversationRuntimeApi.getLeadRuntimeState(leadId);
      setData(res);
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load runtime state');
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { void load(); }, [load]);

  if (!leadId) return null;

  if (loading && !data) {
    return (
      <div style={cardStyle}>
        <span style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>Loading runtime state…</span>
      </div>
    );
  }

  if (error) {
    return (
      <div style={cardStyle}>
        <span style={{ fontSize: 12, color: 'var(--lb-danger)' }}>Runtime state error: {error}</span>
      </div>
    );
  }

  if (!data?.success) {
    return null;
  }

  const tc = data.threadContext;
  const labels = data.displayLabels;
  const leadStatus = data.lead?.status;

  return (
    <div style={cardStyle}>
      {!compact && (
        <div style={headerStyle}>
          <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--lb-ink-7)', letterSpacing: 0.04, textTransform: 'uppercase' }}>
            Conversation Runtime
          </span>
          <button onClick={() => void load()} disabled={loading} style={refreshButtonStyle}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      )}

      <div style={chipsRowStyle}>
        {/* Legacy acquisition status — small, muted, labeled */}
        {leadStatus && (
          <RuntimeChip
            label={leadStatus}
            tone="muted"
            title={`Legacy Lead.status (acquisition outcome) — source: ${data.lead?.statusSource ?? 'unknown'}`}
            hint="acquisition"
          />
        )}

        {/* Conversation state — primary chip */}
        {labels && (
          <RuntimeChip
            label={labels.conversationState}
            tone={toneForRuntime('conv', labels.conversationState)}
            title={tc?.conversationStateReason ?? undefined}
          />
        )}

        {/* AI status */}
        {labels && (
          <RuntimeChip
            label={labels.aiStatus}
            tone={toneForRuntime('ai', labels.aiStatus)}
            title={tc?.aiStatusReason ?? undefined}
          />
        )}

        {/* Last classifier intent */}
        {labels && tc?.lastClassifiedIntent && (
          <RuntimeChip
            label={labels.lastClassifiedIntent}
            tone={toneForRuntime('intent', labels.lastClassifiedIntent)}
            hint={tc.lastClassifiedConfidence != null ? `conf ${tc.lastClassifiedConfidence.toFixed(2)}` : undefined}
            title={tc.lastClassifiedAt ? `Classified ${new Date(tc.lastClassifiedAt).toLocaleString()}` : undefined}
          />
        )}

        {/* Follow-up scheduled */}
        {labels && (
          <RuntimeChip
            label={labels.followUp}
            tone={toneForRuntime('followup', labels.followUp)}
            title={data.followUp?.nextFollowUpAt ? new Date(data.followUp.nextFollowUpAt).toLocaleString() : undefined}
          />
        )}

        {/* Human handoff */}
        {labels && labels.handoff !== 'No handoff' && (
          <RuntimeChip
            label={labels.handoff}
            tone={toneForRuntime('handoff', labels.handoff)}
            title={
              tc?.handoffRequestedAt
                ? `Requested ${new Date(tc.handoffRequestedAt).toLocaleString()}${tc.handoffRequestedReason ? ` (${tc.handoffRequestedReason})` : ''}`
                : undefined
            }
          />
        )}

        {/* SF job outcome */}
        {labels && labels.sfJobOutcome !== '—' && (
          <RuntimeChip
            label={labels.sfJobOutcome}
            tone={toneForRuntime('sf', labels.sfJobOutcome)}
            title={data.lead?.sfJobId ? `SF job ${data.lead.sfJobId}` : undefined}
          />
        )}

        {/* Waiting since */}
        {tc?.waitingSince && (
          <RuntimeChip
            label={`Waiting ${humanRelative(tc.waitingSince)}`}
            tone="warn"
            title={`Business last spoke at ${new Date(tc.waitingSince).toLocaleString()}`}
          />
        )}
      </div>

      {!compact && (
        <div style={metaRowStyle}>
          {tc?.lastCustomerMessageAt && (
            <span>Customer last replied {humanRelative(tc.lastCustomerMessageAt)}</span>
          )}
          {data.lead?.platform && (
            <span>Platform: {data.lead.platform}</span>
          )}
          {data.lead?.sfJobOutcomeAt && (
            <span>SF outcome at {humanRelative(data.lead.sfJobOutcomeAt)}</span>
          )}
        </div>
      )}
    </div>
  );
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 8,
  padding: '10px 12px',
  background: 'var(--lb-bg-1)',
  border: '1px solid var(--lb-ink-10)',
  borderRadius: 8,
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const refreshButtonStyle = {
  fontSize: 11,
  color: 'var(--lb-accent)',
  background: 'transparent',
  border: 'none',
  cursor: 'pointer',
  padding: '2px 4px',
};

const chipsRowStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 6,
};

const metaRowStyle = {
  display: 'flex',
  flexWrap: 'wrap' as const,
  gap: 12,
  fontSize: 11,
  color: 'var(--lb-ink-5)',
};

function humanRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) {
    const abs = -ms;
    const m = Math.round(abs / 60000);
    if (m < 60) return `in ${m}m`;
    const h = Math.round(m / 60);
    if (h < 48) return `in ${h}h`;
    const d = Math.round(h / 24);
    return `in ${d}d`;
  }
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
