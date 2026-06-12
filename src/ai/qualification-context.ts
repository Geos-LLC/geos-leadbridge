/**
 * Qualification-context block for AI prompts.
 *
 * Emits a REFERENCE block listing the snake_case field keys the tenant has
 * marked as required for qualification under the Price or Qualify
 * Conversation Goals. Storage shape (per-account, inside
 * `followUpSettingsJson`):
 *
 *   { qualificationV2: { requiredFields: ['square_footage', 'service_date'] } }
 *
 * Callers (automation.service.ts + follow-up-generator.service.ts) only
 * invoke `buildQualificationBlock` when the active strategy is `qualify`.
 * Price uses the Pricing Table + Pricing Guidance (Playbook) for its
 * "ask only what's needed to quote accurately" behavior, so its prompt
 * deliberately does NOT receive the QUALIFICATION REQUIRED FIELDS block —
 * letting the two surfaces stay clean (Price = pricing rules, Qualify =
 * info collection). Accounts with no `qualificationV2` entry skip the
 * block entirely — the AI then falls back to the legacy hardcoded priority
 * order defined in STRATEGY_PROMPTS.qualify. No migration is required.
 *
 * Unknown / malformed keys are silently dropped to keep the block tidy and
 * forward-compatible: when we ship a new field key later, older
 * deployments that haven't picked up the catalog won't bleed garbage into
 * the prompt.
 */

/** Stable list of every supported field key + its human-readable label. */
const FIELD_LABELS: Record<string, string> = {
  square_footage: 'Square Footage',
  service_date:   'Service Date',
  phone_number:   'Phone Number',
  bedrooms:       'Bedrooms',
  bathrooms:      'Bathrooms',
  zip_code:       'Zip Code',
  address:        'Address',
  frequency:      'Frequency',
  condition:      'Condition (move-in/out, heavy soil)',
  scope_extras:   'Scope Extras (pets, add-ons)',
};

/**
 * Build the REFERENCE block content (the body — the caller adds the
 * `=== REFERENCE: ... ===` header). Returns an empty string when there
 * are no valid fields to emit; callers should treat empty as "skip this
 * block" so we never inject a useless header.
 *
 * @param requiredFields snake_case keys pulled from
 *   `followUpSettingsJson.qualificationV2.requiredFields`. Garbage-in
 *   safe: non-strings, duplicates, and unknown keys are dropped.
 */
export function buildQualificationBlock(requiredFields: unknown): string {
  if (!Array.isArray(requiredFields) || requiredFields.length === 0) return '';

  // Filter to known keys, dedupe, preserve catalog order. We don't trust
  // caller order because the storage layer doesn't enforce it.
  const seen = new Set<string>();
  for (const raw of requiredFields) {
    if (typeof raw !== 'string') continue;
    if (FIELD_LABELS[raw] === undefined) continue;
    seen.add(raw);
  }
  if (seen.size === 0) return '';

  // Re-emit in canonical catalog order so the block doesn't shuffle
  // randomly between saves (the model is mildly position-sensitive
  // for priority-style instructions).
  const ordered = Object.keys(FIELD_LABELS).filter(k => seen.has(k));

  const lines: string[] = [];
  lines.push('The business has marked these fields as required to qualify a lead before quoting or booking:');
  for (const key of ordered) {
    lines.push(`- ${FIELD_LABELS[key]}`);
  }
  lines.push('');
  lines.push('Prioritize collecting these one or two at a time. When the customer has answered all of them, transition forward (to pricing if Price-goal, or to booking if Qualify-goal). Do NOT re-ask information the customer already provided.');
  return lines.join('\n');
}

/**
 * Strategy keys for which qualificationBlock injection is appropriate.
 *
 * Tightened to `qualify` only (was `price` | `qualify` previously). Rationale:
 * the Price goal's behavior is governed by the Pricing Table + Pricing
 * Guidance (Playbook), not by a required-fields list. Mirroring that split
 * on the prompt side keeps the two surfaces semantically clean — Price never
 * receives a QUALIFICATION REQUIRED FIELDS block, so it can't accidentally
 * lead with "I need square footage" before quoting from the table.
 */
const QUALIFICATION_STRATEGIES = new Set(['qualify']);

/** Convenience: returns the block ONLY when the strategy warrants it. */
export function buildQualificationBlockForStrategy(
  strategy: string | undefined,
  requiredFields: unknown,
): string {
  if (!strategy || !QUALIFICATION_STRATEGIES.has(strategy)) return '';
  return buildQualificationBlock(requiredFields);
}
