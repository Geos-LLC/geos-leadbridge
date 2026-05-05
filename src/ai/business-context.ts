/**
 * Business-context block for AI prompts.
 *
 * Emits a `--- BUSINESS PROFILE ---` section that tells the model who the
 * business is, what its operational capability is (turnaround, active hours),
 * and the rules around scheduling. Without this block the AI fabricates
 * specific time slots ("I have 8 AM tomorrow") because it has no signal of
 * what the business can actually offer.
 *
 * Designed to be called from every AI generation path (AI Conversation
 * auto-replies, follow-up generator, preview endpoints) so the model gets
 * the same grounding regardless of who's calling it.
 */

export interface BusinessContextInput {
  /** SavedAccount.businessName */
  businessName?: string | null;
  /** User.name — used for first-person framing ("Hi, this is X from Y") */
  ownerName?: string | null;
  /** Lead.city, Lead.state — falls back to nothing if missing */
  city?: string | null;
  state?: string | null;
  /** SavedAccount.followUpSettingsJson (raw JSON string), parsed inside */
  followUpSettingsJson?: string | null;
  /** SavedAccount.followUpActiveHoursStart, e.g. "09:00" */
  activeHoursStart?: string | null;
  /** SavedAccount.followUpActiveHoursEnd, e.g. "18:00" */
  activeHoursEnd?: string | null;
  /** IANA tz, e.g. "America/New_York" */
  timezone?: string | null;
}

const CAPABILITY_LABELS: Record<string, string> = {
  same_day: 'same-day service is available',
  '24h': 'within 24 hours (next business day)',
  '48h': 'within 48 hours (1–2 days out)',
  not_available: 'by appointment only — no same-day or rush availability',
};

function formatHHMM(value: string | null | undefined): string | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hour24 = parseInt(m[1], 10);
  const min = m[2];
  if (isNaN(hour24) || hour24 < 0 || hour24 > 23) return null;
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return min === '00' ? `${hour12} ${period}` : `${hour12}:${min} ${period}`;
}

function extractCapability(json: string | null | undefined): string | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    const cap = parsed?.followUpUrgentCapability;
    return typeof cap === 'string' ? cap : null;
  } catch {
    return null;
  }
}

export function buildBusinessContextBlock(input: BusinessContextInput): string {
  const parts: string[] = ['--- BUSINESS PROFILE ---'];

  if (input.businessName) parts.push(`Business: ${input.businessName}`);
  if (input.ownerName) parts.push(`Owner / contact: ${input.ownerName}`);
  if (input.city || input.state) {
    parts.push(`Service area: ${[input.city, input.state].filter(Boolean).join(', ')}`);
  }

  const capability = extractCapability(input.followUpSettingsJson);
  if (capability) {
    const label = CAPABILITY_LABELS[capability] || capability;
    parts.push(`Standard turnaround: ${label}`);
  } else {
    parts.push('Standard turnaround: not configured — assume next-day availability and confirm with customer');
  }

  const start = formatHHMM(input.activeHoursStart);
  const end = formatHHMM(input.activeHoursEnd);
  if (start && end) {
    const tz = input.timezone || 'America/New_York';
    parts.push(`Active hours: ${start} – ${end} (${tz})`);
  } else {
    parts.push('Active hours: not configured — default to standard daytime business hours');
  }

  parts.push('');
  parts.push('SCHEDULING RULES (strict):');
  parts.push('- You do NOT have access to the team\'s live calendar. You cannot see what is actually booked.');
  parts.push('- NEVER claim a specific time slot is open ("I have 8 AM tomorrow", "2 PM Thursday is free"). That is a fabrication.');
  parts.push('- DO offer broad windows that match the standard turnaround above (e.g. "tomorrow", "in the next day or two", "later this week").');
  parts.push('- DO ask the customer what time works best for them.');
  parts.push('- If the customer proposes a specific time, you may tentatively confirm ("Got it — I\'ll lock that in and confirm shortly"), but never guarantee.');
  parts.push('- If the customer asks for a time that\'s outside the turnaround above (e.g. wants same-day when capability is 24h), acknowledge it and offer the next available window inside your capability — do not promise what you cannot deliver.');
  parts.push('- Stay within the active hours above when proposing windows. Do not promise service late at night or before opening unless capability explicitly allows it.');
  parts.push('--- END BUSINESS PROFILE ---');

  return parts.join('\n');
}
