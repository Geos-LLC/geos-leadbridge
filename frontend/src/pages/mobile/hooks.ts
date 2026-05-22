// Data hooks for the mobile design. Thin wrappers around the existing
// frontend/src/services/api.ts surface — no react-query, no separate cache;
// each screen owns one query and renders its own loading / empty state.
//
// Returned objects are reshaped via adapters.ts to MobileLead / MobileAccount /
// MobileMessage so the screens stay free of API-mapping logic.

import { useEffect, useMemo, useState } from 'react';
import { leadsApi, thumbtackApi, analyticsApi, followUpApi } from '../../services/api';
import { useAuthStore } from '../../store/authStore';
import { mapAccount, mapLead, mapMessage } from './adapters';
import type {
  MobileAccount, MobileLead, MobileMessage,
} from './data';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

// ── User identity ────────────────────────────────────────────────────────

export function useMobileUser() {
  const user = useAuthStore((s) => s.user);
  return useMemo(() => {
    if (!user) return null;
    const initials = (user.name || user.email)
      .split(/\s+/).filter(Boolean).slice(0, 2)
      .map((s) => s[0]?.toUpperCase()).join('') || '?';
    return {
      name: user.name || user.email,
      email: user.email,
      initials,
      business: user.name || user.email,
      tier: user.subscriptionTier ?? 'Trial',
      website: user.website || null,
    };
  }, [user]);
}

// ── Accounts ──────────────────────────────────────────────────────────────

export function useMobileAccounts(): AsyncState<MobileAccount[]> {
  const [state, setState] = useState<AsyncState<MobileAccount[]>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    thumbtackApi.getSavedAccounts()
      .then((res) => {
        if (cancelled) return;
        const accounts = (res.accounts || []).map(mapAccount);
        setState({ data: accounts, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Failed to load accounts' });
      });
    return () => { cancelled = true; };
  }, []);
  return state;
}

// ── Leads ─────────────────────────────────────────────────────────────────

export function useMobileLeads(scope: 'all' | string = 'all'): AsyncState<MobileLead[]> {
  const [state, setState] = useState<AsyncState<MobileLead[]>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    const params = scope === 'all'
      ? ({ scope: 'all' as const, limit: 100 })
      : ({ businessId: scope, limit: 100 });
    leadsApi.getLeads(params)
      .then((res) => {
        if (cancelled) return;
        const list = (res.leads || []).map(mapLead).sort((a, b) => a.sort - b.sort);
        setState({ data: list, loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Failed to load leads' });
      });
    return () => { cancelled = true; };
  }, [scope]);
  return state;
}

export function useMobileLead(id: string | undefined): AsyncState<MobileLead> {
  const [state, setState] = useState<AsyncState<MobileLead>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!id) {
      setState({ data: null, loading: false, error: 'Missing lead id' });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    leadsApi.getLead(id)
      .then((lead) => {
        if (cancelled) return;
        setState({ data: mapLead(lead), loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Lead not found' });
      });
    return () => { cancelled = true; };
  }, [id]);
  return state;
}

export function useMobileMessages(leadId: string | undefined): AsyncState<MobileMessage[]> {
  const [state, setState] = useState<AsyncState<MobileMessage[]>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!leadId) {
      setState({ data: [], loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    leadsApi.getMessages(leadId)
      .then((res) => {
        if (cancelled) return;
        // Sort ascending by sentAt so the conversation reads top → bottom.
        const sorted = [...(res.messages || [])].sort((a, b) => new Date(a.sentAt).getTime() - new Date(b.sentAt).getTime());
        setState({ data: sorted.map(mapMessage), loading: false, error: null });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Failed to load messages' });
      });
    return () => { cancelled = true; };
  }, [leadId]);
  return state;
}

// ── Analytics / stats ────────────────────────────────────────────────────

export interface MobileStats {
  week: { leads: number; replied: number; booked: number; revenue: number; winRate: number; avgTicket: number };
  funnel: Array<{ label: string; value: number }>;
  sparkRevenue: number[];
}

export function useMobileStats(scope: 'all' | string = 'all'): AsyncState<MobileStats> {
  const [state, setState] = useState<AsyncState<MobileStats>>({ data: null, loading: true, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    const params: { businessId?: string } = scope === 'all' ? {} : { businessId: scope };
    analyticsApi.getBasicAnalytics(params)
      .then((res) => {
        if (cancelled) return;
        const a: any = res.data || {};
        const leads = Number(a.totalLeads ?? a.leadsCount ?? 0) || 0;
        const replied = Number(a.repliedLeads ?? a.replyCount ?? 0) || 0;
        const booked = Number(a.bookedLeads ?? a.wins ?? 0) || 0;
        const revenue = Number(a.totalRevenue ?? a.revenue ?? 0) || 0;
        const avgTicket = booked > 0 ? Math.round(revenue / booked) : 0;
        const winRate = leads > 0 ? booked / leads : 0;
        const funnel = [
          { label: 'Leads in', value: leads },
          { label: 'AI replied', value: replied },
          { label: 'Quoted', value: Number(a.quotedCount ?? Math.round(replied * 0.6)) || 0 },
          { label: 'Booked', value: booked },
        ];
        // Spark — analytics endpoint may not include a per-day series here;
        // fall back to a flat-then-spike shape so the bar chart doesn't crash.
        const spark: number[] = Array.isArray(a.dailyRevenue) && a.dailyRevenue.length === 7
          ? a.dailyRevenue.map((n: any) => Number(n) || 0)
          : new Array(7).fill(0).map((_, i) => i === 6 ? Math.max(1, revenue / 7) : revenue / 10);
        setState({
          data: {
            week: { leads, replied, booked, revenue, winRate, avgTicket },
            funnel,
            sparkRevenue: spark,
          },
          loading: false, error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Failed to load analytics' });
      });
    return () => { cancelled = true; };
  }, [scope]);
  return state;
}

// ── Per-account follow-up settings ───────────────────────────────────────

export interface MobileAccountSettings {
  followUpMode: string | null;
  followUpReplyType: string | null;
  followUpActiveHoursStart: string | null;
  followUpActiveHoursEnd: string | null;
  followUpTimezone: string | null;
}

export function useAccountSettings(savedAccountId: string | null): AsyncState<MobileAccountSettings> {
  const [state, setState] = useState<AsyncState<MobileAccountSettings>>({ data: null, loading: true, error: null });
  useEffect(() => {
    if (!savedAccountId || savedAccountId === 'all') {
      setState({ data: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    followUpApi.getSettings(savedAccountId)
      .then((res) => {
        if (cancelled) return;
        const s = res.settings;
        setState({
          data: s ? {
            followUpMode: s.followUpMode,
            followUpReplyType: s.followUpReplyType,
            followUpActiveHoursStart: s.followUpActiveHoursStart,
            followUpActiveHoursEnd: s.followUpActiveHoursEnd,
            followUpTimezone: s.followUpTimezone,
          } : null,
          loading: false, error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({ data: null, loading: false, error: err?.message || 'Failed to load settings' });
      });
    return () => { cancelled = true; };
  }, [savedAccountId]);
  return state;
}
