import { Link } from 'react-router-dom';
import {
  Zap,
  ShieldCheck,
  Database,
  Users,
  Lock,
  Ban,
  Sparkles,
  KeyRound,
  Info,
  ArrowLeft,
} from 'lucide-react';

export function Security() {
  return (
    <div className="antialiased bg-white text-slate-900 min-h-screen flex flex-col">
      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-white/90 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 h-18 flex items-center justify-between py-4">
          <Link to="/" className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow">
              <Zap className="w-5 h-5" />
            </div>
            <span className="text-lg font-bold tracking-tight">LeadBridge</span>
          </Link>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm font-semibold text-slate-500 hover:text-blue-600 transition-colors hidden sm:block">Sign In</Link>
            <Link to="/register" className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="pt-32 pb-14 px-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50/60 via-white to-white -z-10" />
        <div className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-6">
            <ShieldCheck className="w-3.5 h-3.5" />
            Security & Data Privacy
          </div>
          <h1 className="text-4xl lg:text-5xl font-extrabold leading-[1.1] tracking-tight mb-5">
            Your leads and customer<br />conversations stay private.
          </h1>
          <p className="text-lg text-slate-600 leading-relaxed max-w-2xl mx-auto">
            LeadBridge is built with tenant-level data separation, restricted access controls,
            encrypted connections, and audit logging to help protect the customer data your
            business depends on.
          </p>
        </div>
      </header>

      {/* Content */}
      <main className="px-6 pb-20 flex-1">
        <div className="max-w-3xl mx-auto space-y-10">
          <Section
            icon={<Database className="w-5 h-5" />}
            title="What data LeadBridge protects"
          >
            <p>
              LeadBridge may process lead details, customer contact information, service
              request details, messages, follow-up history, platform connection data, and
              notification activity.
            </p>
            <p>
              This data is used only to operate your lead response, follow-up, alert, and
              automation workflows.
            </p>
          </Section>

          <Section
            icon={<Users className="w-5 h-5" />}
            title="How customer data is separated"
          >
            <p>
              Each business account has its own protected data boundary. Users can only access
              the leads, messages, and settings that belong to their business.
            </p>
          </Section>

          <Section
            icon={<Lock className="w-5 h-5" />}
            title="Restricted internal access"
          >
            <p>
              LeadBridge is designed so internal platform access is limited. Support access to
              customer data is restricted, temporary when possible, and used only when needed
              to troubleshoot account or integration issues.
            </p>
          </Section>

          <Section
            icon={<Ban className="w-5 h-5" />}
            title="No selling customer data"
          >
            <p>We do not sell your customer data.</p>
          </Section>

          <Section
            icon={<Sparkles className="w-5 h-5" />}
            title="AI privacy statement"
          >
            <p>
              If AI features are enabled, your lead and conversation data is used to generate
              replies and automation for your own business account. We do not use your customer
              conversations to train public AI models.
            </p>
          </Section>

          <Section
            icon={<KeyRound className="w-5 h-5" />}
            title="Security controls"
          >
            <p>LeadBridge uses practical SaaS security controls, including:</p>
            <ul className="space-y-2 mt-3">
              {[
                'Tenant-level data separation',
                'Role-based access controls',
                'Encrypted connections',
                'Encrypted sensitive credentials',
                'Restricted support access',
                'Audit logging',
                'Secure integration token storage',
                'Tenant-scoped caching',
              ].map((item) => (
                <li key={item} className="flex items-start gap-2.5">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-blue-600 shrink-0" />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section
            icon={<Info className="w-5 h-5" />}
            title="Certification disclaimer"
            tone="muted"
          >
            <p>
              LeadBridge does not currently claim SOC 2, ISO, or HIPAA certification. We are
              building the system with practical security controls from the beginning and will
              continue improving our security program as the product grows.
            </p>
          </Section>

          {/* Back to home */}
          <div className="pt-4">
            <Link
              to="/"
              className="inline-flex items-center gap-2 text-sm font-semibold text-blue-600 hover:text-blue-700 transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to home
            </Link>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="py-10 border-t border-slate-100 bg-white">
        <div className="max-w-6xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <Zap className="w-4 h-4" />
            </div>
            <span className="font-bold text-slate-900">LeadBridge</span>
          </div>
          <p className="text-slate-400 text-sm">© 2025 LeadBridge. Built for home service pros.</p>
          <div className="flex items-center gap-6 text-sm text-slate-400">
            <Link to="/demo" className="hover:text-blue-600 transition-colors">Demo</Link>
            <Link to="/security" className="hover:text-blue-600 transition-colors">Security</Link>
            <a href="mailto:support@geos-ai.com" className="hover:text-blue-600 transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
  tone = 'default',
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'muted';
}) {
  const isMuted = tone === 'muted';
  return (
    <section
      className={`rounded-2xl border p-7 ${
        isMuted
          ? 'bg-slate-50 border-slate-200'
          : 'bg-white border-slate-200 shadow-sm'
      }`}
    >
      <div className="flex items-center gap-3 mb-4">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center ${
            isMuted ? 'bg-slate-200 text-slate-600' : 'bg-blue-50 text-blue-600'
          }`}
        >
          {icon}
        </div>
        <h2 className="text-xl font-bold tracking-tight">{title}</h2>
      </div>
      <div className="text-slate-600 leading-relaxed space-y-3">{children}</div>
    </section>
  );
}

export default Security;
