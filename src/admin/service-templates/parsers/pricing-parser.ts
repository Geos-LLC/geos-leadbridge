/**
 * Deterministic Pricing parser.
 *
 * Handles two paste shapes seen in real admin use:
 *
 * Shape A — inline (clean spec example):
 *
 *   1 room Avg. $79
 *   2 rooms Avg. $103
 *
 * Shape B — separate lines (what you get when you copy/paste straight
 * from the Thumbtack admin UI — label on one line, price on the next):
 *
 *   1 room
 *
 *   Avg. $79
 *
 *   2 rooms
 *
 *   Avg. $103
 *
 *   Enter add-on prices
 *   Tell customers what you charge extra for. …
 *
 *   Cleaning home with pet(s)
 *
 *   Cleaning home with smoker(s)
 *
 * Algorithm:
 *  1. Drop blank + narration lines up front.
 *  2. Walk surviving lines with a 1-line lookahead:
 *       - if line has $, parse it as a single-line row.
 *       - else, if the NEXT line has $, pair the two (label + price row).
 *       - else, it's a no-price line — meaningful only in addon mode
 *         (becomes a quoteManually addon).
 *  3. Mode flips:
 *       - "Add-ons:", "Add-on prices", "Enter add-on prices", "Extras:"
 *         → addon mode.
 *       - "Base", "Standard pricing" → base mode.
 *       - First line that looks like a Service Options question (ends
 *         in `?`) stops the parser — admin pasted mixed content.
 *  4. Pricing model inference (see inferModel).
 *
 * Errors: never throws.
 */

import {
  AdminAddOn,
  AdminBasePrice,
  AdminPricingJson,
  AdminPricingModel,
  AdminPricingSource,
} from '../admin-service-templates.types';
import { toKey } from './service-options-parser';

const PRICE_TOKEN_RE = /\$\s*([0-9]+(?:\.[0-9]+)?)/;
const AVG_RE = /\b(avg\.?|average)\b/i;
const QUANTITY_LABEL_RE = /^\s*(\d+)\s+([a-zA-Z][a-zA-Z\s]*?)(?=\s+\$|\s+avg|\s+@|\s*$)/i;
const HOURLY_RE = /\b(per\s+hour|\/hour|\/hr|hourly)\b/i;
const FLAT_RATE_RE = /\b(flat\s+rate|service\s+call|minimum\s+charge|min\.?\s+charge|starts?\s+at)\b/i;

/** Header lines that switch us into add-on collection mode. Broadened
 *  to cover Thumbtack's "Enter add-on prices" UI header. */
const ADDON_HEADER_RE =
  /^\s*(add[-\s]?ons?|enter\s+add[-\s]?on\s+prices?|add[-\s]?on\s+prices?|extras|optional|optional\s+add[-\s]?ons?)\s*:?\s*$/i;

const BASE_HEADER_RE = /^\s*(base|base\s+pricing|standard|standard\s+pricing|rates?)\s*:?\s*$/i;

/** Narration lines we want to drop on the floor before parsing. */
const NARRATION_PATTERNS: RegExp[] = [
  /^\s*tell customers/i,
  /^\s*or check the box/i,
  /^\s*for prices and\b/i,
];

function isNarration(line: string): boolean {
  return NARRATION_PATTERNS.some((re) => re.test(line));
}

/**
 * Stop signal — Thumbtack admins sometimes paste pricing + service
 * options together. Once we hit a line that looks like a question
 * heading ("Which types of houses do you clean?"), we stop consuming
 * — the rest belongs in the Service Options textarea, not Pricing.
 */
function looksLikeOptionsHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 5) return false;
  return /\?\s*$/.test(t);
}

/**
 * Pull the FIRST money value out of a line. Returns null when nothing
 * looks like a price.
 */
function extractPrice(line: string): { price: number; source: AdminPricingSource } | null {
  if (!PRICE_TOKEN_RE.test(line)) return null;
  const match = line.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const price = parseFloat(match[1]);
  if (!isFinite(price)) return null;
  const source: AdminPricingSource = AVG_RE.test(line) ? 'thumbtack_average' : 'admin_input';
  return { price, source };
}

