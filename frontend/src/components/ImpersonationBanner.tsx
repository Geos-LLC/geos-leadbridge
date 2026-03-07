import { Eye, X } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useAppStore } from '../store/appStore';

export default function ImpersonationBanner() {
  const { impersonatingUser, stopImpersonation } = useAuthStore();
  const setSavedAccounts = useAppStore((s) => s.setSavedAccounts);
  const setDashboardStats = useAppStore((s) => s.setDashboardStats);
  const setAnalyticsCache = useAppStore((s) => s.setAnalyticsCache);

  if (!impersonatingUser) return null;

  const handleExit = () => {
    stopImpersonation();
    setSavedAccounts([]);
    setDashboardStats(null as any);
    setAnalyticsCache(null as any);
    window.location.reload();
  };

  return (
    <div className="bg-amber-500 text-white px-6 py-2.5 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <Eye size={18} />
        <span className="text-sm font-semibold">
          Viewing as: <strong>{impersonatingUser.name || impersonatingUser.email}</strong>
          <span className="ml-2 opacity-80 text-xs">({impersonatingUser.email})</span>
        </span>
      </div>
      <button
        onClick={handleExit}
        className="flex items-center gap-1.5 px-3 py-1 bg-white/20 hover:bg-white/30 rounded-lg text-sm font-semibold transition-all"
      >
        <X size={14} />
        Exit
      </button>
    </div>
  );
}
