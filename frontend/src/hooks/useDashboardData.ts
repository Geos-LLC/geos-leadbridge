import { useState, useEffect, useCallback } from 'react';
import {
  thumbtackApi,
  platformsApi,
  analyticsApi,
  automationApi,
  notificationsApi,
  leadsApi,
  type HealthIssue,
} from '../services/api';
import type {
  SavedAccount,
  AutomationRule,
  NotificationRule,
  NotificationLog,
  Lead,
} from '../types';

export interface DashboardData {
  // Accounts
  savedAccounts: SavedAccount[];

  // System Health
  autoReplyEnabled: boolean;
  customerSmsEnabled: boolean;
  leadAlertsEnabled: boolean;
  healthIssues: HealthIssue[];

  // Today's Activity
  leadsToday: number;
  smsSentToday: number;
  avgResponseTime: number | null; // minutes

  // Attention Needed
  unrepliedLeadCount: number;
  failedSmsCount: number;

  // 7-Day Snapshot
  leadsLast7Days: number;
  customerEngagementRate7d: number;

  // Lifetime stats
  totalAutoRepliesSent: number;
  totalSmsSent: number;

  // Loading state
  loading: boolean;
  error: string | null;
}

function getToday(): string {
  return new Date().toISOString().split('T')[0];
}

function get7DaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  return d.toISOString().split('T')[0];
}

function isToday(dateStr: string): boolean {
  return dateStr.startsWith(getToday());
}

export function useDashboardData(selectedAccountId: string | null) {
  const [data, setData] = useState<DashboardData>({
    savedAccounts: [],
    autoReplyEnabled: false,
    customerSmsEnabled: false,
    leadAlertsEnabled: false,
    healthIssues: [],
    leadsToday: 0,
    smsSentToday: 0,
    avgResponseTime: null,
    unrepliedLeadCount: 0,
    failedSmsCount: 0,
    leadsLast7Days: 0,
    customerEngagementRate7d: 0,
    totalAutoRepliesSent: 0,
    totalSmsSent: 0,
    loading: true,
    error: null,
  });

  const fetchData = useCallback(async () => {
    setData(prev => ({ ...prev, loading: true, error: null }));

    try {
      const today = getToday();
      const sevenDaysAgo = get7DaysAgo();

      // Build businessId filter from selected account
      const selectedAccount = data.savedAccounts.length > 0
        ? data.savedAccounts.find(a => a.id === selectedAccountId)
        : null;
      const businessId = selectedAccount?.businessId;

      // Parallel fetch all data sources
      const [
        accountsResult,
        healthResult,
        todayAnalytics,
        weekAnalytics,
        automationRules,
        notificationRules,
        smsLogs,
        leadsResult,
      ] = await Promise.all([
        thumbtackApi.getSavedAccounts().catch(() => ({ accounts: [] as SavedAccount[], count: 0 })),
        platformsApi.getHealth().catch(() => ({ healthy: true, issues: [] as HealthIssue[] })),
        analyticsApi.getAnalytics({
          startDate: today,
          ...(businessId ? { businessId } : {}),
        }).catch(() => ({ success: false, data: null })),
        analyticsApi.getBasicAnalytics({
          startDate: sevenDaysAgo,
          ...(businessId ? { businessId } : {}),
        }).catch(() => ({ success: false, data: null })),
        selectedAccountId
          ? automationApi.getRulesForAccount(selectedAccountId).catch(() => ({ rules: [] as AutomationRule[] }))
          : automationApi.getRules().catch(() => ({ rules: [] as AutomationRule[] })),
        selectedAccountId
          ? notificationsApi.getRules(selectedAccountId).catch(() => ({ success: false, count: 0, rules: [] as NotificationRule[] }))
          : notificationsApi.getAllRules().catch(() => ({ success: false, count: 0, rules: [] as NotificationRule[] })),
        notificationsApi.getAllLogs(200).catch(() => ({ success: false, count: 0, logs: [] as NotificationLog[] })),
        leadsApi.getLeads().catch(() => ({ leads: [] as Lead[], count: 0 })),
      ]);

      // Derive System Health
      const autoReplyEnabled = automationRules.rules.some(r => r.enabled);
      const customerSmsEnabled = notificationRules.rules.some(
        (r: NotificationRule) => r.enabled && r.sendToCustomer === true
      );
      const leadAlertsEnabled = notificationRules.rules.some(
        (r: NotificationRule) => r.enabled && !r.sendToCustomer
      );

      // Derive Today's Activity
      const todayData = todayAnalytics.data;
      const leadsToday = todayData?.totalLeads ?? 0;
      const avgResponseTime = todayData?.proResponseTime?.averageMinutes ?? null;

      // SMS sent today - filter logs by today's date and sent/delivered status
      const todayLogs = (smsLogs.logs || []).filter(
        (log: NotificationLog) => isToday(log.createdAt) && ['sent', 'delivered', 'queued'].includes(log.status)
      );
      const smsSentToday = todayLogs.length;

      // Derive Attention Needed
      const todayLeads = (leadsResult.leads || []).filter(
        (lead: Lead) => isToday(lead.createdAt)
      );
      const unrepliedLeadCount = todayLeads.filter(
        (lead: Lead) => lead.status === 'new'
      ).length;

      const failedSmsCount = (smsLogs.logs || []).filter(
        (log: NotificationLog) => isToday(log.createdAt) && log.status === 'failed'
      ).length;

      // Derive 7-Day Snapshot
      const weekData = weekAnalytics.data;
      const leadsLast7Days = weekData?.totalLeads ?? 0;
      const customerEngagementRate7d = weekData?.customerEngagement?.engagementRate ?? 0;

      // Lifetime aggregates
      const totalAutoRepliesSent = automationRules.rules.reduce(
        (sum: number, r: AutomationRule) => sum + (r.triggerCount || 0), 0
      );
      const totalSmsSent = notificationRules.rules.reduce(
        (sum: number, r: NotificationRule) => sum + (r.triggerCount || 0), 0
      );

      setData({
        savedAccounts: accountsResult.accounts,
        autoReplyEnabled,
        customerSmsEnabled,
        leadAlertsEnabled,
        healthIssues: healthResult.issues,
        leadsToday,
        smsSentToday,
        avgResponseTime,
        unrepliedLeadCount,
        failedSmsCount,
        leadsLast7Days,
        customerEngagementRate7d,
        totalAutoRepliesSent,
        totalSmsSent,
        loading: false,
        error: null,
      });
    } catch (err: any) {
      setData(prev => ({
        ...prev,
        loading: false,
        error: err.message || 'Failed to load dashboard data',
      }));
    }
  }, [selectedAccountId]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { ...data, refresh: fetchData };
}
