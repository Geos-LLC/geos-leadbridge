import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Mail, CheckCircle, ArrowLeft, Zap, ShieldCheck, RefreshCw } from 'lucide-react';
import { authApi } from '../services/api';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await authApi.forgotPassword(email);
      setSuccess(true);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to send reset email. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="antialiased min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
        {/* Decorative Background */}
        <div className="absolute top-0 left-0 w-full h-full -z-10 overflow-hidden">
          <div className="absolute -top-24 -left-24 w-96 h-96 bg-emerald-100/50 rounded-full blur-3xl"></div>
          <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-blue-100/50 rounded-full blur-3xl"></div>
        </div>

        <div className="w-full max-w-[440px] z-10">
          {/* Logo Branding */}
          <div className="flex flex-col items-center mb-10">
            <div className="w-14 h-14 bg-emerald-600 rounded-2xl flex items-center justify-center text-white shadow-xl shadow-emerald-200 mb-4 animate-float">
              <CheckCircle className="w-8 h-8" />
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">LeadBridge</h1>
          </div>

          {/* Success Card */}
          <div className="bg-white border border-slate-100 rounded-[2.5rem] p-8 md:p-10 shadow-xl shadow-slate-200/50">
            <div className="mb-8 text-center">
              <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">Check Your Email</h2>
              <p className="text-slate-500 font-medium">We've sent password reset instructions</p>
            </div>

            <div className="p-6 bg-emerald-50 border border-emerald-100 rounded-2xl flex items-start gap-3 text-emerald-700 mb-8">
              <CheckCircle className="w-5 h-5 shrink-0 mt-0.5" />
              <p className="text-sm font-medium">
                If an account exists for <strong>{email}</strong>, you will receive a password reset link shortly.
              </p>
            </div>

            {/* Footer Links */}
            <div className="text-center">
              <Link
                to="/login"
                className="inline-flex items-center gap-2 text-blue-600 font-bold hover:text-blue-700 transition-colors"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to Login
              </Link>
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

  return (
    <div className="antialiased min-h-screen flex items-center justify-center p-6 relative overflow-hidden">
      {/* Decorative Background */}
      <div className="absolute top-0 left-0 w-full h-full -z-10 overflow-hidden">
        <div className="absolute -top-24 -left-24 w-96 h-96 bg-blue-100/50 rounded-full blur-3xl"></div>
        <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-indigo-100/50 rounded-full blur-3xl"></div>
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
            <h2 className="text-3xl font-extrabold text-slate-900 tracking-tight mb-2">Forgot Password?</h2>
            <p className="text-slate-500 font-medium">Enter your email and we'll send you a reset link</p>
          </div>

          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-100 rounded-2xl text-red-600 text-sm font-medium">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-6">
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

            {/* Submit Button */}
            <button
              type="submit"
              disabled={loading}
              className="w-full py-4 bg-blue-600 text-white rounded-2xl font-bold text-lg hover:bg-blue-700 shadow-lg shadow-blue-200 transition-all flex items-center justify-center gap-2 group disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <span>{loading ? 'Sending...' : 'Send Reset Link'}</span>
            </button>
          </form>

          {/* Footer Links */}
          <div className="mt-10 pt-8 border-t border-slate-100 text-center">
            <p className="text-slate-500 font-medium">
              Remember your password?
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
