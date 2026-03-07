import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Smartphone, Phone, Search, Loader2, RefreshCw, UserPlus, UserMinus,
  Trash2, X, Link, Unlink, Download, Users, ShieldCheck, ShieldAlert, GripVertical, MessageSquare, PhoneCall,
} from 'lucide-react';
import {
  DndContext, DragOverlay, useDraggable, useDroppable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { PhonePoolEntry, PhonePoolStats } from '../../types';

// ── Types ──────────────────────────────────────────────────────────────────────

interface TenantPhone {
  id: string;
  phoneNumber: string;
  friendlyName: string | null;
  areaCode: string | null;
  status: 'ACTIVE' | 'GRACE_PERIOD' | 'RELEASED';
  purchasedAt: string;
  cancelledAt: string | null;
  gracePeriodEndsAt: string | null;
  user: { id: string; email: string; name: string | null } | null;
  savedAccount: { id: string; businessId: string; businessName: string } | null;
  tenantName: string | null;
  notificationSettings: { sigcoreProvider: string | null; sigcoreFromPhone: string | null; senderMode: string | null } | null;
}

type DragItem = { type: 'pool'; id: string; phoneNumber: string } | { type: 'tenant'; id: string; phoneNumber: string };

// ── DnD Helpers ────────────────────────────────────────────────────────────────

function DraggableRow({ id, type, children }: { id: string; type: 'pool' | 'tenant'; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `${type}-${id}`,
    data: { type, id },
  });

  return (
    <tr
      ref={setNodeRef}
      className={`hover:bg-slate-50/50 transition-colors ${isDragging ? 'opacity-30' : ''}`}
    >
      <td className="px-3 py-3.5 w-8">
        <button {...listeners} {...attributes} className="cursor-grab active:cursor-grabbing p-1 text-slate-300 hover:text-slate-500 touch-none">
          <GripVertical size={14} />
        </button>
      </td>
      {children}
    </tr>
  );
}

