import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Plus, Search, Loader2, UserPlus, UserMinus, Trash2, RefreshCw, X } from 'lucide-react';
import { adminApi } from '../../services/api';
import { notify } from '../../store/notificationStore';
import { useAuthStore } from '../../store/authStore';
import type { PhonePoolEntry, PhonePoolStats } from '../../types';

export default function AdminPhonePool() {
  const user = useAuthStore((state) => state.user);
  const navigate = useNavigate();

  const [stats, setStats] = useState<PhonePoolStats | null>(null);
  const [phones, setPhones] = useState<PhonePoolEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  // Provision form
  const [showProvision, setShowProvision] = useState(false);
  const [provisionAreaCode, setProvisionAreaCode] = useState('');
  const [provisioning, setProvisioning] = useState(false);

  // Assign modal
  const [assigningPhoneId, setAssigningPhoneId] = useState<string | null>(null);
  const [userSearch, setUserSearch] = useState('');
  const [userResults, setUserResults] = useState<{ id: string; email: string; name: string | null }[]>([]);
  const [searchingUsers, setSearchingUsers] = useState(false);

  useEffect(() => {
    if (user?.role !== 'ADMIN') {
      notify.error('Access Denied', 'You must be an admin to access this page');
      navigate('/');
      return;
    }
    loadData();
  }, [user, statusFilter, searchQuery]);

  const loadData = async () => {
    try {
      setLoading(true);
      const [statsData, poolData] = await Promise.all([
        adminApi.getPhonePoolStats(),
        adminApi.getPhonePool({ status: statusFilter || undefined, search: searchQuery || undefined, limit: 100 }),
      ]);
      setStats(statsData);
      setPhones(poolData.phones);
      setTotal(poolData.total);
    } catch (error: any) {
      console.error('Failed to load phone pool data:', error);
      notify.error('Error', 'Failed to load phone pool');
    } finally {
      setLoading(false);
    }
  };

  const handleProvision = async () => {
    try {
      setProvisioning(true);
      await adminApi.provisionToPool({ areaCode: provisionAreaCode || undefined });
      notify.success('Provisioned', 'Phone number added to pool');
      setShowProvision(false);
      setProvisionAreaCode('');
      loadData();
    } catch (error: any) {
      console.error('Failed to provision:', error);
      notify.error('Error', error.response?.data?.message || 'Failed to provision phone number');
    } finally {
      setProvisioning(false);
    }
  };

  const searchUsers = useCallback(async (query: string) => {
    if (!query.trim()) {
      setUserResults([]);
      return;
    }
    try {
      setSearchingUsers(true);
      const result = await adminApi.getPhonePoolUsers(query);
      setUserResults(result.data);
    } catch (error) {
      console.error('Failed to search users:', error);
    } finally {
      setSearchingUsers(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (assigningPhoneId) {
        searchUsers(userSearch);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [userSearch, assigningPhoneId, searchUsers]);

  const handleAssign = async (phonePoolId: string, userId: string) => {
    try {
      await adminApi.assignPhone(phonePoolId, userId);
      notify.success('Assigned', 'Phone assigned to user');
      setAssigningPhoneId(null);
      setUserSearch('');
      setUserResults([]);
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to assign phone');
    }
  };

  const handleUnassign = async (phonePoolId: string) => {
    if (!confirm('Unassign this phone from the user?')) return;
    try {
      await adminApi.unassignPhone(phonePoolId);
      notify.success('Unassigned', 'Phone unassigned from user');
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to unassign phone');
    }
  };

  const handleRelease = async (phonePoolId: string, phoneNumber: string) => {
    if (!confirm(`Release ${phoneNumber} from the pool? This will release it back to the carrier.`)) return;
    try {
      await adminApi.releasePhone(phonePoolId);
      notify.success('Released', 'Phone released from pool');
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to release phone');
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'AVAILABLE': return 'badge-success';
      case 'ASSIGNED': return 'badge-primary';
      case 'RESERVED': return 'badge-warning';
      case 'RELEASED': return 'badge-secondary';
      default: return 'badge-secondary';
    }
  };

  if (loading && !stats) {
    return (
      <div className="admin-dashboard">
        <div className="admin-header">
          <h1><Phone size={24} /> Phone Pool</h1>
        </div>
        <div className="loading-state">
          <p>Loading phone pool...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-dashboard">
      <div className="admin-header">
        <h1><Phone size={24} /> Phone Pool</h1>
        <p>Manage provisioned phone numbers and assignments</p>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="stats-grid">
          <div className="stat-card">
            <div className="stat-value">{stats.total}</div>
            <div className="stat-label">Total Numbers</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--success)' }}>{stats.available}</div>
            <div className="stat-label">Available</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--primary)' }}>{stats.assigned}</div>
            <div className="stat-label">Assigned</div>
          </div>
          <div className="stat-card">
            <div className="stat-value" style={{ color: 'var(--warning)' }}>{stats.reserved}</div>
            <div className="stat-label">Reserved</div>
          </div>
        </div>
      )}

      {/* Actions Bar */}
      <div className="admin-toolbar">
        <div className="toolbar-left">
          <div className="search-box">
            <Search size={16} />
            <input
              type="text"
              placeholder="Search phone numbers..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="filter-select"
          >
            <option value="">All Status</option>
            <option value="AVAILABLE">Available</option>
            <option value="ASSIGNED">Assigned</option>
            <option value="RESERVED">Reserved</option>
            <option value="RELEASED">Released</option>
          </select>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-secondary" onClick={loadData} title="Refresh">
            <RefreshCw size={16} />
          </button>
          <button className="btn btn-primary" onClick={() => setShowProvision(true)}>
            <Plus size={16} />
            Provision Number
          </button>
        </div>
      </div>

      {/* Provision Form */}
      {showProvision && (
        <div className="provision-form card">
          <div className="card-header">
            <h3>Provision New Number</h3>
            <button className="btn-icon" onClick={() => setShowProvision(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="card-body">
            <div className="form-row">
              <div className="form-group">
                <label>Area Code (optional)</label>
                <input
                  type="text"
                  placeholder="e.g. 813"
                  value={provisionAreaCode}
                  onChange={e => setProvisionAreaCode(e.target.value)}
                  maxLength={3}
                />
              </div>
              <button
                className="btn btn-primary"
                onClick={handleProvision}
                disabled={provisioning}
              >
                {provisioning ? (
                  <><Loader2 size={16} className="spinner" /> Provisioning...</>
                ) : (
                  <><Plus size={16} /> Provision</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Phone Pool Table */}
      <div className="admin-table-container">
        <table className="admin-table">
          <thead>
            <tr>
              <th>Phone Number</th>
              <th>Area Code</th>
              <th>Provider</th>
              <th>Status</th>
              <th>Assigned To</th>
              <th>Provisioned</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {phones.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {loading ? 'Loading...' : 'No phone numbers in pool. Provision one to get started.'}
                </td>
              </tr>
            ) : (
              phones.map(phone => (
                <tr key={phone.id}>
                  <td className="font-mono">{phone.phoneNumber}</td>
                  <td>{phone.areaCode || '-'}</td>
                  <td><span className="provider-badge">{phone.provider}</span></td>
                  <td>
                    <span className={`status-badge ${getStatusBadgeClass(phone.status)}`}>
                      {phone.status}
                    </span>
                  </td>
                  <td>
                    {phone.assignedToUser ? (
                      <span className="assigned-user">
                        {phone.assignedToUser.email}
                        {phone.assignedToUser.name && ` (${phone.assignedToUser.name})`}
                      </span>
                    ) : '-'}
                  </td>
                  <td>{new Date(phone.provisionedAt).toLocaleDateString()}</td>
                  <td>
                    <div className="action-buttons">
                      {phone.status === 'AVAILABLE' && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => {
                            setAssigningPhoneId(phone.id);
                            setUserSearch('');
                            setUserResults([]);
                          }}
                          title="Assign to user"
                        >
                          <UserPlus size={14} />
                        </button>
                      )}
                      {phone.status === 'ASSIGNED' && (
                        <button
                          className="btn btn-sm btn-secondary"
                          onClick={() => handleUnassign(phone.id)}
                          title="Unassign from user"
                        >
                          <UserMinus size={14} />
                        </button>
                      )}
                      {(phone.status === 'AVAILABLE' || phone.status === 'ASSIGNED') && (
                        <button
                          className="btn btn-sm btn-danger"
                          onClick={() => handleRelease(phone.id, phone.phoneNumber)}
                          title="Release from pool"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
        {total > 0 && (
          <div className="table-footer">
            Showing {phones.length} of {total} numbers
          </div>
        )}
      </div>

      {/* Assign Modal */}
      {assigningPhoneId && (
        <div className="modal-overlay" onClick={() => setAssigningPhoneId(null)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Assign Phone to User</h3>
              <button className="btn-icon" onClick={() => setAssigningPhoneId(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Search Users</label>
                <div className="search-box">
                  <Search size={16} />
                  <input
                    type="text"
                    placeholder="Search by email or name..."
                    value={userSearch}
                    onChange={e => setUserSearch(e.target.value)}
                    autoFocus
                  />
                </div>
              </div>
              <div className="user-results">
                {searchingUsers ? (
                  <div className="loading-state"><Loader2 size={20} className="spinner" /></div>
                ) : userResults.length > 0 ? (
                  userResults.map(u => (
                    <button
                      key={u.id}
                      className="user-result-item"
                      onClick={() => handleAssign(assigningPhoneId, u.id)}
                    >
                      <div className="user-result-info">
                        <span className="user-result-email">{u.email}</span>
                        {u.name && <span className="user-result-name">{u.name}</span>}
                      </div>
                      <UserPlus size={16} />
                    </button>
                  ))
                ) : userSearch.trim() ? (
                  <p className="no-results">No users found</p>
                ) : (
                  <p className="no-results">Type to search for users</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
