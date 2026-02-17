import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, X, ArrowLeft, Pencil, Loader2, Trash2, User, CreditCard, Activity, Hash } from 'lucide-react';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { AdminUserDetails } from '../../types';

const tierLabel: Record<string, string> = {
  STARTER: 'Instant Reply',
  PRO: 'Call Assist',
  ENTERPRISE: 'AI Conversations',
};

const tierColor: Record<string, string> = {
  STARTER: 'bg-blue-100 text-blue-700',
  PRO: 'bg-purple-100 text-purple-700',
  ENTERPRISE: 'bg-amber-100 text-amber-700',
};

const statusColor: Record<string, string> = {
  ACTIVE: 'bg-emerald-100 text-emerald-700',
  TRIALING: 'bg-blue-100 text-blue-700',
  PAST_DUE: 'bg-red-100 text-red-700',
  CANCELLED: 'bg-slate-100 text-slate-600',
  INCOMPLETE: 'bg-yellow-100 text-yellow-700',
};

export default function AdminUserDetailsPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const currentUser = useAuthStore((state) => state.user);
  const [user, setUser] = useState<AdminUserDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState({
    tier: '',
    status: '',
    hasOwnNumber: false,
  });

  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (currentUser?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }
    if (userId) loadUser();
  }, [userId, currentUser]);

  const loadUser = async () => {
    try {
      setLoading(true);
      const data = await adminApi.getUserDetails(userId!);
      setUser(data);
      setFormData({
        tier: data.subscriptionTier || '',
        status: data.subscriptionStatus || '',
        hasOwnNumber: data.hasOwnNumber,
      });
    } catch (error: any) {
      console.error('Failed to load user details:', error);
      notify.error('Error', 'Failed to load user details');
      navigate('/admin');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateSubscription = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    try {
      setUpdating(true);
      await adminApi.updateUserSubscription(user.id, {
        tier: formData.tier || undefined,
        status: formData.status || undefined,
        hasOwnNumber: formData.hasOwnNumber,
      });
      notify.success('Updated', 'User subscription updated successfully');
      setEditMode(false);
      loadUser();
    } catch (error: any) {
      console.error('Failed to update subscription:', error);
      notify.error('Error', 'Failed to update user subscription');
    } finally {
      setUpdating(false);
    }
  };

  const openDeleteModal = () => {
    setDeleteConfirmEmail('');
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
    setDeleteConfirmEmail('');
  };

  const handleDeleteUser = async () => {
    if (!user) return;
    if (deleteConfirmEmail !== user.email) {
      notify.error('Email Mismatch', 'Please type the exact email address to confirm');
      return;
    }
    try {
      setDeleting(true);
      await adminApi.deleteUser(user.id);
      notify.success('User Deleted', 'User and all associated data deleted permanently');
      navigate('/admin');
    } catch (error: any) {
      console.error('Failed to delete user:', error);
      notify.error('Error', 'Failed to delete user');
    } finally {
      setDeleting(false);
      closeDeleteModal();
    }
  };

  const handleCancelSubscription = async (immediate: boolean) => {
    if (!user || !user.stripeSubscriptionId) return;
    const confirmMessage = immediate
      ? 'Cancel this subscription immediately? The user will lose access right away.'
      : 'Cancel this subscription at period end? The user will keep access until the billing period ends.';
    if (!window.confirm(confirmMessage)) return;
    try {
      setCancelling(true);
      await adminApi.cancelUserSubscription(user.id, immediate);
      notify.success(
        'Subscription Cancelled',
        immediate ? 'Subscription cancelled immediately' : 'Subscription will cancel at period end'
      );
      loadUser();
    } catch (error: any) {
      console.error('Failed to cancel subscription:', error);
      notify.error('Error', 'Failed to cancel subscription');
    } finally {
      setCancelling(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="p-4 md:p-6 lg:p-10 max-w-5xl mx-auto">
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="ml-3 text-slate-500">Loading user details...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-10 max-w-5xl mx-auto space-y-6 md:space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <Link to="/admin" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-blue-600 transition-colors mb-2">
            <ArrowLeft size={16} />
            Back to Admin
          </Link>
          <h1 className="text-2xl md:text-3xl font-extrabold text-slate-900 tracking-tight">User Details</h1>
        </div>
        <button
          onClick={openDeleteModal}
          className="px-4 py-2.5 bg-red-50 text-red-600 rounded-xl text-sm font-semibold hover:bg-red-100 transition-all flex items-center gap-2 self-start"
        >
          <Trash2 size={16} />
          Delete User
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* User Information Card */}
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-5 md:p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <User size={18} className="text-slate-400" />
            User Information
          </h2>
          <div className="space-y-3">
            <div className="flex items-start justify-between gap-4 py-2 border-b border-slate-50">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest shrink-0">Email</span>
              <span className="text-sm font-medium text-slate-900 text-right break-all">{user.email}</span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Name</span>
              <span className="text-sm font-medium text-slate-900">{user.name || '—'}</span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Role</span>
              <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${user.role === 'ADMIN' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>
                {user.role}
              </span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Created</span>
              <span className="text-sm text-slate-700">{new Date(user.createdAt).toLocaleDateString()}</span>
            </div>
            <div className="flex items-center justify-between gap-4 py-2">
              <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Updated</span>
              <span className="text-sm text-slate-700">{new Date(user.updatedAt).toLocaleDateString()}</span>
            </div>
          </div>
        </div>

        {/* Subscription Card */}
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-5 md:p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <CreditCard size={18} className="text-slate-400" />
              Subscription
            </h2>
            <button
              onClick={() => setEditMode(!editMode)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all flex items-center gap-1.5 ${editMode ? 'bg-slate-100 text-slate-700 hover:bg-slate-200' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
            >
              {editMode ? (
                <>
                  <X size={14} /> Cancel
                </>
              ) : (
                <>
                  <Pencil size={14} /> Edit
                </>
              )}
            </button>
          </div>

          {editMode ? (
            <form onSubmit={handleUpdateSubscription} className="space-y-4">
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Tier</label>
                <select
                  value={formData.tier}
                  onChange={(e) => setFormData({ ...formData, tier: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all"
                >
                  <option value="">No Subscription</option>
                  <option value="STARTER">Instant Reply</option>
                  <option value="PRO">Call Assist</option>
                  <option value="ENTERPRISE">AI Conversations</option>
                </select>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">Status</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                  className="w-full px-4 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-blue-100 focus:border-blue-300 transition-all"
                >
                  <option value="">None</option>
                  <option value="ACTIVE">Active</option>
                  <option value="TRIALING">Trialing</option>
                  <option value="PAST_DUE">Past Due</option>
                  <option value="CANCELLED">Cancelled</option>
                  <option value="INCOMPLETE">Incomplete</option>
                </select>
              </div>
              <label className="flex items-center gap-3 py-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.hasOwnNumber}
                  onChange={(e) => setFormData({ ...formData, hasOwnNumber: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm font-medium text-slate-700">Has Own Number</span>
              </label>
              <button
                type="submit"
                disabled={updating}
                className="w-full px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {updating ? <Loader2 size={16} className="animate-spin" /> : null}
                {updating ? 'Updating...' : 'Update Subscription'}
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Tier</span>
                {user.subscriptionTier ? (
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${tierColor[user.subscriptionTier] || 'bg-slate-100 text-slate-600'}`}>
                    {tierLabel[user.subscriptionTier] || user.subscriptionTier}
                  </span>
                ) : (
                  <span className="text-sm text-slate-400">—</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Status</span>
                {user.subscriptionStatus ? (
                  <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${statusColor[user.subscriptionStatus] || 'bg-slate-100 text-slate-600'}`}>
                    {user.subscriptionStatus}
                  </span>
                ) : (
                  <span className="text-sm text-slate-400">—</span>
                )}
              </div>
              <div className="flex items-center justify-between gap-4 py-2 border-b border-slate-50">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Period End</span>
                <span className="text-sm text-slate-700">
                  {user.subscriptionPeriodEnd ? new Date(user.subscriptionPeriodEnd).toLocaleDateString() : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4 py-2">
                <span className="text-xs font-bold text-slate-400 uppercase tracking-widest">Own Number</span>
                <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase ${user.hasOwnNumber ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {user.hasOwnNumber ? 'Yes' : 'No'}
                </span>
              </div>

              {user.stripeSubscriptionId && user.subscriptionStatus !== 'CANCELLED' && (
                <div className="flex flex-wrap gap-2 pt-3 border-t border-slate-100">
                  <button
                    onClick={() => handleCancelSubscription(true)}
                    disabled={cancelling}
                    className="px-4 py-2 bg-red-50 text-red-600 rounded-xl text-xs font-semibold hover:bg-red-100 transition-all disabled:opacity-50"
                  >
                    {cancelling ? 'Cancelling...' : 'Cancel Immediately'}
                  </button>
                  <button
                    onClick={() => handleCancelSubscription(false)}
                    disabled={cancelling}
                    className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-xs font-semibold hover:bg-slate-200 transition-all disabled:opacity-50"
                  >
                    Cancel at Period End
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Activity Card */}
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-5 md:p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <Activity size={18} className="text-slate-400" />
            Activity
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-slate-900">{user.leadsCount}</p>
              <p className="text-xs text-slate-500 font-medium mt-1">Leads</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-4 text-center">
              <p className="text-2xl font-bold text-slate-900">{user.conversationsCount}</p>
              <p className="text-xs text-slate-500 font-medium mt-1">Conversations</p>
            </div>
          </div>
        </div>

        {/* Subscription History Card */}
        <div className="bg-white rounded-2xl md:rounded-3xl border border-slate-100 shadow-sm p-5 md:p-6">
          <h2 className="text-lg font-bold text-slate-900 mb-4 flex items-center gap-2">
            <Hash size={18} className="text-slate-400" />
            Subscription History
          </h2>
          {user.subscriptionHistory.length > 0 ? (
            <div className="space-y-2">
              {user.subscriptionHistory.map((history) => (
                <div key={history.id} className="flex items-center justify-between gap-3 p-3 bg-slate-50 rounded-xl">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-900">{history.eventType}</p>
                    <p className="text-xs text-slate-500">{new Date(history.createdAt).toLocaleString()}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${tierColor[history.tier] || 'bg-slate-100 text-slate-600'}`}>
                      {tierLabel[history.tier] || history.tier}
                    </span>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${statusColor[history.status] || 'bg-slate-100 text-slate-600'}`}>
                      {history.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-slate-400 text-center py-6">No subscription history</p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && user && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4" onClick={closeDeleteModal}>
          <div className="bg-white rounded-2xl md:rounded-3xl p-6 md:p-8 max-w-lg w-full shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-red-100 text-red-600 rounded-2xl flex items-center justify-center">
                  <AlertTriangle size={24} />
                </div>
                <h2 className="text-xl font-bold text-slate-900">Delete User</h2>
              </div>
              <button className="p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-all" onClick={closeDeleteModal}>
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <p className="text-sm text-slate-700 font-semibold">This action is permanent and cannot be undone.</p>
              <p className="text-sm text-slate-600">Deleting this user will permanently remove:</p>
              <ul className="text-sm text-slate-600 space-y-1 list-disc list-inside">
                <li>User account and profile</li>
                <li>All leads and conversations</li>
                <li>All message templates and automation rules</li>
                <li>Subscription and billing history</li>
              </ul>

              <div className="space-y-2 pt-2">
                <label className="text-xs font-bold text-slate-400 uppercase tracking-widest">
                  Type <span className="text-red-500 font-mono">{user.email}</span> to confirm
                </label>
                <input
                  type="text"
                  value={deleteConfirmEmail}
                  onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                  placeholder="Enter email to confirm"
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm focus:ring-2 focus:ring-red-100 focus:border-red-300 transition-all"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="flex items-center gap-3 mt-6">
              <button
                onClick={handleDeleteUser}
                disabled={deleteConfirmEmail !== user.email || deleting}
                className="flex-1 px-5 py-3 bg-red-600 text-white rounded-xl text-sm font-semibold hover:bg-red-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
              >
                {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                {deleting ? 'Deleting...' : 'Permanently Delete'}
              </button>
              <button
                onClick={closeDeleteModal}
                className="px-5 py-3 bg-slate-100 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-200 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
