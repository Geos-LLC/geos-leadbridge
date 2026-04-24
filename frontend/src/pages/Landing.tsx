import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { notificationsApi } from '../services/api';
import {
  Check,
  Phone,
  MessageSquare,
  Bell,
  ArrowRight,
  Star,
  Zap,
  TrendingUp,
  Timer,
  BarChart3,
  Sparkles,
  RefreshCw,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import leadConversationImg from '../assets/lead-conversation-thumbtack.png';
import { trackEvent } from '../services/analytics';

export function Landing() {
  const [extraNumberPrice, setExtraNumberPrice] = useState<number | null>(null);

  useEffect(() => {
    trackEvent('landing_page_viewed', { source_page: 'landing' });
    notificationsApi.getPhonePricing()
      .then(r => { if (r.success) setExtraNumberPrice(r.data.priceMonthly); })
      .catch(() => {});
  }, []);

  const trackUpgrade = (planType: string, entryPoint: string) =>
    trackEvent('upgrade_clicked', { plan_type: planType, entry_point: entryPoint });

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
            <a href="#demo" className="hover:text-blue-600 transition-colors">Demo</a>
            <a href="#pricing" className="hover:text-blue-600 transition-colors">Pricing</a>
          </div>
          <div className="flex items-center gap-3">
            <Link to="/login" className="text-sm font-semibold text-slate-500 hover:text-blue-600 transition-colors hidden sm:block">Sign In</Link>
            <Link to="/register" className="px-4 py-2 bg-blue-600 text-white rounded-xl text-sm font-bold hover:bg-blue-700 transition-all shadow">Start Free Trial</Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <header className="pt-32 pb-20 lg:pt-44 lg:pb-32 px-6 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-blue-50/60 via-white to-white -z-10" />
        <div className="absolute top-20 right-0 w-[600px] h-[600px] bg-blue-100/30 rounded-full blur-3xl -z-10" />
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-blue-50 border border-blue-200 text-blue-700 text-xs font-bold uppercase tracking-wider mb-8">
              <span className="w-2 h-2 bg-blue-500 rounded-full animate-pulse" />
              For Thumbtack & Yelp Pros
            </div>
            <h1 className="text-5xl lg:text-6xl font-extrabold leading-[1.08] tracking-tight mb-6">
              Win more leads<br />
              <span className="text-blue-600">without chasing them.</span>
            </h1>
            <p className="text-xl text-slate-600 leading-relaxed mb-5 max-w-lg">
              Respond instantly, follow up automatically, and convert more jobs from Thumbtack and Yelp — all in one place.
            </p>
            <p className="text-sm text-slate-500 leading-relaxed mb-8 max-w-lg">
              Built for cleaning companies and home service pros who want faster replies, fewer missed leads, and more booked jobs.
            </p>
            <div className="flex flex-wrap gap-4 mb-10">
              <Link to="/register" onClick={() => trackUpgrade('unknown', 'hero')} className="inline-flex items-center gap-2 px-7 py-4 bg-blue-600 text-white rounded-2xl text-base font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 group">
                Start Free Trial
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
          <div className="relative hidden lg:block h-[580px]">
            {/* Yelp screenshot — back-left card */}
            <div className="absolute top-6 -left-2 w-[58%] rounded-2xl overflow-hidden shadow-xl border-[6px] border-white bg-white -rotate-2 z-10 transition-transform duration-300 hover:-rotate-1">
              <div className="absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/95 backdrop-blur rounded-full shadow-sm border border-slate-100">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                <span className="text-[10px] font-black tracking-wider text-red-600">YELP</span>
              </div>
              <img src="/yelp-screen.jpg" alt="Yelp for Business lead conversation" className="w-full h-auto block" />
            </div>

            {/* Thumbtack mockup — foreground card */}
            <div className="absolute top-0 right-0 w-[58%] rounded-3xl overflow-hidden shadow-2xl border-8 border-white bg-slate-100 rotate-1 z-20 transition-transform duration-300 hover:rotate-0">
              <div className="absolute top-3 left-3 z-10 inline-flex items-center gap-1.5 px-2.5 py-1 bg-white/95 backdrop-blur rounded-full shadow-sm border border-slate-100">
                <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />
                <span className="text-[10px] font-black tracking-wider text-blue-700">THUMBTACK</span>
              </div>
              <img src={leadConversationImg} alt="LeadBridge handling a Thumbtack lead" className="w-full h-full object-cover" />
            </div>

            {/* Floating social-proof card — bottom-right so it doesn't cover Yelp */}
            <div className="absolute -bottom-4 right-2 bg-white rounded-2xl shadow-xl p-5 max-w-xs border border-slate-100 z-30">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 bg-emerald-100 rounded-full flex items-center justify-center shrink-0">
                  <Check className="w-5 h-5 text-emerald-600" />
                </div>
                <div>
                  <p className="text-xs text-slate-400 font-semibold uppercase">Auto-Replied</p>
                  <p className="font-bold text-slate-900 text-sm">Response sent in 4 seconds</p>
                </div>
              </div>
              <p className="text-sm text-slate-500 italic">"Hi! Thanks for reaching out — I'd love to help. What's the best time to connect?"</p>
            </div>

            {/* "Works with both" chip — bridges the two cards */}
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 bg-slate-900 text-white text-[11px] font-bold tracking-wider uppercase px-3 py-1.5 rounded-full shadow-lg">
              Works with both
            </div>
          </div>
        </div>
      </header>

      {/* Pain */}
      <section className="py-20 bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto px-6">
          <div className="text-center mb-14">
            <p className="text-blue-400 font-bold uppercase tracking-widest text-sm mb-4">The Problem</p>
            <h2 className="text-4xl font-extrabold mb-4">You're losing leads — not because of price, but timing.</h2>
          </div>
          <div className="grid md:grid-cols-2 gap-4 max-w-3xl mx-auto mb-10">
            {[
              "You don't reply fast enough",
              'You miss messages while working',
              'Leads go silent after the first message',
              "You don't have time to follow up",
              'Conversations die before booking',
            ].map((pain, i) => (
              <div key={i} className="flex items-start gap-3 bg-slate-800 rounded-2xl px-5 py-4 border border-slate-700">
                <span className="text-red-400 text-lg leading-none mt-0.5">✕</span>
                <p className="text-slate-200 font-medium">{pain}</p>
              </div>
            ))}
          </div>
          <p className="text-center text-xl text-blue-300 font-bold">
            And every missed reply = lost revenue.
          </p>
        </div>
      </section>

      {/* Value — core product */}
      <section id="how" className="py-24 bg-white">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-16">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">How It Works</p>
            <h2 className="text-4xl font-extrabold">One system to handle every lead —<br />from first message to booking.</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8 mb-20">
            {[
              {
                icon: Zap,
                color: 'bg-blue-50 text-blue-600',
                label: 'Respond instantly',
                tagline: 'Be the first to reply — automatically.',
                bullets: [
                  'Send a reply the moment a lead arrives',
                  'Include pricing or ask for missing details',
                  'Reply from your phone without opening apps',
                ],
              },
              {
                icon: RefreshCw,
                color: 'bg-emerald-50 text-emerald-600',
                label: 'Stay in control',
                tagline: "Don't lose leads that go silent.",
                bullets: [
                  'Send follow-ups automatically',
                  'Get notified when a lead responds',
                  'Call or text at the right moment',
                ],
              },
              {
                icon: Sparkles,
                color: 'bg-violet-50 text-violet-600',
                label: 'Let the system convert for you',
                tagline: 'Stop managing conversations manually.',
                bullets: [
                  'AI handles replies and follow-ups',
                  'Adjusts based on customer responses',
                  'Moves leads toward booking',
                ],
              },
            ].map((block, i) => (
              <div key={i} className="bg-slate-50 rounded-3xl p-8 border border-slate-100 hover:shadow-xl transition-all flex flex-col">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center mb-5 ${block.color}`}>
                  <block.icon className="w-7 h-7" />
                </div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">{`Step ${i + 1}`}</p>
                <h3 className="text-xl font-bold mb-2">{block.label}</h3>
                <p className="text-slate-500 mb-5 italic">{block.tagline}</p>
                <ul className="space-y-2.5">
                  {block.bullets.map((b, j) => (
                    <li key={j} className="flex items-start gap-2.5 text-sm text-slate-700">
                      <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Platform-specific */}
          <div className="bg-gradient-to-br from-slate-50 to-blue-50/50 rounded-3xl border border-slate-100 p-10">
            <div className="text-center mb-10">
              <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-3">🎯 Built for how you actually work</p>
              <h3 className="text-2xl font-extrabold">Tuned for each platform.</h3>
            </div>
            <div className="grid md:grid-cols-2 gap-6">
              <div className="bg-white rounded-2xl p-7 border border-slate-100">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
                    <Phone className="w-5 h-5 text-emerald-600" />
                  </div>
                  <h4 className="font-bold text-lg">For Thumbtack users</h4>
                </div>
                <ul className="space-y-2.5">
                  <li className="flex items-start gap-2.5 text-sm text-slate-700">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <span>Call leads instantly</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-sm text-slate-700">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <span>Respond faster than competitors</span>
                  </li>
                </ul>
              </div>
              <div className="bg-white rounded-2xl p-7 border border-slate-100">
                <div className="flex items-center gap-3 mb-4">
                  <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center">
                    <MessageSquare className="w-5 h-5 text-red-600" />
                  </div>
                  <h4 className="font-bold text-lg">For Yelp users</h4>
                </div>
                <ul className="space-y-2.5">
                  <li className="flex items-start gap-2.5 text-sm text-slate-700">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <span>Handle high volume conversations</span>
                  </li>
                  <li className="flex items-start gap-2.5 text-sm text-slate-700">
                    <Check className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                    <span>Follow up and capture more responses</span>
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Demo */}
      <section id="demo" className="py-24 bg-slate-50 border-y border-slate-100">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">See It In Action</p>
            <h2 className="text-4xl font-extrabold">See how it works in seconds.</h2>
          </div>
          <div className="grid md:grid-cols-5 gap-4 mb-10">
            {[
              { step: '1', title: 'New lead arrives', icon: Bell, color: 'bg-blue-50 text-blue-600' },
              { step: '2', title: 'Instant reply sent', icon: Zap, color: 'bg-emerald-50 text-emerald-600' },
              { step: '3', title: 'Follow-ups triggered', icon: RefreshCw, color: 'bg-amber-50 text-amber-600' },
              { step: '4', title: 'Lead responds — you get notified', icon: MessageSquare, color: 'bg-violet-50 text-violet-600' },
              { step: '5', title: 'AI continues or you take over', icon: Sparkles, color: 'bg-pink-50 text-pink-600' },
            ].map((s, i) => (
              <div key={i} className="bg-white rounded-2xl p-5 border border-slate-100 shadow-sm text-center">
                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center mx-auto mb-3 ${s.color}`}>
                  <s.icon className="w-6 h-6" />
                </div>
                <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">Step {s.step}</p>
                <p className="text-sm font-semibold text-slate-800 leading-snug">{s.title}</p>
              </div>
            ))}
          </div>
          <div className="bg-white rounded-3xl border-2 border-dashed border-slate-200 aspect-video flex items-center justify-center">
            <div className="text-center">
              <div className="w-20 h-20 rounded-full bg-blue-600 text-white flex items-center justify-center mx-auto mb-4 shadow-xl shadow-blue-200">
                <svg className="w-8 h-8 ml-1" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
              </div>
              <p className="text-slate-500 font-medium">Demo video coming soon</p>
            </div>
          </div>
        </div>
      </section>

      {/* Benefits */}
      <section className="py-20 bg-white">
        <div className="max-w-5xl mx-auto px-6">
          <div className="text-center mb-12">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">What You Get</p>
            <h2 className="text-4xl font-extrabold">More leads booked. Less work on your end.</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-5">
            {[
              { icon: Zap, color: 'bg-blue-50 text-blue-600', title: 'Faster response times' },
              { icon: TrendingUp, color: 'bg-emerald-50 text-emerald-600', title: 'Higher conversion rate' },
              { icon: Timer, color: 'bg-amber-50 text-amber-600', title: 'Less manual work' },
              { icon: MessageSquare, color: 'bg-violet-50 text-violet-600', title: 'Centralized communication' },
              { icon: BarChart3, color: 'bg-pink-50 text-pink-600', title: 'Clear performance insights' },
            ].map((b, i) => (
              <div key={i} className="bg-slate-50 rounded-2xl p-6 border border-slate-100 text-center">
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center mx-auto mb-4 ${b.color}`}>
                  <b.icon className="w-6 h-6" />
                </div>
                <p className="text-sm font-bold text-slate-800 leading-tight">{b.title}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-24 bg-slate-50 border-t border-slate-100">
        <div className="max-w-6xl mx-auto px-6">
          <div className="text-center mb-14">
            <p className="text-blue-600 font-bold uppercase tracking-widest text-sm mb-4">Pricing</p>
            <h2 className="text-4xl font-extrabold mb-3">Choose how much LeadBridge should handle for you.</h2>
            <p className="text-slate-500 text-lg">Flat monthly pricing. No per-lead fees. Cancel anytime.</p>
          </div>
          <div className="grid md:grid-cols-3 gap-6 mb-10">
            {/* Respond */}
            <div className="rounded-3xl border border-slate-200 bg-white p-8 flex flex-col hover:shadow-xl transition-all">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-3 h-3 rounded-full bg-emerald-500" />
                <p className="text-xs font-bold uppercase tracking-widest text-emerald-700">Respond</p>
              </div>
              <h3 className="text-xl font-bold mb-1">Instant Reply (sent on Yelp/Thumbtack)</h3>
              <div className="flex items-baseline gap-1.5 mt-5 mb-8">
                <span className="text-5xl font-extrabold text-slate-900">$39</span>
                <span className="text-slate-400">/mo</span>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Automatically respond to every new lead',
                  'Get lead details + phone (when available)',
                  'Instant SMS / call alerts',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 text-slate-700 text-sm">
                    <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-emerald-600" />
                    </div>
                    {f}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-500 mb-5">You continue the conversation manually</p>
              <Link to="/register" onClick={() => trackUpgrade('respond', 'pricing_card')} className="block w-full py-3.5 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all">
                Start Free Trial
              </Link>
            </div>

            {/* Engage */}
            <div className="rounded-3xl border-2 border-blue-600 bg-white p-8 flex flex-col shadow-2xl shadow-blue-100 relative md:-my-3">
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-blue-600 text-white text-[10px] font-black uppercase tracking-widest px-4 py-1.5 rounded-full flex items-center gap-1.5">
                <Star className="w-3 h-3" /> Most Popular
              </div>
              <div className="flex items-center gap-2 mb-4">
                <span className="w-3 h-3 rounded-full bg-blue-500" />
                <p className="text-xs font-bold uppercase tracking-widest text-blue-700">Engage</p>
              </div>
              <h3 className="text-xl font-bold mb-1">Follow up, react faster, and capture more leads</h3>
              <div className="flex items-baseline gap-1.5 mt-5 mb-8">
                <span className="text-5xl font-extrabold text-slate-900">$89</span>
                <span className="text-slate-400">/mo</span>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Everything in Respond',
                  'Automated follow-ups',
                  'Re-engagement alerts',
                  'Instant call (Thumbtack)',
                  'Call when phone appears (Yelp)',
                  'SMS communication',
                  'Advanced analytics',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 text-slate-700 text-sm font-medium">
                    <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-white" />
                    </div>
                    {f}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-500 mb-5"><span className="font-semibold text-slate-700">Best for:</span> serious operators & growing teams</p>
              <Link to="/register" onClick={() => trackUpgrade('engage', 'pricing_card')} className="block w-full py-3.5 text-center bg-blue-600 text-white rounded-2xl font-bold hover:bg-blue-700 transition-all shadow-lg shadow-blue-200">
                Start Free Trial
              </Link>
            </div>

            {/* Convert (AI) */}
            <div className="rounded-3xl border border-slate-200 bg-white p-8 flex flex-col hover:shadow-xl transition-all">
              <div className="flex items-center gap-2 mb-4">
                <span className="w-3 h-3 rounded-full bg-violet-500" />
                <p className="text-xs font-bold uppercase tracking-widest text-violet-700">Convert · AI</p>
              </div>
              <h3 className="text-xl font-bold mb-1">Let AI handle conversations and convert leads</h3>
              <div className="flex items-baseline gap-1.5 mt-5 mb-8">
                <span className="text-5xl font-extrabold text-slate-900">$139</span>
                <span className="text-slate-400">/mo</span>
              </div>
              <ul className="space-y-3 flex-1 mb-8">
                {[
                  'Everything in Engage',
                  'AI-powered conversation (not just first message)',
                  'Adaptive replies based on customer responses',
                  'AI pricing & qualification logic',
                  'Smart conversation summaries',
                  'Full analytics',
                ].map((f, i) => (
                  <li key={i} className="flex items-start gap-3 text-slate-700 text-sm">
                    <div className="w-5 h-5 rounded-full bg-violet-100 flex items-center justify-center shrink-0 mt-0.5">
                      <Check className="w-3 h-3 text-violet-600" />
                    </div>
                    {f}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-500 mb-5"><span className="font-semibold text-slate-700">Best for:</span> high-volume & scaling businesses</p>
              <Link to="/register" onClick={() => trackUpgrade('convert', 'pricing_card')} className="block w-full py-3.5 text-center bg-slate-900 text-white rounded-2xl font-bold hover:bg-slate-800 transition-all">
                Start Free Trial
              </Link>
            </div>
          </div>

          {/* Add-ons */}
          <div className="bg-white rounded-3xl border border-slate-200 p-8">
            <div className="flex items-start gap-5 flex-col sm:flex-row sm:items-center">
              <div className="w-14 h-14 rounded-2xl bg-slate-100 flex items-center justify-center shrink-0">
                <Plus className="w-7 h-7 text-slate-600" />
              </div>
              <div className="flex-1">
                <div className="flex items-baseline gap-3 flex-wrap mb-1">
                  <h3 className="text-lg font-bold">Extra Numbers / Locations</h3>
                  <span className="text-sm font-bold text-blue-600">
                    +${extraNumberPrice != null ? extraNumberPrice.toFixed(0) : '20'} per number
                  </span>
                </div>
                <p className="text-sm text-slate-500 leading-relaxed">
                  Separate communication per business · Multi-location setup · Team routing <span className="text-slate-400">(coming soon)</span>
                </p>
                <p className="text-xs text-slate-400 mt-1">First number is included with Engage and Convert.</p>
              </div>
              <Link
                to="/register?intent=extra_number"
                onClick={() => trackUpgrade('extra_number', 'addon_card')}
                className="shrink-0 px-5 py-3 bg-blue-600 text-white rounded-xl font-bold text-sm hover:bg-blue-700 transition-all shadow-lg shadow-blue-200 whitespace-nowrap"
              >
                Get started
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Social Proof / Trust */}
      <section className="py-16 bg-white">
        <div className="max-w-4xl mx-auto px-6 text-center">
          <p className="text-slate-500 font-bold uppercase tracking-widest text-sm mb-6">Social Proof</p>
          <h2 className="text-2xl md:text-3xl font-extrabold text-slate-900 mb-10">
            Trusted by home service pros across the U.S.
          </h2>
          <div className="grid sm:grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { emoji: '⚡', text: 'Setup in under 2 minutes' },
              { emoji: '🔌', text: 'Works with your existing leads' },
              { emoji: '📋', text: 'No contracts required' },
              { emoji: '↩️', text: 'Cancel anytime' },
            ].map((item, i) => (
              <div key={i} className="flex items-center gap-3 bg-slate-50 rounded-2xl p-4 border border-slate-100">
                <span className="text-2xl">{item.emoji}</span>
                <p className="text-sm font-semibold text-slate-700 text-left">{item.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Privacy & Security */}
      <section className="py-20 bg-slate-50 border-y border-slate-100">
        <div className="max-w-4xl mx-auto px-6">
          <div className="bg-white rounded-3xl border border-slate-200 shadow-sm p-8 md:p-12">
            <div className="flex flex-col md:flex-row gap-8 items-start">
              <div className="w-14 h-14 rounded-2xl bg-blue-50 text-blue-600 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <p className="text-blue-600 font-bold uppercase tracking-widest text-xs mb-3">Private by design</p>
                <h2 className="text-2xl md:text-3xl font-extrabold text-slate-900 mb-4 leading-tight">
                  Your leads and customer conversations stay private.
                </h2>
                <p className="text-slate-600 leading-relaxed mb-5">
                  Each business has its own protected data boundary. Your messages, follow-ups,
                  and platform connections are used only to power your own automation —
                  <strong className="text-slate-900"> we don't sell customer data and we don't use your conversations to train public AI models.</strong>
                </p>
                <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-2 text-sm text-slate-600 mb-6">
                  {[
                    'Tenant-level data separation',
                    'Encrypted credentials & connections',
                    'Restricted internal/support access',
                    'Audit logging on sensitive actions',
                  ].map((item) => (
                    <li key={item} className="flex items-start gap-2">
                      <Check className="w-4 h-4 text-emerald-500 mt-0.5 shrink-0" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
                <Link
                  to="/security"
                  className="inline-flex items-center gap-2 text-sm font-bold text-blue-600 hover:text-blue-700 transition-colors group"
                >
                  Read our full security & data privacy page
                  <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-24 bg-gradient-to-br from-blue-600 to-blue-700 text-white">
        <div className="max-w-3xl mx-auto px-6 text-center">
          <h2 className="text-4xl lg:text-5xl font-extrabold mb-5 leading-tight">
            Stop missing leads.<br />Start converting them.
          </h2>
          <p className="text-xl text-blue-100 mb-10">Get your first leads handled automatically.</p>
          <Link to="/register" onClick={() => trackUpgrade('unknown', 'final_cta')} className="inline-flex items-center gap-3 px-10 py-5 bg-white text-blue-700 rounded-2xl text-xl font-bold hover:bg-blue-50 transition-all shadow-xl group">
            Start Free Trial
            <ArrowRight className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
          </Link>
          <div className="flex flex-wrap justify-center gap-6 mt-8 text-sm text-blue-100 font-medium">
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4" /> No per-lead fees</span>
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4" /> Setup in 2 minutes</span>
            <span className="flex items-center gap-1.5"><Check className="w-4 h-4" /> Cancel anytime</span>
          </div>
        </div>
      </section>

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