function DroppableZone({ id, isOver, children }: { id: string; isOver: boolean; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id });

  return (
    <div
      ref={setNodeRef}
      className={`rounded-2xl md:rounded-3xl border-2 transition-all ${
        isOver ? 'border-blue-400 bg-blue-50/30 shadow-lg' : 'border-transparent'
      }`}
    >
      {children}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

const formatPhone = (phone: string) => {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return phone;
};

const formatDate = (dateStr: string) =>
  new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ── Main Component ─────────────────────────────────────────────────────────────

export default function AdminTenantNumbers() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  // ── Tenant state ──
  const [tenantPhones, setTenantPhones] = useState<TenantPhone[]>([]);
  const [tenantTotal, setTenantTotal] = useState(0);
  const [tenantLoading, setTenantLoading] = useState(true);
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantStatusFilter, setTenantStatusFilter] = useState('');
  const [tenantOffset, setTenantOffset] = useState(0);
  const tenantLimit = 50;

  // ── Pool state ──
  const [poolStats, setPoolStats] = useState<PhonePoolStats | null>(null);
  const [poolPhones, setPoolPhones] = useState<PhonePoolEntry[]>([]);
  const [poolTotal, setPoolTotal] = useState(0);
  const [poolLoading, setPoolLoading] = useState(true);
  const [poolSearch, setPoolSearch] = useState('');
  const [poolStatusFilter, setPoolStatusFilter] = useState('');

  // ── Pool config ──
  const [tenantKeyConfigured, setTenantKeyConfigured] = useState<boolean | null>(null);
  const [showConnect, setShowConnect] = useState(false);
  const [connectFields, setConnectFields] = useState({ accountSid: '', authToken: '' });
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // ── Twilio health ──
  const [twilioHealth, setTwilioHealth] = useState<{
    status: 'connected' | 'disconnected' | 'error';
    phoneCount: number;
    message: string;
    checkedAt: string;
  } | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);

  // ── Pool assign modal ──
  const [assigningPhoneId, setAssigningPhoneId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);
  const [assigning, setAssigning] = useState(false);

  // ── DnD state ──
  const [activeDrag, setActiveDrag] = useState<DragItem | null>(null);
  const [overZone, setOverZone] = useState<string | null>(null);

  // ── Convert modal (pool→tenant needs user selection) ──
  const [convertingPoolId, setConvertingPoolId] = useState<string | null>(null);
  const [convertingPoolPhone, setConvertingPoolPhone] = useState('');
  const [convertUserSearch, setConvertUserSearch] = useState('');
  const [convertUserResults, setConvertUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingConvertUsers, setSearchingConvertUsers] = useState(false);
  const [converting, setConverting] = useState(false);

  // ── Reassign modal (tenant → different user) ──
  const [reassigningTenantId, setReassigningTenantId] = useState<string | null>(null);
  const [reassigningTenantPhone, setReassigningTenantPhone] = useState('');
  const [reassignUserSearch, setReassignUserSearch] = useState('');
  const [reassignUserResults, setReassignUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingReassignUsers, setSearchingReassignUsers] = useState(false);
  const [reassigning, setReassigning] = useState(false);

  // ── Messaging Service SID ──
  const [messagingServiceSid, setMessagingServiceSid] = useState('');
  const [messagingServiceSaving, setMessagingServiceSaving] = useState(false);

  // ── OpenPhone numbers (informational) ──
  const [openPhoneNumbers, setOpenPhoneNumbers] = useState<{ phoneNumber: string; friendlyName?: string; provider: string; userName: string | null; userEmail: string; accountName: string }[]>([]);
  const [openPhoneLoading, setOpenPhoneLoading] = useState(false);

  // ── Init ──
  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'Admin access required');
      navigate('/');
      return;
    }
    loadTenantData();
    loadPoolData();
    loadPoolConfig();
    loadMessagingServiceSid();
    checkTwilioHealth();
    loadOpenPhoneNumbers();
  }, [user]);

  // ── Tenant data loading ──
  useEffect(() => {
    if (user?.role === 'ADMIN') loadTenantData();
  }, [tenantStatusFilter, tenantOffset]);

  useEffect(() => {
    const timer = setTimeout(() => {
      setTenantOffset(0);
      if (user?.role === 'ADMIN') loadTenantData();
    }, 300);
    return () => clearTimeout(timer);
  }, [tenantSearch]);

  // ── Pool data reload on filter change ──
  useEffect(() => {
    if (user?.role === 'ADMIN') loadPoolData();
  }, [poolStatusFilter, poolSearch]);

  const loadTenantData = async () => {
    try {
      setTenantLoading(true);
      const result = await adminApi.getTenantNumbers({
        search: tenantSearch || undefined,
        status: tenantStatusFilter || undefined,
        limit: tenantLimit,
        offset: tenantOffset,
      });
      setTenantPhones(result.phones);
      setTenantTotal(result.total);
    } catch {
      notify.error('Error', 'Failed to load tenant numbers');
    } finally {
      setTenantLoading(false);
    }
  };

  const loadPoolData = async () => {
    try {
      setPoolLoading(true);
      const [statsData, poolData] = await Promise.all([
        adminApi.getPhonePoolStats(),
        adminApi.getPhonePool({ status: poolStatusFilter || undefined, search: poolSearch || undefined, limit: 100 }),
      ]);
      setPoolStats(statsData);
      setPoolPhones(poolData.phones);
      setPoolTotal(poolData.total);
    } catch {
      notify.error('Error', 'Failed to load phone pool');
    } finally {
      setPoolLoading(false);
    }
  };

  const loadPoolConfig = async () => {
    try {
      const config = await adminApi.getPoolConfig();
      setTenantKeyConfigured(config.configured);
    } catch {
      setTenantKeyConfigured(false);
    }
  };

  const loadMessagingServiceSid = async () => {
    try {
      const pricing = await adminApi.getPhonePricing();
      if (pricing.messagingServiceSid) setMessagingServiceSid(pricing.messagingServiceSid);
    } catch { /* keep default */ }
  };

  const handleSaveMessagingService = async () => {
    if (!messagingServiceSid.startsWith('MG')) {
      notify.error('Invalid', 'Messaging Service SID must start with MG');
      return;
    }
    try {
      setMessagingServiceSaving(true);
      const result = await adminApi.updateMessagingService(messagingServiceSid);
      notify.success('Saved', result.synced ? 'Messaging Service SID saved and synced to Sigcore' : 'Saved locally but Sigcore sync failed — check logs');
    } catch (err: any) {
      notify.error('Error', err.response?.data?.message || 'Failed to save Messaging Service SID');
    } finally {
      setMessagingServiceSaving(false);
    }
  };

  const checkTwilioHealth = async () => {
    try {
      setHealthChecking(true);
      const result = await adminApi.checkTwilioHealth();
      setTwilioHealth(result);
    } catch {
      setTwilioHealth({ status: 'error', phoneCount: 0, message: 'Failed to check Twilio connection', checkedAt: new Date().toISOString() });
    } finally {
      setHealthChecking(false);
    }
  };

  const loadOpenPhoneNumbers = async () => {
    try {
      setOpenPhoneLoading(true);
      const numbers = await adminApi.getOpenPhoneNumbers();
      setOpenPhoneNumbers(numbers);
    } catch {
      // Silent fail — informational only
    } finally {
      setOpenPhoneLoading(false);
    }
  };

  // ── Pool Actions ──

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const result = await adminApi.connectPoolProvider('twilio', { accountSid: connectFields.accountSid, authToken: connectFields.authToken });
      if (result.success) {
        notify.success('Connected', 'Twilio connected successfully');
        setShowConnect(false);
        setConnectFields({ accountSid: '', authToken: '' });
        await handleSync();
        checkTwilioHealth();
      } else {
        notify.error('Connection Failed', result.error || 'Failed to connect provider');
      }
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || error.response?.data?.error || 'Failed to connect provider');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Disconnect Twilio? All pool numbers from this provider will be released.')) return;
    try {
      const result = await adminApi.disconnectPoolProvider('twilio');
      if (result.success) {
        notify.success('Disconnected', 'Twilio disconnected');
        loadPoolData();
        checkTwilioHealth();
      } else {
        notify.error('Error', result.error || 'Failed to disconnect');
      }
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to disconnect provider');
    }
  };

  const handleSync = async () => {
    try {
      setSyncing(true);
      const result = await adminApi.syncPoolNumbers();
      if (result.success) {
        const totalSynced = result.data.results.reduce((sum: number, r: any) => sum + r.synced, 0);
        const released = result.data.released || 0;
        const errors = result.data.results.flatMap((r: any) => r.errors);
        const details = result.data.results.map((r: any) => `${r.provider}: ${r.synced} synced${r.errors.length ? ` (${r.errors.join(', ')})` : ''}`).join(' | ');
        const releasedMsg = released > 0 ? ` ${released} number(s) released from Twilio.` : '';
        if (totalSynced > 0 || released > 0) notify.success('Synced', `${totalSynced} synced, ${released} released.${releasedMsg ? '' : ` ${details}`}`);
        else if (errors.length > 0) notify.error('Sync Issues', details);
        else notify.success('Up to date', `No new numbers. ${details}`);
      }
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to sync numbers');
    } finally {
      setSyncing(false);
      await loadPoolData();
      checkTwilioHealth();
    }
  };

  const handleToggleSmsApproved = async (phonePoolId: string, currentValue: boolean) => {
    try {
      await adminApi.updateSmsApproved(phonePoolId, !currentValue);
      setPoolPhones(prev => prev.map(p => p.id === phonePoolId ? { ...p, smsApproved: !currentValue } : p));
      notify.success('Updated', !currentValue ? 'SMS sending approved' : 'SMS sending disabled');
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to update SMS status');
    }
  };

  const handleRelease = async (phonePoolId: string, phoneNumber: string) => {
    if (!confirm(`Remove ${phoneNumber} from the pool?`)) return;
    try {
      await adminApi.releasePhone(phonePoolId);
      notify.success('Removed', 'Phone removed from pool');
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to remove phone');
    }
  };

  // ── Pool Assign ──

  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) { setUserResults([]); return; }
    try {
      setSearchingUsers(true);
      const result = await adminApi.getPhonePoolUsers(query);
      setUserResults(result.data);
    } catch { /* ignore */ } finally {
      setSearchingUsers(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (assigningPhoneId) searchUsers(userSearch); }, 300);
    return () => clearTimeout(timer);
  }, [userSearch, assigningPhoneId, searchUsers]);

  const handleAssign = async (phonePoolId: string, userId: string) => {
    if (assigning) return;
    setAssigning(true);
    try {
      await adminApi.assignPhone(phonePoolId, userId);
      notify.success('Assigned', 'Phone assigned to user');
      setAssigningPhoneId(null);
      setUserSearch('');
      setUserResults([]);
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to assign phone');
    } finally {
      setAssigning(false);
    }
  };

  const handleAssignAll = async (phonePoolId: string) => {
    if (!confirm('Assign this phone number to ALL tenants?')) return;
    if (assigning) return;
    setAssigning(true);
    try {
      await adminApi.assignPhoneToAll(phonePoolId);
      notify.success('Assigned', 'Phone assigned to all tenants');
      setAssigningPhoneId(null);
      setUserSearch('');
      setUserResults([]);
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to assign phone to all');
    } finally {
      setAssigning(false);
    }
  };

  const handleUnassign = async (phonePoolId: string, userId: string, userEmail: string) => {
    if (!confirm(`Unassign this phone from ${userEmail}?`)) return;
    try {
      await adminApi.unassignPhone(phonePoolId, userId);
      notify.success('Unassigned', `Phone unassigned from ${userEmail}`);
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to unassign phone');
    }
  };

  // ── DnD Handlers ──

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as { type: 'pool' | 'tenant'; id: string };
    let phoneNumber = '';
    if (data.type === 'pool') {
      phoneNumber = poolPhones.find(p => p.id === data.id)?.phoneNumber || '';
    } else {
      phoneNumber = tenantPhones.find(p => p.id === data.id)?.phoneNumber || '';
    }
    setActiveDrag({ type: data.type, id: data.id, phoneNumber });
  };

  const handleDragOver = (event: any) => {
    setOverZone(event.over?.id?.toString() || null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    const overTarget = event.over?.id?.toString();
    const dragData = event.active.data.current as { type: 'pool' | 'tenant'; id: string } | undefined;

    setActiveDrag(null);
    setOverZone(null);

    if (!overTarget || !dragData) return;

    // Pool → Tenant zone: open user selection modal
    if (dragData.type === 'pool' && overTarget === 'tenant-zone') {
      const phone = poolPhones.find(p => p.id === dragData.id);
      if (phone && phone.status !== 'RELEASED') {
        setConvertingPoolId(phone.id);
        setConvertingPoolPhone(phone.phoneNumber);
        setConvertUserSearch('');
        setConvertUserResults([]);
      }
      return;
    }

    // Tenant → Pool zone: confirm and convert
    if (dragData.type === 'tenant' && overTarget === 'pool-zone') {
      const phone = tenantPhones.find(p => p.id === dragData.id);
      if (phone && phone.status === 'ACTIVE') {
        handleConvertTenantToPool(phone.id, phone.phoneNumber);
      }
    }
  };

  // ── Convert Operations ──

  const searchConvertUsers = useCallback(async (query: string) => {
    try {
      setSearchingConvertUsers(true);
      const result = await adminApi.getPhonePoolUsers(query.trim() || '');
      setConvertUserResults(result.data);
    } catch { /* ignore */ } finally {
      setSearchingConvertUsers(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (convertingPoolId) searchConvertUsers(convertUserSearch); }, 300);
    return () => clearTimeout(timer);
  }, [convertUserSearch, convertingPoolId, searchConvertUsers]);

  const handleConvertPoolToTenant = async (poolId: string, userId: string) => {
    if (converting) return;
    setConverting(true);
    try {
      await adminApi.convertPoolToTenant(poolId, userId);
      notify.success('Moved', 'Number moved to tenant dedicated numbers');
      setConvertingPoolId(null);
      loadTenantData();
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to convert number');
    } finally {
      setConverting(false);
    }
  };

  const handleConvertTenantToPool = async (tenantPhoneId: string, phoneNumber: string) => {
    if (!confirm(`Move ${formatPhone(phoneNumber)} from tenant to pool?`)) return;
    try {
      await adminApi.convertTenantToPool(tenantPhoneId);
      notify.success('Moved', 'Number moved to pool');
      loadTenantData();
      loadPoolData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to convert number');
    }
  };

  // ── Reassign Operations ──

  const searchReassignUsers = useCallback(async (query: string) => {
    try {
      setSearchingReassignUsers(true);
      const result = await adminApi.getPhonePoolUsers(query.trim() || '');
      setReassignUserResults(result.data);
    } catch { /* ignore */ } finally {
      setSearchingReassignUsers(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { if (reassigningTenantId) searchReassignUsers(reassignUserSearch); }, 300);
    return () => clearTimeout(timer);
  }, [reassignUserSearch, reassigningTenantId, searchReassignUsers]);

  const handleReassignTenant = async (tenantPhoneId: string, userId: string) => {
    if (reassigning) return;
    setReassigning(true);
    try {
      await adminApi.reassignTenantPhone(tenantPhoneId, userId);
      notify.success('Reassigned', 'Dedicated number reassigned to new user');
      setReassigningTenantId(null);
      loadTenantData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to reassign number');
    } finally {
      setReassigning(false);
    }
  };

  // ── Badge Renderers ──

  const tenantStatusBadge = (status: string) => {
    switch (status) {
      case 'ACTIVE': return <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-[11px] font-bold">Active</span>;
      case 'GRACE_PERIOD': return <span className="px-2 py-0.5 bg-amber-100 text-amber-700 rounded-full text-[11px] font-bold">Grace Period</span>;
      case 'RELEASED': return <span className="px-2 py-0.5 bg-red-100 text-red-700 rounded-full text-[11px] font-bold">Released</span>;
      default: return <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full text-[11px] font-bold">{status}</span>;
    }
  };

  const providerBadge = (provider: string | null | undefined) => {
    switch (provider) {
      case 'twilio': return <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full text-[11px] font-bold">Twilio</span>;
      case 'openphone': return <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[11px] font-bold">OpenPhone</span>;
      default: return <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-full text-[11px] font-bold">—</span>;
    }
  };

  const poolStatusBadge = (status: string) => {
    switch (status) {
      case 'AVAILABLE': return <span className="px-2.5 py-1 bg-green-100 text-green-700 rounded-full text-[10px] font-bold uppercase">Available</span>;
      case 'ASSIGNED': return <span className="px-2.5 py-1 bg-blue-100 text-blue-700 rounded-full text-[10px] font-bold uppercase">Assigned</span>;
      case 'RESERVED': return <span className="px-2.5 py-1 bg-yellow-100 text-yellow-700 rounded-full text-[10px] font-bold uppercase">Reserved</span>;
      case 'RELEASED': return <span className="px-2.5 py-1 bg-red-100 text-red-700 rounded-full text-[10px] font-bold uppercase">Released</span>;
      default: return <span className="px-2.5 py-1 bg-slate-100 text-slate-700 rounded-full text-[10px] font-bold uppercase">{status}</span>;
    }
  };

  // ── Derived stats ──
  const tenantActiveCount = tenantPhones.filter(p => p.status === 'ACTIVE').length;
  const tenantGraceCount = tenantPhones.filter(p => p.status === 'GRACE_PERIOD').length;

  // ── Loading state ──
  if (tenantLoading && tenantPhones.length === 0 && poolLoading && poolPhones.length === 0) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <Smartphone size={24} /> Tenant Numbers
          </h1>
        </div>
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-blue-600 mr-3" />
          <p className="text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <DndContext onDragStart={handleDragStart} onDragOver={handleDragOver} onDragEnd={handleDragEnd}>
      <div className="p-4 md:p-6 lg:p-10 max-w-7xl mx-auto space-y-6 md:space-y-10">
        {/* Header */}
        <div className="space-y-1 md:space-y-2">
          <h1 className="text-2xl md:text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight flex items-center gap-3">
            <Smartphone size={24} /> <span className="gradient-text">Tenant Numbers</span>
          </h1>
          <p className="text-slate-600 text-sm md:text-lg">Manage tenant dedicated numbers and shared pool numbers</p>
        </div>

        {/* Twilio Health Check */}
        <div className={`rounded-2xl md:rounded-3xl border shadow-sm p-4 md:p-5 ${
          twilioHealth?.status === 'connected' ? 'bg-emerald-50 border-emerald-200' :
          twilioHealth?.status === 'error' ? 'bg-red-50 border-red-200' :
          twilioHealth?.status === 'disconnected' ? 'bg-amber-50 border-amber-200' :
          'bg-white border-slate-100'
        }`}>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-3">
              <div className={`w-3 h-3 rounded-full shrink-0 ${
                twilioHealth?.status === 'connected' ? 'bg-emerald-500' :
                twilioHealth?.status === 'disconnected' ? 'bg-amber-500' :
                twilioHealth?.status === 'error' ? 'bg-red-500' :
                'bg-slate-300 animate-pulse'
              }`} />
              <div>
                <h3 className="text-sm font-bold text-slate-900">Twilio Connection</h3>
                <p className={`text-xs mt-0.5 ${
                  twilioHealth?.status === 'connected' ? 'text-emerald-700' :
                  twilioHealth?.status === 'error' ? 'text-red-700' :
                  twilioHealth?.status === 'disconnected' ? 'text-amber-700' :
                  'text-slate-500'
                }`}>{twilioHealth?.message || 'Checking connection...'}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {twilioHealth?.status === 'connected' && (
                <>
                  <span className="px-2.5 py-1 bg-emerald-100 text-emerald-700 rounded-full text-xs font-bold">
                    {twilioHealth.phoneCount} number{twilioHealth.phoneCount !== 1 ? 's' : ''}
                  </span>
                  <button onClick={handleDisconnect} className="px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-lg text-xs font-semibold hover:bg-red-100 transition-all flex items-center gap-1.5">
                    <Unlink size={12} /> Disconnect
                  </button>
                </>
              )}
              {(twilioHealth?.status === 'disconnected' || twilioHealth?.status === 'error') && (
                <button onClick={() => setShowConnect(true)} className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 transition-all flex items-center gap-1.5 shadow-sm">
                  <Link size={12} /> Connect
                </button>
              )}
              <button onClick={checkTwilioHealth} disabled={healthChecking} className="px-3 py-1.5 bg-white/80 border border-slate-200 text-slate-700 rounded-lg text-xs font-semibold hover:bg-white transition-all flex items-center gap-1.5 disabled:opacity-50">
                {healthChecking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Check
              </button>
            </div>
          </div>
        </div>

        {/* A2P Messaging Service SID — tight under Twilio connection */}
        {twilioHealth?.status === 'connected' && (
          <div className="flex items-center gap-3 px-4 py-3 bg-white rounded-2xl border border-slate-100 shadow-sm">
            <label className="text-xs font-bold text-slate-600 whitespace-nowrap">Messaging Service SID</label>
            <input
              type="text"
              value={messagingServiceSid}
              onChange={e => setMessagingServiceSid(e.target.value)}
              placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm font-mono focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none min-w-0"
            />
            <button
              onClick={handleSaveMessagingService}
              disabled={messagingServiceSaving || !messagingServiceSid}
              className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-semibold hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap"
            >
              {messagingServiceSaving ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
              Save & Sync
            </button>
          </div>
        )}

        {/* Connect Provider Form (appears below health banner) */}
        {showConnect && (
          <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 md:p-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Connect Twilio</h3>
              <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setShowConnect(false)}><X size={18} /></button>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Account SID</label>
                <input type="text" placeholder="AC..." value={connectFields.accountSid} onChange={e => setConnectFields({ ...connectFields, accountSid: e.target.value })} className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Auth Token</label>
                <input type="password" placeholder="Enter your Twilio auth token" value={connectFields.authToken} onChange={e => setConnectFields({ ...connectFields, authToken: e.target.value })} className="w-full px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="flex gap-2 pt-2">
                <button className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center gap-2 disabled:opacity-50" onClick={handleConnect} disabled={connecting || !connectFields.accountSid || !connectFields.authToken}>
                  {connecting ? <><Loader2 size={16} className="animate-spin" /> Connecting...</> : <><Link size={16} /> Connect Twilio</>}
                </button>
                <button className="px-6 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all" onClick={() => setShowConnect(false)}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* SECTION 1: Tenant Dedicated Numbers                               */}
        {/* ═══════════════════════════════════════════════════════════════════ */}

        <DroppableZone id="tenant-zone" isOver={overZone === 'tenant-zone' && activeDrag?.type === 'pool'}>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg md:text-xl font-bold text-slate-900 flex items-center gap-2">
                <Smartphone size={20} /> Tenant Dedicated Numbers
                <span className="text-sm font-normal text-slate-500">({tenantTotal})</span>
              </h2>
            </div>

            {/* Tenant Stats */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                <p className="text-xs font-semibold text-slate-500 mb-1">Active</p>
                <p className="text-2xl font-extrabold text-slate-900">{tenantActiveCount}</p>
              </div>
              <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                <p className="text-xs font-semibold text-slate-500 mb-1">Grace Period</p>
                <p className="text-2xl font-extrabold text-amber-600">{tenantGraceCount}</p>
              </div>
            </div>

            {/* Tenant Search */}
            <div className="flex flex-col md:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                <input
                  type="text"
                  placeholder="Search by phone, email, or business name..."
                  value={tenantSearch}
                  onChange={(e) => setTenantSearch(e.target.value)}
                  className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none transition-all"
                />
              </div>
              <select
                value={tenantStatusFilter}
                onChange={(e) => { setTenantStatusFilter(e.target.value); setTenantOffset(0); }}
                className="px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 outline-none bg-white"
              >
                <option value="">All Statuses</option>
                <option value="ACTIVE">Active</option>
                <option value="GRACE_PERIOD">Grace Period</option>
                <option value="RELEASED">Released</option>
              </select>
              <button onClick={loadTenantData} disabled={tenantLoading} className="px-4 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all flex items-center gap-2 disabled:opacity-50">
                {tenantLoading ? <Loader2 size={16} className="animate-spin" /> : <RefreshCw size={16} />}
                Refresh
              </button>
            </div>

            {/* Tenant Table */}
            <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm overflow-hidden">
              {tenantPhones.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-500">{tenantSearch || tenantStatusFilter ? 'No matching numbers found' : 'No tenant numbers yet. Drag a pool number here to assign it.'}</p>
                </div>
              ) : (
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 text-left">
                        <th className="px-3 py-3.5 w-8"></th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Phone Number</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Tenant</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Owner</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Provider</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Status</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider">Purchased</th>
                        <th className="px-5 py-3.5 text-xs font-bold text-slate-500 uppercase tracking-wider w-20">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-50">
                      {tenantPhones.map((phone) => (
                        <DraggableRow key={phone.id} id={phone.id} type="tenant">
                          <td className="px-5 py-3.5 font-mono text-sm font-bold text-slate-900">{formatPhone(phone.phoneNumber)}</td>
                          <td className="px-5 py-3.5 text-sm text-slate-700 font-medium">{phone.tenantName || '—'}</td>
                          <td className="px-5 py-3.5 text-sm text-slate-500">{phone.user?.email || '—'}</td>
                          <td className="px-5 py-3.5">{providerBadge(phone.notificationSettings?.sigcoreProvider)}</td>
                          <td className="px-5 py-3.5">{tenantStatusBadge(phone.status)}</td>
                          <td className="px-5 py-3.5 text-sm text-slate-500">{formatDate(phone.purchasedAt)}</td>
                          <td className="px-5 py-3.5">
                            {phone.status === 'ACTIVE' && (
                              <button
                                onClick={() => {
                                  setReassigningTenantId(phone.id);
                                  setReassigningTenantPhone(phone.phoneNumber);
                                  setReassignUserSearch('');
                                  setReassignUserResults([]);
                                }}
                                className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-all"
                                title="Reassign to different user"
                              >
                                <UserPlus size={14} />
                              </button>
                            )}
                          </td>
                        </DraggableRow>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Mobile cards for tenant */}
              <div className="md:hidden divide-y divide-slate-100">
                {tenantPhones.map((phone) => (
                  <div key={phone.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-bold text-slate-900 font-mono">{formatPhone(phone.phoneNumber)}</span>
                      {tenantStatusBadge(phone.status)}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                      {providerBadge(phone.notificationSettings?.sigcoreProvider)}
                      {phone.tenantName && <span className="text-xs text-slate-600">{phone.tenantName}</span>}
                    </div>
                    <p className="text-[11px] text-slate-400">{phone.user?.email} · {formatDate(phone.purchasedAt)}</p>
                  </div>
                ))}
              </div>

              {/* Tenant Pagination */}
              {tenantTotal > tenantLimit && (
                <div className="flex items-center justify-between px-5 py-4 border-t border-slate-100">
                  <button onClick={() => setTenantOffset(Math.max(0, tenantOffset - tenantLimit))} disabled={tenantOffset === 0} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm">Previous</button>
                  <span className="text-sm text-slate-600">{tenantOffset + 1}–{Math.min(tenantOffset + tenantLimit, tenantTotal)} of {tenantTotal}</span>
                  <button onClick={() => setTenantOffset(tenantOffset + tenantLimit)} disabled={tenantOffset + tenantLimit >= tenantTotal} className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all disabled:opacity-50 disabled:cursor-not-allowed text-sm">Next</button>
                </div>
              )}
            </div>
          </div>
        </DroppableZone>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* SECTION 2: Pool Numbers                                           */}
        {/* ═══════════════════════════════════════════════════════════════════ */}

        <DroppableZone id="pool-zone" isOver={overZone === 'pool-zone' && activeDrag?.type === 'tenant'}>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg md:text-xl font-bold text-slate-900 flex items-center gap-2">
                <Phone size={20} /> Pool Numbers
                <span className="text-sm font-normal text-slate-500">({poolTotal})</span>
              </h2>
            </div>

            {/* Tenant Key Warning */}
            {tenantKeyConfigured === false && (
              <div className="bg-yellow-50 border border-yellow-300 rounded-2xl p-4">
                <div className="text-yellow-800 text-sm">
                  <strong>SIGCORE_API_KEY not configured.</strong> Set the <code className="bg-yellow-200 px-2 py-0.5 rounded text-xs">SIGCORE_API_KEY</code> environment variable to enable provider connections.
                </div>
              </div>
            )}

            {/* Pool Stats */}
            {poolStats && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Total</p>
                  <p className="text-2xl font-extrabold text-slate-900">{poolStats.total}</p>
                </div>
                <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Available</p>
                  <p className="text-2xl font-extrabold text-green-600">{poolStats.available}</p>
                </div>
                <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Assigned</p>
                  <p className="text-2xl font-extrabold text-blue-600">{poolStats.assigned}</p>
                </div>
                <div className="rounded-2xl bg-white border border-slate-100 shadow-sm p-4">
                  <p className="text-xs font-semibold text-slate-500 mb-1">Reserved</p>
                  <p className="text-2xl font-extrabold text-yellow-600">{poolStats.reserved}</p>
                </div>
              </div>
            )}

            {/* Pool Actions Bar */}
            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 space-y-3">
              <div className="flex flex-col sm:flex-row gap-3">
                <div className="relative flex items-center min-w-0 flex-1">
                  <Search size={16} className="absolute left-4 text-slate-400 pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search pool numbers..."
                    value={poolSearch}
                    onChange={e => setPoolSearch(e.target.value)}
                    className="w-full pl-11 pr-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
                  />
                </div>
                <select
                  value={poolStatusFilter}
                  onChange={e => setPoolStatusFilter(e.target.value)}
                  className="w-full sm:w-auto px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all min-w-[160px]"
                >
                  <option value="">All Status</option>
                  <option value="AVAILABLE">Available</option>
                  <option value="ASSIGNED">Assigned</option>
                  <option value="RESERVED">Reserved</option>
                  <option value="RELEASED">Released</option>
                </select>
              </div>
              <div className="flex items-center gap-2 pt-2 border-t border-slate-100">
                <button className="px-4 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50" onClick={handleSync} disabled={syncing || tenantKeyConfigured === false}>
                  {syncing ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Sync Numbers
                </button>
                <button className="px-3 py-2.5 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center" onClick={loadPoolData} title="Refresh">
                  <RefreshCw size={16} />
                </button>
              </div>
            </div>

            {/* Pool Table */}
            <div className="rounded-2xl md:rounded-3xl bg-white border border-slate-100 shadow-sm overflow-hidden">
              {poolPhones.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-500">{poolLoading ? 'Loading...' : 'No phone numbers in pool. Connect a provider and sync to get started.'}</p>
                </div>
              ) : (
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="border-b border-slate-100 bg-slate-50">
                        <th className="px-3 py-4 w-8"></th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Phone Number</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Friendly Name</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Area Code</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Provider</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Status</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Capabilities</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">A2P SMS</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Assigned To</th>
                        <th className="px-5 py-4 text-left text-xs font-bold text-slate-700 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {poolPhones.map(phone => (
                        <DraggableRow key={phone.id} id={phone.id} type="pool">
                          <td className="px-5 py-3.5 font-mono text-slate-900">{formatPhone(phone.phoneNumber)}</td>
                          <td className="px-5 py-3.5 text-sm text-slate-600">{phone.friendlyName || '—'}</td>
                          <td className="px-5 py-3.5 text-slate-700">{phone.areaCode || '—'}</td>
                          <td className="px-5 py-3.5">
                            <span className="px-3 py-1 bg-slate-100 text-slate-700 rounded-full text-xs font-bold uppercase">{phone.provider}</span>
                          </td>
                          <td className="px-5 py-3.5">{poolStatusBadge(phone.status)}</td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-1.5">
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${phone.smsCapable ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`} title={phone.smsCapable ? 'SMS capable' : 'No SMS'}>
                                <MessageSquare size={10} /> SMS
                              </span>
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold ${phone.voiceCapable ? 'bg-blue-100 text-blue-700' : 'bg-slate-100 text-slate-400'}`} title={phone.voiceCapable ? 'Voice capable' : 'No voice'}>
                                <PhoneCall size={10} /> Voice
                              </span>
                            </div>
                          </td>
                          <td className="px-5 py-3.5">
                            <button onClick={() => handleToggleSmsApproved(phone.id, phone.smsApproved)} className={`px-3 py-1 rounded-full text-xs font-bold uppercase flex items-center gap-1.5 transition-all ${phone.smsApproved ? 'bg-green-100 text-green-700 hover:bg-green-200' : 'bg-red-100 text-red-700 hover:bg-red-200'}`} title={phone.smsApproved ? 'A2P approved — click to disable SMS' : 'Not A2P approved — click to enable SMS'}>
                              {phone.smsApproved ? <ShieldCheck size={12} /> : <ShieldAlert size={12} />}
                              {phone.smsApproved ? 'Approved' : 'Not Approved'}
                            </button>
                          </td>
                          <td className="px-5 py-3.5">
                            {phone.assignments && phone.assignments.length > 0 ? (
                              <div className="space-y-1">
                                {phone.assignments.map(assignment => (
                                  <div key={assignment.id} className="flex items-center gap-2">
                                    <span className="text-sm font-medium text-slate-900">{assignment.user.email}</span>
                                    <button className="p-1 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-all" onClick={() => handleUnassign(phone.id, assignment.user.id, assignment.user.email)} title={`Unassign from ${assignment.user.email}`}>
                                      <UserMinus size={12} />
                                    </button>
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <span className="text-slate-400 italic">Unassigned</span>
                            )}
                          </td>
                          <td className="px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              {phone.status !== 'RELEASED' && (
                                <button className="p-2 bg-slate-100 text-slate-700 rounded-xl hover:bg-slate-200 transition-all" onClick={() => { setAssigningPhoneId(phone.id); setUserSearch(''); setUserResults([]); }} title="Assign to user">
                                  <UserPlus size={14} />
                                </button>
                              )}
                              {phone.status !== 'RELEASED' && (
                                <button className="p-2 bg-red-100 text-red-700 rounded-xl hover:bg-red-200 transition-all" onClick={() => handleRelease(phone.id, phone.phoneNumber)} title="Remove from pool">
                                  <Trash2 size={14} />
                                </button>
                              )}
                            </div>
                          </td>
                        </DraggableRow>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Mobile cards for pool */}
              <div className="md:hidden divide-y divide-slate-100">
                {poolPhones.map(phone => (
                  <div key={phone.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-semibold text-slate-900">{formatPhone(phone.phoneNumber)}</span>
                      {poolStatusBadge(phone.status)}
                    </div>
                    {phone.friendlyName && (
                      <p className="text-xs text-slate-500">{phone.friendlyName}</p>
                    )}
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span className="px-2 py-0.5 bg-slate-100 text-slate-600 rounded-full font-bold uppercase">{phone.provider}</span>
                      {phone.areaCode && <span>Area {phone.areaCode}</span>}
                      {phone.smsCapable && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-bold">SMS</span>}
                      {phone.voiceCapable && <span className="px-2 py-0.5 bg-blue-100 text-blue-700 rounded-full font-bold">Voice</span>}
                    </div>
                    {phone.assignments && phone.assignments.length > 0 && (
                      <div className="space-y-1">
                        {phone.assignments.map(assignment => (
                          <div key={assignment.id} className="flex items-center justify-between bg-slate-50 rounded-lg px-3 py-2">
                            <p className="text-xs font-medium text-slate-900 truncate">{assignment.user.email}</p>
                            <button className="p-1.5 text-slate-500 hover:bg-slate-200 rounded-lg transition-all shrink-0" onClick={() => handleUnassign(phone.id, assignment.user.id, assignment.user.email)}>
                              <UserMinus size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    {phone.status !== 'RELEASED' && (
                      <div className="flex items-center gap-2 pt-1">
                        <button className="px-3 py-1.5 bg-slate-100 text-slate-700 rounded-lg text-xs font-semibold hover:bg-slate-200 transition-all flex items-center gap-1.5" onClick={() => { setAssigningPhoneId(phone.id); setUserSearch(''); setUserResults([]); }}>
                          <UserPlus size={12} /> Assign
                        </button>
                        <button className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-semibold hover:bg-red-100 transition-all flex items-center gap-1.5" onClick={() => handleRelease(phone.id, phone.phoneNumber)}>
                          <Trash2 size={12} /> Remove
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {poolTotal > 0 && (
                <div className="px-4 py-3 border-t border-slate-100 text-xs text-slate-600">
                  Showing {poolPhones.length} of {poolTotal} numbers
                </div>
              )}
            </div>
          </div>
        </DroppableZone>

        {/* ═══════════════════════════════════════════════════════════════════ */}
        {/* SECTION 3: Bring Your Own Numbers (Informational)                  */}
        {/* ═══════════════════════════════════════════════════════════════════ */}

        <div className="space-y-4">
          <h2 className="text-lg md:text-xl font-bold text-slate-900 flex items-center gap-2">
            <Phone size={20} className="text-purple-600" /> Bring Your Own Numbers
            <span className="text-sm font-normal text-slate-500">({openPhoneNumbers.length})</span>
            <span className="px-2 py-0.5 bg-purple-50 text-purple-600 text-[10px] font-bold rounded uppercase tracking-wider">Informational</span>
          </h2>

          <div className="rounded-2xl md:rounded-3xl bg-white border border-purple-100 shadow-sm overflow-hidden">
            {openPhoneLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 size={20} className="animate-spin text-purple-600 mr-3" />
                <span className="text-slate-500">Loading OpenPhone numbers...</span>
              </div>
            ) : openPhoneNumbers.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-slate-500">No OpenPhone numbers connected by any tenant.</p>
              </div>
            ) : (
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-purple-100 bg-purple-50/50">
                      <th className="px-5 py-3.5 text-left text-xs font-bold text-purple-700 uppercase tracking-wider">Phone Number</th>
                      <th className="px-5 py-3.5 text-left text-xs font-bold text-purple-700 uppercase tracking-wider">Name</th>
                      <th className="px-5 py-3.5 text-left text-xs font-bold text-purple-700 uppercase tracking-wider">User</th>
                      <th className="px-5 py-3.5 text-left text-xs font-bold text-purple-700 uppercase tracking-wider">Account</th>
                      <th className="px-5 py-3.5 text-left text-xs font-bold text-purple-700 uppercase tracking-wider">Provider</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-purple-50">
                    {openPhoneNumbers.map((phone, idx) => (
                      <tr key={`${phone.phoneNumber}-${idx}`} className="hover:bg-purple-50/30 transition-colors">
                        <td className="px-5 py-3.5 font-mono text-sm font-bold text-slate-900">{formatPhone(phone.phoneNumber)}</td>
                        <td className="px-5 py-3.5 text-sm text-slate-600">{phone.friendlyName || '—'}</td>
                        <td className="px-5 py-3.5 text-sm text-slate-600">{phone.userEmail}</td>
                        <td className="px-5 py-3.5 text-sm text-slate-600">{phone.accountName}</td>
                        <td className="px-5 py-3.5">
                          <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[11px] font-bold">OpenPhone</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Mobile cards for OpenPhone */}
            {!openPhoneLoading && openPhoneNumbers.length > 0 && (
              <div className="md:hidden divide-y divide-purple-50">
                {openPhoneNumbers.map((phone, idx) => (
                  <div key={`${phone.phoneNumber}-${idx}`} className="p-4 space-y-1">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-sm font-bold text-slate-900">{formatPhone(phone.phoneNumber)}</span>
                      <span className="px-2 py-0.5 bg-purple-100 text-purple-700 rounded-full text-[10px] font-bold">OpenPhone</span>
                    </div>
                    <p className="text-xs text-slate-500">{phone.userEmail} · {phone.accountName}</p>
                    {phone.friendlyName && <p className="text-xs text-slate-400">{phone.friendlyName}</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Drag Overlay ── */}
      <DragOverlay>
        {activeDrag && (
          <div className="bg-white border-2 border-blue-400 rounded-xl shadow-2xl px-4 py-3 flex items-center gap-3">
            <GripVertical size={14} className="text-blue-400" />
            <span className="font-mono font-bold text-slate-900">{formatPhone(activeDrag.phoneNumber)}</span>
            <span className="text-xs text-slate-500">{activeDrag.type === 'pool' ? 'Pool' : 'Tenant'}</span>
          </div>
        )}
      </DragOverlay>

      {/* ── Pool Assign Modal ── */}
      {assigningPhoneId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setAssigningPhoneId(null)}>
          <div className="bg-white rounded-2xl md:rounded-3xl p-4 md:p-8 max-w-2xl w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 md:mb-6">
              <h3 className="text-lg md:text-xl font-bold text-slate-900">Assign Phone</h3>
              <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setAssigningPhoneId(null)}><X size={18} /></button>
            </div>
            <div className="space-y-6">
              <button className="w-full px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 disabled:opacity-50" onClick={() => handleAssignAll(assigningPhoneId)} disabled={assigning}>
                {assigning ? <Loader2 size={16} className="animate-spin" /> : <Users size={16} />} Assign to All Tenants
              </button>
              <div className="relative text-center">
                <hr className="border-t border-slate-200" />
                <span className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white px-3 text-xs text-slate-500">or assign to a specific tenant</span>
              </div>
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">Search Users</label>
                <div className="relative flex items-center">
                  <Search size={16} className="absolute left-4 text-slate-400" />
                  <input type="text" placeholder="Search by email or name..." value={userSearch} onChange={e => setUserSearch(e.target.value)} autoFocus className="w-full pl-11 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
                </div>
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {searchingUsers ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
                ) : userResults.length > 0 ? (
                  userResults.map(u => {
                    const alreadyAssigned = poolPhones.find(p => p.id === assigningPhoneId)?.assignments?.some((a: any) => a.user?.id === u.id);
                    return (
                      <button key={u.id} className={`w-full flex items-center justify-between p-4 rounded-xl transition-all ${alreadyAssigned ? 'bg-green-50 cursor-default' : 'bg-slate-50 hover:bg-slate-100 disabled:opacity-50'}`} onClick={() => !alreadyAssigned && handleAssign(assigningPhoneId, u.id)} disabled={assigning || !!alreadyAssigned}>
                        <div className="flex flex-col items-start">
                          <span className={`font-medium ${alreadyAssigned ? 'text-green-700' : 'text-slate-900'}`}>{u.email}</span>
                          {u.name && <span className="text-sm text-slate-500">{u.name}</span>}
                        </div>
                        {alreadyAssigned ? (
                          <span className="text-xs font-semibold text-green-600 bg-green-100 px-2 py-1 rounded-full">Already assigned</span>
                        ) : assigning ? (
                          <Loader2 size={16} className="animate-spin text-blue-600" />
                        ) : (
                          <UserPlus size={16} className="text-blue-600" />
                        )}
                      </button>
                    );
                  })
                ) : userSearch.trim() ? (
                  <p className="text-center py-8 text-slate-500">No users found</p>
                ) : (
                  <p className="text-center py-8 text-slate-500">Type to search for users</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Convert Pool→Tenant Modal (user selection) ── */}
      {convertingPoolId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setConvertingPoolId(null)}>
          <div className="bg-white rounded-2xl md:rounded-3xl p-4 md:p-8 max-w-lg w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Move to Tenant</h3>
              <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setConvertingPoolId(null)}><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Assign <span className="font-mono font-bold">{formatPhone(convertingPoolPhone)}</span> as a dedicated tenant number. Select the user:
            </p>
            <div className="space-y-4">
              <div className="relative flex items-center">
                <Search size={16} className="absolute left-4 text-slate-400" />
                <input type="text" placeholder="Search by email or name..." value={convertUserSearch} onChange={e => setConvertUserSearch(e.target.value)} autoFocus className="w-full pl-11 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {searchingConvertUsers ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
                ) : convertUserResults.length > 0 ? (
                  convertUserResults.map(u => (
                    <button key={u.id} className="w-full flex items-center justify-between p-4 rounded-xl bg-slate-50 hover:bg-slate-100 transition-all disabled:opacity-50" onClick={() => handleConvertPoolToTenant(convertingPoolId, u.id)} disabled={converting}>
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-slate-900">{u.email}</span>
                        {u.name && <span className="text-sm text-slate-500">{u.name}</span>}
                      </div>
                      {converting ? <Loader2 size={16} className="animate-spin text-blue-600" /> : <UserPlus size={16} className="text-blue-600" />}
                    </button>
                  ))
                ) : convertUserSearch.trim() ? (
                  <p className="text-center py-8 text-slate-500">No users found</p>
                ) : (
                  <p className="text-center py-8 text-slate-500">Type to search for users</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Reassign Tenant Phone Modal ── */}
      {reassigningTenantId && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={() => setReassigningTenantId(null)}>
          <div className="bg-white rounded-2xl md:rounded-3xl p-4 md:p-8 max-w-lg w-full shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-slate-900">Reassign Dedicated Number</h3>
              <button className="w-8 h-8 flex items-center justify-center text-slate-500 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-all" onClick={() => setReassigningTenantId(null)}><X size={18} /></button>
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Reassign <span className="font-mono font-bold">{formatPhone(reassigningTenantPhone)}</span> to a different user:
            </p>
            <div className="space-y-4">
              <div className="relative flex items-center">
                <Search size={16} className="absolute left-4 text-slate-400" />
                <input type="text" placeholder="Search by email or name..." value={reassignUserSearch} onChange={e => setReassignUserSearch(e.target.value)} autoFocus className="w-full pl-11 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all" />
              </div>
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {searchingReassignUsers ? (
                  <div className="flex items-center justify-center py-8"><Loader2 size={20} className="animate-spin text-blue-600" /></div>
                ) : reassignUserResults.length > 0 ? (
                  reassignUserResults.map(u => (
                    <button key={u.id} className="w-full flex items-center justify-between p-4 rounded-xl bg-slate-50 hover:bg-slate-100 transition-all disabled:opacity-50" onClick={() => handleReassignTenant(reassigningTenantId, u.id)} disabled={reassigning}>
                      <div className="flex flex-col items-start">
                        <span className="font-medium text-slate-900">{u.email}</span>
                        {u.name && <span className="text-sm text-slate-500">{u.name}</span>}
                      </div>
                      {reassigning ? <Loader2 size={16} className="animate-spin text-blue-600" /> : <UserPlus size={16} className="text-blue-600" />}
                    </button>
                  ))
                ) : reassignUserSearch.trim() ? (
                  <p className="text-center py-8 text-slate-500">No users found</p>
                ) : (
                  <p className="text-center py-8 text-slate-500">Type to search for users</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </DndContext>
  );
}
