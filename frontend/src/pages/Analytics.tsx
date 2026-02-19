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
} from 'lucide-react';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { analyticsApi, thumbtackApi, type AnalyticsData } from '../services/api';
import { useAppStore } from '../store/appStore';

export function Analytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { savedAccounts, setSavedAccounts, analyticsCache, setAnalyticsCache, analyticsLoading: storeLoading } = useAppStore();

  const [loading, setLoading] = useState(false);
  const [analytics, setAnalytics] = useState<Partial<AnalyticsData> | null>(analyticsCache);

  // Filters from URL params
  const businessId = searchParams.get('businessId') || 'all';
  const timeRange = searchParams.get('range') || 'all';
  const customStart = searchParams.get('startDate') || '';
  const customEnd = searchParams.get('endDate') || '';

  // Time range options
  const timeRanges = [
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
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

      // Phase 2: Load detailed/slow analytics
      const { data: fullData } = await analyticsApi.getAnalytics(params);
      setAnalytics(fullData);

      // Only cache default filter (all accounts, 30d) for preload
      const isDefaultFilter = businessId === 'all' && timeRange === '30d';
      if (isDefaultFilter) {
        setAnalyticsCache(fullData);
      }
    } catch (err) {
      console.error('Failed to load analytics:', err);
    } finally {
      setLoading(false);
    }
  };

  const buildQueryParams = () => {
    const params: any = {};

    if (businessId !== 'all') {
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
            <div key={i} className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
              <div className="h-6 w-48 bg-slate-100 rounded mb-8 animate-pulse" />
              <div className="h-64 w-full bg-slate-100 rounded-2xl animate-pulse" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658'];

  return (
    <div className="p-6 lg:p-10 max-w-7xl mx-auto space-y-10">
      {/* Updating indicator */}
      {isUpdating && (
        <div className="fixed top-0 left-0 right-0 h-1 bg-blue-600 z-50 animate-pulse" />
      )}

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Performance Reports</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">Business <span className="gradient-text">Insights.</span></h2>
          <p className="text-slate-500 mt-2 text-lg">Track your leads, engagement, and response metrics.</p>
        </div>
        <div className="flex flex-wrap gap-3">
          {/* Account Filter */}
          <div className="relative">
            <select
              value={businessId}
              onChange={(e) => setFilter('businessId', e.target.value)}
              className="appearance-none pl-10 pr-10 py-3 bg-white border border-slate-200 rounded-xl font-medium text-slate-700 hover:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all cursor-pointer"
            >
              <option value="all">All Accounts</option>
              {savedAccounts.map((account) => (
                <option key={account.id} value={account.businessId}>
                  {account.businessName}
                </option>
              ))}
            </select>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              <Building2 className="w-4 h-4" />
            </div>
          </div>

          {/* Time Range Filter */}
          <div className="relative">
            <select
              value={timeRange}
              onChange={(e) => setFilter('range', e.target.value)}
              className="appearance-none pl-10 pr-10 py-3 bg-white border border-slate-200 rounded-xl font-medium text-slate-700 hover:border-blue-300 focus:ring-2 focus:ring-blue-100 transition-all cursor-pointer"
            >
              {timeRanges.map((range) => (
                <option key={range.value} value={range.value}>
                  {range.label}
                </option>
              ))}
            </select>
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
              <Calendar className="w-4 h-4" />
            </div>
          </div>

          <button
            onClick={loadAnalytics}
            title="Refresh"
            className="p-3 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-xl transition-colors"
          >
            {isUpdating ? <Loader2 size={20} className="animate-spin" /> : <RefreshCw size={20} />}
          </button>
        </div>
      </div>

      {/* Custom Date Inputs - shown when custom is selected */}
      {timeRange === 'custom' && (
        <div className="flex items-center gap-3">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setFilter('startDate', e.target.value)}
            className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
          />
          <span className="text-slate-500">to</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setFilter('endDate', e.target.value)}
            className="px-4 py-2 bg-white border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300"
          />
        </div>
      )}

      {displayData ? (
        <>
          {/* Summary Cards - 2 per row on mobile, 4 on desktop */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 md:gap-6">
            <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-blue-50 text-blue-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <Users className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Total Leads</p>
              <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 mt-1 transition-opacity ${isUpdating ? 'opacity-40' : 'opacity-100'}`}>
                {displayData.totalLeads}
              </h3>
            </div>

            {displayData.connectionTime ? (
              <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-emerald-50 text-emerald-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                  <Clock className="w-5 h-5 md:w-6 md:h-6" />
                </div>
                <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Avg Connection</p>
                <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 mt-1 transition-opacity ${isUpdating ? 'opacity-40' : 'opacity-100'}`}>
                  {formatDuration(displayData.connectionTime.averageMinutes)}
                </h3>
              </div>
            ) : (
              <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-100 rounded-xl md:rounded-2xl mb-3 md:mb-4 animate-pulse" />
                <div className="h-3 w-20 bg-slate-100 rounded mb-2 animate-pulse" />
                <div className="h-7 w-14 bg-slate-100 rounded animate-pulse" />
              </div>
            )}

            {displayData.messagesPerLead ? (
              <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm hover:shadow-md transition-all">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-purple-50 text-purple-600 rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                  <MessageSquare className="w-5 h-5 md:w-6 md:h-6" />
                </div>
                <p className="text-slate-500 text-xs md:text-sm font-medium uppercase tracking-wide">Msgs/Lead</p>
                <h3 className={`text-2xl md:text-3xl font-bold text-slate-900 mt-1 transition-opacity ${isUpdating ? 'opacity-40' : 'opacity-100'}`}>
                  {displayData.messagesPerLead.average.toFixed(1)}
                </h3>
              </div>
            ) : (
              <div className="bg-white p-4 md:p-6 rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-100 rounded-xl md:rounded-2xl mb-3 md:mb-4 animate-pulse" />
                <div className="h-3 w-20 bg-slate-100 rounded mb-2 animate-pulse" />
                <div className="h-7 w-14 bg-slate-100 rounded animate-pulse" />
              </div>
            )}

            <div className="bg-indigo-600 p-4 md:p-6 rounded-2xl md:rounded-3xl shadow-xl shadow-indigo-100 text-white">
              <div className="w-10 h-10 md:w-12 md:h-12 bg-white/20 text-white rounded-xl md:rounded-2xl flex items-center justify-center mb-3 md:mb-4">
                <TrendingUp className="w-5 h-5 md:w-6 md:h-6" />
              </div>
              <p className="text-indigo-100 text-xs md:text-sm font-medium uppercase tracking-wide">Engagement</p>
              <div className="flex items-baseline gap-1 md:gap-2 mt-1">
                <h3 className={`text-2xl md:text-3xl font-bold transition-opacity ${isUpdating ? 'opacity-40' : 'opacity-100'}`}>
                  {displayData.customerEngagement?.engagementRate?.toFixed(1) ?? 0}%
                </h3>
                <span className="text-indigo-200 text-xs md:text-sm">Active</span>
              </div>
            </div>
          </div>

          {/* Charts Section */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Category Distribution - Progress Bars */}
            {displayData.categoryDistribution && displayData.categoryDistribution.length > 0 && (
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
                <div className="flex items-center justify-between mb-6 md:mb-8">
                  <h3 className="text-lg md:text-xl font-bold text-slate-900">Job Status</h3>
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm overflow-hidden">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm overflow-hidden">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm overflow-hidden">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm overflow-hidden">
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
              <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm">
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
            <div className="bg-white border border-slate-100 rounded-[2.5rem] p-6 md:p-8 shadow-sm overflow-hidden">
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
