/**
 * Deterministic Service Options parser.
 *
 * Handles two paste shapes seen in real admin use:
 *
 * Shape A — bulleted (clean spec example):
 *
 *   Which types of stains do you clean?
 *   - Pet stains
 *   - Food stains
 *
 * Shape B — bullet-less (what you get when you copy/paste straight from
 * the Thumbtack admin UI):
 *
 *   Which types of stains do you clean?
 *
 *   Pet stains
 *
 *   Food stains
 *
 * Algorithm:
 *  1. Drop narration lines (Thumbtack helper copy like "Tell customers
 *     what you charge extra for…").
 *  2. Detect heading lines: trimmed line ends with `?` or `:` AND is at
 *     least 5 chars long. Everything from one heading to the next
 *     belongs to that heading.
 *  3. Between two headings (or after the last heading), every non-empty
 *     line is an option. Bullet glyphs are stripped if present but no
 *     longer required.
 *  4. Stable snake_case keys generated from labels.
 *  5. Conservative single/multi select inference.
 *
 * Errors: never throws. Unparseable input returns an empty groups array.
 */

import {
  ServiceOptionGroup,
  ServiceOptionGroupType,
  ServiceOptionItem,
  ServiceOptionsJson,
} from '../admin-service-templates.types';

/** Strip common bullet glyphs from the start of a line. */
const BULLET_RE = /^[\s]*([-*•·]|\d+[.)])\s+/;

function stripBullet(line: string): string {
  return line.replace(BULLET_RE, '').trim();
}

/**
 * Heading detection. A heading is a non-empty line that:
 *   - ends in `?` or `:` after trimming, AND
 *   - is at least 5 chars long (avoids false positives like "Q:" or "?")
 *
 * The Thumbtack UI uses `?` for question prompts. Some admins paste
 * sections with `:` headings ("Add-ons:", "Pricing:") — same path.
 */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 5) return false;
  return /[?:]\s*$/.test(t);
}

/**
 * Narration lines we want to drop on the floor before parsing — the
 * Thumbtack admin UI includes helper copy that has no semantic value
 * (e.g. "Tell customers what you charge extra for. Or check the box to
 * let customers know it's included at no extra cost."). If we don't
 * drop these, the parser tries to interpret them as options or
 * headings and the output looks garbled.
 *
 * Each pattern is intentionally specific — generic phrases like "you can"
 * would over-match real option labels.
 */
const NARRATION_PATTERNS: RegExp[] = [
  /^\s*tell customers/i,
  /^\s*or check the box/i,
  /^\s*enter add-?on prices?\s*$/i,
  /^\s*for prices and\b/i,
];

function isNarration(line: string): boolean {
  // If the line ends with `?` (a heading), don't drop it — let the
  // heading cleaner strip any narration prefix. Otherwise pattern-match.
  if (/\?\s*$/.test(line.trim())) return false;
  return NARRATION_PATTERNS.some((re) => re.test(line));
}

/**
 * Strip narration prefix from a heading line. The Thumbtack UI
 * sometimes emits concatenated text like
 * `Cleaning stains (pet, food or drink)\n for prices and Which types of stains do you clean?`.
 * When we detect such a heading, we want the cleaned form
 * `Which types of stains do you clean?` — everything before a known
 * question starter is just narration noise.
 */
function cleanHeading(line: string): string {
  const t = line.trim();
  // Find the first occurrence of a known question starter (case-sensitive
  // — Thumbtack capitalizes them; matching loose would over-trim).
  const match = t.match(/\b(Which|How|What|Do you|Are you|Can you|When|Where)\b.*$/);
  if (match && match.index !== undefined && match.index > 0) {
    return match[0].trim();
  }
  return t;
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
 * Split raw input into { heading, items } blocks. v2 algorithm:
 *
 *   - Drop blank lines and narration lines up front.
 *   - Walk the surviving lines. Heading lines (end in `?` or `:`) open
 *     a new block. Every other line is appended as an option to the
 *     currently open block.
 *   - If the input has no heading at all, fabricate a single "Options"
 *     heading so the items don't get dropped entirely.
 *
 * Bulleted input still works — stripBullet() runs on each option line.
 */
function splitIntoBlocks(text: string): Array<{ heading: string; items: string[] }> {
  const rawLines = text.split(/\r?\n/);
  const blocks: Array<{ heading: string; items: string[] }> = [];
  let current: { heading: string; items: string[] } | null = null;

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (isNarration(trimmed)) continue;

    if (isHeadingLine(trimmed)) {
      if (current && current.items.length > 0) blocks.push(current);
      current = { heading: cleanHeading(trimmed), items: [] };
      continue;
    }

    // Option line. If we haven't seen a heading yet, drop it on the
    // floor: the admin pasted unstructured content (or mixed in their
    // pricing block) and we shouldn't manufacture a phantom group from
    // pricing rows. Headings end with `?` or `:` — they're cheap to add.
    if (!current) continue;
    const cleaned = stripBullet(raw);
    if (cleaned.length === 0) continue;
    current.items.push(cleaned);
  }

  if (current && current.items.length > 0) blocks.push(current);
  return blocks;
}

/**
 * De-duplicate keys within a single parse run. Append `_2`, `_3`, ...
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
