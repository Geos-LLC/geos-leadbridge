/**
 * ServiceSchema types — shape of the JSONB `questionsJson` column.
 *
 * Kept in its own file so the accumulator service, controller, backfill
 * script, and tests can all import the same shape without circular
 * dependencies through the NestJS module graph.
 */

export type ServiceSchemaQuestion = {
  /** normalize(label): lowercased, non-word chars -> "_", collapsed */
  key: string;
  /** original label as we first observed it */
  label: string;
  /** step-1 source treats every observed TT question as `observed_select` */
  type: 'observed_select' | 'unknown';
  /** de-duplicated observed answer values, insertion-ordered */
  options: string[];
  /** number of leads that showed this question */
  observationsCount: number;
  /** ISO timestamp of the most recent observation */
  lastSeenAt: string | null;
};

/**
 * Normalize a free-text question label into a stable dedup key.
 *
 * - lowercase
 * - strip everything that isn't a word char or whitespace
 * - collapse whitespace to underscores
 * - trim leading/trailing underscores
 *
 * Two slightly differently-punctuated versions of "What type of issue?"
 * collapse to the same key. The original (first-seen) label is preserved
 * in `label` for display.
 */
export function normalizeQuestionKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Coerce a TT `details[].answer` value into a list of string options.
 * TT usually returns scalar strings; multi-select answers come as arrays.
 * null/undefined/empty-string answers are dropped — we don't want empty
 * options polluting the catalog.
 */
export function coerceAnswerToOptions(raw: unknown): string[] {
  if (raw == null) return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const out: string[] = [];
  for (const v of values) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s.length > 0) out.push(s);
  }
  return out;
}
