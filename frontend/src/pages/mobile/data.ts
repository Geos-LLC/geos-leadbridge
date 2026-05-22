// Mock fixtures for the mobile design preview. Ported from the design
// handoff's data.jsx — treat as the API contract. Real LB data wiring
// (zustand stores, react-query selectors) lands in a follow-up PR; this
// file exists so designers/PMs can click through the mobile flow on
// staging without any backend dependency.

export type Platform = 'thumbtack' | 'yelp' | 'angi' | 'google';
export type LeadStatus = 'new' | 'replied' | 'quoted' | 'won' | 'lost';
export type AiStatus = 'waiting' | 'replied' | 'handed-off';
export type AccountStatus = 'connected' | 'warning';

export interface MobileAccount {
  id: string;
  platform: Platform;
  name: string;
  shortName: string;
  city: string;
  status: AccountStatus;
  leadsToday: number;
  issue?: string;
}

export interface MobileMessage {
  from: 'lead' | 'ai' | 'you';
  text: string;
  at: string;
}

export interface MobileLead {
  id: string;
  name: string;
  location: string;
  service: string;
  platform: Platform;
  phone: string;
  amount: number | null;
  status: LeadStatus;
  ai: AiStatus;
  unread: boolean;
  receivedAt: string;
  sort: number;
  messages: MobileMessage[];
  snippet: string;
}

export const LB_PLATFORM_META: Record<Platform, { label: string; color: string; short: string }> = {
  thumbtack: { label: 'Thumbtack', color: '#009fd9', short: 'TT' },
  yelp: { label: 'Yelp', color: '#c4302b', short: 'Y' },
  angi: { label: 'Angi', color: '#ff6153', short: 'A' },
  google: { label: 'Google', color: '#34a853', short: 'G' },
};

export const LB_USER = {
  name: 'Marcus Ryland',
  email: 'marcus@greenfieldlawn.co',
  initials: 'MR',
  business: 'GreenField Lawn & Garden',
  tier: 'Pro',
};

export const LB_ACCOUNTS: MobileAccount[] = [
  { id: 'gf_austin', platform: 'thumbtack', name: 'GreenField — Austin Central', shortName: 'Austin Central', city: 'Austin, TX', status: 'connected', leadsToday: 3 },
  { id: 'gf_cedarpark', platform: 'thumbtack', name: 'GreenField — Cedar Park', shortName: 'Cedar Park', city: 'Cedar Park, TX', status: 'connected', leadsToday: 2 },
  { id: 'gf_roundrock', platform: 'yelp', name: 'GreenField — Round Rock', shortName: 'Round Rock', city: 'Round Rock, TX', status: 'connected', leadsToday: 1 },
  { id: 'gf_pflug', platform: 'angi', name: 'GreenField — Pflugerville', shortName: 'Pflugerville', city: 'Pflugerville, TX', status: 'connected', leadsToday: 0 },
  { id: 'gf_beecave', platform: 'yelp', name: 'GreenField — Bee Cave', shortName: 'Bee Cave', city: 'Bee Cave, TX', status: 'connected', leadsToday: 0 },
  { id: 'gf_westlake', platform: 'angi', name: 'GreenField — West Lake Hills', shortName: 'West Lake', city: 'West Lake Hills', status: 'warning', leadsToday: 0, issue: 'Re-authenticate in 3 days' },
];

