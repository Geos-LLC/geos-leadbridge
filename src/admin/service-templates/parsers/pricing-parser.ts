/**
 * Deterministic Pricing parser.
 *
 * Input shape (admin paste):
 *
 *   1 room Avg. $79
 *   2 rooms Avg. $103
 *   3 rooms Avg. $132
 *
 *   Add-ons:
 *   Cleaning 1 flight of stairs
 *   Cleaning stains
 *   Cleaning home with pets
 *
 * Algorithm:
 *  1. Walk each line.
 *  2. If a line matches "Add-ons:" / "Add ons:" / "Extras:" we switch
 *     into addOn-collection mode.
 *  3. Each base-price line is parsed into { quantity, label, price, source }.
 *  4. Add-on lines without a number get quoteManually=true.
 *  5. Pricing model is inferred from the base rows:
 *       - all rows say "room" / "rooms"      → room_quantity
 *       - rows look like noun + price        → item_quantity
 *       - "$X/hour" or "X per hour" present  → hourly
 *       - single "Service call $X" / "Flat $X" → flat_rate
 *       - otherwise                           → custom (+ quoteRequired)
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

/** Currency token at the start of a money chunk. v1 supports USD only. */
const PRICE_RE = /\$?\s*([0-9]+(?:\.[0-9]+)?)/;

/** "Avg." / "Avg" / "average" tags from Thumbtack-style copy. */
const AVG_RE = /\b(avg\.?|average)\b/i;

/** "1 room", "2 rooms", "12 items", "3 bedrooms" — anything starting with a number + noun. */
const QUANTITY_LABEL_RE = /^\s*(\d+)\s+([a-zA-Z][a-zA-Z\s]*?)(?=\s+\$|\s+avg|\s+@|\s*$)/i;

/** Hourly markers in the price line. */
const HOURLY_RE = /\b(per\s+hour|\/hour|\/hr|hourly)\b/i;

/** Flat-rate markers. */
const FLAT_RATE_RE = /\b(flat\s+rate|service\s+call|minimum\s+charge|min\.?\s+charge|starts?\s+at)\b/i;

/** Header lines that switch us into add-on collection mode. */
const ADDON_HEADER_RE = /^\s*(add[-\s]?ons?|extras|optional|optional add\-?ons?)\s*:?\s*$/i;

/** Header lines that switch us back to base rows. */
const BASE_HEADER_RE = /^\s*(base|base\s+pricing|standard|standard\s+pricing|rates?)\s*:?\s*$/i;

/**
 * Pull the FIRST money value out of a line. Returns null when nothing
 * looks like a price.
 */
function extractPrice(line: string): { price: number; source: AdminPricingSource } | null {
  if (!PRICE_RE.test(line)) return null;
  const match = line.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const price = parseFloat(match[1]);
  if (!isFinite(price)) return null;
  const source: AdminPricingSource = AVG_RE.test(line)
    ? 'thumbtack_average'
    : 'admin_input';
  return { price, source };
}

/** "1 room Avg. $79" → { quantity: 1, label: "1 room" }. */
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
  const labelPart = line.slice(0, cutoff).replace(/\b(avg\.?|average)\b/gi, '').trim();
  return { quantity: null, label: labelPart || line.trim() };
}

/**
 * Decide which pricing model best fits the parsed rows.
 *  - All base rows reference "room" / "rooms"        → room_quantity
 *  - Any base row matches HOURLY_RE                   → hourly
 *  - Exactly one row + matches FLAT_RATE_RE          → flat_rate
 *  - All base rows have quantity != null + a noun     → item_quantity
 *  - Otherwise                                         → custom
 */
