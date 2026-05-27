/**
 * Drift diagnostic — shows the 7 legacy-vs-runtime mismatch categories
 * with counts + expandable example leadIds. No PII in examples (server
 * already enforces this).
 *
 * Each category is collapsed by default; click to expand and inspect the
 * up-to-5 example leads. Click a leadId to copy it to the clipboard for
 * spot-checking via the existing lead-detail page.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  conversationRuntimeApi,
  type LegacyComparisonCategory,
  type LegacyComparisonResponse,
} from '../../services/api';

export function LegacyComparisonCard() {
  const [data, setData] = useState<LegacyComparisonResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await conversationRuntimeApi.getLegacyComparison(5));
    } catch (e: any) {
      setError(e?.response?.data?.error ?? e?.message ?? 'Failed to load comparison');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (loading && !data) return <div style={cardStyle}>Loading drift comparison…</div>;
  if (error) return <div style={{ ...cardStyle, color: 'var(--lb-danger)' }}>Drift error: {error}</div>;
  if (!data) return null;

  const cats = Object.entries(data.categories);

  return (
    <div style={cardStyle}>
      <div style={headerStyle}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Legacy ↔ Runtime Drift</h3>
        <span style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
          {cats.reduce((acc, [, v]) => acc + v.count, 0)} total · ≤{data.examplesPerCategory} examples/cat
        </span>
      </div>

      <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {cats.map(([key, cat]) => (
          <li key={key} style={rowStyle}>
            <button
              onClick={() => setExpanded((p) => ({ ...p, [key]: !p[key] }))}
              style={{
                ...rowToggleStyle,
                color: cat.count > 0 ? 'var(--lb-ink-9)' : 'var(--lb-ink-5)',
              }}
            >
              <span style={{ fontFamily: 'monospace', fontSize: 11, minWidth: 32, textAlign: 'right', color: cat.count > 0 ? 'var(--lb-warn)' : 'var(--lb-ink-5)', fontWeight: 700 }}>
                {cat.count}
              </span>
              <span style={{ fontSize: 12, fontWeight: 600 }}>{key}</span>
              <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', flex: 1, marginLeft: 8 }}>{cat.description}</span>
              <span style={{ fontSize: 11, color: 'var(--lb-ink-5)' }}>
                {expanded[key] ? '▾' : '▸'}
              </span>
            </button>
            {expanded[key] && cat.examples.length > 0 && <ExampleTable cat={cat} />}
            {expanded[key] && cat.examples.length === 0 && (
              <div style={{ fontSize: 11, color: 'var(--lb-ink-5)', padding: '6px 12px' }}>
                No examples (count is {cat.count}).
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ExampleTable({ cat }: { cat: LegacyComparisonCategory }) {
  return (
    <div style={{ padding: '6px 12px', background: 'var(--lb-bg-0)', borderTop: '1px solid var(--lb-ink-10)' }}>
      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'var(--lb-ink-5)', textAlign: 'left' }}>
            <th style={thStyle}>leadId</th>
            <th style={thStyle}>platform</th>
            <th style={thStyle}>legacy</th>
            <th style={thStyle}>runtime</th>
            <th style={thStyle}>reason</th>
          </tr>
        </thead>
        <tbody>
          {cat.examples.map((ex) => (
            <tr key={ex.leadId ?? Math.random()} style={{ borderTop: '1px solid var(--lb-ink-10)' }}>
              <td style={tdStyle}>
                {ex.leadId ? (
                  <button
                    onClick={() => { if (ex.leadId) void navigator.clipboard.writeText(ex.leadId); }}
                    title="Click to copy"
                    style={leadIdButtonStyle}
                  >
                    {ex.leadId.slice(0, 8)}…
                  </button>
                ) : '—'}
              </td>
              <td style={tdStyle}>{ex.platform ?? '—'}</td>
              <td style={tdStyle}>{ex.legacyStatus ?? '—'}{ex.statusSource && <span style={{ color: 'var(--lb-ink-5)' }}> · {ex.statusSource}</span>}</td>
              <td style={tdStyle}>
                {ex.conversationState ?? ex.sfJobOutcome ?? '—'}
                {ex.aiStatus && <span style={{ color: 'var(--lb-ink-5)' }}> · {ex.aiStatus}</span>}
              </td>
              <td style={{ ...tdStyle, color: 'var(--lb-ink-5)' }}>
                {ex.conversationStateReason ?? ex.aiStatusReason ?? '—'}
              </td>
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
  gap: 10,
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

const rowStyle = {
  border: '1px solid var(--lb-ink-10)',
  borderRadius: 6,
  overflow: 'hidden' as const,
};

const rowToggleStyle = {
  width: '100%',
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '8px 12px',
  background: 'var(--lb-bg-1)',
  border: 'none',
  cursor: 'pointer',
  textAlign: 'left' as const,
};

const thStyle = { fontWeight: 500, fontSize: 10, padding: '4px 6px', textTransform: 'uppercase' as const, letterSpacing: 0.04 };
const tdStyle = { padding: '4px 6px', verticalAlign: 'top' as const };

const leadIdButtonStyle = {
  fontFamily: 'monospace',
  fontSize: 11,
  background: 'transparent',
  border: 'none',
  color: 'var(--lb-accent)',
  cursor: 'pointer',
  padding: 0,
};
