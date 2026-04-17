/**
 * Long-term follow-up cadence.
 *
 * Used when a lead has been marked "Not hired" on the platform BUT had
 * meaningful engagement (see `FollowUpEngineService.isEngaged`). Rather than
 * dropping the lead, we slow the cadence way down and shift the tone to
 * re-engagement ("Need cleaning again?") instead of conversion ("Book now").
 *
 * Structure mirrors the `stepsJson` shape used in follow-up-seed.ts, so the
 * scheduler's existing `SequenceStep`/step-delay logic can consume it without
 * modification. Template wording is intentionally terse — the AI generator
 * fills in the actual copy from the objective + thread context.
 *
 * See plans/2026-04-17-job-sync-sf-lb.md §7.4.
 */

export interface LongTermStep {
  stepOrder: number;
  delayMinutes: number;
  objective: string;
}

// Spacing: 7d / 14d / 30d / 90d from the previous send.
const MIN_IN_DAY = 24 * 60;

export const LONG_TERM_STEPS: ReadonlyArray<LongTermStep> = [
  { stepOrder: 0, delayMinutes: 7 * MIN_IN_DAY, objective: 'long_term_check_in' },
  { stepOrder: 1, delayMinutes: 14 * MIN_IN_DAY, objective: 'long_term_availability' },
  { stepOrder: 2, delayMinutes: 30 * MIN_IN_DAY, objective: 'long_term_reminder' },
  { stepOrder: 3, delayMinutes: 90 * MIN_IN_DAY, objective: 'long_term_seasonal' },
];

/**
 * Suggested copy per objective for the AI prompt / fallback template.
 * Tone: friendly, recurring-service oriented. No pressure.
 */
export const LONG_TERM_OBJECTIVE_HINTS: Record<string, string> = {
  long_term_check_in:
    'Checking in — are you still looking at cleaning options? No pressure, just wanted to keep the door open.',
  long_term_availability:
    'We have availability this week if you want to revisit. Happy to work around your schedule.',
  long_term_reminder:
    'Just a reminder — need cleaning again? We saved your preferences from last time if it helps.',
  long_term_seasonal:
    'Seasonal reminder: if you\'re planning spring/holiday cleaning, grab a slot while the schedule\'s open.',
};
