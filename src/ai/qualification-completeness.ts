/**
 * Gate-side completeness check for the LLM classifier's
 * `qualification_complete` handoff signal.
 *
 * The classifier (intent-classifier.service.ts) flags
 * `handoff.reason='qualification_complete'` whenever its recent-history
 * heuristic spots THREE of {cleaning type, bedrooms, bathrooms, square
 * footage, frequency, preferred date/time}. That heuristic is not aware
 * of the tenant's per-account `qualificationV2.requiredFields` config,
 * so it can fire while genuinely-required fields (e.g. square_footage,
 * phone_number) are still missing. Lawrence Parker (Spotless JAX, Yelp,
 * 2026-06-20): classifier returned qualification_complete on a zip-code
 * confirmation message even though sqft / bathrooms / phone were never
 * collected.
 *
 * This module enforces the tenant's contract at the automation gate:
 * given the configured `requiredFields` and the conversation's customer-
 * side messages, compute which required fields are missing. The gate
 * uses the result to decide whether to honor the classifier's handoff
 * or let the AI keep asking.
 *
 * Scope notes:
 * - We only scan CUSTOMER messages (sender='customer'). The AI's
 *   acknowledgements are derivative and would risk mis-attribution
 *   (e.g. AI prints the business phone number → false-positive
 *   `phone_number`).
 * - `customFields` from `qualificationV2.customFields` are NOT enforced
 *   here. Their labels are tenant-defined free text and we have no
 *   reliable way to detect "the customer answered this". They remain
 *   informational only in the prompt. If a future tenant relies on
 *   custom fields gating the handoff, add a separate detector.
 * - The canonical field set mirrors `FIELD_LABELS` in
 *   qualification-context.ts. Keep them in sync.
 */

const CANONICAL_FIELDS = new Set<string>([
  'square_footage',
  'service_date',
  'phone_number',
  'bedrooms',
  'bathrooms',
  'zip_code',
  'address',
  'frequency',
  'condition',
  'scope_extras',
]);

export interface ClassifierExtractedFacts {
  phoneNumber?: string;
  squareFootage?: number;
  cleaningType?: string;
  bedrooms?: number;
  bathrooms?: number;
  preferredDateTime?: string;
}

/**
 * Parse `followUpSettingsJson.qualificationV2.requiredFields` defensively.
 * Returns only the canonical builtin keys we know how to detect; unknown
 * strings, non-arrays, and malformed JSON all collapse to an empty array.
 */
export function parseRequiredFields(followUpSettingsJson: string | null | undefined): string[] {
  if (!followUpSettingsJson) return [];
  let parsed: any;
  try { parsed = JSON.parse(followUpSettingsJson); } catch { return []; }
  const raw = parsed?.qualificationV2?.requiredFields;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k !== 'string') continue;
    if (!CANONICAL_FIELDS.has(k)) continue;
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * Detect which canonical fields are present in a single customer message.
 * Returns a set of snake_case field keys.
 */
