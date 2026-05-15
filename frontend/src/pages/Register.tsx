import { useState, useEffect, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Mail, Lock, Building2, Phone, ArrowRight, Zap, ShieldCheck, RefreshCw } from 'lucide-react';
import { authApi } from '../services/api';
import { useAuthStore } from '../store/authStore';
import { trackEvent } from '../services/analytics';

export function Register() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((state) => state.setAuth);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [businessPhone, setBusinessPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const startedRef = useRef(false);

  useEffect(() => {
    trackEvent('signup_page_viewed');
  }, []);

  const markStarted = () => {
    if (startedRef.current) return;
    startedRef.current = true;
    trackEvent('signup_started');
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    trackEvent('signup_submitted');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      trackEvent('signup_failed', { error_type: 'password_mismatch' });
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      trackEvent('signup_failed', { error_type: 'password_too_short' });
      return;
    }

    setLoading(true);

    try {
      const { user, token } = await authApi.register(email, password, name || undefined, businessPhone || undefined);
      setAuth(user, token);
      trackEvent('signup_success', { method: 'email' });
      trackEvent('first_login');
      localStorage.setItem('lb_has_logged_in', '1');
      navigate('/overview');
    } catch (err: any) {
      const errorType = err.response?.status === 409 ? 'email_exists' : err.response?.status >= 500 ? 'server_error' : 'validation';
      setError(err.response?.data?.message || 'Registration failed. Please try again.');
      trackEvent('signup_failed', { error_type: errorType });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="antialiased min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
      {/* Decorative Background */}
      <div className="absolute top-0 left-0 w-full h-full -z-10 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-purple-100/50 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-blue-100/50 rounded-full blur-3xl"></div>
      </div>

      <div className="w-full max-w-[440px] z-10">
        {/* Logo Branding */}
        <div className="flex flex-col items-center mb-10">
          <div className="w-14 h-14 bg-blue-600 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-blue-200 mb-4 animate-float">
            <Zap className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">LeadBridge</h1>
        </div>

        {/* Auth Card */}
        <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 md:p-10 shadow-xl shadow-slate-200/50">
          <div className="mb-8 text-center">
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">Create Account</h2>
            <p className="text-slate-500 font-medium">Get started with LeadBridge</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} onFocus={markStarted} className="space-y-5">
            {/* Company Name Field */}
            <div className="space-y-2">
              <label htmlFor="name" className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                Company Name <span className="text-slate-300">(optional)</span>
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-600 transition-colors">
                  <Building2 className="w-5 h-5" />
                </div>
                <input
                  id="name"
                  type="text"
                  placeholder="Your company name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>
            </div>

            {/* Business Phone Field */}
            <div className="space-y-2">
              <label htmlFor="businessPhone" className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                Business Phone Number
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-600 transition-colors">
                  <Phone className="w-5 h-5" />
                </div>
                <input
                  id="businessPhone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={businessPhone}
                  onChange={(e) => setBusinessPhone(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                />
              </div>
              <p className="text-xs text-slate-400 px-1">
                Notifications and customer replies will be forwarded to this number. You can change it later in Settings.
              </p>
            </div>

            {/* Email Field */}
            <div className="space-y-2">
              <label htmlFor="email" className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                Email Address
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-600 transition-colors">
                  <Mail className="w-5 h-5" />
                </div>
                <input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  required
                />
              </div>
            </div>

            {/* Password Field */}
            <div className="space-y-2">
              <label htmlFor="password" className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                Password
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-600 transition-colors">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  id="password"
                  type="password"
                  placeholder="At least 6 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  required
                />
              </div>
            </div>

            {/* Confirm Password Field */}
            <div className="space-y-2">
              <label htmlFor="confirmPassword" className="text-xs font-bold text-slate-400 uppercase tracking-widest px-1">
                Confirm Password
              </label>
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none text-slate-400 group-focus-within:text-blue-600 transition-colors">
                  <Lock className="w-5 h-5" />
                </div>
                <input
                  id="confirmPassword"
                  type="password"
                  placeholder="Confirm your password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full pl-12 pr-4 py-4 bg-slate-50 border border-slate-100 rounded-2xl text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  required
                />
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-lg hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed mt-6"
            >
              <span>{loading ? 'Creating account...' : 'Create Account'}</span>
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
          </form>

          {/* Footer Links */}
          <div className="mt-10 pt-8 border-t border-slate-100 text-center">
            <p className="text-slate-500 font-medium">
              Already have an account?
              <Link to="/login" className="text-blue-600 font-bold hover:underline ml-1">
                Sign in
              </Link>
            </p>
          </div>
        </div>

        {/* Trust Badges */}
        <div className="mt-8 flex justify-center items-center gap-6 opacity-40 grayscale hover:opacity-100 hover:grayscale-0 transition-all duration-500">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Secure SSL</span>
          </div>
          <div className="flex items-center gap-2">
            <RefreshCw className="w-4 h-4" />
            <span className="text-[10px] font-bold uppercase tracking-widest">Real-time Sync</span>
          </div>
        </div>
      </div>
    </div>
  );
}
