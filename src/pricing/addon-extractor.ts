/**
 * Add-on extractor.
 *
 * Walks the platform-supplied lead facts AND the customer message corpus
 * to find mentions of pricing add-ons (fridge, oven, …). Output is a list
 * of normalized add-on keys ready to feed `calculateQuote`.
 *
 * Deterministic — no LLM in the path. The synonym map below is the source
 * of truth; add new patterns when introducing new default extras in
 * `pricing-hydrate.ts`.
 *
 * Sources (in order of preference for ranking, all unioned for matching):
 *   1. Customer message (latest inbound — strongest signal for "just now")
 *   2. Conversation history (prior customer turns)
 *   3. Lead details (Thumbtack request.details, Yelp survey_answers)
 *   4. Additional info / additional_info free-text block
 *
 * Ambiguous mentions ("can you clean my appliances?" without naming a
 * specific appliance) surface in `ambiguous` so the prompt builder can
 * tell the LLM to ask which appliance instead of auto-adding $0.
 */

import { ServicePricing } from '../users/pricing-hydrate';

export interface AddonExtractorInput {
  pricing: ServicePricing;
  /** Latest inbound customer message (or first message for first-touch). */
  customerMessage?: string | null;
  /** Full conversation; only `role: 'customer'` turns are scanned. */
  conversationHistory?: Array<{ role: 'customer' | 'pro'; content: string }> | null;
  /** Output of the existing `extractLeadDetails` helpers — question/answer bag. */
  leadDetails?: Record<string, string> | null;
  /** Yelp `project.additional_info` or any other free-form field. */
  additionalInfo?: string | null;
}

export interface AddonExtractionResult {
  /** Normalized keys present in `pricing.extras[].key`. Dedup-by-key, source order. */
  matched: string[];
  /** Generic mentions ("appliances") that need clarification before quoting. */
  ambiguous: string[];
}

/**
 * Synonyms map from a `pricing.extras[].key` to the phrases that should
 * trigger it. The keys here match the default extras in
 * `pricing-hydrate.ts:DEFAULT_CLEANING_PRICING.extras`. Tenants who keep
 * custom add-on keys will still match anything they spell the same way
 * in their key (case-insensitive equality), so the map only needs to
 * cover the defaults explicitly.
 *
 * Phrases are matched as whole-word(ish) substrings on the corpus — the
 * boundary regex tolerates pluralization and adjacent punctuation but
 * does not match inside a larger word (e.g. "blinds" won't match
 * "blindspot").
 */
const SYNONYMS: Record<string, string[]> = {
  oven: [
    'oven', 'ovens', 'inside oven', 'inside the oven', 'oven cleaning', 'oven cleaned', 'clean the oven',
  ],
  fridge: [
    'fridge', 'fridges', 'refrigerator', 'refrigerators',
    'inside fridge', 'inside the fridge', 'inside refrigerator',
    'refrigerator cleaning', 'fridge cleaning', 'clean the fridge',
  ],
  cabinet: [
    'cabinet', 'cabinets',
    'kitchen cabinet', 'kitchen cabinets',
    'inside cabinets', 'inside the cabinets',
  ],
  laundry: [
    'laundry', 'laundry room', 'wash and fold', 'do laundry',
  ],
  dishes: [
    'dishes', 'dishwashing', 'dish washing', 'wash dishes', 'do the dishes',
  ],
  windows: [
    'window', 'windows', 'interior windows', 'inside windows', 'window cleaning',
  ],
  blinds: [
    'blind', 'blinds', 'window blinds',
  ],
  baseboard: [
    'baseboard', 'baseboards',
  ],
  patio_door: [
    'patio door', 'sliding door', 'sliding glass door',
  ],
  patio_garage: [
    'patio', 'garage',
  ],
};

const AMBIGUOUS_PATTERNS: Array<{ token: string; rx: RegExp }> = [
  { token: 'appliances', rx: /\bappliance(?:s)?\b/i },
];

export function extractAddons(input: AddonExtractorInput): AddonExtractionResult {
  const corpus = collectCorpus(input);
  if (!corpus) return { matched: [], ambiguous: [] };
  const lc = corpus.toLowerCase();

  // The tenant's configured extras, indexed by key (lowercased) — we only
  // ever return matched keys that the pricing table can actually price.
  const offered = new Set<string>();
  for (const e of input.pricing.extras ?? []) {
    if (e && typeof e.key === 'string') offered.add(e.key.toLowerCase());
  }

  const matched: string[] = [];

  // First pass: synonym map → pricing keys.
  for (const [key, phrases] of Object.entries(SYNONYMS)) {
    if (!offered.has(key.toLowerCase())) continue;
    for (const phrase of phrases) {
      if (phraseInCorpus(lc, phrase)) {
        if (!matched.includes(key)) matched.push(key);
        break;
      }
    }
  }

  // Second pass: any non-default extras the tenant configured. Match their
  // own `.key` and `.label` literally as whole phrases. Covers add-ons we
  // didn't put in SYNONYMS (e.g. tenant adds "porch" or "office").
  for (const e of input.pricing.extras ?? []) {
    if (!e || typeof e.key !== 'string') continue;
    if (matched.includes(e.key)) continue;
    if (Number(e.price) <= 0) continue;
    const candidates: string[] = [e.key];
    if (typeof e.label === 'string' && e.label.trim()) candidates.push(e.label.trim());
    for (const phrase of candidates) {
      if (phraseInCorpus(lc, phrase)) { matched.push(e.key); break; }
    }
  }

  const ambiguous: string[] = [];
  for (const { token, rx } of AMBIGUOUS_PATTERNS) {
    if (rx.test(corpus) && matched.length === 0) {
      ambiguous.push(token);
    }
  }

  return { matched, ambiguous };
}

function collectCorpus(input: AddonExtractorInput): string {
  const parts: string[] = [];
  if (typeof input.customerMessage === 'string' && input.customerMessage.trim()) {
    parts.push(input.customerMessage);
  }
  if (Array.isArray(input.conversationHistory)) {
    for (const m of input.conversationHistory) {
      if (m && m.role === 'customer' && typeof m.content === 'string' && m.content.trim()) {
        parts.push(m.content);
      }
    }
  }
  if (input.leadDetails) {
    for (const [k, v] of Object.entries(input.leadDetails)) {
      if (v) parts.push(`${k}: ${v}`);
    }
  }
  if (typeof input.additionalInfo === 'string' && input.additionalInfo.trim()) {
    parts.push(input.additionalInfo);
  }
  return parts.join('\n');
}

function phraseInCorpus(corpus: string, phrase: string): boolean {
  const p = phrase.toLowerCase().trim();
  if (!p) return false;
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word boundary that tolerates whitespace, punctuation, and start/end-of-string
  // on both sides. Avoids "blinds" matching inside "blindspot" or "patio" inside
  // "patiomatic". Plurals are covered by listing them explicitly in SYNONYMS.
  const rx = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
  return rx.test(corpus);
}
