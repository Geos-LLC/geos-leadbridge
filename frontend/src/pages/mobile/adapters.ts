// Mapping layer: real LB API shapes → MobileLead / MobileAccount / MobileMessage
// shapes that the screens render. Keeps the screens free of mapping logic and
// gives one place to extend when adding new derived fields.

import type { Lead, SavedAccount } from '../../types';
import type { ApiMessage } from '../../services/api';
import type {
  MobileAccount, MobileLead, MobileMessage, AiStatus, LeadStatus, Platform, AccountStatus,
} from './data';

// ── Platforms ─────────────────────────────────────────────────────────────

export function mapPlatform(p: string): Platform {
  const v = p.toLowerCase();
  if (v === 'thumbtack' || v === 'yelp' || v === 'angi' || v === 'google') return v;
  // Unknown platforms render as thumbtack-styled (worst case — fixes layout,
  // not a routing decision).
  return 'thumbtack';
}

// ── Lead status mapping ──────────────────────────────────────────────────
// LB canonical statuses → 5-state mobile pill. Mobile collapses several
// engaged sub-states into "replied" because the mobile UI doesn't visualize
// the difference.
const LEAD_STATUS_MAP: Record<string, LeadStatus> = {
  new: 'new',
  contacted: 'replied',
  engaged: 'replied',
  in_progress: 'replied',
  quoted: 'quoted',
  scheduled: 'won',
  booked: 'won',
  hired: 'won',
  completed: 'won',
  done: 'won',
  lost: 'lost',
  archived: 'lost',
};

export function mapLeadStatus(s: string | undefined): LeadStatus {
  if (!s) return 'new';
  return LEAD_STATUS_MAP[s.toLowerCase()] ?? 'new';
}

// ── Relative time formatting ──────────────────────────────────────────────

export function formatRelative(iso?: string | null): string {
  if (!iso) return '';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diffMs = Date.now() - t;
  if (diffMs < 0) return 'just now';
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hr ago`;
  const day = Math.floor(hr / 24);
  if (day === 1) return 'Yesterday';
  if (day < 7) return `${day} days ago`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week} wk ago`;
  return new Date(iso).toLocaleDateString();
}

function sortMinutes(iso?: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

// ── SavedAccount → MobileAccount ─────────────────────────────────────────

export function mapAccount(a: SavedAccount): MobileAccount {
  const platform = mapPlatform(a.platform);
  const status: AccountStatus = a.tokenDead === true ? 'warning' : 'connected';
  const issue = a.tokenDead === true ? 'Reconnect required — token expired' : undefined;
  return {
    id: a.id,
    platform,
    name: a.businessName,
    shortName: shortenAccountName(a.businessName),
    city: '',                    // SavedAccount doesn't carry city; left blank.
    status,
    leadsToday: 0,               // Derived later from leads list if needed.
    issue,
  };
}

function shortenAccountName(name: string): string {
  // Most LB accounts are named like "Spotless Homes — Tampa" or
  // "FargiPro.Cleaning". Take the last segment after an em/en/regular dash
  // when present; otherwise return the full name truncated.
  for (const sep of [' — ', ' – ', ' - ']) {
    const i = name.lastIndexOf(sep);
    if (i > -1) return name.slice(i + sep.length).trim();
  }
  return name.length > 28 ? `${name.slice(0, 26)}…` : name;
}

// ── Lead → MobileLead ─────────────────────────────────────────────────────

export function mapLead(l: Lead): MobileLead {
  const platform = mapPlatform(l.platform);
  const locationParts = [l.city, l.state].filter(Boolean) as string[];
  const location = locationParts.length ? locationParts.join(', ') : '';
  // Best-effort service label — `category` is the platform's coarse bucket
  // (e.g. "House Cleaning"); fall back to the message head if absent.
  const service = l.category || (l.message ? l.message.slice(0, 60).replace(/\s+/g, ' ') : '');
  const lastIso = l.lastMessageAt || l.updatedAt || l.createdAt;
  const lastSender = l.lastMessage?.sender;
  // AI status — we don't have a direct flag; infer from isAutoHandled
  // (an autohandled lead is one our AI replied to) plus latest sender.
  let ai: AiStatus;
  if (l.isAutoHandled && lastSender !== 'customer') ai = 'replied';
  else if (lastSender === 'customer') ai = 'waiting';
  else ai = 'replied';
  // Snippet preference order: last message > original lead body > category fallback.
  const snippet = (l.lastMessage?.content || l.message || service || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  // Unread heuristic: customer is the last sender and we haven't auto-handled.
  const unread = lastSender === 'customer' && l.isAutoHandled !== true;
  return {
    id: l.id,
    name: l.customerName || 'Unknown',
    location,
    service,
    platform,
    phone: l.customerPhone || '',
    amount: l.budget ?? null,
    status: mapLeadStatus(l.status),
    ai,
    unread,
    receivedAt: formatRelative(lastIso),
    sort: sortMinutes(lastIso),
    messages: [],               // Loaded on-demand by useMobileMessages.
    snippet,
  };
}

// ── ApiMessage → MobileMessage ────────────────────────────────────────────

export function mapMessage(m: ApiMessage): MobileMessage {
  // `from` semantics: lead | ai | you.
  //  - customer message → lead
  //  - pro with senderType=ai → ai
  //  - pro with senderType=user or unset → you
  let from: MobileMessage['from'];
  if (m.sender === 'customer') from = 'lead';
  else if (m.senderType === 'ai') from = 'ai';
  else from = 'you';
  return {
    from,
    text: m.content || '',
    at: formatRelative(m.sentAt),
  };
}