export const LB_LEADS: MobileLead[] = [
  {
    id: 'L-8814', name: 'Priya Desai', location: 'Northwood, Austin TX',
    service: 'Weekly lawn mowing', platform: 'thumbtack', phone: '+1 (512) 555-0168',
    amount: 85, status: 'new', ai: 'waiting', unread: true, receivedAt: '6 min ago', sort: 6,
    messages: [{ from: 'lead', text: "Hi — looking for weekly lawn service for a ~5,000 sqft front + back yard. What's your earliest availability?", at: '6m ago' }],
    snippet: 'Looking for weekly lawn service for a ~5,000 sqft yard.',
  },
  {
    id: 'L-8813', name: 'Derek Mulligan', location: 'Cedar Park, Austin TX',
    service: 'Sod installation — 1,200 sqft', platform: 'yelp', phone: '+1 (737) 555-0112',
    amount: 1450, status: 'replied', ai: 'replied', unread: true, receivedAt: '18 min ago', sort: 18,
    messages: [
      { from: 'lead', text: 'Need a quote for Bermuda sod on ~1,200 sqft. Old grass is dead.', at: '24m ago' },
      { from: 'ai', text: 'Hey Derek — thanks for reaching out! Bermuda on 1,200 sqft typically runs $1,200–$1,600 installed with haul-away. Are you flexible on start date this month?', at: '22m ago' },
      { from: 'lead', text: 'Yeah, late April or early May works. Can you come by to measure?', at: '18m ago' },
    ],
    snippet: 'Yeah, late April or early May works. Can you come by to measure?',
  },
  {
    id: 'L-8812', name: 'Teagan O’Byrne', location: 'Round Rock, TX',
    service: 'Hedge trimming + cleanup', platform: 'thumbtack', phone: '+1 (512) 555-0194',
    amount: 220, status: 'quoted', ai: 'replied', unread: false, receivedAt: '1 hr ago', sort: 60,
    messages: [
      { from: 'lead', text: '6 boxwood hedges, overgrown. Also need bagged leaf cleanup.', at: '1h ago' },
      { from: 'ai', text: 'Hi Teagan — sure thing. Typical hedge trim + bag-and-haul on that volume is $180–$240. Want me to send a firm quote and book you in for Friday?', at: '1h ago' },
      { from: 'you', text: 'Sent quote: $220, Friday 10am.', at: '42m ago' },
    ],
    snippet: 'Sent quote: $220, Friday 10am.',
  },
  {
    id: 'L-8810', name: 'Alicia Romero', location: 'Pflugerville, TX',
    service: 'Spring cleanup + mulch', platform: 'angi', phone: '+1 (512) 555-0143',
    amount: 640, status: 'replied', ai: 'waiting', unread: true, receivedAt: '3 hr ago', sort: 180,
    messages: [{ from: 'lead', text: 'Front and back spring cleanup, maybe 12 yards of mulch (brown).', at: '3h ago' }],
    snippet: 'Front and back spring cleanup, maybe 12 yards of mulch.',
  },
  {
    id: 'L-8807', name: 'Brandon Liu', location: 'West Lake Hills, TX',
    service: 'Full yard redesign — consult', platform: 'yelp', phone: '+1 (512) 555-0119',
    amount: null, status: 'replied', ai: 'handed-off', unread: false, receivedAt: 'Yesterday', sort: 1440,
    messages: [
      { from: 'lead', text: 'Want to redo the whole front yard — xeriscape ideas. Budget flexible.', at: '1d ago' },
      { from: 'ai', text: 'Handed this one to you Marcus — looks like a consult-first job.', at: '1d ago' },
    ],
    snippet: 'Want to redo the whole front yard — xeriscape ideas.',
  },
  {
    id: 'L-8804', name: 'Naomi Fletcher', location: 'Austin, TX',
    service: 'Weekly mowing, 0.25 ac', platform: 'thumbtack', phone: '+1 (512) 555-0107',
    amount: 60, status: 'won', ai: 'replied', unread: false, receivedAt: '2 days ago', sort: 2880,
    messages: [
      { from: 'lead', text: 'Starting weekly — this Thursday works?', at: '2d ago' },
      { from: 'you', text: 'Confirmed for Thursday 11am. Will send calendar invite.', at: '2d ago' },
    ],
    snippet: 'Confirmed — started weekly service.',
  },
  {
    id: 'L-8801', name: 'Ken Halvorsen', location: 'Bee Cave, TX',
    service: 'One-time mow + edge', platform: 'yelp', phone: '+1 (512) 555-0188',
    amount: 95, status: 'lost', ai: 'replied', unread: false, receivedAt: '3 days ago', sort: 4320,
    snippet: 'Went with another pro — no reply after 3 follow-ups.',
    messages: [
      { from: 'lead', text: 'How soon can you come out?', at: '3d ago' },
      { from: 'ai', text: 'Earliest is Wednesday. $95 for the package — shall I book?', at: '3d ago' },
    ],
  },
];

export const LB_STATS = {
  today: { newLeads: 5, aiReplies: 4, quotesSent: 2, bookedJobs: 1, responseTimeMedian: '38 sec' },
  week: { leads: 27, replied: 26, booked: 9, revenue: 4320, winRate: 0.33, avgTicket: 480 },
  funnel: [
    { label: 'Leads in', value: 27 },
    { label: 'AI replied', value: 26 },
    { label: 'Quoted', value: 14 },
    { label: 'Booked', value: 9 },
  ],
  sparkLeads: [3, 2, 4, 5, 3, 6, 4],
  sparkRevenue: [420, 280, 560, 610, 380, 780, 640],
};

export const LB_AUTOMATION = {
  instantReply: {
    enabled: true,
    mode: 'ai' as const,
    prompt: 'You are a friendly, helpful estimator for GreenField Lawn. Ask 1–2 qualifying questions (property size, service frequency, access) and give a rough ballpark if possible. Keep replies under 3 sentences.',
    availability: 'always' as const,
  },
  followUps: {
    enabled: true,
    mode: 'ai' as const,
    schedule: [
      { offset: '30 min', label: 'First follow-up' },
      { offset: '3 hours', label: 'Second follow-up' },
      { offset: '1 day', label: 'Third follow-up' },
      { offset: '3 days', label: 'Final nudge' },
    ],
    stopOnReply: true,
  },
  aiStrategy: 'auto' as const,
  instantCall: { enabled: true, mode: 'agent-first' as const },
  alerts: { sms: true, email: true, push: false, recipients: ['+1 (512) 555-0100', 'marcus@greenfieldlawn.co'] },
};

export const LB_AVAILABILITY = {
  timezone: 'America/Chicago',
  weekdays: {
    mon: { on: true, start: '07:00', end: '18:00' },
    tue: { on: true, start: '07:00', end: '18:00' },
    wed: { on: true, start: '07:00', end: '18:00' },
    thu: { on: true, start: '07:00', end: '18:00' },
    fri: { on: true, start: '07:00', end: '17:00' },
    sat: { on: true, start: '08:00', end: '14:00' },
    sun: { on: false, start: '00:00', end: '00:00' },
  } as Record<string, { on: boolean; start: string; end: string }>,
  offHoursReply: true,
};
