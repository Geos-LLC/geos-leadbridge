import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  BarChart3,
  Building2,
  Calendar,
  TrendingUp,
  MessageSquare,
  Clock,
  Users,
  RefreshCw,
  Loader2,
  DollarSign,
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  Line,
  ComposedChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  LabelList,
  ResponsiveContainer,
} from 'recharts';
import { analyticsApi, thumbtackApi, type AnalyticsData, type TimeSeriesPoint } from '../services/api';
import { useAppStore } from '../store/appStore';
import { useAuthStore } from '../store/authStore';
import AdminNoAccountsState from '../components/AdminNoAccountsState';
import NoAccountsOverlay from '../components/NoAccountsOverlay';
import { Kpi } from '../components/ui';
import { notify } from '../store/notificationStore';

export function Analytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { savedAccounts, setSavedAccounts, analyticsCache, setAnalyticsCache, analyticsLoading: storeLoading } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [analytics, setAnalytics] = useState<Partial<AnalyticsData> | null>(analyticsCache);
  const [calculatedAt, setCalculatedAt] = useState<string | null>(null);

  // Time-series trends state
  const [tsPeriod, setTsPeriod] = useState<'day' | 'week' | 'month' | 'year'>('month');
  const [tsData, setTsData] = useState<TimeSeriesPoint[]>([]);
  const [tsLoading, setTsLoading] = useState(false);

  // Filters from URL params.
  // businessId values:
  //   'all'             — every account
  //   'all_thumbtack'   — all Thumbtack accounts
  //   'all_yelp'        — all Yelp accounts
  //   <real businessId> — single account
  const businessId = searchParams.get('businessId') || 'all';
  const timeRange = searchParams.get('range') || '365d';
  const customStart = searchParams.get('startDate') || '';
  const customEnd = searchParams.get('endDate') || '';

  // Time range options
  const timeRanges = [
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Past month' },
    { value: '365d', label: 'Past year' },
    { value: 'all', label: 'All time' },
    { value: 'custom', label: 'Custom range' },
  ];

  // Sync from store cache when it updates (e.g. preload finishes)
  useEffect(() => {
    if (analyticsCache && !analytics) {
      setAnalytics(analyticsCache);
    }
  }, [analyticsCache]);

  useEffect(() => {
    loadSavedAccounts();
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [businessId, timeRange, customStart, customEnd]);

  useEffect(() => {
    loadTimeSeries();
  }, [businessId, timeRange, customStart, customEnd, tsPeriod]);

  const loadSavedAccounts = async () => {
    try {
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setSavedAccounts(accounts);
    } catch (err) {
      console.error('Failed to load saved accounts:', err);
    }
  };

  const loadAnalytics = async () => {
    setLoading(true);
    try {
      const params = buildQueryParams();

      // Phase 1: Load basic/fast analytics first
      const { data: basicData } = await analyticsApi.getBasicAnalytics(params);
      setAnalytics(basicData as Partial<AnalyticsData>);

      // Phase 2: Load detailed/slow analytics (returns from DB cache if fresh)
      const { data: fullData, calculatedAt: ts } = await analyticsApi.getAnalytics(params);
      setAnalytics(fullData);
      if (ts) setCalculatedAt(ts);

      // Only cache default filter (all accounts, 365d) for preload
      const isDefaultFilter = businessId === 'all' && timeRange === '365d';
      if (isDefaultFilter) {
        setAnalyticsCache(fullData);
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
      notify.error('Analytics', 'Failed to load analytics data. Please refresh.');
    } finally {
      setLoading(false);
    }
  };

  const loadTimeSeries = async () => {
    setTsLoading(true);
    try {
      const params = { ...buildQueryParams(), period: tsPeriod };
      const { data } = await analyticsApi.getTimeSeries(params);
      setTsData(data);
    } catch (err) {
      console.error('Failed to load time series:', err);
    } finally {
      setTsLoading(false);
    }
  };

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const params: { businessId?: string; platform?: 'thumbtack' | 'yelp' } = {};
      if (businessId === 'all_thumbtack') params.platform = 'thumbtack';
      else if (businessId === 'all_yelp') params.platform = 'yelp';
      else if (businessId !== 'all') params.businessId = businessId;
      const { data: fullData, calculatedAt: ts } = await analyticsApi.refreshAnalytics(params);
      setAnalytics(fullData);
      setCalculatedAt(ts);
      notify.success('Analytics', 'Analytics refreshed successfully.');
    } catch (err) {
      console.error('Failed to refresh analytics:', err);
      notify.error('Analytics', 'Failed to refresh analytics.');
    } finally {
      setRefreshing(false);
    }
  };

  const formatRelativeTime = (iso: string): string => {
    const diffMs = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins} min ago`;
    const hours = Math.floor(mins / 60);
    return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
  };

  const buildQueryParams = () => {
    const params: any = {};

    if (businessId === 'all_thumbtack') {
      params.platform = 'thumbtack';
    } else if (businessId === 'all_yelp') {
      params.platform = 'yelp';
    } else if (businessId !== 'all') {
      params.businessId = businessId;
    }

    if (timeRange === 'custom' && customStart && customEnd) {
      params.startDate = customStart;
      params.endDate = customEnd;
    } else if (timeRange !== 'all') {
      const days = parseInt(timeRange);
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(endDate.getDate() - days);
      params.startDate = startDate.toISOString();
      params.endDate = endDate.toISOString();
    }

    return params;
  };

  const formatDuration = (minutes: number): string => {
    if (minutes < 1) {
      const seconds = Math.round(minutes * 60);
      return `${seconds}s`;
    }
    if (minutes < 60) {
      return `${Math.round(minutes)}m`;
    }
    const hours = Math.floor(minutes / 60);
    const mins = Math.round(minutes % 60);
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  };

  const setFilter = (key: string, value: string) => {
    if (value === 'all' || value === '') {
      searchParams.delete(key);
    } else {
      searchParams.set(key, value);
    }
    setSearchParams(searchParams);
  };

  const isUpdating = loading || storeLoading;
  const displayData = analytics || analyticsCache;

  // Show skeleton only on very first load with zero data
  if (!displayData && isUpdating) {
    return (
      <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
          <div>
            <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Performance Reports</p>
            <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Business <span className="gradient-text">Insights.</span></h2>
            <p className="text-slate-500 mt-2 text-lg">Track your leads, engagement, and response metrics.</p>
          </div>
          <div className="h-10 w-64 bg-slate-100 rounded-xl animate-pulse" />
        </div>

        {/* Skeleton Summary Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
              <div className="h-10 w-10 md:h-12 md:w-12 bg-slate-100 rounded-xl md:rounded-2xl mb-3 md:mb-4 animate-pulse" />
              <div className="h-3 w-20 bg-slate-100 rounded mb-2 animate-pulse" />
              <div className="h-7 w-14 bg-slate-100 rounded animate-pulse" />
            </div>
          ))}
        </div>

        {/* Skeleton Charts */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          {[1, 2].map((i) => (
            <div key={i} className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
              <div className="h-6 w-48 bg-slate-100 rounded mb-8 animate-pulse" />
              <div className="h-64 w-full bg-slate-100 rounded-2xl animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (savedAccounts.length === 0 && useAuthStore.getState().user?.role === 'ADMIN') {
    return (
      <div className="p-6 lg:p-10">
        <div className="mb-6">
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Performance Reports</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Business <span className="gradient-text">Insights.</span></h2>
        </div>
        <AdminNoAccountsState />
      </div>
    );
  }

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658'];

  return (
    <div
      style={{ padding: '24px 28px', maxWidth: 1120, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 20 }}
    >
      {savedAccounts.length === 0 && useAuthStore.getState().user?.role !== 'ADMIN' && <NoAccountsOverlay />}
      {/* Updating indicator */}
      {isUpdating && (
        <div
          className="fixed top-0 left-0 right-0 z-50 animate-pulse"
          style={{ height: 2, background: 'var(--lb-accent)' }}
        />
      )}

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              fontFamily: 'var(--lb-font-mono)',
              fontWeight: 700,
              color: 'var(--lb-accent)',
              textTransform: 'uppercase',
              letterSpacing: 0.1,
            }}
          >
            Insights
          </div>
          <h2 style={{ margin: '4px 0 2px', fontSize: 22, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>
            Business insights
          </h2>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--lb-ink-5)' }}>
            Track leads, engagement, and response metrics.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {calculatedAt && (
            <span
              style={{
                fontSize: 11,
                color: 'var(--lb-ink-5)',
                fontFamily: 'var(--lb-font-mono)',
                whiteSpace: 'nowrap',
              }}
            >
              Updated {formatRelativeTime(calculatedAt)}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={refreshing || loading}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              background: 'var(--lb-surface)',
              color: 'var(--lb-ink-2)',
              border: '1px solid var(--lb-line)',
              borderRadius: 'var(--lb-radius)',
              fontSize: 12,
              fontWeight: 500,
              fontFamily: 'inherit',
              cursor: refreshing || loading ? 'not-allowed' : 'pointer',
              opacity: refreshing || loading ? 0.5 : 1,
            }}
          >
            {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            Refresh
          </button>
          {/* Account Filter */}
          <div style={{ position: 'relative' }}>
            <Building2
              size={13}
              style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--lb-ink-5)', pointerEvents: 'none' }}
            />
            <select
              value={businessId}
              onChange={(e) => setFilter('businessId', e.target.value)}
              style={{
                appearance: 'none',
                padding: '6px 30px 6px 28px',
                background: 'var(--lb-ink-10)',
                border: '1px solid var(--lb-line)',
                borderRadius: 'var(--lb-radius)',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--lb-ink-1)',
                fontFamily: 'inherit',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              <option value="all">All Accounts</option>
              {savedAccounts.some((a) => a.platform === 'thumbtack') && (
                <option value="all_thumbtack">{'\uD83D\uDD35 '}All Thumbtack</option>
              )}
              {savedAccounts.some((a) => a.platform === 'yelp') && (
                <option value="all_yelp">{'\uD83D\uDD34 '}All Yelp</option>
              )}
              {savedAccounts.map((account) => (
                <option key={account.id} value={account.businessId}>
                  {account.platform === 'yelp' ? '\uD83D\uDD34 ' : '\uD83D\uDD35 '}{account.businessName}
                </option>
              ))}
            </select>
            <div style={{ position: 'absolute', right: 8, top: 0, bottom: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none', color: 'var(--lb-ink-5)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>

          {/* Time Range Filter */}
          <div style={{ position: 'relative' }}>
            <Calendar
              size={13}
              style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--lb-ink-5)', pointerEvents: 'none' }}
            />
            <select
              value={timeRange}
              onChange={(e) => {
                // Don't use setFilter — it deletes the param on value==='all',
                // which would collide with the '365d' default and prevent the
                // user from ever selecting "All time".
                searchParams.set('range', e.target.value);
                setSearchParams(searchParams);
              }}
              style={{
                appearance: 'none',
                padding: '6px 30px 6px 28px',
                background: 'var(--lb-ink-10)',
                border: '1px solid var(--lb-line)',
                borderRadius: 'var(--lb-radius)',
                fontSize: 12,
                fontWeight: 500,
                color: 'var(--lb-ink-1)',
                fontFamily: 'inherit',
                cursor: 'pointer',
                outline: 'none',
              }}
            >
              {timeRanges.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </select>
            <div style={{ position: 'absolute', right: 8, top: 0, bottom: 0, display: 'flex', alignItems: 'center', pointerEvents: 'none', color: 'var(--lb-ink-5)' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
          </div>
        </div>
      </div>

      {/* Custom Date Inputs - shown when custom is selected */}
      {timeRange === 'custom' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="date"
            value={customStart}
            onChange={(e) => setFilter('startDate', e.target.value)}
            style={{
              padding: '6px 10px',
              background: 'var(--lb-surface)',
              border: '1px solid var(--lb-line)',
              borderRadius: 'var(--lb-radius)',
              fontSize: 12,
              fontFamily: 'inherit',
              color: 'var(--lb-ink-1)',
              outline: 'none',
            }}
          />
          <span style={{ fontSize: 12, color: 'var(--lb-ink-5)' }}>to</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setFilter('endDate', e.target.value)}
            style={{
              padding: '6px 10px',
              background: 'var(--lb-surface)',
              border: '1px solid var(--lb-line)',
              borderRadius: 'var(--lb-radius)',
              fontSize: 12,
              fontFamily: 'inherit',
              color: 'var(--lb-ink-1)',
              outline: 'none',
            }}
          />
        </div>
      )}

      {/* ── Trends Over Time ── */}
      <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-5">
          <div>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--lb-ink-1)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <TrendingUp size={14} style={{ color: 'var(--lb-accent)' }} />
              Trends over time
            </h3>
            <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--lb-ink-5)' }}>Lead volume, revenue, and hire rate by period</p>
          </div>
          {/* Period selector */}
          <div
            style={{
              display: 'inline-flex',
              background: 'var(--lb-ink-10)',
              border: '1px solid var(--lb-line)',
              borderRadius: 'var(--lb-radius)',
              padding: 2,
              gap: 2,
            }}
          >
            {(['day', 'week', 'month', 'year'] as const).map((p) => {
              const active = tsPeriod === p;
              return (
                <button
                  key={p}
                  onClick={() => setTsPeriod(p)}
                  style={{
                    padding: '4px 10px',
                    fontSize: 11,
                    fontWeight: 500,
                    fontFamily: 'inherit',
                    textTransform: 'capitalize',
                    background: active ? 'var(--lb-surface)' : 'transparent',
                    color: active ? 'var(--lb-ink-1)' : 'var(--lb-ink-5)',
                    border: 0,
                    borderRadius: 4,
                    cursor: 'pointer',
                    boxShadow: active ? '0 1px 2px rgba(0,0,0,0.06)' : 'none',
                  }}
                >
                  {p === 'day' ? 'Daily' : p === 'week' ? 'Weekly' : p === 'month' ? 'Monthly' : 'Yearly'}
                </button>
              );
            })}
          </div>
        </div>

        {(() => {
          // Status colors — marketplace bucket labels for the stacked bar.
          // Trends time series aggregates Lead.status into 5 buckets:
          //   Active (new + engaged + quoted + in_progress)
          //   Scheduled (booked)
          //   Done (completed)
          //   Lost (lost + no_show + archived)
          //   Cancelled (cancelled — separated from Lost)
          const STATUS_COLORS: Record<string, string> = {
            'Active':    '#3b82f6',  // blue
            'Scheduled': '#10b981',  // emerald
            'Done':      '#059669',  // emerald-dark
            'Lost':      '#94a3b8',  // slate
            'Cancelled': '#f97316',  // orange — distinct from Lost
          };
          const fallbackColors = ['#fb923c','#06b6d4','#f59e0b','#ec4899','#64748b'];
          const allStatuses = Array.from(
            tsData.reduce((set, r) => { Object.keys(r.statuses).forEach(s => set.add(s)); return set; }, new Set<string>())
          ).sort((a, b) => {
            const totalA = tsData.reduce((s, r) => s + (r.statuses[a] ?? 0), 0);
            const totalB = tsData.reduce((s, r) => s + (r.statuses[b] ?? 0), 0);
            return totalB - totalA;
          });
          const getColor = (s: string, i: number) => STATUS_COLORS[s] ?? fallbackColors[i % fallbackColors.length];

          return tsLoading ? (
            <div className="h-64 flex items-center justify-center">
              <Loader2 className="w-6 h-6 text-blue-600 animate-spin" />
            </div>
          ) : tsData.length === 0 ? (
            <div className="h-48 flex items-center justify-center text-slate-400 text-sm">No data for selected period</div>
          ) : (
            <>
              {/* Summary strip — marketplace KPIs.
                  Hire Rate = (Scheduled + Done) / (Scheduled + Done + Lost + Cancelled)
                  Scheduled and Done are surfaced as separate raw counts
                  (no aggregate "Won" card per UX spec). */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
                {(() => {
                  const totalLeads     = tsData.reduce((s, r) => s + r.total, 0);
                  const scheduledTotal = tsData.reduce((s, r) => s + (r.scheduledCount ?? 0), 0);
                  const doneTotal      = tsData.reduce((s, r) => s + (r.doneCount      ?? 0), 0);
                  const lostTotal      = tsData.reduce((s, r) => s + (r.lostCount      ?? 0), 0);
                  const cancelledTotal = tsData.reduce((s, r) => s + (r.cancelledCount ?? 0), 0);
                  const wonTotal       = scheduledTotal + doneTotal;
                  const resolved       = wonTotal + lostTotal + cancelledTotal;
                  return [
                    { label: 'Total Leads',    value: totalLeads.toString() },
                    { label: 'Scheduled',      value: scheduledTotal.toString() },
                    { label: 'Done',           value: doneTotal.toString() },
                    {
                      label: 'Hire Rate',
                      value: resolved > 0 ? `${((wonTotal / resolved) * 100).toFixed(1)}%` : '—',
                    },
                  ];
                })().map(({ label, value }) => (
                  <div
                    key={label}
                    style={{
                      background: 'var(--lb-ink-10)',
                      borderRadius: 'var(--lb-radius)',
                      padding: '10px 14px',
                    }}
                  >
                    <p
                      style={{
                        margin: 0,
                        fontSize: 11,
                        color: 'var(--lb-ink-5)',
                        textTransform: 'uppercase',
                        letterSpacing: 0.06,
                        fontWeight: 500,
                        fontFamily: 'var(--lb-font-mono)',
                      }}
                    >
                      {label}
                    </p>
                    <p style={{ margin: '3px 0 0', fontSize: 18, fontWeight: 600, color: 'var(--lb-ink-1)', letterSpacing: '-0.01em' }}>{value}</p>
                  </div>
                ))}
              </div>

              {/* Stacked bar chart by job status + hire rate line */}
              <ResponsiveContainer width="100%" height={320}>
                <ComposedChart data={tsData} margin={{ top: 24, right: 20, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="left" width={48} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis yAxisId="right" width={48} orientation="right" unit="%" domain={[0, 100]} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.07)' }}
                    formatter={(value: any, name: string | undefined) => {
                      if (name === 'Hire Rate') return [`${Number(value).toFixed(1)}%`, name ?? ''];
                      if (name === '_total') return null as any;
                      return [value, name ?? ''];
                    }}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {allStatuses.map((status, i) => (
                    <Bar
                      key={status}
                      yAxisId="left"
                      dataKey={(d: TimeSeriesPoint) => d.statuses[status] ?? 0}
                      name={status}
                      stackId="status"
                      fill={getColor(status, i)}
                      maxBarSize={56}
                    />
                  ))}
                  {/* Invisible top-of-stack bar to render total count labels */}
                  <Bar yAxisId="left" dataKey={() => 0} stackId="status" fill="transparent" legendType="none" maxBarSize={56} name="_total">
                    <LabelList dataKey="total" position="top" style={{ fontSize: 11, fill: '#475569', fontWeight: 700 }} />
                  </Bar>
                  <Line
                    yAxisId="right"
                    type="monotone"
                    name="Hire Rate"
                    dataKey={(d: TimeSeriesPoint) => {
                      // Hire Rate = won / (won + lost + cancelled). 0 when
                      // no resolved leads in bucket (chart doesn't render
                      // null cleanly; the empty-period gap is acceptable).
                      const won       = d.wonCount       ?? 0;
                      const lost      = d.lostCount      ?? 0;
                      const cancelled = d.cancelledCount ?? 0;
                      const resolved  = won + lost + cancelled;
                      return resolved > 0 ? (won / resolved) * 100 : 0;
                    }}
                    stroke="#f59e0b" strokeWidth={2} dot={{ r: 3 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>

              {/* Lead spend chart */}
              <div className="mt-8">
                  <p className="text-sm font-semibold text-slate-700 mb-4">Avg Lead Cost per Period</p>
                  {!tsData.some(r => r.avgBudget != null) && (
                    <p className="text-xs text-slate-400 mb-3">No lead price data available — lead prices are captured from Thumbtack webhooks.</p>
                  )}
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={tsData} margin={{ top: 24, right: 68, left: 0, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                      <YAxis width={48} tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${v}`} />
                      <Tooltip
                        contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0' }}
                        formatter={(v: any, name: string | undefined) => {
                          if (name === 'Avg Lead Cost') return [`$${Number(v).toFixed(2)}`, name];
                          return [v, name ?? ''];
                        }}
                      />
                      <Bar dataKey="avgBudget" name="Avg Lead Cost" fill="#8b5cf6" radius={[4, 4, 0, 0]} maxBarSize={48}>
                        {/* Avg lead cost — centered inside the bar */}
                        <LabelList
                          dataKey="avgBudget"
                          content={(props: any) => {
                            const { x, y, width, height, value } = props;
                            if (value == null || height < 18) return null;
                            return (
                              <text x={x + width / 2} y={y + height / 2 + 4} textAnchor="middle" fontSize={10} fill="white" fontWeight={700}>
                                ${Number(value).toFixed(2)}
                              </text>
                            );
                          }}
                        />
                        {/* Total spend — above the bar */}
                        <LabelList
                          dataKey="totalBudget"
                          content={(props: any) => {
                            const { x, y, width, value } = props;
                            if (value == null) return null;
                            return (
                              <text x={x + width / 2} y={y - 6} textAnchor="middle" fontSize={11} fill="#475569" fontWeight={700}>
                                ${Number(value).toLocaleString('en-US', { maximumFractionDigits: 0 })}
                              </text>
                            );
                          }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
            </>
          );
        })()}
      </div>

      {displayData ? (
        <>
          {/* Outcome KPIs — marketplace terminology.
              6 cards: Hire Rate, Active, Scheduled, Done, Lost, Cancelled.
              Hire Rate = (Scheduled + Done) / (Scheduled + Done + Lost + Cancelled)
              Active   = new + engaged (collapsed; granular labels remain on
                         per-lead pills). */}
          {displayData.outcomes && (() => {
            const o = displayData.outcomes;
            // Tolerate legacy payload shape (older deploys returned only
            // conversionRate/won) by falling back through aliases.
            const hireRate = (o.hireRate ?? o.conversionRate);
            const hireRateStr = hireRate != null ? `${hireRate.toFixed(1)}%` : '—';
            const scheduled = o.scheduled ?? 0;
            const done = o.done ?? 0;
            const cancelled = o.cancelled ?? 0;
            return (
              <div
                className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6"
                style={{
                  background: 'var(--lb-surface)',
                  border: '1px solid var(--lb-line)',
                  borderRadius: 'var(--lb-radius-lg)',
                }}
              >
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TrendingUp size={12} /> Hire rate</span>}
                  value={hireRateStr}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Active</span>}
                  value={o.active}
                  loading={isUpdating}
                  muted
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Scheduled</span>}
                  value={scheduled}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Done</span>}
                  value={done}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Lost</span>}
                  value={o.lost}
                  loading={isUpdating}
                  muted
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Cancelled</span>}
                  value={cancelled}
                  loading={isUpdating}
                  muted
                />
              </div>
            );
          })()}

          {/* Active sub-bucket breakdown — derived from
              ThreadContext.conversationState + Lead.status. Sums to the
              Active KPI above. Human Handoff is visually urgent because
              the customer is waiting on a human. */}
          {displayData.outcomes?.activeBuckets && (() => {
            const ab = displayData.outcomes!.activeBuckets!;
            const total = ab.engagement + ab.ai_conversation + ab.follow_up + ab.human_handoff;
            const subBuckets: { id: keyof typeof ab; label: string; color: string; urgent?: boolean }[] = [
              { id: 'engagement',      label: 'Engagement',      color: '#3b82f6' },
              { id: 'ai_conversation', label: 'AI Conversation', color: '#8b5cf6' },
              { id: 'follow_up',       label: 'Follow-up',       color: '#06b6d4' },
              { id: 'human_handoff',   label: 'Human Handoff',   color: '#ef4444', urgent: true },
            ];
            return (
              <div
                style={{
                  background: 'var(--lb-surface)',
                  border: '1px solid var(--lb-line)',
                  borderRadius: 'var(--lb-radius-lg)',
                  padding: '12px 16px 14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{
                  fontSize: 11, color: 'var(--lb-ink-5)',
                  textTransform: 'uppercase', letterSpacing: 0.06,
                  fontFamily: 'var(--lb-font-mono)', fontWeight: 500,
                }}>
                  Active sub-buckets · {total} total
                </div>
                <div
                  className="grid grid-cols-2 md:grid-cols-4"
                  style={{ gap: 10 }}
                >
                  {subBuckets.map((sb) => {
                    const n = ab[sb.id] ?? 0;
                    return (
                      <div
                        key={sb.id}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          padding: '10px 12px',
                          borderRadius: 'var(--lb-radius)',
                          background: sb.urgent && n > 0 ? '#fef2f2' : 'var(--lb-ink-10)',
                          borderLeft: `3px solid ${sb.color}`,
                        }}
                      >
                        <span style={{
                          fontSize: 11, color: sb.urgent && n > 0 ? '#991b1b' : 'var(--lb-ink-5)',
                          fontWeight: sb.urgent && n > 0 ? 600 : 500,
                          fontFamily: 'var(--lb-font-mono)',
                        }}>
                          {sb.label}{sb.urgent && n > 0 ? '  ⚠' : ''}
                        </span>
                        <span style={{
                          fontSize: 20, fontWeight: 700,
                          color: sb.urgent && n > 0 ? '#991b1b' : 'var(--lb-ink-1)',
                          letterSpacing: '-0.01em',
                        }}>{n}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Summary KPIs — single bordered row.
              Adds Avg Lead Price (Thumbtack-only, hidden on all_yelp) and
              Avg Job Price (any platform, when there are won leads). */}
          {(() => {
            const showLeadPrice = displayData.averageLeadPrice != null && businessId !== 'all_yelp';
            const showJobPrice = displayData.averageJobPrice?.value != null;
            const extraCols = (showLeadPrice ? 1 : 0) + (showJobPrice ? 1 : 0);
            const colClass = extraCols === 2 ? 'md:grid-cols-6' : extraCols === 1 ? 'md:grid-cols-5' : 'md:grid-cols-4';
            return (
              <div
                className={`grid grid-cols-2 ${colClass}`}
                style={{
                  background: 'var(--lb-surface)',
                  border: '1px solid var(--lb-line)',
                  borderRadius: 'var(--lb-radius-lg)',
                }}
              >
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Users size={12} /> Total leads</span>}
                  value={displayData.totalLeads}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><Clock size={12} /> Avg connection</span>}
                  value={displayData.connectionTime ? formatDuration(displayData.connectionTime.averageMinutes) : '—'}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><MessageSquare size={12} /> Msgs/lead</span>}
                  value={displayData.messagesPerLead ? displayData.messagesPerLead.average.toFixed(1) : '—'}
                  loading={isUpdating}
                />
                <Kpi
                  label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><TrendingUp size={12} /> Engagement</span>}
                  value={`${displayData.customerEngagement?.engagementRate?.toFixed(1) ?? 0}%`}
                  delta="active"
                  deltaDir="up"
                  loading={isUpdating}
                  muted
                />
                {showLeadPrice && (
                  <Kpi
                    label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><BarChart3 size={12} /> Avg lead price (TT)</span>}
                    value={
                      displayData.averageLeadPrice?.value != null
                        ? `$${displayData.averageLeadPrice.value.toFixed(2)}`
                        : '—'
                    }
                    loading={isUpdating}
                  />
                )}
                {showJobPrice && (
                  <Kpi
                    label={<span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><DollarSign size={12} /> Avg job price</span>}
                    value={`$${displayData.averageJobPrice!.value!.toFixed(0)}`}
                    loading={isUpdating}
                  />
                )}
              </div>
            );
          })()}

          {/* Charts Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Category Distribution - Progress Bars */}
            {displayData.categoryDistribution && displayData.categoryDistribution.length > 0 && (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <h3 className="text-lg md:text-xl font-bold text-slate-900">Service Categories</h3>
                  <BarChart3 className="w-5 h-5 text-slate-400" />
                </div>
                <div className="space-y-6">
                  {displayData.categoryDistribution.slice(0, 4).map((cat, index) => (
                    <div key={cat.category} className="space-y-2">
                      <div className="flex justify-between text-sm font-bold text-slate-700">
                        <span className="truncate mr-2">{cat.category}</span>
                        <span className="shrink-0">{Math.round((cat.count / (displayData.totalLeads || 1)) * 100)}%</span>
                      </div>
                      <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.round((cat.count / (displayData.totalLeads || 1)) * 100)}%`,
                            backgroundColor: COLORS[index % COLORS.length],
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Job Status Distribution */}
            {displayData.jobStatusDistribution && displayData.jobStatusDistribution.length > 0 && (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <div>
                    <h3 className="text-lg md:text-xl font-bold text-slate-900">Job Status</h3>
                    {displayData.lastLeadSyncAt && (
                      <p className="text-[10px] text-slate-400 mt-0.5">Last sync {formatRelativeTime(displayData.lastLeadSyncAt)}</p>
                    )}
                  </div>
                  <Users className="w-5 h-5 text-slate-400" />
                </div>
                <div className="space-y-4">
                  {displayData.jobStatusDistribution.map((status, index) => (
                    <div key={status.name} className="flex items-center gap-3">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: COLORS[index % COLORS.length] }}
                      />
                      <span className="text-sm font-medium text-slate-700 flex-1">{status.name}</span>
                      <span className="text-sm font-bold text-slate-900">{status.count}</span>
                      <span className="text-xs text-slate-400 w-12 text-right">{Math.round(status.percentage)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Connection Time Details */}
            {displayData.connectionTime ? (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <h3 className="text-lg md:text-xl font-bold text-slate-900">Response Speed</h3>
                  <Clock className="w-5 h-5 text-slate-400" />
                </div>
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center group hover:bg-white hover:border-blue-200 transition-all">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {formatDuration(displayData.connectionTime.averageMinutes)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-blue-600 uppercase tracking-tight mt-1">Your Avg</div>
                    <p className="text-[10px] text-slate-400 mt-2 leading-tight hidden md:block">Average response time</p>
                  </div>
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center group hover:bg-white hover:border-blue-200 transition-all">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {formatDuration(displayData.connectionTime.median)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-slate-500 uppercase tracking-tight mt-1">Median</div>
                    <p className="text-[10px] text-slate-400 mt-2 leading-tight hidden md:block">Middle response time</p>
                  </div>
                  <div className="p-4 md:p-5 bg-emerald-50 rounded-2xl md:rounded-3xl border border-emerald-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-emerald-700">
                      {formatDuration(displayData.connectionTime.min)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-emerald-600 uppercase tracking-tight mt-1">Fastest</div>
                    <p className="text-[10px] text-emerald-600/60 mt-2 leading-tight hidden md:block">Peak performance</p>
                  </div>
                  <div className="p-4 md:p-5 bg-rose-50 rounded-2xl md:rounded-3xl border border-rose-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-rose-700">
                      {formatDuration(displayData.connectionTime.max)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-rose-600 uppercase tracking-tight mt-1">Slowest</div>
                    <p className="text-[10px] text-rose-600/60 mt-2 leading-tight hidden md:block">Needs attention</p>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <div className="h-6 w-48 bg-slate-100 rounded mb-8 animate-pulse" />
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  {[1, 2, 3, 4].map((i) => (
                    <div key={i} className="h-24 md:h-32 bg-slate-50 rounded-2xl md:rounded-3xl animate-pulse" />
                  ))}
                </div>
              </div>
            )}

            {/* Response Times - Bar Chart */}
            {displayData.proResponseTime && displayData.customerResponseTime && (
              <div className="p-5 md:p-6 overflow-hidden" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Response Times</h3>
                <div className="w-full -ml-4 md:ml-0">
                  <ResponsiveContainer width="100%" height={280}>
                    <BarChart
                      data={[
                        {
                          name: 'Pro',
                          average: displayData.proResponseTime.averageMinutes,
                          median: displayData.proResponseTime.median,
                        },
                        {
                          name: 'Customer',
                          average: displayData.customerResponseTime.averageMinutes,
                          median: displayData.customerResponseTime.median,
                        },
                      ]}
                      margin={{ top: 5, right: 10, left: 0, bottom: 5 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                      <YAxis tick={{ fontSize: 11 }} width={40} />
                      <Tooltip formatter={(value) => formatDuration(value as number)} />
                      <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                      <Bar dataKey="average" fill="#0088FE" name="Average" radius={[8, 8, 0, 0]} />
                      <Bar dataKey="median" fill="#00C49F" name="Median" radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Messages Per Lead Details */}
            {displayData.messagesPerLead && (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Messages Per Lead</h3>
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {displayData.messagesPerLead.average.toFixed(1)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-blue-600 uppercase tracking-tight mt-1">Average</div>
                  </div>
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {displayData.messagesPerLead.median.toFixed(1)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-slate-500 uppercase tracking-tight mt-1">Median</div>
                  </div>
                  <div className="p-4 md:p-5 bg-emerald-50 rounded-2xl md:rounded-3xl border border-emerald-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-emerald-700">
                      {displayData.messagesPerLead.min}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-emerald-600 uppercase tracking-tight mt-1">Minimum</div>
                  </div>
                  <div className="p-4 md:p-5 bg-purple-50 rounded-2xl md:rounded-3xl border border-purple-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-purple-700">
                      {displayData.messagesPerLead.max}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-purple-600 uppercase tracking-tight mt-1">Maximum</div>
                  </div>
                </div>
              </div>
            )}

            {/* Cleaning Type Distribution */}
            {displayData.cleaningTypeDistribution && displayData.cleaningTypeDistribution.length > 0 && (
              <div className="p-5 md:p-6 overflow-hidden" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Cleaning Type Distribution</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={displayData.cleaningTypeDistribution}
                      cx="50%"
                      cy="45%"
                      labelLine={false}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="count"
                    >
                      {displayData.cleaningTypeDistribution.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend
                      layout="horizontal"
                      verticalAlign="bottom"
                      align="center"
                      wrapperStyle={{ fontSize: 11, paddingTop: 12, lineHeight: '20px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Add-ons Distribution */}
            {displayData.addOnsDistribution && displayData.addOnsDistribution.length > 0 && (
              <div className="p-5 md:p-6 overflow-hidden" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Popular Add-ons</h3>
                <div className="w-full -ml-2 md:ml-0">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart
                      data={displayData.addOnsDistribution.slice(0, 10)}
                      margin={{ top: 5, right: 10, left: 0, bottom: 60 }}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis
                        dataKey="name"
                        angle={-45}
                        textAnchor="end"
                        interval={0}
                        tick={{ fontSize: 10 }}
                        height={80}
                      />
                      <YAxis tick={{ fontSize: 11 }} width={35} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#00C49F" radius={[8, 8, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Frequency Distribution */}
            {displayData.frequencyDistribution && displayData.frequencyDistribution.length > 0 && (
              <div className="p-5 md:p-6 overflow-hidden" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Service Frequency</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={displayData.frequencyDistribution}
                      cx="50%"
                      cy="45%"
                      labelLine={false}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="count"
                    >
                      {displayData.frequencyDistribution.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend
                      layout="horizontal"
                      verticalAlign="bottom"
                      align="center"
                      wrapperStyle={{ fontSize: 11, paddingTop: 12, lineHeight: '20px' }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Room Statistics */}
            {displayData.roomStats && displayData.roomStats.averageBedrooms > 0 && (
              <div className="p-5 md:p-6" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
                <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Room Statistics</h3>
                <div className="grid grid-cols-2 gap-3 md:gap-4">
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {displayData.roomStats.averageBedrooms.toFixed(1)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-blue-600 uppercase tracking-tight mt-1">Avg Bedrooms</div>
                  </div>
                  <div className="p-4 md:p-5 bg-slate-50 rounded-2xl md:rounded-3xl border border-slate-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-slate-900">
                      {displayData.roomStats.averageBathrooms.toFixed(1)}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-slate-500 uppercase tracking-tight mt-1">Avg Bathrooms</div>
                  </div>
                  <div className="p-4 md:p-5 bg-purple-50 rounded-2xl md:rounded-3xl border border-purple-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-purple-700">
                      {displayData.roomStats.maxBedrooms}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-purple-600 uppercase tracking-tight mt-1">Max Bedrooms</div>
                  </div>
                  <div className="p-4 md:p-5 bg-purple-50 rounded-2xl md:rounded-3xl border border-purple-100 text-center">
                    <div className="text-xl md:text-2xl font-bold text-purple-700">
                      {displayData.roomStats.maxBathrooms}
                    </div>
                    <div className="text-[10px] md:text-xs font-bold text-purple-600 uppercase tracking-tight mt-1">Max Bathrooms</div>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Top Locations - Special Dark Section */}
          {displayData.locationDistribution && displayData.locationDistribution.length > 0 && (
            <section className="space-y-6">
              <div className="flex items-center justify-between px-2">
                <h3 className="text-xl font-bold text-slate-900">Top Service Locations</h3>
              </div>
              <div className="bg-slate-900 rounded-[2.5rem] p-6 md:p-8 text-white relative overflow-hidden shadow-xl">
                <div className="relative z-10">
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-6 md:gap-8 items-center">
                    {displayData.locationDistribution.slice(0, 5).map((loc, index) => (
                      <div key={loc.name} className={`space-y-2 ${index === 0 ? '' : 'opacity-80'}`}>
                        <p className={`${index === 0 ? 'text-2xl md:text-3xl' : 'text-xl md:text-2xl'} font-bold`}>{loc.count}</p>
                        <p className={`text-xs md:text-sm font-medium ${index === 0 ? 'text-blue-400' : 'text-slate-400'}`}>{loc.name}</p>
                        <div className="h-1 bg-white/20 rounded-full w-full overflow-hidden">
                          <div
                            className="h-full bg-blue-500 rounded-full"
                            style={{ width: `${(loc.count / (displayData.locationDistribution?.[0]?.count || 1)) * 100}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="absolute -right-20 -top-20 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl" />
              </div>
            </section>
          )}

          {/* Zip Codes Chart */}
          {displayData.zipCodeDistribution && displayData.zipCodeDistribution.length > 0 && (
            <div className="p-5 md:p-6 overflow-hidden" style={{ background: 'var(--lb-surface)', border: '1px solid var(--lb-line)', borderRadius: 'var(--lb-radius-lg)' }}>
              <h3 className="text-lg md:text-xl font-bold text-slate-900 mb-6 md:mb-8">Top Zip Codes</h3>
              <div className="w-full -ml-2 md:ml-0">
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart
                    data={displayData.zipCodeDistribution.slice(0, 10)}
                    margin={{ top: 5, right: 10, left: 0, bottom: 60 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis
                      dataKey="name"
                      angle={-45}
                      textAnchor="end"
                      interval={0}
                      tick={{ fontSize: 10 }}
                      height={80}
                    />
                    <YAxis tick={{ fontSize: 11 }} width={35} />
                    <Tooltip />
                    <Bar dataKey="count" fill="#FFBB28" radius={[8, 8, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <BarChart3 className="w-16 h-16 text-slate-300 mb-4" />
          <h3 className="text-xl font-bold text-slate-900 mb-2">No analytics data yet</h3>
          <p className="text-slate-500">Connect an account and receive some leads to see insights here.</p>
        </div>
      )}
    </div>
  );
}
