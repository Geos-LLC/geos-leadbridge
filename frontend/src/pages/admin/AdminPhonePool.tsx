import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Phone, Search, Loader2, UserPlus, UserMinus, Trash2, RefreshCw, X, Link, Unlink, Download } from 'lucide-react';
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

  // Config
  const [tenantKeyConfigured, setTenantKeyConfigured] = useState<boolean | null>(null);

  // Connect provider form
  const [showConnect, setShowConnect] = useState(false);
  const [connectProvider, setConnectProvider] = useState<'openphone' | 'twilio'>('openphone');
  const [connectFields, setConnectFields] = useState({ apiKey: '', accountSid: '', authToken: '', phoneNumber: '' });
  const [connecting, setConnecting] = useState(false);

  // Sync
  const [syncing, setSyncing] = useState(false);

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
    loadConfig();
  }, [user, statusFilter, searchQuery]);

  const loadConfig = async () => {
    try {
      const config = await adminApi.getPoolConfig();
      setTenantKeyConfigured(config.configured);
    } catch {
      setTenantKeyConfigured(false);
    }
  };

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

  const handleConnect = async () => {
    try {
      setConnecting(true);
      const credentials = connectProvider === 'openphone'
        ? { apiKey: connectFields.apiKey }
        : { accountSid: connectFields.accountSid, authToken: connectFields.authToken, phoneNumber: connectFields.phoneNumber };

      const result = await adminApi.connectPoolProvider(connectProvider, credentials);
      if (result.success) {
        notify.success('Connected', `${connectProvider === 'openphone' ? 'OpenPhone' : 'Twilio'} connected successfully`);
        setShowConnect(false);
        setConnectFields({ apiKey: '', accountSid: '', authToken: '', phoneNumber: '' });
        // Auto-sync after connecting
        await handleSync();
      } else {
        notify.error('Connection Failed', result.error || 'Failed to connect provider');
      }
    } catch (error: any) {
      console.error('Failed to connect provider:', error);
      notify.error('Error', error.response?.data?.message || error.response?.data?.error || 'Failed to connect provider');
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async (provider: 'openphone' | 'twilio') => {
    if (!confirm(`Disconnect ${provider === 'openphone' ? 'OpenPhone' : 'Twilio'}? All pool numbers from this provider will be released.`)) return;
    try {
      const result = await adminApi.disconnectPoolProvider(provider);
      if (result.success) {
        notify.success('Disconnected', `${provider === 'openphone' ? 'OpenPhone' : 'Twilio'} disconnected`);
        loadData();
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
        const errors = result.data.results.flatMap((r: any) => r.errors);
        if (totalSynced > 0) {
          notify.success('Synced', `${totalSynced} number(s) synced to pool`);
        } else if (errors.length > 0) {
          notify.error('Sync Issues', errors.join('; '));
        } else {
          notify.success('Up to date', 'No new numbers to sync');
        }
        await loadData();
      }
    } catch (error: any) {
      console.error('Failed to sync:', error);
      notify.error('Error', error.response?.data?.message || 'Failed to sync numbers');
    } finally {
      setSyncing(false);
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
    if (!confirm(`Remove ${phoneNumber} from the pool?`)) return;
    try {
      await adminApi.releasePhone(phonePoolId);
      notify.success('Removed', 'Phone removed from pool');
      loadData();
    } catch (error: any) {
      notify.error('Error', error.response?.data?.message || 'Failed to remove phone');
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
        <p>Connect providers, sync numbers, and manage assignments</p>
      </div>

      {/* Tenant Key Warning */}
      {tenantKeyConfigured === false && (
        <div className="card" style={{ borderColor: 'var(--warning)', marginBottom: '1rem' }}>
          <div className="card-body" style={{ color: 'var(--warning)' }}>
            <strong>SIGCORE_API_KEY not configured.</strong> Set the <code>SIGCORE_API_KEY</code> environment variable to enable provider connections.
          </div>
        </div>
      )}

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
          <button
            className="btn btn-secondary"
            onClick={handleSync}
            disabled={syncing || tenantKeyConfigured === false}
            title="Sync numbers from connected providers"
          >
            {syncing ? <Loader2 size={16} className="spinner" /> : <Download size={16} />}
            Sync Numbers
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setShowConnect(true)}
            disabled={tenantKeyConfigured === false}
          >
            <Link size={16} />
            Connect Provider
          </button>
          <button
            className="btn btn-danger"
            onClick={() => handleDisconnect('openphone')}
            disabled={tenantKeyConfigured === false}
            title="Disconnect OpenPhone"
          >
            <Unlink size={16} />
            Disconnect OpenPhone
          </button>
          <button
            className="btn btn-danger"
            onClick={() => handleDisconnect('twilio')}
            disabled={tenantKeyConfigured === false}
            title="Disconnect Twilio"
          >
            <Unlink size={16} />
            Disconnect Twilio
          </button>
        </div>
      </div>

      {/* Connect Provider Form */}
      {showConnect && (
        <div className="provision-form card">
          <div className="card-header">
            <h3>Connect Provider</h3>
            <button className="btn-icon" onClick={() => setShowConnect(false)}>
              <X size={18} />
            </button>
          </div>
          <div className="card-body">
            {/* Provider Tabs */}
            <div className="provider-tabs" style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <button
                className={`btn btn-sm ${connectProvider === 'openphone' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setConnectProvider('openphone')}
              >
                OpenPhone
              </button>
              <button
                className={`btn btn-sm ${connectProvider === 'twilio' ? 'btn-primary' : 'btn-secondary'}`}
                onClick={() => setConnectProvider('twilio')}
              >
                Twilio
              </button>
            </div>

            {connectProvider === 'openphone' ? (
              <div className="form-group">
                <label>OpenPhone API Key</label>
                <input
                  type="password"
                  placeholder="Enter your OpenPhone API key"
                  value={connectFields.apiKey}
                  onChange={e => setConnectFields({ ...connectFields, apiKey: e.target.value })}
                />
              </div>
            ) : (
              <>
                <div className="form-group">
                  <label>Account SID</label>
                  <input
                    type="text"
                    placeholder="AC..."
                    value={connectFields.accountSid}
                    onChange={e => setConnectFields({ ...connectFields, accountSid: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Auth Token</label>
                  <input
                    type="password"
                    placeholder="Enter your Twilio auth token"
                    value={connectFields.authToken}
                    onChange={e => setConnectFields({ ...connectFields, authToken: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>Phone Number</label>
                  <input
                    type="text"
                    placeholder="+1234567890"
                    value={connectFields.phoneNumber}
                    onChange={e => setConnectFields({ ...connectFields, phoneNumber: e.target.value })}
                  />
                </div>
              </>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
              <button
                className="btn btn-primary"
                onClick={handleConnect}
                disabled={connecting || (connectProvider === 'openphone' ? !connectFields.apiKey : (!connectFields.accountSid || !connectFields.authToken))}
              >
                {connecting ? (
                  <><Loader2 size={16} className="spinner" /> Connecting...</>
                ) : (
                  <><Link size={16} /> Connect {connectProvider === 'openphone' ? 'OpenPhone' : 'Twilio'}</>
                )}
              </button>
              <button className="btn btn-secondary" onClick={() => setShowConnect(false)}>Cancel</button>
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
              <th>Added</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {phones.length === 0 ? (
              <tr>
                <td colSpan={7} className="empty-cell">
                  {loading ? 'Loading...' : 'No phone numbers in pool. Connect a provider and sync to get started.'}
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
                          title="Remove from pool"
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
