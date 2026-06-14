/**
 * Deterministic Pricing Engine.
 *
 * The LLM must NEVER do the pricing math. It receives a fully-calculated
 * quote (base + matched add-ons + total) and either quotes it verbatim or,
 * when inputs are missing, asks for the missing piece.
 *
 * Inputs come from two sources:
 *   1. Structured lead facts (bedrooms, bathrooms, sqft, frequency, cleaning
 *      type) — usually extracted from `lead.rawJson` upstream into a
 *      Record<string, string> by the existing `extractLeadDetails` helpers.
 *      `inferQuoteFacts` normalizes that bag into typed fields.
 *   2. Mentioned add-ons (fridge, oven, …) — produced by `extractAddons`
 *      in `addon-extractor.ts`, which walks the platform fields + customer
 *      message corpus.
 *
 * Output is rendered into a prompt section by `buildQuoteBlock`. The new
 * AiReplyContext.quoteBlock field on ai.service.ts surfaces that block to
 * the LLM under an authoritative REFERENCE header (see base-hard-rules.ts
 * PRICING — DETERMINISTIC QUOTE).
 */

import { ServicePricing, PricingRow } from '../users/pricing-hydrate';
import { extractAddons } from './addon-extractor';
import { buildPriceIntentBlock } from './price-intent';

export interface MatchedExtra {
  /** Pricing key on `ServicePricing.extras[].key`. */
  key: string;
  /** Human label rendered to the customer. */
  label: string;
  /** Price in whole dollars. */
  price: number;
}

export interface PricingCalculationInput {
  /** Pricing key on `ServicePricing.cleaningTypes[].key`. Optional — engine picks the first offered when unset. */
  serviceType?: string | null;
  bedrooms?: number | null;
  bathrooms?: number | null;
  sqft?: number | null;
  /** Normalized add-on keys (must match `pricing.extras[].key`). */
  extras?: string[];
  pricing: ServicePricing;
}

export interface PricingCalculationResult {
  /** Base row price for the chosen serviceType. null when unknown / not offered. */
  basePrice: number | null;
  /** Sum of matched extras. Always defined (0 when none). */
  extrasPrice: number;
  /** Extras that matched both the requested list AND have price > 0 in the table. */
  extrasMatched: MatchedExtra[];
  /** basePrice + extrasPrice. null when basePrice is null. */
  totalPrice: number | null;
  /** Resolved cleaningType key actually used for basePrice (after defaulting). */
  serviceType: string | null;
  /** Human label for serviceType. */
  serviceLabel: string | null;
  /** Row metadata when matched. */
  row: { bed: number; bath: number; sqftMin?: number; sqftMax?: number } | null;
  /** Human-readable string composed for the LLM. May be empty. */
  explanation: string;
  /** True when one or more required inputs are missing OR pricing column is not offered. */
  requiresClarification: boolean;
  /** Specific missing fields the LLM should ask about. */
  missing: string[];
}

export interface QuoteFacts {
  serviceType?: string;
  bedrooms?: number;
  bathrooms?: number;
  sqft?: number;
}

/**
 * Pull typed quote facts out of the bag produced by `extractLeadDetails`.
 * Tolerant of arbitrary key casing because Thumbtack/Yelp survey questions
 * are user-facing strings ("Bedrooms?", "Square footage", "Cleaning Type").
 *
 * Returns only the fields that could be parsed — callers should treat
 * undefined fields as missing inputs.
 */
