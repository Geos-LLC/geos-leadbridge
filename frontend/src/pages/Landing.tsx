import { Link } from 'react-router-dom';
import {
  Zap, ArrowUpRight, ArrowRight, Check, X, Clock, DollarSign,
  Users, AlertCircle, Twitter, Linkedin
} from 'lucide-react';
import leadConversationImg from '../assets/lead-conversation-thumbtack.png';

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
            <Link to="/login" className="text-sm font-semibold text-slate-600 hover:text-blue-600">Sign In</Link>
            <Link to="/register" className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow-md">Start Free Trial</Link>
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
            <div className="flex flex-wrap items-center gap-4">
              <Link to="/register" className="inline-flex items-center gap-3 px-8 py-4 bg-blue-600 text-white rounded-2xl text-lg font-bold hover:bg-blue-700 transition-all shadow-xl shadow-blue-200 group">
                Start Free Trial — First 10 Leads Free
                <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
              </Link>
              <Link to="/demo" className="inline-flex items-center gap-2 px-6 py-3.5 border-2 border-slate-200 text-slate-700 rounded-2xl text-sm font-bold hover:border-blue-300 hover:text-blue-600 transition-all">
                See It In Action
              </Link>
            </div>

            <div className="mt-12 flex items-center gap-4">
              <div className="flex -space-x-3">
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1560066984-138dadb4c035?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 1" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1633332755192-727a05c4013d?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 2" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 3" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 4" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 5" className="w-full h-full object-cover" />
                </div>
                <div className="w-12 h-12 rounded-full border-4 border-white overflow-hidden bg-slate-200">
                  <img src="https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&q=80&w=100&h=100" alt="Pro 6" className="w-full h-full object-cover" />
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
              <img src={leadConversationImg} alt="Lead Conversation on Thumbtack" className="w-full h-full object-cover" />
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

      {/* Still Not Sure? */}
      <section className="py-16 bg-white">
        <div className="max-w-2xl mx-auto px-6 text-center">
          <h3 className="text-2xl font-extrabold text-slate-900 mb-3">Still not sure?</h3>
          <p className="text-lg text-slate-500 mb-8">Watch how LeadBridge replies in real time.</p>
          <Link to="/demo" className="inline-flex items-center gap-2 px-8 py-4 bg-slate-900 text-white rounded-2xl text-lg font-bold hover:bg-slate-800 transition-all shadow-lg">
            See Live Demo
            <ArrowRight className="w-5 h-5" />
          </Link>
        </div>
      </section>

      {/* How it Works */}
      <section id="how-it-works" className="py-24 bg-slate-50">
        <div className="max-w-7xl mx-auto px-6">
          <div className="text-center mb-16">
            <span className="text-blue-600 font-bold tracking-widest uppercase text-sm">⚙️ HOW IT WORKS</span>
            <h2 className="text-4xl font-extrabold text-slate-900 mt-4">Simple, Powerful, Automated.</h2>
          </div>
          <div className="grid md:grid-cols-5 gap-6">
            {/* Step 1 - New Lead - amber */}
            <div className="flex flex-col items-center gap-4">
              <span className="text-[11px] font-bold tracking-wider text-slate-400">STEP 1</span>
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center relative overflow-hidden"
                style={{ background: 'linear-gradient(145deg, #2a1f0a, #1a1308)' }}>
                <div className="absolute inset-0 rounded-[22px]" style={{ padding: '1.5px', background: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.03))', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10" style={{ filter: 'drop-shadow(0 0 8px rgba(245,158,11,0.3))' }}>
                  <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>
                  <circle cx="9" cy="7" r="4"/>
                  <line x1="19" y1="8" x2="19" y2="14"/>
                  <line x1="22" y1="11" x2="16" y2="11"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-center text-slate-500 max-w-[120px] leading-snug">New lead comes in</p>
            </div>

            {/* Step 2 - Detect - blue */}
            <div className="flex flex-col items-center gap-4">
              <span className="text-[11px] font-bold tracking-wider text-slate-400">STEP 2</span>
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center relative overflow-hidden"
                style={{ background: 'linear-gradient(145deg, #0a1a2a, #081320)' }}>
                <div className="absolute inset-0 rounded-[22px]" style={{ padding: '1.5px', background: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.03))', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10" style={{ filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.3))' }}>
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-center text-slate-500 max-w-[120px] leading-snug">LeadBridge detects it instantly</p>
            </div>

            {/* Step 3 - AI Reply - purple */}
            <div className="flex flex-col items-center gap-4">
              <span className="text-[11px] font-bold tracking-wider text-slate-400">STEP 3</span>
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center relative overflow-hidden"
                style={{ background: 'linear-gradient(145deg, #1a0a2a, #130820)' }}>
                <div className="absolute inset-0 rounded-[22px]" style={{ padding: '1.5px', background: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.03))', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="#a855f7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10" style={{ filter: 'drop-shadow(0 0 8px rgba(168,85,247,0.3))' }}>
                  <path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.8-3.5 6l-.5.3V18H9v-2.7l-.5-.3C6.3 13.8 5 11.5 5 9a7 7 0 0 1 7-7z"/>
                  <line x1="9" y1="21" x2="15" y2="21"/>
                  <path d="M10 18v1a2 2 0 0 0 4 0v-1"/>
                  <path d="M9.5 9h1.5l1 2 1.5-4 1 2h1"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-center text-slate-500 max-w-[120px] leading-snug">AI sends optimized first reply</p>
            </div>

            {/* Step 4 - Follow-ups - teal */}
            <div className="flex flex-col items-center gap-4">
              <span className="text-[11px] font-bold tracking-wider text-slate-400">STEP 4</span>
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center relative overflow-hidden"
                style={{ background: 'linear-gradient(145deg, #0a2a1f, #082018)' }}>
                <div className="absolute inset-0 rounded-[22px]" style={{ padding: '1.5px', background: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.03))', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10" style={{ filter: 'drop-shadow(0 0 8px rgba(16,185,129,0.3))' }}>
                  <polyline points="17 1 21 5 17 9"/>
                  <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                  <polyline points="7 23 3 19 7 15"/>
                  <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-center text-slate-500 max-w-[120px] leading-snug">Follow-ups triggered automatically</p>
            </div>

            {/* Step 5 - You Jump In - rose */}
            <div className="flex flex-col items-center gap-4">
              <span className="text-[11px] font-bold tracking-wider text-slate-400">STEP 5</span>
              <div className="w-[88px] h-[88px] rounded-[22px] flex items-center justify-center relative overflow-hidden"
                style={{ background: 'linear-gradient(145deg, #2a0a1a, #200815)' }}>
                <div className="absolute inset-0 rounded-[22px]" style={{ padding: '1.5px', background: 'linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.03))', WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)', WebkitMaskComposite: 'xor', maskComposite: 'exclude' }} />
                <svg viewBox="0 0 24 24" fill="none" stroke="#f43f5e" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="w-10 h-10" style={{ filter: 'drop-shadow(0 0 8px rgba(244,63,94,0.3))' }}>
                  <path d="M20 21v-2a4 4 0 0 0-3-3.87"/>
                  <path d="M4 21v-2a4 4 0 0 1 3-3.87"/>
                  <circle cx="12" cy="7" r="4"/>
                  <path d="M8 21l2-4h4l2 4"/>
                </svg>
              </div>
              <p className="text-sm font-medium text-center text-slate-500 max-w-[120px] leading-snug">You jump in when customer responds</p>
            </div>
          </div>
          <div className="text-center mt-12">
            <p className="text-xl font-bold text-slate-900">You stay in control. But you're never slow again.</p>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-6">
            <span className="text-blue-600 font-bold tracking-widest uppercase text-sm">💰 PRICING</span>
            <h2 className="text-4xl font-extrabold text-slate-900 mt-4">Simple, Honest Pricing</h2>
            <p className="text-slate-500 mt-3 text-lg">All plans include a 14-day money-back guarantee.</p>
          </div>
          <div className="flex justify-center mb-12">
            <div className="bg-amber-50 border border-amber-200 px-6 py-3 rounded-2xl text-center">
              <span className="text-amber-800 font-bold text-sm">🎉 Early Access Pricing</span>
              <span className="text-amber-600 text-sm ml-2">— Lock in lower rates before we launch publicly</span>
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto">
            {/* Starter */}
            <div className="bg-white p-10 rounded-[2.5rem] border border-slate-100 shadow-sm hover:shadow-xl transition-all flex flex-col">
              <h3 className="text-xl font-bold mb-1">Starter</h3>
              <p className="text-slate-500 text-sm mb-5">Never miss a lead</p>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-slate-400 line-through text-lg font-medium">$29</span>
                <span className="text-4xl font-extrabold text-slate-900">$19</span>
                <span className="text-slate-400 font-medium">/month</span>
              </div>
              <p className="text-xs text-amber-600 font-semibold mb-6">Early Access Price</p>
              <ul className="space-y-3 mb-8 flex-1">
                <li className="flex items-center gap-3 text-slate-600 text-sm"><div className="rounded-full p-1 bg-emerald-100 text-emerald-600 shrink-0"><Check className="w-3 h-3" /></div> Instant lead notifications (SMS alerts)</li>
                <li className="flex items-center gap-3 text-slate-600 text-sm"><div className="rounded-full p-1 bg-emerald-100 text-emerald-600 shrink-0"><Check className="w-3 h-3" /></div> Basic auto-reply (first message only)</li>
                <li className="flex items-center gap-3 text-slate-600 text-sm"><div className="rounded-full p-1 bg-emerald-100 text-emerald-600 shrink-0"><Check className="w-3 h-3" /></div> 1 phone number included</li>
                <li className="flex items-center gap-3 text-slate-600 text-sm"><div className="rounded-full p-1 bg-emerald-100 text-emerald-600 shrink-0"><Check className="w-3 h-3" /></div> Manual follow-up & calls</li>
              </ul>
              <p className="text-xs text-slate-400 italic mb-4">Perfect for solo operators getting started</p>
              <Link to="/register" className="block w-full py-4 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all">Start Free Trial</Link>
            </div>

            {/* Pro */}
            <div className="bg-white p-10 rounded-[2.5rem] border-2 border-blue-600 shadow-2xl shadow-blue-100 scale-[1.02] relative flex flex-col">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full">Most Popular</div>
              <h3 className="text-xl font-bold mb-1">Pro</h3>
              <p className="text-slate-500 text-sm mb-5">Automatically handle every lead</p>
              <div className="flex items-baseline gap-2 mb-1">
                <span className="text-slate-400 line-through text-lg font-medium">$99</span>
                <span className="text-4xl font-extrabold text-slate-900">$49</span>
                <span className="text-slate-400 font-medium">/month</span>
              </div>
              <p className="text-xs text-amber-600 font-semibold mb-6">Early Access Price</p>
              <ul className="space-y-3 mb-8 flex-1">
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> Full auto-replies (ongoing conversations)</li>
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> 2-way messaging (SMS + calls)</li>
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> Call connect (instant call to new leads)</li>
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> Automatic follow-ups <span className="text-slate-400 font-normal">(coming soon)</span></li>
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> Handles up to 500 leads/month</li>
                <li className="flex items-center gap-3 text-slate-700 text-sm font-medium"><div className="rounded-full p-1 bg-blue-600 text-white shrink-0"><Check className="w-3 h-3" /></div> Everything in Starter, included</li>
              </ul>
              <p className="text-xs text-slate-400 italic mb-4">Best for growing businesses that want more bookings with less effort</p>
              <Link to="/register" className="block w-full py-4 text-center bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200">Get Started</Link>
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
          <p className="text-slate-400 text-sm">© 2025 LeadBridge AI. Built for the Home Service Industry.</p>
          <div className="flex items-center gap-6 text-slate-400">
            <Link to="/demo" className="text-sm hover:text-blue-600 transition-colors">Demo</Link>
            <a href="#" className="hover:text-blue-600 transition-colors"><Twitter className="w-5 h-5" /></a>
            <a href="#" className="hover:text-blue-600 transition-colors"><Linkedin className="w-5 h-5" /></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
