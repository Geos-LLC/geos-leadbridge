import { useState, useEffect } from 'react';
import { Phone, Loader2, X, ChevronDown, AlertCircle, PhoneCall, Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { usersApi, thumbtackApi } from '../services/api';
import type { SavedAccount, PhonePoolEntry } from '../types';
import { useAppStore } from '../store/appStore';

export function PhoneSettings() {
  const navigate = useNavigate();
  const setSavedAccounts = useAppStore(state => state.setSavedAccounts);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Pool phone state
  const [poolPhones, setPoolPhones] = useState<PhonePoolEntry[]>([]);
  const [loadingPoolPhone, setLoadingPoolPhone] = useState(true);

  useEffect(() => {
    loadAccounts();
    loadPoolPhone();
  }, []);

  async function loadPoolPhone() {
    try {
      setLoadingPoolPhone(true);
      const result = await usersApi.getMyPoolPhone();
      setPoolPhones(result.poolPhones || (result.poolPhone ? [result.poolPhone] : []));
    } catch (err) {
      console.error('Failed to load pool phone:', err);
    } finally {
      setLoadingPoolPhone(false);
    }
  }

  async function loadAccounts() {
    try {
      setLoading(true);
      const { accounts } = await thumbtackApi.getSavedAccounts();
      setAccounts(accounts);
      setSavedAccounts(accounts); // Update global app store
      if (accounts.length > 0) {
        setSelectedAccountId(accounts[0].id);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to load accounts');
    } finally {
      setLoading(false);
    }
  }

  if (loading && accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Phone className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Business Line</h1>
        </div>
        <div className="flex flex-col items-center justify-center py-20">
          <Loader2 size={32} className="animate-spin text-blue-600" />
          <p className="mt-4 text-slate-500">Loading...</p>
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="p-6 lg:p-10">
        <div className="flex items-center gap-3 mb-6">
          <Phone className="w-6 h-6 text-blue-600" />
          <h1 className="text-2xl font-bold text-slate-900">Business Line</h1>
        </div>
        <div className="max-w-md mx-auto bg-white rounded-3xl border border-slate-100 shadow-sm p-10 text-center mt-10">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-xl font-bold text-slate-900 mb-2">No Accounts Connected</h3>
          <p className="text-slate-500 mb-6">You need to connect an account first.</p>
          <button
            className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
            onClick={() => navigate('/dashboard')}
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-10 max-w-5xl mx-auto space-y-10">
      {error && (
        <div className="bg-red-50 border border-red-100 rounded-2xl p-4 flex items-center gap-3 text-red-600 text-sm font-medium">
          <AlertCircle size={16} className="shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="p-1 hover:bg-red-100 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      )}

      {/* Welcome Section */}
      <section className="flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <p className="text-blue-600 font-semibold mb-1 uppercase tracking-wider text-xs">Communication Hub</p>
          <h2 className="text-3xl lg:text-4xl font-extrabold text-slate-900 tracking-tight">
            Business <span className="gradient-text">Line.</span>
          </h2>
          <p className="text-slate-500 mt-2 text-lg">Manage phone numbers for SMS notifications and customer communication.</p>
        </div>
      </section>

      {/* Account Selector */}
      <div className="bg-white p-6 rounded-3xl border border-slate-100 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-1">Select Account</h2>
          <p className="text-slate-600 text-sm">View phone numbers for your business profile.</p>
        </div>
        <div className="relative min-w-[240px]">
          <select
            value={selectedAccountId}
            onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full bg-slate-50 border border-slate-200 text-slate-900 text-sm rounded-xl focus:ring-blue-500 focus:border-blue-500 block p-3 appearance-none font-semibold"
          >
            {accounts.map(acc => (
              <option key={acc.id} value={acc.id}>
                {acc.businessName}
              </option>
            ))}
          </select>
          <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none text-slate-400">
            <ChevronDown className="w-4 h-4" />
          </div>
        </div>
      </div>

      {/* Options Info */}
      <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 text-blue-700 text-sm">
        <p className="font-medium">
          You have two options for sending SMS: use a phone number assigned by your administrator, or connect your own provider (coming soon).
        </p>
      </div>

      {/* Option 1: Admin-Assigned Phone */}
      <section className="space-y-6">
        <div className="flex items-center gap-3 px-2">
          <PhoneCall className="w-5 h-5 text-blue-600" />
          <h3 className="text-xl font-bold text-slate-900">Option 1: Admin-Assigned Phone</h3>
        </div>

        {loadingPoolPhone ? (
          <div className="flex justify-center py-10">
            <Loader2 size={24} className="animate-spin text-blue-600" />
          </div>
        ) : poolPhones.length > 0 ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {poolPhones.map(phone => (
                <div key={phone.id} className="bg-white rounded-2xl border border-slate-100 shadow-sm p-6 hover:border-blue-200 transition-all">
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-10 h-10 bg-emerald-50 text-emerald-600 rounded-xl flex items-center justify-center">
                      <Phone className="w-5 h-5" />
                    </div>
                    <div className="flex-1">
                      <div className="font-bold text-slate-900 text-sm">{phone.phoneNumber}</div>
                      <div className="text-xs text-slate-400">{phone.areaCode ? `Area: ${phone.areaCode}` : 'LeadBridge Pool'}</div>
                    </div>
                  </div>
                  {phone.friendlyName && (
                    <div className="text-xs text-slate-500 mt-2">{phone.friendlyName}</div>
                  )}
                  <div className="mt-3 pt-3 border-t border-slate-100">
                    <span className="px-2 py-1 bg-blue-50 text-blue-600 text-[10px] font-bold rounded uppercase">LeadBridge</span>
                  </div>
                </div>
              ))}
            </div>
            <div className="bg-slate-50 rounded-2xl p-4 text-sm text-slate-600">
              <p>✓ Assigned by administrator • Used as default sender for SMS alerts</p>
            </div>
          </div>
        ) : (
          <div className="bg-slate-50 border-2 border-dashed border-slate-200 rounded-3xl p-10 text-center">
            <Building2 className="w-12 h-12 text-slate-300 mx-auto mb-4" />
            <h3 className="text-lg font-bold text-slate-600 mb-2">No Phone Assigned</h3>
            <p className="text-slate-500 max-w-md mx-auto">
              Your administrator can assign a phone number from the pool to enable SMS functionality.
            </p>
          </div>
        )}
      </section>

      {/* Option 2: Connect Your Own Provider - Coming Soon */}
      <section className="space-y-6 opacity-60">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-3">
            <Phone className="w-5 h-5 text-slate-400" />
            <h3 className="text-xl font-bold text-slate-400">Option 2: Connect Your Own Provider</h3>
          </div>
          <div className="flex items-center gap-3">
            <span className="px-2 py-1 bg-slate-200 text-slate-500 text-[10px] font-bold rounded uppercase">Coming Soon</span>
            <div className="w-14 h-7 bg-slate-100 rounded-full cursor-not-allowed"></div>
          </div>
        </div>

        <div className="bg-slate-50/50 rounded-2xl p-6 border border-slate-100">
          <p className="text-slate-500 text-sm">
            Connect your own OpenPhone or Twilio account to use your own phone numbers for SMS notifications and customer communication.
          </p>
        </div>
      </section>
    </div>
  );
}
