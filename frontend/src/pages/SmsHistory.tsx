import { useState, useEffect } from 'react';
import { MessageSquare, RefreshCw, Loader2, CheckCircle, AlertCircle, Send, ChevronDown, Phone, Clock } from 'lucide-react';
import { adminApi, isSupportAccessDenied } from '../services/api';
import { SupportAccessRequired } from '../components/SupportAccessRequired';
import type { NotificationLog } from '../types';

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return phone;
}

function StatusBadge({ status, error }: { status: string; error?: string | null }) {
  if (status === 'delivered') {
    return (
      <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
        <CheckCircle size={12} /> Delivered
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span className="px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-xs font-bold inline-flex items-center gap-1" title={error || 'Unknown error'}>
        <AlertCircle size={12} /> Failed
      </span>
    );
  }
  if (status === 'sent') {
    return (
      <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
        <Send size={12} /> Sent
      </span>
    );
  }
  return (
    <span className="px-2.5 py-1 bg-yellow-100 text-yellow-700 rounded-full text-xs font-bold inline-flex items-center gap-1">
      <Loader2 size={12} className="animate-spin" /> {status}
    </span>
  );
}

// Module-level cache — survives navigation unmounts
type SmsLogEntry = NotificationLog & { savedAccountId?: string; savedAccount?: { id: string; businessId: string; businessName: string } };
let _smsLogsCache: SmsLogEntry[] | null = null;