export function inferQuoteFacts(
  leadDetails: Record<string, string> | null | undefined,
  pricing: ServicePricing,
): QuoteFacts {
  const out: QuoteFacts = {};
  if (!leadDetails) return out;

  for (const [rawKey, rawVal] of Object.entries(leadDetails)) {
    if (!rawKey) continue;
    const k = rawKey.toLowerCase();
    const v = String(rawVal ?? '');

    if (out.bedrooms === undefined && /(bedroom|^bed\b|\bbed[s]?\b|\bbdr\b|\bbr\b)/.test(k)) {
      const n = parseFirstInt(v);
      if (n !== null) out.bedrooms = n;
    }
    if (out.bathrooms === undefined && /(bathroom|bath\b|\bba\b|\bbth\b)/.test(k)) {
      const n = parseFirstFloat(v);
      if (n !== null) out.bathrooms = Math.round(n);
    }
    if (out.sqft === undefined && /(square|sq\.?\s*ft|sqft|footage)/.test(k)) {
      const n = parseFirstInt(v);
      if (n !== null) out.sqft = n;
    }
    if (out.serviceType === undefined && /(cleaning type|service type|type of|service requested|category)/.test(k)) {
      const inferred = matchCleaningTypeKey(v, pricing.cleaningTypes);
      if (inferred) out.serviceType = inferred;
    }
  }

  return out;
}

/**
 * Core deterministic calculation. Pure function — no I/O, no LLM, no surprises.
 *
 * Algorithm:
 *   1. Resolve serviceType — explicit > first offered.
 *   2. Look up row by exact bed/bath match.
 *   3. If row + serviceType + non-zero price → basePrice.
 *   4. Match requested extras against `pricing.extras` (price > 0 only).
 *   5. total = base + sum(extras).
 *
 * `requiresClarification` is true when any of basePrice's inputs are missing
 * OR when the requested service is configured as not offered (price 0).
 */
export function calculateQuote(input: PricingCalculationInput): PricingCalculationResult {
  const { pricing } = input;
  const missing: string[] = [];

  const bedrooms = numberOrNull(input.bedrooms);
  const bathrooms = numberOrNull(input.bathrooms);
  // sqft is accepted in the input shape for forward-compat (future scale-up
  // logic) but the v1 engine does not use it — base price is pulled from the
  // exact bed/bath row only. Read here to silence "unused param" linters.
  void numberOrNull(input.sqft);
  let serviceType: string | null = input.serviceType ?? null;

  if (!serviceType) {
    for (const ct of pricing.cleaningTypes ?? []) {
      if (isOffered(pricing, ct.key)) { serviceType = ct.key; break; }
    }
  }

  if (bedrooms === null) missing.push('bedrooms');
  if (bathrooms === null) missing.push('bathrooms');

  // Match extras — only those configured AND priced > 0. Dedupe by key,
  // preserve request order so the AI's verbal explanation reads natural.
  const requested = (input.extras ?? []).filter((k): k is string => typeof k === 'string');
  const matched: MatchedExtra[] = [];
  const seen = new Set<string>();
  for (const req of requested) {
    const key = req.toLowerCase();
    if (seen.has(key)) continue;
    const entry = (pricing.extras ?? []).find(e => e && typeof e.key === 'string' && e.key.toLowerCase() === key);
    if (!entry) continue;
    const price = Number(entry.price) || 0;
    if (price <= 0) continue;
    matched.push({ key: entry.key, label: entry.label, price });
    seen.add(key);
  }

  const extrasPrice = matched.reduce((s, m) => s + m.price, 0);

  // Row lookup — exact bed/bath. No closest-match inference; LB pricing-guards
  // already forbids interpolation across rows.
  let row: PricingRow | null = null;
  if (bedrooms !== null && bathrooms !== null) {
    row = (pricing.priceTable ?? []).find(r =>
      Number(r.bed) === bedrooms && Number(r.bath) === bathrooms,
    ) || null;
    if (!row) missing.push(`pricing row for ${bedrooms}BR/${bathrooms}BA`);
  }

  let basePrice: number | null = null;
  if (row && serviceType) {
    const p = Number(row[serviceType]) || 0;
    if (p > 0) basePrice = p;
    else missing.push(`${serviceType} pricing for ${bedrooms}BR/${bathrooms}BA (not offered)`);
  }

  const totalPrice = basePrice !== null ? basePrice + extrasPrice : null;

  const serviceLabel = serviceType
    ? (pricing.cleaningTypes ?? []).find(c => c.key === serviceType)?.label ?? serviceType
    : null;

  const explanation = buildExplanation({
    serviceLabel,
    bedrooms,
    bathrooms,
    basePrice,
    matched,
    totalPrice,
  });

  return {
    basePrice,
    extrasPrice,
    extrasMatched: matched,
    totalPrice,
    serviceType,
    serviceLabel,
    row: row ? { bed: row.bed, bath: row.bath, sqftMin: row.sqftMin, sqftMax: row.sqftMax } : null,
    explanation,
    requiresClarification: missing.length > 0,
    missing,
  };
}

