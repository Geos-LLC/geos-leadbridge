/**
 * Skipped & Refunded Leads tab.
 *
 * Shows the list of leads where the follow-up engine couldn't deliver
 * messages (TT refund, platform thread removed, archived, etc.) AND/OR
 * leads where Lead.refundedAt was set by the chargeState sweep / 404
 * detection in the scheduler.
 *
 * The data comes from GET /v1/analytics/skipped — backed by
 * AnalyticsService.getSkippedLeads which merges two sources (refunded
 * Lead rows + stopped FollowUpEnrollment rows with platform-side
 * stoppedReasons).
 *
 * Filter state (businessId, platform, date range) is driven by the
 * parent Analytics page — keeps Skipped consistent with whatever the
 * operator is looking at on the Overview tab.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, DollarSign, Phone, Loader2 } from 'lucide-react';
import { analyticsApi, type SkippedLeadRow } from '../../services/api';

type AnalyticsPlatform = 'thumbtack' | 'yelp' | undefined;

interface Props {
  businessId?: string;
  platform?: AnalyticsPlatform;
  startDate?: string;
  endDate?: string;
}

const REASON_LABELS: Record<string, string> = {
  platform_lead_removed_refunded: 'Refunded by platform',
  platform_thread_unreachable: 'Platform thread unreachable',
  platform_thread_closed: 'Platform thread closed',
  platform_thread_archived: 'Platform thread archived',
  lead_archived: 'Customer archived lead',
  no_thread_id: 'Missing thread ID',
  no_delivery_channel: 'No delivery channel',
  awaiting_human_response: 'Awaiting human handoff',
  deferral_phrase: 'Customer requested deferral',
  thread_closed: 'Thread closed',
  platform_send_failed: 'Send failed at platform',
  smoke_v2_delivery_failed_retry_loop: 'Delivery retry loop (legacy)',
};

function formatReason(reason: string | null): string {
  if (!reason) return '—';
  return REASON_LABELS[reason] ?? reason;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function SkippedRefundedTab({ businessId, platform, startDate, endDate }: Props) {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<SkippedLeadRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    analyticsApi
      .getSkippedLeads({
        businessId: businessId && businessId !== 'all' ? businessId : undefined,
        platform,
        startDate,
        endDate,
      })
      .then((resp) => {
        if (cancelled) return;
        setRows(resp.data ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.response?.data?.message ?? err.message ?? 'Failed to load skipped leads');
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [businessId, platform, startDate, endDate]);

  const refundedCount = rows.filter((r) => r.refundedAt !== null).length;
  const totalCount = rows.length;

  return (
    <div className="space-y-6">
      {/* Summary strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat
          icon={<AlertTriangle size={14} style={{ color: 'var(--lb-accent)' }} />}
          label="Total skipped"
          value={totalCount}
          hint="Leads we couldn't message due to platform-side issues"
        />
        <Stat
          icon={<DollarSign size={14} style={{ color: 'var(--lb-accent)' }} />}
          label="Refunded by platform"
          value={refundedCount}
          hint="Cost auto-excluded from your analytics totals"
        />
        <Stat
          icon={<Phone size={14} style={{ color: 'var(--lb-accent)' }} />}
          label="Reachable by phone"
          value={rows.filter((r) => r.phone).length}
          hint="Phone numbers preserved — operator can reach out directly"
        />
      </div>

      {/* Table */}
      <div
        className="p-5 md:p-6"
        style={{
          background: 'var(--lb-surface)',
          border: '1px solid var(--lb-line)',
          borderRadius: 'var(--lb-radius-lg)',
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <h3
            style={{
              margin: 0,
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--lb-ink-1)',
            }}
          >
            Skipped &amp; Refunded leads
          </h3>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--lb-ink-5)' }}>
            Lead status, phone numbers, and SF link remain intact — these leads are still queryable on the Leads page.
          </p>
        </div>

        {loading ? (
          <div style={{ padding: 40, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--lb-ink-5)' }}>
            <Loader2 size={14} className="animate-spin" />
            <span style={{ fontSize: 12 }}>Loading skipped leads…</span>
          </div>
        ) : error ? (
          <div style={{ padding: 20, color: 'var(--lb-danger, #dc2626)', fontSize: 12 }}>{error}</div>
        ) : rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--lb-ink-5)', fontSize: 12 }}>
            No skipped or refunded leads in this window — the follow-up engine reached everyone.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--lb-line)' }}>
                  <Th>Customer</Th>
                  <Th>Platform</Th>
                  <Th>Reason</Th>
                  <Th>Refund</Th>
                  <Th>Phone</Th>
                  <Th>When</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.leadId} style={{ borderBottom: '1px solid var(--lb-line)' }}>
                    <Td>
                      <span style={{ fontWeight: 500, color: 'var(--lb-ink-1)' }}>{r.customerName}</span>
                    </Td>
                    <Td>
                      <span style={{ textTransform: 'capitalize' }}>{r.platform}</span>
                    </Td>
                    <Td>
                      <span>{formatReason(r.stoppedReason)}</span>
                    </Td>
                    <Td>
                      {r.refundedAt ? (
                        <span
                          style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 4,
                            padding: '2px 8px',
                            background: 'rgba(220, 38, 38, 0.08)',
                            color: '#dc2626',
                            border: '1px solid rgba(220, 38, 38, 0.2)',
                            borderRadius: 999,
                            fontSize: 11,
                            fontWeight: 500,
                          }}
                        >
                          Refunded
                        </span>
                      ) : (
                        <span style={{ color: 'var(--lb-ink-5)' }}>—</span>
                      )}
                    </Td>
                    <Td>
                      {r.phone ? (
                        <span style={{ fontFamily: 'var(--lb-font-mono)' }}>{r.phone}</span>
                      ) : (
                        <span style={{ color: 'var(--lb-ink-5)' }}>no phone</span>
                      )}
                    </Td>
                    <Td>
                      <span style={{ fontFamily: 'var(--lb-font-mono)', color: 'var(--lb-ink-5)' }}>
                        {formatDate(r.stoppedAt ?? r.refundedAt)}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ icon, label, value, hint }: { icon: React.ReactNode; label: string; value: number; hint: string }) {
  return (
    <div
      className="p-4 md:p-5"
      style={{
        background: 'var(--lb-surface)',
        border: '1px solid var(--lb-line)',
        borderRadius: 'var(--lb-radius-lg)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        {icon}
        <span style={{ fontSize: 11, color: 'var(--lb-ink-5)', fontFamily: 'var(--lb-font-mono)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
          {label}
        </span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
        {value}
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--lb-ink-5)' }}>{hint}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        textAlign: 'left',
        padding: '10px 12px',
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--lb-ink-5)',
        textTransform: 'uppercase',
        letterSpacing: 0.5,
        fontFamily: 'var(--lb-font-mono)',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return (
    <td style={{ padding: '12px', color: 'var(--lb-ink-2)' }}>{children}</td>
  );
}
