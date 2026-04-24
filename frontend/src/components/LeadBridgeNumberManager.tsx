import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Trash2, RefreshCw, Phone, AlertCircle, Clock, Hash, X, Lock } from 'lucide-react';
import { notificationsApi } from '../services/api';
import type { TenantPhoneNumber } from '../services/api';
import type { SavedAccount, AvailablePhoneNumber } from '../types';

interface Props {
  accounts: SavedAccount[];
  canPurchase: boolean; // true for PRO/ENTERPRISE, false for STARTER/no plan
  onError?: (msg: string) => void;
  onSuccess?: (msg: string) => void;
}

export function LeadBridgeNumberManager({ accounts, canPurchase, onError, onSuccess }: Props) {
  const [tenantPhones, setTenantPhones] = useState<TenantPhoneNumber[]>([]);
  const [loading, setLoading] = useState(true);
  const [phonePrice, setPhonePrice] = useState<number | null>(null);
  const [gracePeriodDays, setGracePeriodDays] = useState(30);

  const [showBuyModal, setShowBuyModal] = useState(false);
  const [buyAccountId, setBuyAccountId] = useState<string>('');
  const [dpAreaCode, setDpAreaCode] = useState('');
  const [dpLocality, setDpLocality] = useState('');
  const [dpSearchLoading, setDpSearchLoading] = useState(false);
  const [dpAvailableNumbers, setDpAvailableNumbers] = useState<AvailablePhoneNumber[]>([]);
  const [dpPurchasingNumber, setDpPurchasingNumber] = useState<string | null>(null);
  const [dpSearchError, setDpSearchError] = useState<string | null>(null);
  const [dpSmsConsent, setDpSmsConsent] = useState(false);

  const [releasingPhoneId, setReleasingPhoneId] = useState<string | null>(null);
  const [restoringPhoneId, setRestoringPhoneId] = useState<string | null>(null);
  const [assigningPhoneId, setAssigningPhoneId] = useState<string | null>(null);
  const [releaseConfirmPhone, setReleaseConfirmPhone] = useState<TenantPhoneNumber | null>(null);

  async function loadPhones() {
    const result = await notificationsApi.listTenantPhones();
    if (result.success) {
      const visible = result.data
        .filter(tp => tp.status === 'ACTIVE' || tp.status === 'GRACE_PERIOD')
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'ACTIVE' ? -1 : 1));
      setTenantPhones(visible);
    }
  }

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        await loadPhones();
      } catch { /* still render the empty state */ }
      try {
        const r = await notificationsApi.getPhonePricing();
        if (r.success) {
          setPhonePrice(r.data.priceMonthly);
          setGracePeriodDays(r.data.gracePeriodDays ?? 30);
        }
      } catch { /* ignore */ }
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    if (buyAccountId === '' && accounts.length > 0) {
      setBuyAccountId(accounts[0].id);
    }
  }, [accounts, buyAccountId]);

  function openBuyModal() {
    setShowBuyModal(true);
    setDpAreaCode('');
    setDpLocality('');
    setDpAvailableNumbers([]);
    setDpSearchError(null);
  }

  async function handleSearch() {
    if (!buyAccountId) return;
    setDpSearchLoading(true);
    setDpSearchError(null);
    try {
      const result = await notificationsApi.searchAvailableNumbers(buyAccountId, 'US', dpAreaCode || undefined, dpLocality || undefined);
      if (result.success) {
        setDpAvailableNumbers(result.data);
      } else {
        setDpSearchError('Search failed — try a different area code or city');
      }
    } catch (err: any) {
      setDpSearchError(err.response?.data?.message || err.message || 'Search failed');
    } finally {
      setDpSearchLoading(false);
    }
  }

  async function handlePurchase(phoneNumber: string) {
    if (!buyAccountId || !dpSmsConsent) return;
    setDpPurchasingNumber(phoneNumber);
    setDpSearchError(null);
    try {
      const result = await notificationsApi.purchaseTenantPhone(buyAccountId, phoneNumber);
      if (result.success) {
        await loadPhones();
        setShowBuyModal(false);
        setDpAvailableNumbers([]);
        setDpAreaCode('');
        setDpLocality('');
        onSuccess?.('LeadBridge number provisioned successfully');
      } else {
        setDpSearchError((result as any).error || 'Purchase failed');
      }
    } catch (err: any) {
      setDpSearchError(err.response?.data?.message || err.message || 'Purchase failed');
    } finally {
      setDpPurchasingNumber(null);
    }
  }

  async function handleRelease(phoneId: string) {
    setReleasingPhoneId(phoneId);
    try {
      const result = await notificationsApi.cancelTenantPhone(phoneId);
      if (result.success) {
        await loadPhones();
        setReleaseConfirmPhone(null);
        onSuccess?.('Number scheduled for release');
      } else {
        onError?.(result.error || 'Failed to release number');
      }
    } catch (err: any) {
      onError?.(err.response?.data?.message || err.message || 'Failed to release number');
    } finally {
      setReleasingPhoneId(null);
    }
  }

  async function handleRestore(phoneId: string) {
    setRestoringPhoneId(phoneId);
    try {
      const result = await notificationsApi.restoreTenantPhone(phoneId);
      if (result.success) {
        await loadPhones();
        onSuccess?.('Number restored');
      } else {
        onError?.(result.error || 'Failed to restore number');
      }
    } catch (err: any) {
      onError?.(err.response?.data?.message || err.message || 'Failed to restore number');
    } finally {
      setRestoringPhoneId(null);
    }
  }

  async function handleAssign(phoneId: string, savedAccountId: string | null) {
    setAssigningPhoneId(phoneId);
    try {
      const result = await notificationsApi.assignTenantPhone(phoneId, savedAccountId);
      if (result.success) {
        await loadPhones();
        onSuccess?.('Assignment updated · only affects new conversations');
      } else {
        onError?.(result.error || 'Failed to reassign');
      }
    } catch (err: any) {
      onError?.(err.response?.data?.message || err.message || 'Failed to reassign');
    } finally {
      setAssigningPhoneId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-5 h-5 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {tenantPhones.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 p-5 text-center">
          <Phone className="w-6 h-6 text-slate-400 mx-auto mb-2" />
          <p className="text-sm font-semibold text-slate-700">No LeadBridge Numbers yet</p>
          <p className="text-xs text-slate-500 mt-1">Your first number is included with Engage and Convert.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {tenantPhones.map(phone => {
            const isGrace = phone.status === 'GRACE_PERIOD';
            const isReleasing = releasingPhoneId === phone.id;
            const isRestoring = restoringPhoneId === phone.id;
            const isAssigning = assigningPhoneId === phone.id;
            let daysLeft: number | null = null;
            if (isGrace && phone.gracePeriodEndsAt) {
              const diffMs = new Date(phone.gracePeriodEndsAt).getTime() - Date.now();
              daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
            }
            return (
              <div
                key={phone.id}
                className={`rounded-xl border p-3 ${
                  isGrace ? 'border-amber-200 bg-amber-50/40' : 'border-blue-200 bg-blue-50/30'
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[180px]">
                    <div className={`font-mono text-sm font-semibold ${isGrace ? 'text-amber-800' : 'text-blue-700'}`}>
                      {phone.phoneNumber}
                      {phone.friendlyName && phone.friendlyName !== phone.phoneNumber && (
                        <span className="ml-2 text-xs font-normal text-slate-500">— {phone.friendlyName}</span>
                      )}
                    </div>
                    {isGrace && (
                      <div className="mt-1 flex items-center gap-1 text-[11px] text-amber-700">
                        <Clock size={11} />
                        Releases in {daysLeft} day{daysLeft === 1 ? '' : 's'} · billing already stopped
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="text-[11px] text-slate-500 whitespace-nowrap">Assigned to:</label>
                    <select
                      value={phone.savedAccountId || ''}
                      onChange={e => handleAssign(phone.id, e.target.value || null)}
                      disabled={isGrace || isAssigning}
                      className="px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 disabled:bg-slate-50 disabled:text-slate-400 max-w-[180px]"
                    >
                      <option value="">Unassigned (shared)</option>
                      {accounts.map(acc => (
                        <option key={acc.id} value={acc.id}>
                          {acc.platform === 'yelp' ? '🔴 ' : '🔵 '}{acc.businessName}
                        </option>
                      ))}
                    </select>
                    {isGrace ? (
                      <button
                        onClick={() => handleRestore(phone.id)}
                        disabled={isRestoring}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {isRestoring ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                        {isRestoring ? 'Restoring…' : 'Restore'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setReleaseConfirmPhone(phone)}
                        disabled={isReleasing}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-red-600 bg-red-50 border border-red-100 rounded-lg hover:bg-red-100 disabled:opacity-50 transition-colors whitespace-nowrap"
                      >
                        {isReleasing ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        {isReleasing ? 'Releasing…' : 'Release'}
                      </button>
                    )}
                  </div>
                </div>
                {isAssigning && (
                  <div className="mt-2 text-[11px] text-slate-500 flex items-center gap-1">
                    <Loader2 size={10} className="animate-spin" /> Updating assignment…
                  </div>
                )}
              </div>
            );
          })}
          <p className="text-[11px] text-slate-400 flex items-center gap-1 pl-1">
            <AlertCircle size={11} /> Changing assignment only affects new conversations.
          </p>
        </div>
      )}

      {canPurchase ? (
        <button
          onClick={openBuyModal}
          disabled={accounts.length === 0}
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-blue-700 bg-blue-50 border border-dashed border-blue-300 rounded-xl hover:bg-blue-100 disabled:opacity-50 transition-colors"
        >
          <Phone size={12} />
          {tenantPhones.length === 0 ? 'Get your LeadBridge Number' : '+ Buy another number'}
          {phonePrice != null && tenantPhones.length > 0 && ` — $${phonePrice.toFixed(0)}/mo`}
        </button>
      ) : (
        <Link
          to="/pricing"
          className="w-full flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold text-slate-600 bg-slate-50 border border-dashed border-slate-300 rounded-xl hover:bg-slate-100 transition-colors"
        >
          <Lock size={12} />
          Upgrade to Engage to buy a LeadBridge Number
        </Link>
      )}

      {/* Buy modal */}
      {showBuyModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setShowBuyModal(false)}>
          <div className="bg-white rounded-3xl shadow-2xl max-w-xl w-full p-8 relative" onClick={e => e.stopPropagation()}>
            <button onClick={() => setShowBuyModal(false)} className="absolute top-5 right-5 text-slate-400 hover:text-slate-600 transition-colors">
              <X className="w-5 h-5" />
            </button>
            <h3 className="text-xl font-bold text-slate-900 mb-2">
              {tenantPhones.length > 0 ? 'Buy another LeadBridge Number' : 'Get your LeadBridge Number'}
            </h3>
            <p className="text-sm text-slate-500 mb-4 leading-relaxed">
              {tenantPhones.length > 0
                ? 'Additional numbers are useful for separate communication per business or multi-location setup.'
                : 'Search for an available number by area code or city, then pick it for your account.'}
            </p>
            <div className={`rounded-xl p-3 mb-4 text-xs leading-relaxed ${tenantPhones.length > 0 ? 'bg-blue-50/60 border border-blue-100 text-blue-800' : 'bg-emerald-50/60 border border-emerald-100 text-emerald-800'}`}>
              {tenantPhones.length > 0
                ? (<><span className="font-semibold">${phonePrice != null ? phonePrice.toFixed(0) : '—'}/mo</span> add-on, billed on top of your current plan.</>)
                : (<><span className="font-semibold">Included with your plan.</span> No extra charge for your first number.</>)}
            </div>

            {dpSearchError && (
              <div className="mb-4 bg-red-50 border border-red-100 rounded-xl p-3 flex items-center gap-2 text-red-600 text-sm">
                <AlertCircle size={14} className="shrink-0" />
                <span className="flex-1">{dpSearchError}</span>
                <button onClick={() => setDpSearchError(null)}><X size={14} /></button>
              </div>
            )}

            <div className="mb-4">
              <label className="text-[11px] font-bold text-slate-500 uppercase tracking-widest">Assign to</label>
              <select
                value={buyAccountId}
                onChange={e => setBuyAccountId(e.target.value)}
                className="w-full mt-1 px-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {accounts.map(acc => (
                  <option key={acc.id} value={acc.id}>
                    {acc.platform === 'yelp' ? '🔴 ' : '🔵 '}{acc.businessName}
                  </option>
                ))}
              </select>
            </div>

            <div className={`rounded-xl border p-3 mb-4 ${dpSmsConsent ? 'bg-emerald-50/50 border-emerald-200' : 'bg-amber-50/50 border-amber-200'}`}>
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={dpSmsConsent}
                  onChange={e => setDpSmsConsent(e.target.checked)}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-xs text-slate-600 leading-relaxed">
                  I agree to receive SMS notifications from Geos LLC regarding account alerts and new leads. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe or HELP for assistance.
                </span>
              </label>
              {!dpSmsConsent && (
                <div className="mt-2 ml-7 flex items-center gap-1.5 text-amber-600 text-xs font-medium">
                  <AlertCircle size={11} className="shrink-0" />
                  You must accept the SMS consent to purchase a number.
                </div>
              )}
            </div>

            <div className="flex flex-wrap gap-3 mb-4">
              <input
                type="text"
                value={dpAreaCode}
                onChange={e => setDpAreaCode(e.target.value.replace(/\D/g, '').slice(0, 3))}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="Area code (e.g. 415)"
                maxLength={3}
                className="w-36 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono tracking-widest"
              />
              <input
                type="text"
                value={dpLocality}
                onChange={e => setDpLocality(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSearch()}
                placeholder="City (e.g. San Francisco)"
                className="flex-1 min-w-40 px-4 py-3 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button
                onClick={handleSearch}
                disabled={dpSearchLoading || !buyAccountId}
                className="px-5 py-3 bg-blue-600 text-white rounded-xl font-semibold text-sm hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2 shadow-lg shadow-blue-200 transition-all"
              >
                {dpSearchLoading ? <Loader2 size={14} className="animate-spin" /> : <Hash size={14} />}
                {dpSearchLoading ? 'Searching...' : 'Search Numbers'}
              </button>
            </div>

            {dpAvailableNumbers.length > 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 max-h-64 overflow-y-auto">
                {dpAvailableNumbers.map(num => {
                  const isAdditional = tenantPhones.length > 0;
                  return (
                    <div key={num.phoneNumber} className="bg-slate-50 rounded-xl border border-slate-200 p-3 flex flex-col gap-2 hover:border-blue-200 transition-all">
                      <div>
                        <div className="font-bold text-slate-900 font-mono text-sm">{num.phoneNumber}</div>
                        <div className="text-xs text-slate-500">{[num.locality, num.region].filter(Boolean).join(', ') || 'US'}</div>
                        {isAdditional
                          ? (phonePrice != null && <div className="text-xs text-slate-400">${phonePrice.toFixed(2)}/mo (add-on)</div>)
                          : <div className="text-xs text-emerald-600 font-medium">Included with your plan</div>}
                      </div>
                      <button
                        onClick={() => handlePurchase(num.phoneNumber)}
                        disabled={dpPurchasingNumber !== null || !dpSmsConsent}
                        className="w-full px-3 py-2 bg-blue-600 text-white rounded-lg font-semibold text-xs hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 transition-all"
                      >
                        {dpPurchasingNumber === num.phoneNumber ? <><Loader2 size={12} className="animate-spin" /> Getting...</> : 'Get this number'}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Release confirmation */}
      {releaseConfirmPhone && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setReleaseConfirmPhone(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-6 relative" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-red-100 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-red-600" />
              </div>
              <div>
                <h3 className="text-base font-bold text-slate-900">Release this number?</h3>
                <p className="text-xs font-mono text-slate-500 mt-0.5">{releaseConfirmPhone.phoneNumber}</p>
              </div>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 mb-4 text-xs text-amber-800 leading-relaxed space-y-1">
              <p>• Billing stops immediately.</p>
              <p>• The number stays active for <span className="font-semibold">{gracePeriodDays} days</span> so you can restore it.</p>
              <p>• After that, the number is released and <span className="font-semibold">cannot be recovered</span>.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setReleaseConfirmPhone(null)}
                className="px-4 py-2 text-sm font-semibold text-slate-600 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRelease(releaseConfirmPhone.id)}
                disabled={releasingPhoneId === releaseConfirmPhone.id}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-lg hover:bg-red-700 disabled:opacity-50 transition-colors"
              >
                {releasingPhoneId === releaseConfirmPhone.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Release number
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
