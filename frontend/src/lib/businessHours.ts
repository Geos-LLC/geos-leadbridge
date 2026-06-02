// Shared formatters for User.businessHours and User.quietHours summaries.
// Used by the automation pages (Respond, Conversation, Followups) so the
// "AI replies only outside business hours" / "Only send during business
// hours" / "Quiet hours" labels reflect the user's actual saved schedule
// instead of a hardcoded "Mon–Fri, 9:00 AM – 6:00 PM" string.

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
const DAY_ORDER: DayKey[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL: Record<DayKey, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

// "09:00" → "9:00 AM". Accepts already-12h strings unchanged.
export function to12h(t: string | null | undefined): string {
  if (!t) return '';
  if (/^\d{1,2}:\d{2}\s*(AM|PM)$/i.test(t)) return t;
  const m = /^(\d{2}):(\d{2})$/.exec(t);
  if (!m) return t;
  let h = parseInt(m[1], 10);
  const min = m[2];
  const isPm = h >= 12;
  if (h === 0) h = 12;
  else if (h > 12) h -= 12;
  return `${h}:${min} ${isPm ? 'PM' : 'AM'}`;
}

// Compact timezone tag for display. Falls back to the raw IANA id.
const TZ_SHORT: Record<string, string> = {
  'America/New_York': 'ET',
  'America/Chicago': 'CT',
  'America/Denver': 'MT',
  'America/Los_Angeles': 'PT',
  'America/Phoenix': 'MST',
  'America/Anchorage': 'AKT',
  'Pacific/Honolulu': 'HT',
};
export function tzShort(tz: string | null | undefined): string {
  if (!tz) return '';
  return TZ_SHORT[tz] || tz;
}

export type BusinessHoursSchedule = Partial<Record<DayKey, { start: string; end: string } | null>>;

/**
 * Format a business-hours schedule into a short human-readable line.
 * Examples:
 *   "Mon–Fri, 9:00 AM – 6:00 PM (ET)"   (contiguous weekdays w/ identical hours)
 *   "Mon, Wed, Fri: 10:00 AM – 4:00 PM (ET)"
 *   "Closed all week"                    (no days on)
 *
 * Keeps the label short for sublabels/tile bodies — defers to "Edit Hours"
 * actions for the full grid.
 */
export function formatBusinessHoursSummary(
  schedule: BusinessHoursSchedule | null | undefined,
  timezone?: string | null,
): string {
  if (!schedule) return 'Not configured';
  const active = DAY_ORDER
    .map(d => ({ day: d, entry: schedule[d] }))
    .filter(x => x.entry && x.entry.start && x.entry.end) as Array<{ day: DayKey; entry: { start: string; end: string } }>;
  if (active.length === 0) return 'Closed all week';
  const tz = tzShort(timezone);
  const tzTag = tz ? ` (${tz})` : '';

  // Group consecutive days that share the same start/end time.
  const groups: Array<{ days: DayKey[]; start: string; end: string }> = [];
  for (const { day, entry } of active) {
    const last = groups[groups.length - 1];
    const idx = DAY_ORDER.indexOf(day);
    const lastIdx = last ? DAY_ORDER.indexOf(last.days[last.days.length - 1]) : -2;
    if (last && last.start === entry.start && last.end === entry.end && idx === lastIdx + 1) {
      last.days.push(day);
    } else {
      groups.push({ days: [day], start: entry.start, end: entry.end });
    }
  }

  // One uniform window across all active days → single line.
  if (groups.length === 1) {
    const g = groups[0];
    const dayRange = g.days.length === 1
      ? DAY_LABEL[g.days[0]]
      : `${DAY_LABEL[g.days[0]]}–${DAY_LABEL[g.days[g.days.length - 1]]}`;
    return `${dayRange}, ${to12h(g.start)} – ${to12h(g.end)}${tzTag}`;
  }

  // Multiple windows — list each.
  return groups
    .map(g => {
      const days = g.days.length === 1
        ? DAY_LABEL[g.days[0]]
        : `${DAY_LABEL[g.days[0]]}–${DAY_LABEL[g.days[g.days.length - 1]]}`;
      return `${days}: ${to12h(g.start)} – ${to12h(g.end)}`;
    })
    .join('; ') + tzTag;
}

/** "10:00 PM – 8:00 AM (ET)" for the quiet-hours summary line. */
export function formatQuietHoursSummary(
  start: string | null | undefined,
  end: string | null | undefined,
  timezone?: string | null,
): string {
  if (!start || !end) return 'Not configured';
  const tz = tzShort(timezone);
  return `${to12h(start)} – ${to12h(end)}${tz ? ` (${tz})` : ''}`;
}
