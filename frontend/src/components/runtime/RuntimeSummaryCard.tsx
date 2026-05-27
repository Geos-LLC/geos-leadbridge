/**
 * Tenant-wide runtime summary — counts grid for a drift dashboard.
 *
 * Pulls /v1/conversation-runtime/summary on mount and renders distribution
 * tables for conversationState, aiStatus, classifier intents, sfJobOutcome
 * coverage, and mismatch counts.
 *
 * Designed for an admin/debug page during the Phase 2/3 transition — not
 * for end-user dashboards. The Phase 3 read-path migration will need this
 * page to verify the legacy/runtime mismatch drops to near-zero.
 */

import { useCallback, useEffect, useState } from 'react';
import { conversationRuntimeApi, type RuntimeSummaryResponse } from '../../services/api';

interface RuntimeSummaryCardProps {
  /** Auto-refresh interval in ms. Pass 0 (default) to disable. */
  refreshMs?: number;
}

export function RuntimeSummaryCard({ refreshMs = 0 }: RuntimeSummaryCardProps) {
  const [data, setData] = useState<RuntimeSummaryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await conversationRuntimeApi.getSummary());
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load summary');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => { void load(); }, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs, load]);

  if (loading && !data) return <div style={cardStyle}>Loading tenant summary…</div>;
  if (error) return <div style={{ ...cardStyle, color: 'var(--lb-danger)' }}>Summary error: {error}</div>;
  if (!data) return null;

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Conversation Runtime — Summary</h3>
        <span style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
          {data.totals.threadContexts} threads · generated {new Date(data.generatedAt).toLocaleTimeString()}
        </span>
      </div>

      <div style={gridStyle}>
        <DistributionBlock title="Conversation state" counts={data.byConversationState} />
        <DistributionBlock title="AI status" counts={data.byAiStatus} />
        <DistributionBlock title="Last classifier intent" counts={data.byLastClassifiedIntent} />
        <DistributionBlock title="SF job outcome" counts={data.sfJobOutcomeCounts} />
      </div>

      <div style={sectionsRowStyle}>
        <KvBlock title="SF outcome coverage" rows={[
          ['Populated', String(data.sfOutcomeCoverage.populated)],
          ['SF-linked total', String(data.sfOutcomeCoverage.sfLinkedTotal)],
          ['Ratio', data.sfOutcomeCoverage.ratio != null ? `${(data.sfOutcomeCoverage.ratio * 100).toFixed(1)}%` : '—'],
        ]}/>

        <KvBlock title="Mismatch (Lead.status ↔ conversationState)" rows={[
          ['Legacy terminal + runtime active', String(data.mismatchCounts.legacyTerminalRuntimeActive)],
          ['Runtime terminal + legacy active', String(data.mismatchCounts.runtimeTerminalLegacyActive)],
        ]}/>

        <KvBlock title="Handoff + waiting" rows={[
          ['Open handoffs', String(data.handoffOpen)],
          ['Waiting (any duration)', String(data.waitingSinceCount)],
          ['Stale waiting (>72h)', String(data.staleWaiting)],
        ]}/>

        <KvBlock title="Runtime writes (last 24h)" rows={[
          ['conversationState', String(data.updatedLast24h.conversationState)],
          ['aiStatus', String(data.updatedLast24h.aiStatus)],
          ['classifierIntent', String(data.updatedLast24h.classifiedIntent)],
          ['handoffRequested', String(data.updatedLast24h.handoffRequested)],
          ['sfJobOutcome', String(data.updatedLast24h.sfJobOutcome)],
        ]}/>
      </div>
    </div>
  );
}

interface DistributionBlockProps {
  title: string;
  counts: Record<string, number>;
}
function DistributionBlock({ title, counts }: DistributionBlockProps) {
  const entries = Object.entries(counts).filter(([, v]) => v > 0);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <div style={blockStyle}>
      <div style={blockTitleStyle}>{title} <span style={{ color: 'var(--lb-ink-5)', fontWeight: 400 }}>· {total}</span></div>
      {entries.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>No data</div>
      ) : (
        <table style={{ width: '100%', fontSize: 12 }}>
          <tbody>
            {entries.sort(([, a], [, b]) => b - a).map(([k, v]) => (
              <tr key={k}>
                <td style={{ padding: '2px 0', color: 'var(--lb-ink-7)' }}>{k === '_null' ? <em>null</em> : k}</td>
                <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface KvBlockProps {
  title: string;
  rows: Array<[label: string, value: string]>;
}
function KvBlock({ title, rows }: KvBlockProps) {
  return (
    <div style={blockStyle}>
      <div style={blockTitleStyle}>{title}</div>
      <table style={{ width: '100%', fontSize: 12 }}>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ padding: '2px 0', color: 'var(--lb-ink-7)' }}>{k}</td>
              <td style={{ padding: '2px 0', textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const cardStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 16,
  padding: 16,
  background: 'var(--lb-bg-1)',
  border: '1px solid var(--lb-ink-10)',
  borderRadius: 10,
};

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const gridStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const sectionsRowStyle = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 12,
};

const blockStyle = {
  padding: '10px 12px',
  background: 'var(--lb-bg-0)',
  border: '1px solid var(--lb-ink-10)',
  borderRadius: 6,
};

const blockTitleStyle = {
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--lb-ink-7)',
  letterSpacing: 0.04,
  textTransform: 'uppercase' as const,
  marginBottom: 6,
};