export function detectFieldsInText(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  const lower = text.toLowerCase();

  // bedrooms — "3 bedrooms", "three bedroom", "3 bed", "3br", "3-bedroom"
  if (/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*[-]?\s*(?:bed(?:room)?s?\b|br\b)/i.test(text)) {
    out.add('bedrooms');
  }
  // bathrooms — "2 bathrooms", "1.5 bath", "2 ba"
  if (/\b(\d+(?:\.\d+)?|one|two|three|four|five|six)\s*[-]?\s*(?:bath(?:room)?s?\b|ba\b)/i.test(text)) {
    out.add('bathrooms');
  }
  // square_footage — "2100 sqft", "1,800 sq ft", "950 square feet"
  if (/\b\d{1,2}[,\s]?\d{3}\s*(?:sq\.?\s*ft|sqft|square\s*f(?:ee)?t)\b/i.test(text) ||
      /\b\d{3,5}\s*(?:sq\.?\s*ft|sqft|square\s*f(?:ee)?t)\b/i.test(text)) {
    out.add('square_footage');
  }
  // phone_number — 10-digit US phone. Avoid matching long digit runs (zip+ext).
  // Require either a 1- prefix, parentheses, or punctuation between groups.
  if (/(?:\+?1[-.\s])\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text) ||
      /\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}\b/.test(text) ||
      /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(text)) {
    out.add('phone_number');
  }
  // frequency
  if (/\b(weekly|bi[-\s]?weekly|every\s+(?:other\s+|\d+\s+|two\s+|three\s+|four\s+)?weeks?|fortnightly|monthly|every\s+(?:other\s+|\d+\s+)?months?|one[-\s]?time|just\s+once|recurring)\b/i.test(text)) {
    out.add('frequency');
  }
  // zip_code — 5-digit number. Loose on purpose; gated by tenant including it
  // in requiredFields. If a tenant requires zip_code AND the customer never
  // states one, the digit pattern won't fire.
  if (/\b\d{5}(?:-\d{4})?\b/.test(text)) {
    out.add('zip_code');
  }
  // address — "123 Main St", optional middle words
  if (/\b\d{1,5}\s+\w+(?:\s+\w+){0,4}\s+(?:street|st|avenue|ave|road|rd|boulevard|blvd|drive|dr|lane|ln|way|court|ct|place|pl|terrace|ter|circle|cir)\b/i.test(text)) {
    out.add('address');
  }
  // condition
  if (/\b(move[-\s]?in|move[-\s]?out|moving\s+(?:in|out)|deep\s+clean|heavy\s+soil|post[-\s]?construction)\b/i.test(text)) {
    out.add('condition');
  }
  // scope_extras — common cleaning add-ons
  if (/\b(pets?\b|dogs?\b|cats?\b|fridge|refrigerator|oven|windows?|blinds?|baseboards?|cabinets?|patio|garage|laundry|dishes)\b/i.test(text)) {
    out.add('scope_extras');
  }
  // service_date — explicit date / weekday / time-of-day. Deliberately
  // does NOT count "flexible" / "anytime" — those don't pin a real slot.
  if (/\b(today|tomorrow|tonight|this\s+(?:morning|afternoon|evening|weekend)|next\s+(?:week|weekend|month)|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|\d{1,2}[-]\d{1,2}|january|february|march|april|may|june|july|august|september|october|november|december|\d{1,2}\s*(?:am|pm))\b/i.test(lower)) {
    out.add('service_date');
  }

  return out;
}

/**
 * Detect which canonical fields are present in the classifier's
 * extracted-facts payload for the current message.
 */
export function detectFieldsInClassifierFacts(facts: ClassifierExtractedFacts | undefined): Set<string> {
  const out = new Set<string>();
  if (!facts) return out;
  if (typeof facts.phoneNumber === 'string' && facts.phoneNumber.replace(/\D/g, '').length >= 7) {
    out.add('phone_number');
  }
  if (typeof facts.squareFootage === 'number' && Number.isFinite(facts.squareFootage) && facts.squareFootage >= 100) {
    out.add('square_footage');
  }
  if (typeof facts.bedrooms === 'number' && Number.isFinite(facts.bedrooms) && facts.bedrooms >= 1) {
    out.add('bedrooms');
  }
  if (typeof facts.bathrooms === 'number' && Number.isFinite(facts.bathrooms) && facts.bathrooms >= 1) {
    out.add('bathrooms');
  }
  if (typeof facts.preferredDateTime === 'string' && facts.preferredDateTime.trim()) {
    out.add('service_date');
  }
  return out;
}

/**
 * Compute the set of canonical required fields the customer has provided
 * across the conversation. Scans the supplied customer messages plus the
 * current inbound message text, then unions with whatever the classifier
 * already extracted on the current turn.
 */
export function collectedFields(opts: {
  customerMessages: string[];
  currentMessage?: string | null;
  classifierFacts?: ClassifierExtractedFacts;
  leadCustomerPhone?: string | null;
}): Set<string> {
  const out = new Set<string>();
  for (const m of opts.customerMessages) {
    for (const f of detectFieldsInText(m)) out.add(f);
  }
  if (opts.currentMessage) {
    for (const f of detectFieldsInText(opts.currentMessage)) out.add(f);
  }
  for (const f of detectFieldsInClassifierFacts(opts.classifierFacts)) out.add(f);
  // If the lead row already carries a usable phone (>=7 digits), the
  // tenant has a callback number regardless of whether the customer
  // typed it. Required-fields contract is "we have it", not "they typed
  // it in this thread".
  const phoneDigits = (opts.leadCustomerPhone || '').replace(/\D/g, '');
  if (phoneDigits.length >= 7) out.add('phone_number');
  return out;
}

/**
 * Given required + collected, return the canonical missing fields in
 * the canonical order they were declared in `required`.
 */
export function missingRequiredFields(required: string[], collected: Set<string>): string[] {
  return required.filter(f => !collected.has(f));
}
