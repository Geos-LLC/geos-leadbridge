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
import { analyticsApi, type AnalyticsData } from '../services/api';
import { useAppStore } from '../store/appStore';

export function Analytics() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { savedAccounts } = useAppStore();

  const [loading, setLoading] = useState(true);
  const [analytics, setAnalytics] = useState<AnalyticsData | null>(null);
  const [previousAnalytics, setPreviousAnalytics] = useState<AnalyticsData | null>(null);

  // Filters from URL params
  const businessId = searchParams.get('businessId') || 'all';
  const timeRange = searchParams.get('range') || '30d';
  const customStart = searchParams.get('startDate') || '';
  const customEnd = searchParams.get('endDate') || '';

  // Time range options
  const timeRanges = [
    { value: '7d', label: 'Last 7 days' },
    { value: '30d', label: 'Last 30 days' },
    { value: 'all', label: 'All time' },
    { value: 'custom', label: 'Custom range' },
  ];

  useEffect(() => {
    loadAnalytics();
  }, [businessId, timeRange, customStart, customEnd]);

  const loadAnalytics = async () => {
    setLoading(true);
    // Save current analytics as previous before loading new data
    if (analytics) {
      setPreviousAnalytics(analytics);
    }
    try {
      const params = buildQueryParams();
      const { data } = await analyticsApi.getAnalytics(params);
      setAnalytics(data);
      setPreviousAnalytics(data); // Update cache
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

  // Show full-screen loader only on first load (no previous data)
  if (loading && !previousAnalytics) {
    return (
      <div className="loading-container">
        <Loader2 className="spinner" size={48} />
        <p>Loading analytics...</p>
      </div>
    );
  }

  const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884d8', '#82ca9d', '#ffc658'];

  // Use previous analytics while loading new data
  const displayData = analytics || previousAnalytics;

  return (
    <div className="analytics-page">
      {/* Progress bar */}
      {loading && <div className="analytics-loading-bar" />}
      <div className="analytics-header">
        <div className="header-left">
          <BarChart3 size={32} />
          <h1>Analytics</h1>
        </div>
        <div className="header-right">
          <button className="btn-icon" onClick={loadAnalytics} title="Refresh">
            <RefreshCw size={20} />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="analytics-filters">
        {/* Account Filter */}
        <div className="filter-group">
          <Building2 size={16} />
          <select
            value={businessId}
            onChange={(e) => setFilter('businessId', e.target.value)}
            className="filter-select"
          >
            <option value="all">All Accounts</option>
            {savedAccounts.map((account) => (
              <option key={account.id} value={account.businessId}>
                {account.businessName}
              </option>
            ))}
          </select>
        </div>

        {/* Time Range Filter */}
        <div className="filter-group">
          <Calendar size={16} />
          <select
            value={timeRange}
            onChange={(e) => setFilter('range', e.target.value)}
            className="filter-select"
          >
            {timeRanges.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>
        </div>

        {/* Custom Date Inputs - shown when custom is selected */}
        {timeRange === 'custom' && (
          <>
            <input
              type="date"
              value={customStart}
              onChange={(e) => setFilter('startDate', e.target.value)}
              className="date-input"
            />
            <span>to</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setFilter('endDate', e.target.value)}
              className="date-input"
            />
          </>
        )}
      </div>

      {displayData && (
        <>
          {/* Loading overlay */}
          {loading && <div className="analytics-loading-overlay" />}

          {/* Summary Cards */}
          <div className="metrics-summary">
            <div className="metric-card">
              <div className="metric-icon">
                <Users size={24} />
              </div>
              <div className="metric-details">
                <span className="metric-label">Total Leads</span>
                <span className="metric-value">{displayData.totalLeads}</span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon">
                <Clock size={24} />
              </div>
              <div className="metric-details">
                <span className="metric-label">Avg Connection Time</span>
                <span className="metric-value">
                  {formatDuration(displayData.connectionTime.averageMinutes)}
                </span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon">
                <MessageSquare size={24} />
              </div>
              <div className="metric-details">
                <span className="metric-label">Avg Messages Per Lead</span>
                <span className="metric-value">
                  {displayData.messagesPerLead.average.toFixed(1)}
                </span>
              </div>
            </div>

            <div className="metric-card">
              <div className="metric-icon">
                <TrendingUp size={24} />
              </div>
              <div className="metric-details">
                <span className="metric-label">Customer Engagement</span>
                <span className="metric-value">
                  {displayData.customerEngagement.engagementRate.toFixed(1)}%
                </span>
              </div>
            </div>
          </div>

          {/* Charts Section */}
          <div className="charts-grid">
            {/* Category Distribution - Pie Chart */}
            {displayData.categoryDistribution.length > 0 && (
              <div className="chart-card">
                <h3>Service Category Distribution</h3>
                <ResponsiveContainer width="100%" height={300}>
                  <PieChart>
                    <Pie
                      data={displayData.categoryDistribution}
                      cx="50%"
                      cy="50%"
                      labelLine={false}
                      label={(entry: any) => `${entry.category}: ${entry.count}`}
                      outerRadius={80}
                      fill="#8884d8"
                      dataKey="count"
                    >
                      {displayData.categoryDistribution.map((_, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip />
                    <Legend />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Response Times - Bar Chart */}
            <div className="chart-card">
              <h3>Response Times</h3>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart
                  data={[
                    {
                      name: 'Pro Response',
                      average: displayData.proResponseTime.averageMinutes,
                      median: displayData.proResponseTime.median,
                    },
                    {
                      name: 'Customer Response',
                      average: displayData.customerResponseTime.averageMinutes,
                      median: displayData.customerResponseTime.median,
                    },
                  ]}
                >
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" />
                  <YAxis label={{ value: 'Time', angle: -90, position: 'insideLeft' }} />
                  <Tooltip formatter={(value) => formatDuration(value as number)} />
                  <Legend />
                  <Bar dataKey="average" fill="#0088FE" name="Average" />
                  <Bar dataKey="median" fill="#00C49F" name="Median" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Connection Time Details */}
            <div className="chart-card stats-card">
              <h3>Connection Time Statistics</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Average</span>
                  <span className="stat-value">
                    {formatDuration(displayData.connectionTime.averageMinutes)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Median</span>
                  <span className="stat-value">
                    {formatDuration(displayData.connectionTime.median)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Fastest</span>
                  <span className="stat-value">
                    {formatDuration(displayData.connectionTime.min)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Slowest</span>
                  <span className="stat-value">
                    {formatDuration(displayData.connectionTime.max)}
                  </span>
                </div>
              </div>
            </div>

            {/* Messages Per Lead Details */}
            <div className="chart-card stats-card">
              <h3>Messages Per Lead</h3>
              <div className="stats-grid">
                <div className="stat-item">
                  <span className="stat-label">Average</span>
                  <span className="stat-value">
                    {displayData.messagesPerLead.average.toFixed(1)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Median</span>
                  <span className="stat-value">
                    {displayData.messagesPerLead.median.toFixed(1)}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Minimum</span>
                  <span className="stat-value">
                    {displayData.messagesPerLead.min}
                  </span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Maximum</span>
                  <span className="stat-value">
                    {displayData.messagesPerLead.max}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
