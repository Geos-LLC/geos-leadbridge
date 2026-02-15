import { Link } from 'react-router-dom';
import {
  Zap, ArrowUpRight, ArrowRight, Check, X, Clock, DollarSign,
  Users, AlertCircle, Twitter, Linkedin
} from 'lucide-react';

export function Landing() {
  return (
    <div className="antialiased">
      {/* Navigation */}
      <nav className="fixed top-0 w-full z-50 bg-white/80 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow-lg">
              <Zap className="w-6 h-6" />
            </div>
            <span className="text-xl font-bold tracking-tight">LeadBridge</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm font-semibold text-slate-600">
            <a href="#problem" className="hover:text-blue-600">Why Us</a>
            <a href="#how-it-works" className="hover:text-blue-600">How it Works</a>
            <a href="#pricing" className="hover:text-blue-600">Pricing</a>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/login" className="text-sm font-semibold text-slate-600 hover:text-blue-600">Login</Link>
            <Link to="/demo" className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-md">Try Demo</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="relative pt-32 pb-20 lg:pt-48 lg:pb-32 overflow-hidden">
        <div className="absolute top-[-10%] right-[-10%] w-[500px] h-[500px] bg-[radial-gradient(circle,rgba(37,99,235,0.1)_0%,rgba(255,255,255,0)_70%)] z-[-1]"></div>
        <div className="max-w-7xl mx-auto px-6 grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-blue-50 text-blue-600 text-xs font-bold uppercase tracking-wider mb-6">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
              </span>
              New: AI-Powered Responses for 2024
            </div>
            <h1 className="text-5xl lg:text-7xl font-extrabold text-slate-900 leading-[1.1] mb-6">
              Win More Thumbtack & <span className="gradient-text">Yelp Jobs</span> — Automatically.
            </h1>
            <p className="text-xl text-slate-600 mb-8 leading-relaxed max-w-xl">
              Instant AI replies. Smart follow-ups. No missed leads. LeadBridge responds to every new lead in seconds — even at night.
            </p>
            <div className="flex flex-wrap gap-4 mb-10">
              <div className="flex items-center gap-2 text-slate-700 font-medium">
                <ArrowUpRight className="w-5 h-5 text-emerald-500" /> Increase response speed
              </div>
              <div className="flex items-center gap-2 text-slate-700 font-medium">
                <ArrowUpRight className="w-5 h-5 text-emerald-500" /> Increase close rate
              </div>
              <div className="flex items-center gap-2 text-slate-700 font-medium">
                <ArrowUpRight className="w-5 h-5 text-emerald-500" /> Increase revenue
              </div>
            </div>
            <Link to="/register" className="inline-flex items-center gap-3 px-8 py-4 bg-blue-600 text-white rounded-2xl text-lg font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-200 group">
              Get More Jobs Automatically
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </Link>

            <div className="mt-12 flex items-center gap-4">
              <div className="flex -space-x-3">
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 1" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1621905252507-b354bcadcabc?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 2" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1581578731548-c64695ce6958?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 3" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200 flex items-center justify-center bg-blue-600 text-white text-xs font-bold">
                  +500
                </div>
              </div>
              <p className="text-sm text-slate-500 font-medium">Trusted by 500+ home service pros</p>
            </div>
          </div>

          <div className="relative">
            <div className="rounded-3xl overflow-hidden shadow-2xl shadow-slate-200 border-8 border-white bg-slate-100">
              <img src="https://images.unsplash.com/photo-1581578731548-c64695ce6958?auto=format&fit=crop&q=80&w=800" alt="Home Service Professional" className="w-full h-full object-cover" />
            </div>
            <div className="absolute -bottom-10 -left-10 glass-card p-6 rounded-2xl shadow-xl max-w-xs animate-float">
              <div className="flex items-center gap-4 mb-3">
                <div className="w-10 h-10 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center">
                  <Check className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-bold uppercase">New Lead Captured</p>
                  <p className="font-bold text-slate-900">AI Response Sent</p>
                </div>
              </div>
              <p className="text-sm text-slate-600">"Hey! I'd love to help with your plumbing issue. Are you free at 2pm?"</p>
            </div>
          </div>
        </div>
      </header>

      {/* Problem Section */}
      <section id="problem" className="py-24 bg-amber-50/50">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-16">
            <span className="text-amber-600 font-bold tracking-widest uppercase text-sm">🟨 WHEN IS THIS NEEDED?</span>
            <h2 className="text-4xl font-extrabold text-slate-900 mt-4">Does This Sound Familiar?</h2>
          </div>
          <div className="grid gap-4">
            {[
              { icon: X, text: "You're driving, cleaning, on a job — and miss a new lead." },
              { icon: Clock, text: "You respond 20–40 minutes later… and the job is gone." },
              { icon: DollarSign, text: "You pay for leads but don't win enough of them." },
              { icon: Users, text: "Customers message multiple pros — fastest reply wins." },
              { icon: AlertCircle, text: "Or worse… You reply manually all day and feel chained to your phone.", bold: true },
            ].map((item, i) => (
              <div key={i} className="bg-white p-6 rounded-2xl border border-amber-100 shadow-sm flex items-start gap-4">
                <div className="w-6 h-6 rounded bg-amber-100 flex-shrink-0 flex items-center justify-center mt-1">
                  <item.icon className="w-4 h-4 text-amber-600" />
                </div>
                <p className={`text-lg text-slate-700 ${item.bold ? 'font-bold italic' : ''}`}>{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it Works */}
      <section id="how-it-works" className="py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <span className="text-blue-600 font-bold tracking-widest uppercase text-sm">⚙️ HOW IT WORKS</span>
            <h2 className="text-4xl font-extrabold text-slate-900 mt-4">Simple, Powerful, Automated.</h2>
          </div>
          <div className="grid md:grid-cols-5 gap-4">
            {[
              "New lead comes in",
              "LeadBridge detects it instantly",
              "AI sends optimized first reply",
              "Follow-ups are triggered automatically",
              "You jump in when the customer responds"
            ].map((step, i) => (
              <div key={i} className={`p-6 rounded-3xl shadow-sm ${i === 4 ? 'bg-blue-600 text-white shadow-lg' : 'bg-white border border-slate-100'}`}>
                <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold mb-4 ${i === 4 ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-900'}`}>{i + 1}</div>
                <p className="font-bold">{step}</p>
              </div>
            ))}
          </div>
          <div className="text-center mt-12">
            <p className="text-xl font-bold text-slate-900">You stay in control. But you're never slow again.</p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 bg-white">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <span className="text-blue-600 font-bold tracking-widest uppercase text-sm">💰 PRICING</span>
            <h2 className="text-4xl font-extrabold text-slate-900 mt-4">Transparent Growth Plans</h2>
          </div>
          <div className="grid lg:grid-cols-3 gap-8">
            <div className="bg-white p-10 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-xl transition-all">
              <h3 className="text-xl font-bold mb-2">Starter</h3>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-4xl font-extrabold">$79</span>
                <span className="text-slate-500">/month</span>
              </div>
              <ul className="space-y-4 mb-10">
                <li className="flex items-center gap-3 text-slate-600"><Check className="w-5 h-5 text-blue-500" /> Instant first reply</li>
                <li className="flex items-center gap-3 text-slate-600"><Check className="w-5 h-5 text-blue-500" /> 1 follow-up sequence</li>
                <li className="flex items-center gap-3 text-slate-600 font-bold"><Check className="w-5 h-5 text-blue-500" /> Up to 50 leads</li>
              </ul>
              <Link to="/register" className="block w-full py-4 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800">Start Free Trial</Link>
            </div>

            <div className="bg-white p-10 rounded-[2.5rem] border-4 border-blue-600 shadow-xl relative scale-105 z-10">
              <div className="absolute -top-5 left-1/2 -translate-x-1/2 bg-blue-600 text-white px-4 py-1 rounded-full text-xs font-bold uppercase tracking-widest">Most Popular</div>
              <h3 className="text-xl font-bold mb-2 text-blue-600">Pro</h3>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-4xl font-extrabold">$149</span>
                <span className="text-slate-500">/month</span>
              </div>
              <ul className="space-y-4 mb-10">
                <li className="flex items-center gap-3 text-slate-700 font-medium"><Check className="w-5 h-5 text-blue-500" /> AI first reply</li>
                <li className="flex items-center gap-3 text-slate-700 font-medium"><Check className="w-5 h-5 text-blue-500" /> Multi-step follow-ups</li>
                <li className="flex items-center gap-3 text-slate-700 font-medium"><Check className="w-5 h-5 text-blue-500" /> Performance tracking</li>
                <li className="flex items-center gap-3 text-slate-700 font-bold"><Check className="w-5 h-5 text-blue-500" /> Up to 150 leads</li>
              </ul>
              <Link to="/register" className="block w-full py-4 text-center bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 shadow-lg shadow-blue-200">Start Free Trial</Link>
            </div>

            <div className="bg-white p-10 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-xl transition-all">
              <h3 className="text-xl font-bold mb-2">Elite</h3>
              <div className="flex items-baseline gap-1 mb-6">
                <span className="text-4xl font-extrabold">$249</span>
                <span className="text-slate-500">/month</span>
              </div>
              <ul className="space-y-4 mb-10">
                <li className="flex items-center gap-3 text-slate-600"><Check className="w-5 h-5 text-blue-500" /> AI optimization</li>
                <li className="flex items-center gap-3 text-slate-600"><Check className="w-5 h-5 text-blue-500" /> Custom message logic</li>
                <li className="flex items-center gap-3 text-slate-600"><Check className="w-5 h-5 text-blue-500" /> Dedicated phone number</li>
                <li className="flex items-center gap-3 text-slate-600 font-bold"><Check className="w-5 h-5 text-blue-500" /> Unlimited leads</li>
              </ul>
              <Link to="/register" className="block w-full py-4 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800">Contact Sales</Link>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-6">
          <div className="bg-gradient-to-tr from-blue-600 to-indigo-700 rounded-[3rem] p-16 text-white text-center shadow-2xl shadow-blue-200 relative overflow-hidden">
            <div className="relative z-10">
              <h2 className="text-4xl lg:text-5xl font-extrabold mb-8">Stop Losing Jobs to Faster Competitors.</h2>
              <p className="text-xl text-blue-100 mb-10 max-w-2xl mx-auto">Your competitors aren't better. They're just faster. Let AI respond first.</p>
              <Link to="/register" className="inline-flex items-center gap-3 px-10 py-5 bg-white text-blue-600 rounded-2xl text-xl font-bold hover:bg-blue-50 transition-all shadow-xl">
                Start Winning More Leads
                <Zap className="w-6 h-6" />
              </Link>
            </div>
            <div className="absolute -bottom-20 -right-20 w-80 h-80 bg-white/10 rounded-full blur-3xl"></div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-12 border-t border-slate-100">
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-8">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center text-white">
              <Zap className="w-5 h-5" />
            </div>
            <span className="text-lg font-bold">LeadBridge</span>
          </div>
          <p className="text-slate-400 text-sm">© 2024 LeadBridge AI. Built for the Home Service Industry.</p>
          <div className="flex gap-6 text-slate-400">
            <a href="#" className="hover:text-blue-600 transition-colors"><Twitter className="w-5 h-5" /></a>
            <a href="#" className="hover:text-blue-600 transition-colors"><Linkedin className="w-5 h-5" /></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
