/**
 * Parse a human-readable duration string into MINUTES.
 *
 * Accepts both long form ("1 hour", "3 days", "30 min") and compact form
 * ("24h", "1w", "2.5d") — the two formats coexist in saved settings JSON
 * across different fields. Centralising the parser fixes a class of
 * silent bugs where each call site rolled its own and disagreed on the
 * edges: e.g. `parseDelayString` (long-form only) returned 24 minutes
 * when given "24h" because `"24h".includes("hr")` is false; the inline
 * fuReEnrollDelay parser handled "24h" but not "1w".
 *
 * Callers pass their own `fallbackMinutes` so a missing / empty / unparseable
 * value falls back to a sensible default for THAT setting (e.g. 60 for step
 * delays, 1440 for re-enroll delay, 4320 for deferral re-engage). The
 * function never throws.
 */
export function parseDuration(input: string | null | undefined, fallbackMinutes = 60): number {
  if (!input) return fallbackMinutes;
  const raw = String(input).toLowerCase().trim();
  // Allow "24h", "1 hour", "2.5d", "30 min", "1w", etc. Number + optional
  // space + optional unit letters.
  const match = raw.match(/^([\d.]+)\s*([a-z]*)$/);
  if (!match) return fallbackMinutes;
  const num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num <= 0) return fallbackMinutes;
  const unit = match[2];

  // Order matters — disambiguate the m-prefix group ("min", "month", bare "m").
  //   "mo" / "mon" / "month(s)" → months (43200 min)
  //   "min" / "minute(s)"       → minutes
  //   "m" alone                 → minutes (compact form like "30m")
  // Everything else is unambiguous by first letter.
  if (unit === 'mo' || unit === 'mon' || unit.startsWith('month')) return Math.round(num * 43200);
  if (unit === 'min' || unit.startsWith('minute')) return Math.round(num);
  if (unit === 'm') return Math.round(num);
  if (unit === '') return Math.round(num); // bare number → minutes
  if (unit === 'y' || unit === 'yr' || unit === 'yrs' || unit.startsWith('year')) return Math.round(num * 525600);
  if (unit === 'w' || unit === 'wk' || unit === 'wks' || unit.startsWith('week')) return Math.round(num * 10080);
  if (unit === 'd' || unit.startsWith('day')) return Math.round(num * 1440);
  if (unit === 'h' || unit === 'hr' || unit === 'hrs' || unit.startsWith('hour')) return Math.round(num * 60);

  // Unrecognised unit (e.g. "1s", "5fortnights") — fall back rather than guess.
  return fallbackMinutes;
}
