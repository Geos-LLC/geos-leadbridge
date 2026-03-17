import { Link } from 'react-router-dom';
import { Check, Phone, MessageSquare, Bell, ArrowRight, Star, Zap } from 'lucide-react';
import leadConversationImg from '../assets/lead-conversation-thumbtack.png';

export function Landing() {
  return (
    <div className="antialiased bg-white text-slate-900">

      {/* Nav */}
      <nav className="fixed top-0 w-full z-50 bg-white/90 backdrop-blur-md border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 h-18 flex items-center justify-between py-4">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-blue-600 rounded-xl flex items-center justify-center text-white shadow">
              <Zap className="w-5 h-5" />
            </div>
            <span className="text-lg font-bold tracking-tight">LeadBridge</span>
          </div>
          <div className="hidden md:flex items-center gap-8 text-sm font-semibold text-slate-500">
            <a href="#how" className="hover:text-blue-600 transition-colors">How It Works</a>
            <a href="#pricing" className="hover:text-blue-600 transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm font-semibold text-slate-500 hover:text-blue-600 transition-colors hidden sm:block">Sign In</Link>
            <Link to="/register" className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow">Start Early Access</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="pt-32 pb-20 lg:pt-44 lg:pb-32 px-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50/60 via-white to-white -z-10" />
        <div className="absolute top-20 right-0 w-[600px] h-[600px] bg-blue-100/30 rounded-full blur-3xl -z-10" />
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-50 border border-amber-200 text-amber-700 text-xs font-bold uppercase tracking-wider mb-8">
              <span className="w-2 h-2 bg-amber-400 rounded-full animate-pulse" />
              Early Access — Limited Spots
            </div>
            <h1 className="text-5xl lg:text-6xl font-extrabold leading-[1.08] tracking-tight mb-6">
              Never miss a<br />
              <span className="text-blue-600">lead again.</span>
            </h1>
            <p className="text-xl text-slate-600 leading-relaxed mb-8 max-w-lg">
              LeadBridge notifies you, replies to customers, and connects calls automatically — so you book more jobs without chasing leads.
            </p>
            <div className="flex flex-wrap gap-4 mb-10">
              <Link to="/register" className="inline-flex items-center gap-2 px-7 py-4 bg-blue-600 text-white rounded-2xl text-base font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 group">
                Start Early Access
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
              </Link>
              <a href="#how" className="inline-flex items-center gap-2 px-6 py-4 border-2 border-slate-200 text-slate-700 rounded-2xl text-base font-bold hover:border-blue-300 hover:text-blue-600 transition-all">
                See How It Works
              </a>
            </div>
            <div className="flex flex-wrap gap-5 text-sm text-slate-500 font-medium">
              <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> No per-lead fees</span>
              <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> Setup in 2 minutes</span>
              <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> Cancel anytime</span>
            </div>
          </div>
          <div className="relative hidden lg:block">
            <div className="rounded-3xl overflow-hidden shadow-2xl border-8 border-white bg-slate-100">
              <img src={leadConversationImg} alt="LeadBridge in action" className="w-full h-full object-cover" />
            </div>
            <div className="absolute -bottom-6 -left-6 bg-white rounded-2xl shadow-xl p-5 max-w-xs border border-slate-100">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 bg-emerald-100 rounded-full flex items-center justify-center">
                  <Check className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase">New Lead — Auto-Replied</p>
                  <p className="font-bold text-slate-900 text-sm">Response sent in 4 seconds</p>
                </div>
              </div>
              <p className="text-sm text-slate-500 italic">"Hi! Thanks for reaching out — I'd love to help. What's the best time to connect?"</p>
            </div>
          </div>
        </div>
      </header>

      {/* Problem */}
      <section className="py-20 bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <p className="text-blue-400 font-bold uppercase tracking-widest text-sm mb-4">The Problem</p>
          <h2 className="text-4xl font-extrabold mb-4">You're losing leads without realizing it.</h2>
          <p className="text-slate-400 text-lg mb-14 max-w-xl mx-auto">Most businesses lose 30–50% of leads due to slow response times. The fastest reply wins — every time.</p>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              { emoji: '📵', title: 'Missed calls = lost jobs', desc: 'If you don\'t pick up, they call the next pro on the list.' },
              { emoji: '⏱️', title: 'Slow responses = lost customers', desc: 'A 20-minute delay drops your close rate by over 80%.' },
              { emoji: '😤', title: 'Manual follow-ups = wasted time', desc: 'Chasing leads manually takes hours you don\'t have.' },
            ].map((item, i) => (
              <div key={i} className="bg-slate-800 rounded-2xl p-6 text-left border border-slate-700">
                <div className="text-3xl mb-3">{item.emoji}</div>
                <h3 className="font-bold text-white mb-2">{item.title}</h3>
                <p className="text-slate-400 text-sm leading-relaxed">{item.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Solution — 3 blocks */}
      <section id="how" className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-16">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">The Solution</p>
            <h2 className="text-4xl font-extrabold">One system. Every lead handled.</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              {
                icon: MessageSquare,
                color: 'bg-blue-50 text-blue-600',
                title: 'Instant Response',
                desc: 'Auto-reply to every new lead within seconds — even at night or while on a job.',
              },
              {
                icon: Phone,
                color: 'bg-emerald-50 text-emerald-600',
                title: 'Call Connect',
                desc: 'Get an instant call when a lead comes in. Connect you and the customer immediately.',
              },
              {
                icon: Bell,
                color: 'bg-amber-50 text-amber-600',
                title: 'Smart Follow-Up',
                desc: 'Automatically follow up with customers until the job is booked — no manual effort.',
              },
            ].map((block, i) => (
              <div key={i} className="bg-slate-50 rounded-3xl p-8 border border-slate-100 hover:shadow-xl transition-all">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-5 ${block.color}`}>
                  <block.icon className="w-7 h-7" />
                </div>
                <h3 className="text-xl font-bold mb-3">{block.title}</h3>
                <p className="text-slate-500 leading-relaxed">{block.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Differentiation */}
      <section className="py-20 bg-blue-600 text-white">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-extrabold mb-3">Why LeadBridge is different</h2>
            <p className="text-blue-200 text-lg">Not just another chatbot. A complete lead handling system.</p>
          </div>
          <div className="bg-white/10 backdrop-blur rounded-3xl overflow-hidden border border-white/20">
            <div className="grid grid-cols-2 text-sm font-bold uppercase tracking-wide">
              <div className="px-8 py-4 text-blue-200 border-b border-white/10">Others</div>
              <div className="px-8 py-4 text-white border-b border-white/10">LeadBridge</div>
            </div>
            {[
              ['SMS only', 'Calls + SMS + alerts'],
              ['Per-lead pricing', 'Flat monthly pricing'],
              ['Just first reply', 'Full conversation handling'],
              ['Complex setup', '2-minute setup'],
            ].map(([other, us], i) => (
              <div key={i} className={`grid grid-cols-2 ${i < 3 ? 'border-b border-white/10' : ''}`}>
                <div className="px-8 py-5 text-blue-200/80 flex items-center gap-2">
                  <span className="text-red-400">✕</span> {other}
                </div>
                <div className="px-8 py-5 text-white font-semibold flex items-center gap-2">
                  <span className="text-emerald-400">✓</span> {us}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 bg-white">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-6">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">Pricing</p>
            <h2 className="text-4xl font-extrabold mb-3">Simple, flat pricing.</h2>
            <p className="text-slate-500 text-lg">No per-lead fees. No surprises. Cancel anytime.</p>
          </div>
          <div className="flex justify-center mb-12">
            <div className="inline-flex items-center gap-2 px-5 py-2.5 bg-amber-50 border border-amber-200 rounded-2xl">
              <span className="text-amber-600 font-bold text-sm">🎉 Early Access Pricing — Lock in before public launch</span>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-8">
            {/* Starter */}
            <div className="rounded-3xl border border-slate-200 p-10 flex flex-col hover:shadow-xl transition-all">
              <div className="mb-8">
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">Starter</p>
                <h3 className="text-2xl font-bold mb-1">For getting started</h3>
                <div className="flex items-baseline gap-2 mt-5 mb-1">
                  <span className="text-slate-300 line-through text-xl">$29</span>
                  <span className="text-5xl font-extrabold text-slate-900">$19</span>
                  <span className="text-slate-400">/mo</span>
                </div>
                <p className="text-xs text-amber-600 font-semibold">Early Access Price</p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Lead notifications (SMS alerts)',
                  'First auto-reply only',
                  '1 phone number included',
                  'Manual follow-up & calls',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 text-slate-600 text-sm">
                    <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-emerald-600" />
                    </div>
                    {f}
                  </li>
                ))}
              </ul>
              <Link to="/register" className="block w-full py-4 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all">
                Start Early Access
              </Link>
            </div>

            {/* Pro */}
            <div className="rounded-3xl border-2 border-blue-600 p-10 flex flex-col shadow-2xl shadow-blue-100 scale-[1.02] relative">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full flex items-center gap-1.5">
                <Star className="w-3 h-3" /> Most Popular
              </div>
              <div className="mb-8">
                <p className="text-xs font-bold uppercase tracking-widest text-blue-600 mb-2">Pro</p>
                <h3 className="text-2xl font-bold mb-1">Best for growing businesses</h3>
                <div className="flex items-baseline gap-2 mt-5 mb-1">
                  <span className="text-slate-300 line-through text-xl">$99</span>
                  <span className="text-5xl font-extrabold text-slate-900">$49</span>
                  <span className="text-slate-400">/mo</span>
                </div>
                <p className="text-xs text-amber-600 font-semibold">Early Access Price</p>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Full auto-replies (ongoing conversations)',
                  '2-way messaging (SMS + calls)',
                  'Call connect (instant call to new leads)',
                  ['Automatic follow-ups', '(coming soon)'],
                  'Handles up to 500 leads/month',
                  'Everything in Starter',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 text-slate-700 text-sm font-medium">
                    <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                    {Array.isArray(f) ? (
                      <span>{f[0]} <span className="text-slate-400 font-normal">{f[1]}</span></span>
                    ) : f}
                  </li>
                ))}
              </ul>
              <Link to="/register" className="block w-full py-4 text-center bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200">
                Start Early Access
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Trust */}
      <section className="py-16 bg-slate-50 border-y border-slate-100">
        <div className="max-w-4xl mx-auto px-6">
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-6">
            {[
              { emoji: '⚡', text: 'Setup in under 2 minutes' },
              { emoji: '🔌', text: 'Works with your existing leads' },
              { emoji: '📋', text: 'No contracts required' },
              { emoji: '↩️', text: 'Cancel anytime' },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 bg-white rounded-2xl p-4 border border-slate-100 shadow-sm">
                <span className="text-2xl">{item.emoji}</span>
                <p className="text-sm font-semibold text-slate-700">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 bg-white">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-4xl lg:text-5xl font-extrabold mb-5 leading-tight">
            Start handling every lead<br />automatically today.
          </h2>
          <p className="text-xl text-slate-500 mb-10">Join pros already using LeadBridge to respond faster and book more jobs.</p>
          <Link to="/register" className="inline-flex items-center gap-3 px-10 py-5 bg-blue-600 text-white rounded-2xl text-xl font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-200 group">
            Start Early Access
            <ArrowRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
          </Link>
          <div className="flex flex-wrap justify-center gap-6 mt-8 text-sm text-slate-400 font-medium">
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> No per-lead fees</span>
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> Setup in 2 minutes</span>
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4 text-emerald-500" /> Cancel anytime</span>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-10 border-t border-slate-100">
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
            <a href="mailto:support@leadbridge360.com" className="hover:text-blue-600 transition-colors">Support</a>
          </div>
        </div>
      </footer>

    </div>
  );
}
