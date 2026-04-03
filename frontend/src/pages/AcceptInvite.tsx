import { useState, useEffect } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { Users, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { teamsApi } from '../services/api';
import { useAuthStore } from '../store/authStore';

export default function AcceptInvite() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');
  const { user } = useAuthStore();
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('Invalid invitation link — no token provided.');
      return;
    }

    if (!user) {
      // Not logged in — redirect to login with return URL
      navigate(`/login?redirect=${encodeURIComponent(`/invite/accept?token=${token}`)}`);
      return;
    }

    // Accept the invitation
    teamsApi.acceptInvite(token)
      .then(res => {
        setStatus('success');
        setMessage(`You've joined the team as ${res.role.toLowerCase()}!`);
        setTimeout(() => navigate('/settings'), 2000);
      })
      .catch(err => {
        setStatus('error');
        setMessage(err.response?.data?.message || 'Failed to accept invitation.');
      });
  }, [token, user]);

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-sm border border-slate-100 p-8 max-w-md w-full text-center">
        <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-blue-50 flex items-center justify-center">
          <Users className="w-8 h-8 text-blue-600" />
        </div>

        {status === 'loading' && (
          <>
            <h1 className="text-xl font-bold text-slate-900 mb-2">Joining Team...</h1>
            <Loader2 className="w-6 h-6 animate-spin text-blue-600 mx-auto" />
          </>
        )}

        {status === 'success' && (
          <>
            <h1 className="text-xl font-bold text-slate-900 mb-2">Welcome to the Team!</h1>
            <div className="flex items-center justify-center gap-2 text-emerald-600 mb-3">
              <CheckCircle size={20} />
              <span className="text-sm font-semibold">{message}</span>
            </div>
            <p className="text-sm text-slate-500">Redirecting to settings...</p>
          </>
        )}

        {status === 'error' && (
          <>
            <h1 className="text-xl font-bold text-slate-900 mb-2">Invitation Error</h1>
            <div className="flex items-center justify-center gap-2 text-red-600 mb-3">
              <AlertCircle size={20} />
              <span className="text-sm font-semibold">{message}</span>
            </div>
            <button
              onClick={() => navigate('/settings')}
              className="mt-4 px-5 py-2 bg-blue-600 text-white text-sm font-semibold rounded-xl hover:bg-blue-700 transition-colors"
            >
              Go to Settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
