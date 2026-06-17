/**
 * Deterministic Service Options parser.
 *
 * Input shape (admin paste):
 *
 *   Which types of houses do you clean?
 *   - Houses with pets
 *   - Houses without pets
 *
 *   How many rooms?
 *   - 1 room
 *   - 2 rooms
 *
 * Algorithm:
 *  1. Split into blocks separated by blank lines.
 *  2. For each block: first non-bullet line = group label, remaining
 *     bullet-prefixed lines = option items.
 *  3. Generate stable snake_case keys from labels (lowercase, strip
 *     punctuation, replace non-alnum runs with '_').
 *  4. Infer single vs multi select conservatively (see classifyGroupType).
 *
 * Errors: never throws. Unparseable blocks are dropped silently so the
 * admin can paste partial / messy text without crashing the generator.
 * The preview UI lets the admin add missing groups by hand.
 */

import {
  ServiceOptionGroup,
  ServiceOptionGroupType,
  ServiceOptionItem,
  ServiceOptionsJson,
} from '../admin-service-templates.types';

/** Strip common bullet glyphs from the start of a line. */
const BULLET_RE = /^[\s]*([-*•·]|\d+[.)])\s+/;

/** Anything we want to treat as "this line is a bullet, not a heading." */
function isBulletLine(line: string): boolean {
  return BULLET_RE.test(line);
}

/** Strip the leading bullet glyph. */
function stripBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/**
 * Convert a free-text label into a stable snake_case key.
 * - lowercase
 * - drop everything that isn't a-z / 0-9 / space / underscore
 * - collapse runs of whitespace / underscore to a single underscore
 * - strip leading/trailing underscores
 * Falls back to 'option' / 'group' when the result would be empty so
 * downstream code never has to handle empty-key rows.
 */
export function toKey(label: string, fallback: 'option' | 'group'): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9\s_]/g, ' ')
    .replace(/[\s_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (cleaned.length === 0) return fallback;
  // Cap at 48 chars to keep keys stable in URLs / filters / DB rows.
  return cleaned.slice(0, 48);
}

/**
 * Single vs multi-select heuristic. Goal: never block a customer from
 * picking a valid combination, so default lean is `multi_select`.
 *
 * Single-select triggers (any one is enough):
 *  - Heading contains "method", "preference", "size", "type of " (singular)
 *  - Heading starts with "How many" — quantity questions are single-pick
 *  - Heading contains "which one"
 *
 * Everything else defaults to multi_select.
 */
export function classifyGroupType(label: string): ServiceOptionGroupType {
  const l = label.toLowerCase();
  if (/\bhow many\b/.test(l)) return 'single_select';
  if (/\bwhich one\b/.test(l)) return 'single_select';
  if (/\bmethod\b/.test(l)) return 'single_select';
  if (/\bpreference\b/.test(l)) return 'single_select';
  if (/\bsize\b/.test(l) && !/\bsizes\b/.test(l)) return 'single_select';
  // "Which type of" (singular) → single; "Which types of" (plural) → multi.
  if (/\btype of\b/.test(l) && !/\btypes of\b/.test(l)) return 'single_select';
  return 'multi_select';
}

/**
 * Split raw input into blocks. A block is a heading + its following
 * bullet lines, separated from the next block by a blank line OR by
 * another non-bullet line.
 *
 * Returns an array of blocks where block[0] is the heading and
 * block[1..] are the bullet item labels (already stripped of bullets).
 */
function splitIntoBlocks(text: string): Array<{ heading: string; items: string[] }> {
  const rawLines = text.split(/\r?\n/);
  const blocks: Array<{ heading: string; items: string[] }> = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const raw of rawLines) {
    const line = raw.replace(/\s+$/, '');
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      // Blank line ends the current block.
      if (current && current.items.length > 0) blocks.push(current);
      current = null;
      continue;
    }

    if (isBulletLine(line)) {
      const item = stripBullet(line);
      if (item.length === 0) continue;
      if (!current) {
        // Orphan bullet — no heading yet. Fabricate a generic group so
        // we don't drop the row entirely.
        current = { heading: 'Options', items: [] };
      }
      current.items.push(item);
      continue;
    }

    // Non-bullet, non-empty line → new heading. Push the current block
    // first if it had items.
    if (current && current.items.length > 0) blocks.push(current);
    current = { heading: trimmed, items: [] };
  }

  // Don't forget the last block.
  if (current && current.items.length > 0) blocks.push(current);
  return blocks;
}

/**
 * De-duplicate keys within a single parse run. We append `_2`, `_3`,
 * ... when a generated key already exists in the set. This stays
 * idempotent across re-runs because the input order drives suffixing.
 */
function uniqueKey(base: string, taken: Set<string>): string {
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
export function parseServiceOptions(input: string | null | undefined): ServiceOptionsJson {
  if (!input || typeof input !== 'string') return { groups: [] };

  const blocks = splitIntoBlocks(input);
  const groupKeys = new Set<string>();
  const groups: ServiceOptionGroup[] = [];

  for (const block of blocks) {
    const groupKey = uniqueKey(toKey(block.heading, 'group'), groupKeys);

    const itemKeys = new Set<string>();
    const options: ServiceOptionItem[] = [];
    for (const itemLabel of block.items) {
      const itemKey = uniqueKey(toKey(itemLabel, 'option'), itemKeys);
      options.push({ key: itemKey, label: itemLabel });
    }

    groups.push({
      key: groupKey,
      label: block.heading,
      type: classifyGroupType(block.heading),
      options,
    });
  }

  return { groups };
}