export function SmsHistory() {
  const [logs, setLogs] = useState<SmsLogEntry[]>(_smsLogsCache ?? []);
  const [loading, setLoading] = useState(!_smsLogsCache);
  const [accountFilter, setAccountFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    loadLogs();
  }, []);

  const loadLogs = async () => {
    try {
      if (!_smsLogsCache) setLoading(true);
      const data = await adminApi.getNotificationLogs(200);
      setLogs(data.logs);
      _smsLogsCache = data.logs;
      setAccessDenied(false);
    } catch (err: any) {
      if (isSupportAccessDenied(err)) {
        setAccessDenied(true);
        setLogs([]);
        _smsLogsCache = null;
      } else {
        console.error('Failed to load SMS logs:', err);
      }
    } finally {
      setLoading(false);
    }
  };

  const filtered = logs.filter(log => {
    if (accountFilter && log.savedAccount?.businessName !== accountFilter) return false;
    if (statusFilter && log.status !== statusFilter) return false;
    return true;
  });

  const accountNames = [...new Set(logs.map(l => l.savedAccount?.businessName).filter(Boolean))];

  // Stats
  const total = filtered.length;
  const delivered = filtered.filter(l => l.status === 'delivered').length;
  const failed = filtered.filter(l => l.status === 'failed').length;
  const pending = filtered.filter(l => l.status === 'pending' || l.status === 'queued').length;

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
      {/* Header */}
      <section>
        <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
          SMS <span className="gradient-text">History</span>
        </h1>
        <p className="text-slate-500 mt-1 md:mt-2 text-sm md:text-lg">View all SMS notifications sent across all accounts</p>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-50 text-blue-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <MessageSquare className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Total Sent</p>
          <h3 className="text-2xl md:text-3xl font-bold text-slate-900 mt-1">{total}</h3>
        </div>
        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-50 text-emerald-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <CheckCircle className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Delivered</p>
          <h3 className="text-2xl md:text-3xl font-bold text-emerald-600 mt-1">{delivered}</h3>
        </div>
        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-red-50 text-red-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <AlertCircle className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Failed</p>
          <h3 className="text-2xl md:text-3xl font-bold text-red-600 mt-1">{failed}</h3>
        </div>
        <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
          <div className="w-10 h-10 md:w-12 md:h-12 bg-amber-50 text-amber-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
            <Clock className="w-5 h-5 md:w-6 md:h-6" />
          </div>
          <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Pending</p>
          <h3 className="text-2xl md:text-3xl font-bold text-amber-600 mt-1">{pending}</h3>
        </div>
      </section>

      {/* Filters + Refresh */}
      <section className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-4 md:p-6">
        <div className="flex flex-col sm:flex-row gap-3">
          {accountNames.length > 1 && (
            <div className="relative flex-1">
              <select
                value={accountFilter}
                onChange={e => setAccountFilter(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all appearance-none"
              >
                <option value="">All Accounts</option>
                {accountNames.map(name => (
                  <option key={name} value={name!}>{name}</option>
                ))}
              </select>
              <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
            </div>
          )}
          <div className="relative flex-1 sm:max-w-[200px]">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all appearance-none"
            >
              <option value="">All Status</option>
              <option value="delivered">Delivered</option>
              <option value="sent">Sent</option>
              <option value="failed">Failed</option>
              <option value="pending">Pending</option>
            </select>
            <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          </div>
          <button
            className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            onClick={loadLogs}
            disabled={loading}
          >
            {loading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </section>

      {/* Messages */}
      {accessDenied ? (
        <SupportAccessRequired
          scope="notifications:read"
          sectionLabel="SMS notification logs"
          onGranted={loadLogs}
        />
      ) : (
      <section className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm overflow-hidden">
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-500">
            <MessageSquare size={32} className="mx-auto mb-3 text-slate-300" />
            <p className="font-medium">No SMS messages found</p>
            <p className="text-sm mt-1">Messages will appear here when SMS notifications are triggered.</p>
          </div>
        ) : (
          <>
            {/* Mobile: Card list */}
            <div className="md:hidden divide-y divide-slate-100">
              {filtered.map(log => {
                const isExpanded = expandedId === log.id;
                return (
                  <div
                    key={log.id}
                    className={`p-4 transition-colors ${log.status === 'failed' ? 'bg-red-50/30' : ''}`}
                    onClick={() => setExpandedId(isExpanded ? null : log.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Phone size={14} className="text-slate-400 shrink-0" />
                          <span className="text-sm font-semibold text-slate-900 truncate">{formatPhone(log.toPhone)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs text-slate-500">{new Date(log.createdAt).toLocaleString()}</span>
                          {log.savedAccount?.businessName && (
                            <span className="text-xs text-slate-400 truncate">· {log.savedAccount.businessName}</span>
                          )}
                        </div>
                      </div>
                      <StatusBadge status={log.status} error={log.error} />
                    </div>

                    {isExpanded && (
                      <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
                        {log.fromPhone && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">From</span>
                            <span className="font-mono text-slate-700">{formatPhone(log.fromPhone)}</span>
                          </div>
                        )}
                        {log.ruleName && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Rule</span>
                            <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-bold">{log.ruleName}</span>
                          </div>
                        )}
                        {log.deliveredAt && (
                          <div className="flex justify-between text-xs">
                            <span className="text-slate-500">Delivered</span>
                            <span className="text-green-600">{new Date(log.deliveredAt).toLocaleString()}</span>
                          </div>
                        )}
                        {log.error && (
                          <div className="text-xs text-red-600 bg-red-50 rounded-lg p-2 mt-1">{log.error}</div>
                        )}
                        {log.messageBody && (
                          <div className="text-xs text-slate-700 bg-slate-50 rounded-lg p-2 mt-1 whitespace-pre-wrap">{log.messageBody}</div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop: Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 bg-slate-50">
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Time</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Account</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Rule</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">From</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">To</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Status</th>
                    <th className="px-6 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Delivered</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(log => (
                    <tr key={log.id} className={`border-b border-slate-100 hover:bg-slate-50 transition-colors ${log.status === 'failed' ? 'bg-red-50/30' : ''}`}>
                      <td className="px-6 py-4 text-slate-700 text-sm whitespace-nowrap">{new Date(log.createdAt).toLocaleString()}</td>
                      <td className="px-6 py-4">
                        <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-bold">
                          {log.savedAccount?.businessName || 'Unknown'}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        {log.ruleName ? (
                          <span className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-xs font-bold">{log.ruleName}</span>
                        ) : (
                          <span className="px-3 py-1 bg-slate-100 text-slate-400 rounded-full text-xs font-bold">Legacy</span>
                        )}
                      </td>
                      <td className="px-6 py-4 font-mono text-slate-900 text-sm">{log.fromPhone ? formatPhone(log.fromPhone) : '-'}</td>
                      <td className="px-6 py-4 font-mono text-slate-900 text-sm">{formatPhone(log.toPhone)}</td>
                      <td className="px-6 py-4"><StatusBadge status={log.status} error={log.error} /></td>
                      <td className="px-6 py-4">
                        {log.deliveredAt ? (
                          <span className="text-green-600 flex items-center gap-1 text-sm whitespace-nowrap">
                            <CheckCircle size={12} />
                            {new Date(log.deliveredAt).toLocaleString()}
                          </span>
                        ) : log.status === 'failed' ? (
                          <span className="text-slate-400">—</span>
                        ) : (
                          <span className="text-slate-500 text-sm">Pending</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>
      )}
    </div>
  );
}
