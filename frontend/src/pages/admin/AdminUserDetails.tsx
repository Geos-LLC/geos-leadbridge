import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { AlertTriangle, X } from 'lucide-react';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { AdminUserDetails } from '../../types';

export default function AdminUserDetailsPage() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const currentUser = useAuthStore((state) => state.user);
  const [user, setUser] = useState<AdminUserDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);

  // Delete confirmation modal state
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmEmail, setDeleteConfirmEmail] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Edit form state
  const [editMode, setEditMode] = useState(false);
  const [formData, setFormData] = useState({
    tier: '',
    status: '',
    hasOwnNumber: false,
  });

  useEffect(() => {
    if (currentUser?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }

    if (userId) {
      loadUser();
    }
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

  if (loading || !user) {
    return (
      <div className="admin-user-details">
        <div className="loading-state">
          <p>Loading user details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-user-details">
      <div className="page-header">
        <div>
          <Link to="/admin" className="back-link">
            ← Back to Admin Dashboard
          </Link>
          <h1>User Details</h1>
        </div>
        <button onClick={openDeleteModal} className="btn-danger">
          Delete User
        </button>
      </div>

      <div className="details-grid">
        <div className="details-card">
          <h2>User Information</h2>
          <div className="details-row">
            <span className="label">Email:</span>
            <span className="value">{user.email}</span>
          </div>
          <div className="details-row">
            <span className="label">Name:</span>
            <span className="value">{user.name || '—'}</span>
          </div>
          <div className="details-row">
            <span className="label">Role:</span>
            <span className="value">
              <span className={`role-badge role-${user.role.toLowerCase()}`}>{user.role}</span>
            </span>
          </div>
          <div className="details-row">
            <span className="label">Created:</span>
            <span className="value">{new Date(user.createdAt).toLocaleString()}</span>
          </div>
          <div className="details-row">
            <span className="label">Updated:</span>
            <span className="value">{new Date(user.updatedAt).toLocaleString()}</span>
          </div>
        </div>

        <div className="details-card">
          <div className="card-header">
            <h2>Subscription</h2>
            {!editMode ? (
              <button onClick={() => setEditMode(true)} className="btn-secondary">
                Edit
              </button>
            ) : (
              <button onClick={() => setEditMode(false)} className="btn-secondary">
                Cancel
              </button>
            )}
          </div>

          {editMode ? (
            <form onSubmit={handleUpdateSubscription} className="subscription-form">
              <div className="form-group">
                <label>Subscription Tier:</label>
                <select
                  value={formData.tier}
                  onChange={(e) => setFormData({ ...formData, tier: e.target.value })}
                >
                  <option value="">No Subscription</option>
                  <option value="STARTER">Instant Reply</option>
                  <option value="PRO">Call Assist</option>
                  <option value="ENTERPRISE">AI Conversations</option>
                </select>
              </div>

              <div className="form-group">
                <label>Status:</label>
                <select
                  value={formData.status}
                  onChange={(e) => setFormData({ ...formData, status: e.target.value })}
                >
                  <option value="">None</option>
                  <option value="ACTIVE">Active</option>
                  <option value="TRIALING">Trialing</option>
                  <option value="PAST_DUE">Past Due</option>
                  <option value="CANCELLED">Cancelled</option>
                  <option value="INCOMPLETE">Incomplete</option>
                </select>
              </div>

              <div className="form-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={formData.hasOwnNumber}
                    onChange={(e) => setFormData({ ...formData, hasOwnNumber: e.target.checked })}
                  />
                  Has Own Number
                </label>
              </div>

              <button type="submit" disabled={updating} className="btn-primary">
                {updating ? 'Updating...' : 'Update Subscription'}
              </button>
            </form>
          ) : (
            <>
              <div className="details-row">
                <span className="label">Tier:</span>
                <span className="value">
                  {user.subscriptionTier ? (
                    <span className={`tier-badge tier-${user.subscriptionTier.toLowerCase()}`}>
                      {user.subscriptionTier}
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              <div className="details-row">
                <span className="label">Status:</span>
                <span className="value">
                  {user.subscriptionStatus ? (
                    <span className={`status-badge status-${user.subscriptionStatus.toLowerCase()}`}>
                      {user.subscriptionStatus}
                    </span>
                  ) : (
                    '—'
                  )}
                </span>
              </div>
              <div className="details-row">
                <span className="label">Period End:</span>
                <span className="value">
                  {user.subscriptionPeriodEnd
                    ? new Date(user.subscriptionPeriodEnd).toLocaleDateString()
                    : '—'}
                </span>
              </div>
              <div className="details-row">
                <span className="label">Own Number:</span>
                <span className="value">{user.hasOwnNumber ? 'Yes' : 'No'}</span>
              </div>
            </>
          )}
        </div>

        <div className="details-card">
          <h2>Activity</h2>
          <div className="details-row">
            <span className="label">Leads:</span>
            <span className="value">{user.leadsCount}</span>
          </div>
          <div className="details-row">
            <span className="label">Conversations:</span>
            <span className="value">{user.conversationsCount}</span>
          </div>
        </div>

        <div className="details-card full-width">
          <h2>Subscription History</h2>
          {user.subscriptionHistory.length > 0 ? (
            <table className="history-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Event</th>
                  <th>Tier</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {user.subscriptionHistory.map((history) => (
                  <tr key={history.id}>
                    <td>{new Date(history.createdAt).toLocaleString()}</td>
                    <td>{history.eventType}</td>
                    <td>
                      <span className={`tier-badge tier-${history.tier.toLowerCase()}`}>
                        {history.tier}
                      </span>
                    </td>
                    <td>
                      <span className={`status-badge status-${history.status.toLowerCase()}`}>
                        {history.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="empty-message">No subscription history</p>
          )}
        </div>
      </div>

      {/* Delete Confirmation Modal */}
      {showDeleteModal && user && (
        <div className="modal-overlay" onClick={closeDeleteModal}>
          <div className="modal delete-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={closeDeleteModal}>
              <X size={20} />
            </button>

            <div className="delete-warning-header">
              <AlertTriangle size={48} className="warning-icon" />
              <h2>Delete User Account</h2>
            </div>

            <div className="delete-warning-content">
              <p className="warning-text">
                <strong>This action is permanent and cannot be undone.</strong>
              </p>
              <p>Deleting this user will permanently remove:</p>
              <ul className="delete-consequences">
                <li>User account and profile</li>
                <li>All leads and conversations</li>
                <li>All message templates</li>
                <li>All automation rules</li>
                <li>Subscription and billing history</li>
              </ul>

              <div className="confirm-email-section">
                <label>
                  To confirm, type the user's email address:
                  <strong> {user.email}</strong>
                </label>
                <input
                  type="text"
                  value={deleteConfirmEmail}
                  onChange={(e) => setDeleteConfirmEmail(e.target.value)}
                  placeholder="Enter email to confirm"
                  className="confirm-email-input"
                  autoComplete="off"
                />
              </div>
            </div>

            <div className="modal-actions">
              <button onClick={closeDeleteModal} className="btn-secondary">
                Cancel
              </button>
              <button
                onClick={handleDeleteUser}
                disabled={deleteConfirmEmail !== user.email || deleting}
                className="btn-danger-solid"
              >
                {deleting ? 'Deleting...' : 'Permanently Delete User'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
