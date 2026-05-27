/**
 * Runtime Debug page (operator-only).
 *
 * Read-only diagnostic surface for the Phase 1.5 conversation runtime
 * layer. Combines:
 *   - Tenant-wide summary (counts + coverage + drift)
 *   - Legacy/runtime mismatch categories (drill into example leadIds)
 *   - Optional per-lead runtime panel (paste a leadId)
 *
 * Lives at /runtime/debug — NOT linked from the main nav. Operators
 * navigate to it directly. The primary lead UI is untouched until Phase 3.
 */

import { useState } from 'react';
import { LeadRuntimePanel } from '../components/runtime/LeadRuntimePanel';
import { LegacyComparisonCard } from '../components/runtime/LegacyComparisonCard';
import { RuntimeSummaryCard } from '../components/runtime/RuntimeSummaryCard';

export default function RuntimeDebug() {
  const [leadId, setLeadId] = useState('');
  const [submittedLeadId, setSubmittedLeadId] = useState<string | null>(null);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, padding: 24, maxWidth: 1200, margin: '0 auto' }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700 }}>Conversation Runtime — Debug</h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--lb-ink-5)', maxWidth: 760 }}>
          Read-only diagnostic for the Phase 1.5 runtime layer. Shows new
          ThreadContext fields (conversationState, aiStatus, lastClassifiedIntent,
          handoff lifecycle, waitingSince) and Lead.sfJobOutcome alongside the
          legacy Lead.status pipeline. Used to verify drift before Phase 3
          migrates decision logic.
        </p>
      </header>

      <RuntimeSummaryCard refreshMs={0} />

      <LegacyComparisonCard />

      <section style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 16,
        background: 'var(--lb-bg-1)',
        border: '1px solid var(--lb-ink-10)',
        borderRadius: 10,
      }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Per-lead inspection</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = leadId.trim();
            setSubmittedLeadId(trimmed || null);
          }}
          style={{ display: 'flex', gap: 8 }}
        >
          <input
            type="text"
            placeholder="Paste leadId (uuid) — copy from the comparison table above"
            value={leadId}
            onChange={(e) => setLeadId(e.target.value)}
            style={{
              flex: 1,
              padding: '6px 10px',
              fontSize: 13,
              border: '1px solid var(--lb-ink-10)',
              borderRadius: 6,
              fontFamily: 'monospace',
            }}
          />
          <button
            type="submit"
            disabled={!leadId.trim()}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              background: 'var(--lb-accent)',
              color: 'white',
              border: 'none',
              borderRadius: 6,
              cursor: leadId.trim() ? 'pointer' : 'not-allowed',
              opacity: leadId.trim() ? 1 : 0.5,
            }}
          >
            Inspect
          </button>
          {submittedLeadId && (
            <button
              type="button"
              onClick={() => { setSubmittedLeadId(null); setLeadId(''); }}
              style={{
                padding: '6px 10px',
                fontSize: 13,
                background: 'transparent',
                color: 'var(--lb-ink-7)',
                border: '1px solid var(--lb-ink-10)',
                borderRadius: 6,
                cursor: 'pointer',
              }}
            >
              Clear
            </button>
          )}
        </form>

        {submittedLeadId && (
          <LeadRuntimePanel leadId={submittedLeadId} />
        )}
      </section>
    </div>
  );
}
