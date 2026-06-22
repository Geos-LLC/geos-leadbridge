import { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, AlertCircle, CheckCircle2, RefreshCw, Loader2, Bell, Users,
} from 'lucide-react';
import { adminApi, isSupportAccessDenied } from '../../services/api';
import type { TenantHealthSummary } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { SupportAccessRequired } from '../../components/SupportAccessRequired';

const statusBadge = (status: string) => {
  const cls = status === 'critical'
    ? 'bg-red-100 text-red-700'
    : status === 'warning'
      ? 'bg-amber-100 text-amber-700'
      : 'bg-slate-100 text-slate-600';
  return (
    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase ${cls}`}>
      {status}
    </span>
  );
};

const formatRelative = (iso: string | null) => {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '—';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
};

export default function AdminTenantHealth() {
  const [data, setData] = useState<TenantHealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [running, setRunning] = useState(false);
  const [accessDenied, setAccessDenied] = useState(false);

  const load = useCallback(async (showSpinner = true) => {
    try {
      if (showSpinner) setLoading(true);
      else setRefreshing(true);
      setAccessDenied(false);
      const result = await adminApi.getTenantHealth();
      setData(result);
    } catch (err: any) {
      if (isSupportAccessDenied(err)) {
        setAccessDenied(true);
      } else {
        notify.error('Failed to load tenant health', err?.response?.data?.message || err.message);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(true);
  }, [load]);

  const handleRunSweep = async () => {
    try {
      setRunning(true);
      await adminApi.runTenantHealthSweep();
      notify.success('Sweep triggered', 'The hourly health check is running. Refreshing in 8 seconds...');
      setTimeout(() => load(false), 8000);
    } catch (err: any) {
      notify.error('Failed to trigger sweep', err?.response?.data?.message || err.message);
    } finally {
      setRunning(false);
    }
  };

  if (accessDenied) {
    return (
      <div className="p-6">
        <SupportAccessRequired
          scope="errors:read"
          sectionLabel="Cross-tenant health"
          onGranted={() => load(true)}
        />
      </div>
    );
  }

  if (loading || !data) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[400px]">
        <Loader2 className="animate-spin text-slate-400" size={28} />
      </div>
    );
  }

  const { summary, byCode, activeIssues, recentDevAlerts } = data;

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Cross-Tenant Health</h1>
          <p className="text-sm text-slate-500 mt-1">
            Active issues across all tenants. Last sweep: {formatRelative(summary.lastCheckedAt)}.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => load(false)}
            disabled={refreshing}
            className="px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-md hover:bg-slate-50 disabled:opacity-50 flex items-center gap-2"
          >
            {refreshing ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            Refresh
          </button>
          <button
            onClick={handleRunSweep}
            disabled={running}
            className="px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded-md hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
          >
            {running ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
            Run sweep now
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
        <SummaryCard
          icon={<AlertCircle size={18} className="text-red-600" />}
          label="Critical"
          value={summary.critical}
          accent="text-red-700"
        />
        <SummaryCard
          icon={<AlertTriangle size={18} className="text-amber-600" />}
          label="Warning"
          value={summary.warning}
          accent="text-amber-700"
        />
        <SummaryCard
          icon={<Users size={18} className="text-slate-600" />}
          label="Tenants affected"
          value={summary.tenantsAffected}
        />
        <SummaryCard
          icon={summary.totalActive === 0
            ? <CheckCircle2 size={18} className="text-emerald-600" />
            : <Bell size={18} className="text-slate-600" />}
          label="Total active"
          value={summary.totalActive}
          accent={summary.totalActive === 0 ? 'text-emerald-700' : ''}
        />
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">Issues by code</h2>
          <span className="text-xs text-slate-500">{byCode.length} distinct codes</span>
        </div>
        {byCode.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500 flex items-center justify-center gap-2">
            <CheckCircle2 size={16} className="text-emerald-600" /> No active issues across any tenant.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Issue code</th>
                <th className="px-4 py-2 text-left font-semibold">Severity</th>
                <th className="px-4 py-2 text-right font-semibold">Count</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {byCode.map((c) => (
                <tr key={c.issueCode} className="hover:bg-slate-50">
                  <td className="px-4 py-2 font-mono text-xs">{c.issueCode}</td>
                  <td className="px-4 py-2">{statusBadge(c.status)}</td>
                  <td className="px-4 py-2 text-right font-semibold">{c.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
          <h2 className="text-sm font-bold text-slate-900">Active issues — all tenants</h2>
          <span className="text-xs text-slate-500">{activeIssues.length} rows</span>
        </div>
        {activeIssues.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">No active issues.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
                <tr>
                  <th className="px-4 py-2 text-left font-semibold">Tenant</th>
                  <th className="px-4 py-2 text-left font-semibold">Account</th>
                  <th className="px-4 py-2 text-left font-semibold">Platform</th>
                  <th className="px-4 py-2 text-left font-semibold">Issue</th>
                  <th className="px-4 py-2 text-left font-semibold">Severity</th>
                  <th className="px-4 py-2 text-left font-semibold">First seen</th>
                  <th className="px-4 py-2 text-right font-semibold">Pages</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {activeIssues.map((issue) => (
                  <tr key={issue.id} className="hover:bg-slate-50">
                    <td className="px-4 py-2">
                      <Link to={`/admin/users/${issue.userId}`} className="text-blue-600 hover:underline">
                        {issue.userName || issue.userEmail || issue.userId.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-4 py-2 text-slate-700">{issue.accountName}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs uppercase">{issue.platform}</td>
                    <td className="px-4 py-2">
                      <div className="font-mono text-xs text-slate-700">{issue.issueCode}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{issue.issueMessage}</div>
                    </td>
                    <td className="px-4 py-2">{statusBadge(issue.status)}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs">{formatRelative(issue.firstDetectedAt)}</td>
                    <td className="px-4 py-2 text-right text-slate-700">{issue.notificationCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <h2 className="text-sm font-bold text-slate-900">Recent dev alerts</h2>
          <p className="text-xs text-slate-500 mt-1">
            Cross-tenant alerts paged to the on-call dev (SMS + email). Deduped at 1h per kind.
          </p>
        </div>
        {recentDevAlerts.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">No dev alerts in recent history.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs uppercase">
              <tr>
                <th className="px-4 py-2 text-left font-semibold">Sent</th>
                <th className="px-4 py-2 text-left font-semibold">Kind</th>
                <th className="px-4 py-2 text-left font-semibold">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {recentDevAlerts.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2 text-slate-500 text-xs whitespace-nowrap">
                    {formatRelative(a.emailedAt)}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-700">{a.code || '—'}</td>
                  <td className="px-4 py-2 text-slate-700">{a.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  icon, label, value, accent,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  accent?: string;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4">
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 uppercase">
        {icon}
        {label}
      </div>
      <div className={`mt-2 text-2xl font-bold ${accent || 'text-slate-900'}`}>{value}</div>
    </div>
  );
}