/**
 * Extract a quantity + clean label from a line. Handles:
 *   "1 room"            → quantity=1, label="1 room"
 *   "1 room Avg. $79"   → quantity=1, label="1 room"
 *   "Sofa $96"          → quantity=null, label="Sofa"
 *   "Service call $120" → quantity=null, label="Service call"
 */
function extractQuantityAndLabel(line: string): { quantity: number | null; label: string } {
  const match = line.match(QUANTITY_LABEL_RE);
  if (match) {
    const quantity = parseInt(match[1], 10);
    if (isFinite(quantity)) {
      const noun = match[2].trim();
      return { quantity, label: `${quantity} ${noun}` };
    }
  }
  // Fall back: label is "everything before the first $". This handles
  // item rows like "Sofa $96" or "Service call $120".
  const dollarIdx = line.indexOf('$');
  const cutoff = dollarIdx > 0 ? dollarIdx : line.length;
  const labelPart = line
    .slice(0, cutoff)
    .replace(/\b(avg\.?|average)\b/gi, '')
    .trim();
  return { quantity: null, label: labelPart || line.trim() };
}

/**
 * Same logic but applied to a label-only line (no $). When the price
 * comes from a PAIRED next line ("1 room" \n "Avg. $79"), we want the
 * quantity from the label line, not the price line.
 */
function extractQuantityFromLabelOnly(line: string): { quantity: number | null; label: string } {
  const trimmed = line.trim();
  // "1 room", "12 items", "3 bedrooms"
  const m = trimmed.match(/^(\d+)\s+([a-zA-Z][a-zA-Z\s]*?)\s*$/);
  if (m) {
    const q = parseInt(m[1], 10);
    if (isFinite(q)) return { quantity: q, label: `${q} ${m[2].trim()}` };
  }
  return { quantity: null, label: trimmed };
}

function inferModel(basePrices: AdminBasePrice[], rawLines: string[]): AdminPricingModel {
  if (basePrices.length === 0) {
    const joined = rawLines.join(' ');
    if (HOURLY_RE.test(joined)) return 'hourly';
    if (FLAT_RATE_RE.test(joined)) return 'flat_rate';
    return 'custom';
  }
  if (rawLines.some((l) => HOURLY_RE.test(l))) return 'hourly';

  const allRoomy = basePrices.every((b) => /\brooms?\b/i.test(b.label));
  if (allRoomy) return 'room_quantity';

  if (basePrices.length === 1 && FLAT_RATE_RE.test(basePrices[0].label)) return 'flat_rate';

  // item_quantity: 2+ priced rows, none room-shaped.
  if (basePrices.length >= 2 && basePrices.every((b) => b.price > 0)) return 'item_quantity';

  if (basePrices.length === 1 && basePrices[0].price > 0) return 'flat_rate';

  return 'custom';
}

function extractHourly(text: string): { laborRate?: number; minimumCharge?: number } {
  const hourMatch = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:\/\s*hour|\/\s*hr|per\s+hour|hourly)/i);
  const minMatch = text.match(/\$\s*([0-9]+(?:\.[0-9]+)?)\s*(?:minimum|min\.?\s*charge)/i);
  const out: { laborRate?: number; minimumCharge?: number } = {};
  if (hourMatch) {
    const v = parseFloat(hourMatch[1]);
    if (isFinite(v)) out.laborRate = v;
  }
  if (minMatch) {
    const v = parseFloat(minMatch[1]);
    if (isFinite(v)) out.minimumCharge = v;
  }
  return out;
}

/** Track a generated addOn key to keep the registry unique within one parse. */
function nextUniqueKey(label: string, taken: Set<string>): string {
  const base = toKey(label, 'option');
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  let n = 2;
  while (taken.has(`${base}_${n}`)) n += 1;
  const out = `${base}_${n}`;
  taken.add(out);
  return out;
}

/**
 * Main entry point. Pure — no side effects, no exceptions.
 */
