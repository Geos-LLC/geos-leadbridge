import { Link2Off } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * Full-page overlay shown to regular users who have no connected accounts.
 * Renders on top of the page layout so users can see the template underneath.
 */
export default function NoAccountsOverlay() {
  const navigate = useNavigate();

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl border border-slate-100 shadow-2xl p-10 text-center max-w-md w-full">
        <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Link2Off className="w-8 h-8 text-amber-500" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Accounts Connected</h3>
        <p className="text-slate-500 mb-8 leading-relaxed">
          You need to connect an account first.
        </p>
        <button
          onClick={() => navigate('/overview')}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
        >
          Go to Overview
        </button>
      </div>
    </div>
  );
}
