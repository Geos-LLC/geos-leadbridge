import { Wrench } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

/**
 * Full-page blocking overlay shown on the Automation pages when the
 * tenant has zero active ServiceProfiles. Automation's qualification
 * block + pricing resolver are both driven by service data, so the
 * page is meaningless without at least one configured service.
 *
 * Mirrors NoAccountsOverlay's blocking pattern — same z-40 dim layer
 * with no dismiss affordance.
 */
export default function NoServiceOverlay() {
  const navigate = useNavigate();

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40 flex items-center justify-center p-4">
      <div className="bg-white rounded-3xl border border-slate-100 shadow-2xl p-10 text-center max-w-md w-full">
        <div className="w-16 h-16 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-5">
          <Wrench className="w-8 h-8 text-amber-500" />
        </div>
        <h3 className="text-xl font-bold text-slate-900 mb-2">No Service Configured</h3>
        <p className="text-slate-500 mb-8 leading-relaxed">
          Automation needs at least one active service before it can qualify, price, or
          respond to leads. Set one up to continue.
        </p>
        <button
          onClick={() => navigate('/settings?tab=ai-playbook')}
          className="px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all"
        >
          Set up a service
        </button>
      </div>
    </div>
  );
}
