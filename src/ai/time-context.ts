/**
 * Time-context helpers for AI prompts.
 *
 * Used to give the model accurate clock awareness:
 *   - current local time + timezone
 *   - per-message timestamps with relative deltas
 *   - rules for handling stale offers and conversation gaps
 */

const DEFAULT_TIMEZONE = 'America/New_York';

export function resolveTimezone(tz: string | null | undefined): string {
  return tz && tz.trim() ? tz : DEFAULT_TIMEZONE;
}

export function formatLocalTime(date: Date, timezone: string): string {
  const tz = resolveTimezone(timezone);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

function localDateKey(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function localTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(date);
}

export interface MessageStamp {
  /** Absolute label, e.g. "Today 6:28 PM" / "Yesterday 10:36 AM" / "Apr 20 3:15 PM" */
  absolute: string;
  /** Relative label, e.g. "just now" / "5 min ago" / "2 weeks ago" */
  relative: string;
  /** Combined `[<absolute>, <relative>]` — what we prefix on each history message */
  prefix: string;
}

export function stampMessage(sentAt: Date, now: Date, timezone: string): MessageStamp {
  const tz = resolveTimezone(timezone);
  const diffMs = Math.max(0, now.getTime() - sentAt.getTime());
  const diffMin = Math.round(diffMs / 60_000);
  const diffHr = Math.round(diffMs / 3_600_000);
  const diffDay = Math.round(diffMs / 86_400_000);

  const sentKey = localDateKey(sentAt, tz);
  const todayKey = localDateKey(now, tz);
  const yesterdayKey = localDateKey(new Date(now.getTime() - 86_400_000), tz);

  let absolute: string;
  if (sentKey === todayKey) {
    absolute = `Today ${localTime(sentAt, tz)}`;
  } else if (sentKey === yesterdayKey) {
    absolute = `Yesterday ${localTime(sentAt, tz)}`;
  } else if (diffDay < 7) {
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(sentAt);
    absolute = `${weekday} ${localTime(sentAt, tz)}`;
  } else {
    absolute = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(sentAt);
  }

  let relative: string;
  if (diffMs < 60_000) relative = 'just now';
  else if (diffMin < 60) relative = `${diffMin} min ago`;
  else if (diffHr < 24) relative = `${diffHr}h ago`;
  else if (diffDay < 14) relative = `${diffDay} days ago`;
  else if (diffDay < 60) relative = `${Math.round(diffDay / 7)} weeks ago`;
  else relative = `${Math.round(diffDay / 30)} months ago`;

  return {
    absolute,
    relative,
    prefix: `[${absolute}, ${relative}]`,
  };
}

/**
 * Block to prepend to the user-prompt portion of the AI request. Tells the
 * model the current wall-clock time and the rules for using per-message
 * timestamps.
 */
export function buildTimeAwarenessBlock(now: Date, timezone: string): string {
  const tz = resolveTimezone(timezone);
  return [
    '--- TIME CONTEXT ---',
    `Current local time: ${formatLocalTime(now, tz)} (${tz})`,
    '',
    'TIME AWARENESS RULES:',
    '- Each message in the conversation history is prefixed with [its local timestamp, relative delta]. These brackets are metadata for YOUR reasoning only.',
    '- NEVER include the bracketed timestamp prefix in your reply. Output only the message text the customer should read — no leading "[Today …]", no "[just now]", nothing in square brackets that mirrors that format.',
    '- If you previously offered a specific time and that time has already passed (per the current local time above), do NOT re-offer the same slot. Propose a new one or ask the customer for their preferred time.',
    '- If a long gap (hours, days, weeks, months) elapsed between the customer\'s last message and the previous message, acknowledge the gap naturally. Do not pretend the conversation is unbroken.',
    '- Match cadence to recency: rapid back-and-forth (minutes apart) → brief, direct replies. Long silence followed by a reply → a warmer, slightly fuller re-engagement that re-establishes context.',
    '- The customer\'s most recent message (the one you are replying to) was sent at the current local time above.',
    '--- END TIME CONTEXT ---',
  ].join('\n');
}

/**
 * Strip any leading `[...]` brackets the model may have echoed from the
 * timestamp-prefixed history. Defensive backstop — the prompt already tells
 * the model not to emit these, but we strip on the way out so a slip never
 * reaches the customer. Repeats once in case the model stacked two prefixes.
 */
export function stripLeadingTimestampPrefix(reply: string): string {
  let out = reply.trimStart();
  for (let i = 0; i < 2; i++) {
    const m = out.match(/^\[[^\]\n]*\]\s*/);
    if (!m) break;
    out = out.slice(m[0].length).trimStart();
  }
  return out;
}

/**
 * Prefix a history message's content with its timestamp stamp.
 * Returns the original content unchanged if no `sentAt` was provided.
 */
export function prefixWithTimestamp(
  content: string,
  sentAt: Date | string | undefined | null,
  now: Date,
  timezone: string,
): string {
  if (!sentAt) return content;
  const date = sentAt instanceof Date ? sentAt : new Date(sentAt);
  if (isNaN(date.getTime())) return content;
  return `${stampMessage(date, now, timezone).prefix} ${content}`;
}