function inferModel(
  basePrices: AdminBasePrice[],
  rawLines: string[],
): AdminPricingModel {
  if (basePrices.length === 0) {
    // No base rows but maybe a single hourly / flat line in raw text.
    const joined = rawLines.join(' ');
    if (HOURLY_RE.test(joined)) return 'hourly';
    if (FLAT_RATE_RE.test(joined)) return 'flat_rate';
    return 'custom';
  }
  if (rawLines.some((l) => HOURLY_RE.test(l))) return 'hourly';

  const allRoomy = basePrices.every((b) => /\brooms?\b/i.test(b.label));
  if (allRoomy) return 'room_quantity';

  if (basePrices.length === 1 && FLAT_RATE_RE.test(basePrices[0].label)) {
    return 'flat_rate';
  }

  // item_quantity matches in two shapes:
  //   - Explicit per-quantity rows ("1 sofa $96") where quantity != null
  //   - Per-item rows ("Sofa $96") where the label is a noun + price
  // Either way: 2+ rows with non-zero prices is the strongest signal.
  if (basePrices.length >= 2 && basePrices.every((b) => b.price > 0)) {
    return 'item_quantity';
  }

  // Single labeled row with a real price → flat_rate (cleanout, service call).
  if (basePrices.length === 1 && basePrices[0].price > 0) {
    return 'flat_rate';
  }

  // Mixed shapes / missing prices → leave it to the admin to clean up.
  return 'custom';
}

/**
 * Extract a labour rate + minimum from hourly-leaning text.
 * "$100/hour, $100 minimum" — picks two numbers.
 */
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

/**
 * Main entry point. Pure — no side effects, no exceptions.
 *
 * Returns a pricing JSON in the v2 admin shape. The runtime pricing
 * engine consumes a different shape; the bridge happens when an admin
 * copies a template into a ServiceProfile (see
 * service-profile.service.ts copyTemplateToProfile).
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

  const lines = input.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);

  const basePrices: AdminBasePrice[] = [];
  const addOns: AdminAddOn[] = [];
  const addOnKeys = new Set<string>();
  let mode: 'base' | 'addon' = 'base';

  for (const line of lines) {
    if (ADDON_HEADER_RE.test(line)) {
      mode = 'addon';
      continue;
    }
    if (BASE_HEADER_RE.test(line)) {
      mode = 'base';
      continue;
    }
    // Strip a leading bullet so "* Sofa $96" parses cleanly.
    const stripped = line.replace(/^\s*[-*•·]\s+/, '');

    const priced = extractPrice(stripped);
    const { quantity, label } = extractQuantityAndLabel(stripped);

    if (mode === 'addon') {
      const key = (() => {
        const base = toKey(label, 'option');
        if (!addOnKeys.has(base)) {
          addOnKeys.add(base);
          return base;
        }
        let n = 2;
        while (addOnKeys.has(`${base}_${n}`)) n += 1;
        const out = `${base}_${n}`;
        addOnKeys.add(out);
        return out;
      })();
      addOns.push({
        key,
        label,
        price: priced?.price ?? 0,
        source: priced?.source ?? 'missing',
        quoteManually: priced == null,
      });
      continue;
    }

    if (priced == null) {
      // Base mode but no price — treat as a missing-price row so admin
      // can fill in the number later. Skip lines that are clearly just
      // notes / commentary (no digits, no nouns).
      if (/^[a-zA-Z]/.test(label)) {
        basePrices.push({
          quantity,
          label: label || stripped,
          price: 0,
          source: 'missing',
        });
      }
      continue;
    }

    basePrices.push({
      quantity,
      label: label || stripped,
      price: priced.price,
      source: priced.source,
    });
  }

  const pricingModel = inferModel(basePrices, lines);
  const currency = 'USD';
  const out: AdminPricingJson = {
    pricingModel,
    currency,
    basePrices,
    addOns,
  };

  // Pricing models that can't produce a bound quote without owner input
  // get quoteRequired=true so the AI prompt assembler later disables the
  // calculated-total path for them.
  if (pricingModel === 'hourly' || pricingModel === 'custom') {
    out.quoteRequired = true;
  }
  if (pricingModel === 'hourly') {
    const hourly = extractHourly(input);
    if (hourly.laborRate !== undefined) out.laborRate = hourly.laborRate;
    if (hourly.minimumCharge !== undefined) out.minimumCharge = hourly.minimumCharge;
  }
  if (pricingModel === 'flat_rate') {
    // Minimum charge = the single base price if there's exactly one.
    if (basePrices.length === 1) out.minimumCharge = basePrices[0].price;
  }

  return out;
}