/**
 * Render the calculation result into an AI-facing reference block. Returns
 * null when there's literally nothing to say — the caller can omit the
 * REFERENCE section entirely in that case so the prompt stays small.
 *
 * Two modes:
 *   - Quote ready: emits "Base price / Matched add-ons / Calculated total".
 *   - Clarification needed: emits "Missing inputs / ambiguous add-ons" and
 *     instructs the LLM to ask one question instead of quoting.
 */
export function buildQuoteBlock(
  result: PricingCalculationResult,
  opts: { ambiguousAddons?: string[] } = {},
): string | null {
  const ambiguous = (opts.ambiguousAddons ?? []).filter(Boolean);

  // Nothing to say — no inputs, no asks. Caller omits the block entirely.
  if (
    result.basePrice === null &&
    result.extrasMatched.length === 0 &&
    ambiguous.length === 0 &&
    result.missing.length === 0
  ) {
    return null;
  }

  // Clarification path: cannot give a total. Tell the LLM to ask instead
  // of guessing.
  if (result.basePrice === null && result.extrasMatched.length === 0) {
    const lines: string[] = ['Pricing has NOT been calculated — DO NOT quote a total.'];
    if (result.missing.length > 0) {
      lines.push(`Missing inputs: ${result.missing.join(', ')}`);
    }
    if (ambiguous.length > 0) {
      lines.push(`Customer asked about (ambiguous — needs clarification): ${ambiguous.join(', ')}`);
    }
    lines.push('Ask ONE clarifying question for the missing piece. Do not invent or estimate the price.');
    return lines.join('\n');
  }

  // Quote-ready path. May still surface ambiguous add-ons alongside the
  // total so the LLM can ask "and would you also like X cleaned?" without
  // having auto-added it.
  const lines: string[] = ['Quote calculation (use these numbers verbatim — do NOT recompute):'];
  if (result.basePrice !== null && result.serviceLabel && result.row) {
    lines.push(`  Base price: $${result.basePrice} (${result.serviceLabel} ${result.row.bed}BR/${result.row.bath}BA)`);
  } else if (result.extrasMatched.length > 0) {
    lines.push('  Base price: not calculated (bedrooms/bathrooms unknown).');
  }
  if (result.extrasMatched.length > 0) {
    lines.push('  Matched add-ons:');
    for (const m of result.extrasMatched) {
      lines.push(`    - ${m.label}: +$${m.price}`);
    }
  }
  if (result.totalPrice !== null) {
    lines.push(`  Calculated total: $${result.totalPrice}`);
  }
  if (result.explanation) {
    lines.push(`Pricing explanation: ${result.explanation}`);
  }
  if (ambiguous.length > 0) {
    lines.push(`Customer also mentioned (ambiguous — ask to clarify, do NOT auto-add): ${ambiguous.join(', ')}`);
  }
  return lines.join('\n');
}

