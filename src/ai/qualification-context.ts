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
 * block entirely — the AI then falls back to the generic "ask whichever
 * decision-relevant detail is most clearly missing" guidance in
 * STRATEGY_PROMPTS.qualify. No migration is required.
 *
 * Unknown / malformed keys are silently dropped to keep the block tidy and
 * forward-compatible: when we ship a new field key later, older
 * deployments that haven't picked up the catalog won't bleed garbage into
 * the prompt.
 */

/**
 * Stable list of every supported field key + its human-readable label.
 *
 * `service_date` is the built-in "Desired service date" field
 * (2026-06-16). It belongs to Qualify (collect before quoting/booking)
 * AND to Booking (it's the date the booking is for). The key stays
 * `service_date` for back-compat with any account that already saved
 * this field under the old "Service Date" label.
 */
const FIELD_LABELS: Record<string, string> = {
  square_footage: 'Square Footage',
  service_date:   'Desired Service Date',
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
 * @param customFields Optional tenant-defined fields from
 *   `followUpSettingsJson.qualificationV2.customFields`. Each row has a
 *   label, optional helper question, and required flag. Only required
 *   rows are emitted into the block — non-required custom fields are
 *   ignored for prompt purposes (they remain saved on the account but
 *   don't gate qualification completion). Garbage-in safe: malformed
 *   rows + rows without a label are dropped.
 */
export function buildQualificationBlock(
  requiredFields: unknown,
  customFields?: unknown,
): string {
  // Parse the built-in catalog selections.
  const seen = new Set<string>();
  if (Array.isArray(requiredFields)) {
    for (const raw of requiredFields) {
      if (typeof raw !== 'string') continue;
      if (FIELD_LABELS[raw] === undefined) continue;
      seen.add(raw);
    }
  }
  // Re-emit in canonical catalog order so the block doesn't shuffle
  // randomly between saves (the model is mildly position-sensitive
  // for priority-style instructions).
  const orderedBuiltins = Object.keys(FIELD_LABELS).filter(k => seen.has(k));

  // Parse custom fields defensively. Required-only; preserves caller
  // order so the user-visible row order in the editor matches the
  // priority the AI sees.
  const customRows: { label: string; question: string }[] = [];
  const labelDedup = new Set<string>();
  if (Array.isArray(customFields)) {
    for (const raw of customFields) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      if (r.required === false) continue;
      const label = typeof r.label === 'string' ? r.label.trim() : '';
      if (!label) continue;
      const dedupKey = label.toLowerCase();
      if (labelDedup.has(dedupKey)) continue;
      labelDedup.add(dedupKey);
      const question = typeof r.question === 'string' ? r.question.trim() : '';
      customRows.push({ label, question });
    }
  }

  if (orderedBuiltins.length === 0 && customRows.length === 0) return '';

  const lines: string[] = [];
  lines.push('The business has marked these fields as required to qualify a lead before quoting or booking:');
  for (const key of orderedBuiltins) {
    lines.push(`- ${FIELD_LABELS[key]}`);
  }
  for (const row of customRows) {
    // Helper question (when present) is wrapped in quotes so the AI
    // reads it as a hint to phrase its question naturally, not as a
    // verbatim line to send. Without a question, the AI generates one
    // from the label.
    if (row.question) {
      lines.push(`- ${row.label} — ask: "${row.question}"`);
    } else {
      lines.push(`- ${row.label}`);
    }
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
 *
 * `booking` (2026-06-16) is included because the Booking goal's prompt
 * explicitly asks "is one required field still missing AND is it
 * booking-critical?" — that question only makes sense when the prompt
 * sees the REQUIRED FIELDS list. The prompt itself enforces the
 * "booking-critical fields only" filter (address / zip / service type /
 * desired date) so the AI doesn't chain through every Qualify field
 * during a Booking flow. See strategy-prompts.ts → booking.
 */
const QUALIFICATION_STRATEGIES = new Set(['qualify', 'booking']);

/** Convenience: returns the block ONLY when the strategy warrants it. */
export function buildQualificationBlockForStrategy(
  strategy: string | undefined,
  requiredFields: unknown,
  customFields?: unknown,
): string {
  if (!strategy || !QUALIFICATION_STRATEGIES.has(strategy)) return '';
  return buildQualificationBlock(requiredFields, customFields);
}
