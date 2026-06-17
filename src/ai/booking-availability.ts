/**
 * Booking-availability REFERENCE block for the Booking conversation goal.
 *
 * The Booking strategy prompt (see strategy-prompts.ts → booking) already
 * tells the AI: "if an AVAILABILITY block appears with concrete open
 * slots, offer EXACTLY TWO of them." This module synthesizes that block
 * from the tenant's per-account day/period preferences stored at
 * `SavedAccount.followUpSettingsJson.bookingAvailability`.
 *
 * Why two periods (morning / afternoon) and not full hour-grain slots:
 *   This is tenant-declared availability, not a real calendar
 *   integration. The SF /availability orchestrator (memory:
 *   project_sf_orch_availability_contract_fix_2026_06_04) is the path
 *   for concrete date+time slots and is still flag-gated. Until then,
 *   the model uses "Mon morning / Wed afternoon" style suggestions that
 *   the team confirms separately. Two periods × 7 days = 14 booleans
 *   the user can flip per business.
 *
 * Default when nothing is saved:
 *   Mon–Fri morning + afternoon ON, Sat + Sun OFF. Matches how most
 *   service businesses run weekdays. Tenants can override per account.
 *
 * Storage shape (per-account, inside `followUpSettingsJson`):
 *
 *   {
 *     bookingAvailability: {
 *       mon: { morning: true,  afternoon: true  },
 *       tue: { morning: true,  afternoon: true  },
 *       wed: { morning: true,  afternoon: true  },
 *       thu: { morning: true,  afternoon: true  },
 *       fri: { morning: true,  afternoon: true  },
 *       sat: { morning: false, afternoon: false },
 *       sun: { morning: false, afternoon: false },
 *     }
 *   }
 *
 * The block is only emitted when the active conversation goal is
 * `booking`. Other goals never see it — the model would treat it as
 * scheduling pressure during Qualify / Price flows.
 */

export type BookingPeriod = 'morning' | 'afternoon';

export type BookingDayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface BookingDaySettings {
  morning: boolean;
  afternoon: boolean;
}

export type BookingAvailability = Record<BookingDayKey, BookingDaySettings>;

/** Stable list of weekday keys + human-readable labels. Order = display order. */
export const BOOKING_DAY_KEYS: readonly BookingDayKey[] =
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const DAY_LABELS: Record<BookingDayKey, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

/**
 * Default availability when a tenant hasn't saved anything. Mon–Fri
 * morning + afternoon ON, weekends OFF. Exported so the frontend
 * Conversation.tsx can pre-fill the toggle grid with the same shape
 * the backend would derive.
 */
export const DEFAULT_BOOKING_AVAILABILITY: BookingAvailability = {
  mon: { morning: true,  afternoon: true  },
  tue: { morning: true,  afternoon: true  },
  wed: { morning: true,  afternoon: true  },
  thu: { morning: true,  afternoon: true  },
  fri: { morning: true,  afternoon: true  },
  sat: { morning: false, afternoon: false },
  sun: { morning: false, afternoon: false },
};

/**
 * Parse whatever shape arrived from `followUpSettingsJson.bookingAvailability`
 * into a strict `BookingAvailability`. Garbage-in safe:
 *   - undefined / null / non-object → DEFAULT_BOOKING_AVAILABILITY
 *   - missing days → filled from the default
 *   - extra/unknown day keys → dropped
 *   - non-boolean period values → coerced to the default for that day
 *
 * Defensive parsing matches the qualification-context.ts convention —
 * the runtime should never crash on a bad saved JSON.
 */
export function normalizeBookingAvailability(raw: unknown): BookingAvailability {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_BOOKING_AVAILABILITY };
  const obj = raw as Record<string, unknown>;
  const out = {} as BookingAvailability;
  for (const day of BOOKING_DAY_KEYS) {
    const node = obj[day];
    const defaults = DEFAULT_BOOKING_AVAILABILITY[day];
    if (!node || typeof node !== 'object') {
      out[day] = { ...defaults };
      continue;
    }
    const n = node as Record<string, unknown>;
    out[day] = {
      morning:   typeof n.morning   === 'boolean' ? n.morning   : defaults.morning,
      afternoon: typeof n.afternoon === 'boolean' ? n.afternoon : defaults.afternoon,
    };
  }
  return out;
}

/**
 * Build the body of the AVAILABILITY REFERENCE block. Returns an empty
 * string when EVERY day/period combination is off — emitting "no slots
 * available" to the AI would be worse than letting it ask the customer
 * open-ended (which the Booking prompt already handles).
 *
 * Caller wraps the result with the `=== REFERENCE: AVAILABILITY ===`
 * header — matches how qualificationBlock is consumed in ai.service.ts.
 */
export function buildAvailabilityBlock(raw: unknown): string {
  const parsed = normalizeBookingAvailability(raw);
  // Flatten to (day, period) pairs in canonical Mon→Sun order.
  const slots: string[] = [];
  for (const day of BOOKING_DAY_KEYS) {
    if (parsed[day].morning)   slots.push(`${DAY_LABELS[day]} morning`);
    if (parsed[day].afternoon) slots.push(`${DAY_LABELS[day]} afternoon`);
  }
  if (slots.length === 0) return '';

  const lines: string[] = [];
  lines.push('The team accepts bookings during these windows:');
  for (const s of slots) lines.push(`- ${s}`);
  lines.push('');
  lines.push(
    "Offer EXACTLY TWO of these as suggestions when asking the customer for a date "
    + '(e.g. "Would Tuesday morning or Thursday afternoon work?"). Pick the two '
    + "soonest upcoming windows from this list. Do not invent windows that aren't "
    + 'listed here — these are the only times the team accepts.',
  );
  return lines.join('\n');
}

/**
 * Strategy keys for which the AVAILABILITY block should be injected.
 *
 * Booking only — every other goal is intentionally silent on
 * scheduling. The Booking prompt's "offer EXACTLY TWO" clause is dead
 * weight without this block; the other prompts treat scheduling info
 * as out-of-scope. Mirroring the qualification-context split: each
 * REFERENCE block has a tight goal-key allowlist.
 */
const AVAILABILITY_STRATEGIES = new Set(['booking']);

/** Convenience: returns the block ONLY when the strategy warrants it. */
export function buildAvailabilityBlockForStrategy(
  strategy: string | undefined | null,
  raw: unknown,
): string {
  if (!strategy || !AVAILABILITY_STRATEGIES.has(strategy)) return '';
  return buildAvailabilityBlock(raw);
}