function buildExplanation(opts: {
  serviceLabel: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  basePrice: number | null;
  matched: MatchedExtra[];
  totalPrice: number | null;
}): string {
  const parts: string[] = [];
  if (opts.serviceLabel && opts.bedrooms !== null && opts.bathrooms !== null && opts.basePrice !== null) {
    parts.push(`${opts.serviceLabel} ${opts.bedrooms}BR/${opts.bathrooms}BA ($${opts.basePrice})`);
  }
  for (const m of opts.matched) {
    parts.push(`${m.label} ($${m.price})`);
  }
  if (parts.length === 0) return '';
  let s = parts.join(' + ');
  if (opts.totalPrice !== null && (opts.matched.length > 0 || opts.basePrice !== null) && parts.length > 1) {
    s += ` = $${opts.totalPrice}`;
  }
  return s;
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseFirstInt(s: string): number | null {
  const m = s.match(/-?\d+/);
  return m ? parseInt(m[0], 10) : null;
}

function parseFirstFloat(s: string): number | null {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : null;
}

function isOffered(pricing: ServicePricing, key: string): boolean {
  return (pricing.priceTable ?? []).some(r => Number(r[key]) > 0);
}

/**
 * Convenience facade for AI surfaces. Stitches `inferQuoteFacts` +
 * `extractAddons` + `calculateQuote` + `buildQuoteBlock` into a single
 * call so each integration site (ai.controller, automation.service,
 * follow-up-generator, instant-text-ai) needs one line, not 30 lines of
 * the same boilerplate.
 *
 * Returns the quoteBlock string ready to pass into
 * `AiService.generateReply({ quoteBlock })`, or null when there is
 * nothing meaningful to inject.
 */
export interface BuildQuoteFromContextInput {
  pricing: ServicePricing;
  leadDetails?: Record<string, string> | null;
  customerMessage?: string | null;
  conversationHistory?: Array<{ role: 'customer' | 'pro'; content: string }> | null;
  additionalInfo?: string | null;
}

export function buildQuoteFromContext(input: BuildQuoteFromContextInput): string | null {
  return computeQuoteAndIntent(input).quoteBlock;
}

/**
 * Two-output facade used by every AI surface: returns both the
 * authoritative CALCULATED QUOTE reference block AND the runtime
 * PRICE INTENT ENFORCEMENT instruction (when fire conditions are met).
 *
 * The price-intent block is null when the latest customer message has
 * no price-seeking token. When it IS set, callers should inject it at
 * a layer that overrides PRIMARY INSTRUCTION (see ai.service.ts
 * priceIntentBlock field).
 */
export interface QuoteAndIntent {
  quoteBlock: string | null;
  priceIntentBlock: string | null;
}

export function computeQuoteAndIntent(input: BuildQuoteFromContextInput): QuoteAndIntent {
  const facts = inferQuoteFacts(input.leadDetails ?? undefined, input.pricing);
  const addons = extractAddons({
    pricing: input.pricing,
    leadDetails: input.leadDetails ?? undefined,
    customerMessage: input.customerMessage ?? undefined,
    conversationHistory: input.conversationHistory ?? undefined,
    additionalInfo: input.additionalInfo ?? undefined,
  });
  const result = calculateQuote({
    serviceType: facts.serviceType ?? null,
    bedrooms: facts.bedrooms ?? null,
    bathrooms: facts.bathrooms ?? null,
    sqft: facts.sqft ?? null,
    extras: addons.matched,
    pricing: input.pricing,
  });
  const quoteBlock = buildQuoteBlock(result, { ambiguousAddons: addons.ambiguous });
  const priceIntentBlock = buildPriceIntentBlock({
    customerMessage: input.customerMessage ?? null,
    calculation: result,
  });
  return { quoteBlock, priceIntentBlock };
}

function matchCleaningTypeKey(
  text: string,
  cleaningTypes: Array<{ key: string; label: string }>,
): string | null {
  const t = text.toLowerCase();
  if (!t) return null;
  for (const ct of cleaningTypes) {
    if (t === ct.key.toLowerCase()) return ct.key;
  }
  for (const ct of cleaningTypes) {
    if (t.includes(ct.label.toLowerCase())) return ct.key;
  }
  if (/(deep|move[\s-]?in|move[\s-]?out|moving)/.test(t)) {
    const deep = cleaningTypes.find(c => c.key === 'deep');
    if (deep) return deep.key;
  }
  if (/(airbnb|turnover|turn[\s-]?around)/.test(t)) {
    const ab = cleaningTypes.find(c => c.key === 'airbnb');
    if (ab) return ab.key;
  }
  if (/(regular|standard|basic|maintenance|recurring)/.test(t)) {
    const r = cleaningTypes.find(c => c.key === 'regular');
    if (r) return r.key;
  }
  return null;
}
