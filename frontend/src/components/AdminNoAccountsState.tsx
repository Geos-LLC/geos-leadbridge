import { Users, Eye, Plus } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

interface AdminNoAccountsStateProps {
  onConnectAccount?: () => void;
}

/**
 * Empty state shown to admin users who have no connected Thumbtack accounts.
 * Offers options to impersonate a tenant or connect their own account.
 */
export default function AdminNoAccountsState({ onConnectAccount }: AdminNoAccountsStateProps) {
  const navigate = useNavigate();

  return (
    <div className="max-w-lg mx-auto mt-12">
      <div className="bg-white rounded-3xl border border-slate-100 shadow-sm p-10 text-center">
        <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Users className="w-8 h-8 text-slate-400" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Connected Accounts</h3>
        <p className="text-slate-500 mb-8 leading-relaxed">
          Select a tenant from the Admin Dashboard to view their data, or connect your own Thumbtack account.
        </p>
        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={() => navigate('/admin')}
            className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2"
          >
            <Eye className="w-4 h-4" />
            Admin Dashboard
          </button>
          {onConnectAccount && (
            <button
              onClick={onConnectAccount}
              className="w-full sm:w-auto px-6 py-3 bg-slate-100 text-slate-700 rounded-xl font-semibold hover:bg-slate-200 transition-all flex items-center justify-center gap-2"
            >
              <Plus className="w-4 h-4" />
              Connect Account
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