export function parsePricing(input: string | null | undefined): AdminPricingJson {
  if (!input || typeof input !== 'string') {
    return {
      pricingModel: 'custom',
      currency: 'USD',
      basePrices: [],
      addOns: [],
      quoteRequired: true,
    };
  }

  // Pre-filter: drop blank + narration. Keep order so 1-line lookahead works.
  const allLines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  const lines: string[] = [];
  for (const l of allLines) {
    // Stop at the first Options-style question — admin pasted mixed content.
    if (looksLikeOptionsHeading(l)) break;
    if (isNarration(l)) continue;
    lines.push(l);
  }

  const basePrices: AdminBasePrice[] = [];
  const addOns: AdminAddOn[] = [];
  const addOnKeys = new Set<string>();
  let mode: 'base' | 'addon' = 'base';

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Mode switches.
    if (ADDON_HEADER_RE.test(line)) {
      mode = 'addon';
      i += 1;
      continue;
    }
    if (BASE_HEADER_RE.test(line)) {
      mode = 'base';
      i += 1;
      continue;
    }

    // Strip a leading bullet so "* Sofa $96" parses cleanly.
    const stripped = line.replace(/^\s*[-*•·]\s+/, '');

    // Case 1 — price on this line.
    if (PRICE_TOKEN_RE.test(stripped)) {
      const priced = extractPrice(stripped)!;
      const { quantity, label } = extractQuantityAndLabel(stripped);
      if (mode === 'base') {
        basePrices.push({ quantity, label: label || stripped, price: priced.price, source: priced.source });
      } else {
        addOns.push({
          key: nextUniqueKey(label || stripped, addOnKeys),
          label: label || stripped,
          price: priced.price,
          source: priced.source,
          quoteManually: false,
        });
      }
      i += 1;
      continue;
    }

    // Case 2 — base mode only: pair label-line with next priced line.
    // Restricted to base mode because addon labels are descriptive
    // ("Cleaning stains") and should NOT swallow the next addon's
    // price. Also restricted to label lines that LOOK like a paired
    // label (numeric quantity prefix OR short noun-only line); a long
    // descriptive line in base mode is more likely just orphan text
    // (e.g. category divider like "Flights of stairs").
    const next = i + 1 < lines.length ? lines[i + 1] : null;
    const looksLikeBasePairLabel = /^\d+\s+[a-zA-Z]/.test(line) || (line.length < 30 && /^[a-zA-Z]/.test(line));
    if (
      mode === 'base' &&
      looksLikeBasePairLabel &&
      next &&
      PRICE_TOKEN_RE.test(next) &&
      !ADDON_HEADER_RE.test(next) &&
      !BASE_HEADER_RE.test(next)
    ) {
      const priced = extractPrice(next)!;
      const { quantity, label } = extractQuantityFromLabelOnly(line);
      basePrices.push({ quantity, label, price: priced.price, source: priced.source });
      i += 2;
      continue;
    }

    // Case 3 — no price, no paired price.
    // In addon mode: capture as a quote-manually addon.
    // In base mode: skip (just an orphan label / divider like "Flights of stairs").
    if (mode === 'addon') {
      const { label } = extractQuantityFromLabelOnly(line);
      addOns.push({
        key: nextUniqueKey(label, addOnKeys),
        label,
        price: 0,
        source: 'missing',
        quoteManually: true,
      });
    }
    i += 1;
  }

  const pricingModel = inferModel(basePrices, lines);
  const currency = 'USD';
  const out: AdminPricingJson = {
    pricingModel,
    currency,
    basePrices,
    addOns,
  };

  if (pricingModel === 'hourly' || pricingModel === 'custom') {
    out.quoteRequired = true;
  }
  if (pricingModel === 'hourly') {
    const hourly = extractHourly(input);
    if (hourly.laborRate !== undefined) out.laborRate = hourly.laborRate;
    if (hourly.minimumCharge !== undefined) out.minimumCharge = hourly.minimumCharge;
  }
  if (pricingModel === 'flat_rate' && basePrices.length === 1) {
    out.minimumCharge = basePrices[0].price;
  }

  return out;
}
